import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { Agent, type AgentEvent, type AgentMessage, type BeforeToolCallContext } from '@earendil-works/pi-agent-core';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import type { Model } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type {
  AppError,
  ApprovalDecision,
  ApprovalRequest,
  ChangesView,
  DiffView,
  McpServerDefinition,
  ModelInput,
  ModelProfile,
  PermissionSetting,
  RootChanges,
  RootView,
  RunEvent,
  RunPhase,
  RunView,
  RunnerKind,
  SandboxStatus,
  SnapshotEnvelope,
  TaskSummary,
  TimelineItem,
  ToolItem,
  UserMode,
  WorkbenchEvent,
  WorkbenchSnapshot,
} from '../../shared/contracts.js';
import { McpManager } from '../tools/mcp.js';
import { createRootTools } from '../tools/native-tools.js';
import { ApprovalBroker, classify, permissionFor, registered, verdict } from '../tools/permission.js';
import { SandboxRunner } from '../tools/sandbox.js';
import * as git from '../workspace/git.js';
import { openRoot, readWorkspaceRules } from '../workspace/workspace.js';
import { Ledger } from './ledger.js';

type Baseline = { tree: string; commit?: string; branch?: string };
type TaskState = {
  id: string;
  title: string;
  updatedAt: number;
  roots: RootView[];
  permission: PermissionSetting;
  session: SessionManager;
  timeline: TimelineItem[];
  run?: RunView;
  error?: AppError;
  baselines: Map<string, Baseline>;
  changes?: ChangesView;
};
type ActiveRun = { id: string; kind: 'prompt' | 'test'; taskId?: string; agent?: Agent; cancelRequested: boolean; done?: Promise<unknown> };
type SandboxOptions = { exe: string; tempDir: string };

const ARGS_TEXT_LIMIT = 4 * 1024;
const APPROVAL_ARGS_LIMIT = 8 * 1024;
const OUTPUT_PREVIEW_LIMIT = 8 * 1024;
const IMPLEMENT_PLAN_TEXT = '请按照上面的计划开始实施。';

export class AgentRuntime {
  private profile?: ModelInput;
  private models: ModelProfile[] = [];
  private apiKey?: string;
  private tasks: TaskState[] = [];
  private taskId?: string;
  private active?: ActiveRun;
  private testRun?: RunView;
  private error?: AppError;
  private assistantId?: string;
  private seq = 0;
  private readonly ledger = new Ledger();
  private readonly broker = new ApprovalBroker();
  private readonly mcp: McpManager;
  private readonly sandbox?: SandboxRunner;
  private readonly runners = new Map<string, RunnerKind>();
  private readonly startedAt = new Map<string, number>();

  constructor(
    private readonly hostInstanceId: string,
    private readonly rulesPath: string,
    private readonly send: (event: WorkbenchEvent) => void,
    sandbox?: SandboxOptions,
  ) {
    this.mcp = new McpManager(() => this.emit({ type: 'mcp.updated', value: this.mcp.statuses() }));
    if (sandbox) {
      this.sandbox = new SandboxRunner(sandbox.exe, sandbox.tempDir);
      void this.sandbox.verify().then(status => this.emit({ type: 'sandbox.updated', value: status }));
    }
  }

  // 上次异常退出时遗留的授权：新的 Host 不再持有它们，直接撤销。
  async revokeStaleGrants(paths: string[]): Promise<void> {
    for (const path of paths) await this.sandbox?.revoke(path).catch(() => undefined);
  }

  getSnapshot(): SnapshotEnvelope {
    return { hostInstanceId: this.hostInstanceId, seq: this.seq, value: this.snapshot() };
  }

  setModel(profile: ModelInput, apiKey?: string, models?: ModelProfile[]): ModelProfile {
    this.assertIdle();
    this.profile = profile;
    this.apiKey = apiKey;
    this.models = models ?? [{ ...profile, hasApiKey: Boolean(apiKey) }];
    this.emitSnapshot();
    return { ...profile, hasApiKey: Boolean(apiKey) };
  }

  async setMcpServers(servers: McpServerDefinition[]): Promise<void> {
    await this.mcp.setServers(servers);
  }

  async newTask(rootPaths: string[] = []): Promise<void> {
    this.assertIdle();
    const roots: RootView[] = [];
    for (const path of rootPaths) {
      try {
        roots.push(await openRoot(path, roots));
      } catch {
        // 已不存在的最近目录在播种新任务时直接丢弃。
      }
    }
    this.testRun = undefined;
    this.createTask(roots);
    this.emitSnapshot();
  }

  selectTask(taskId: string): void {
    this.assertIdle();
    if (!this.tasks.some(task => task.id === taskId)) throw new Error('任务不存在');
    this.taskId = taskId;
    this.testRun = undefined;
    this.emitSnapshot();
  }

  async addRoot(path: string, grantSandbox = false): Promise<RootView> {
    this.assertIdle();
    const task = this.ensureTask();
    const root = await openRoot(path, task.roots);
    if (grantSandbox) await this.grant(root);
    task.roots.push(root);
    this.rootsChanged(task);
    return root;
  }

  async removeRoot(rootId: string): Promise<void> {
    this.assertIdle();
    const task = this.requireTask();
    const root = task.roots.find(item => item.id === rootId);
    if (!root) throw new Error('目录不存在');
    task.roots = task.roots.filter(item => item.id !== rootId);
    if (root.primary && task.roots.length) task.roots[0].primary = true;
    task.baselines.delete(rootId);
    this.rootsChanged(task);
    if (root.sandboxGranted && !this.tasks.some(item => item.roots.some(other => other.path === root.path && other.sandboxGranted))) {
      await this.sandbox?.revoke(root.path).catch(() => undefined);
    }
  }

  setPrimaryRoot(rootId: string): void {
    this.assertIdle();
    const task = this.requireTask();
    if (!task.roots.some(root => root.id === rootId)) throw new Error('目录不存在');
    for (const root of task.roots) root.primary = root.id === rootId;
    this.rootsChanged(task);
  }

  async setPermission(userMode: UserMode): Promise<PermissionSetting> {
    this.assertIdle();
    const task = this.ensureTask();
    if (userMode === 'auto') {
      if (this.sandbox?.status !== 'available') throw new Error('Auto 需要已验证的原生沙箱，当前不可用');
      for (const root of task.roots) await this.grant(root);
    }
    task.permission = permissionFor(userMode, task.permission.grants);
    this.emitSnapshot();
    return task.permission;
  }

  startMessage(text: string): { runId: string } {
    this.assertConfigured();
    this.assertIdle();
    const task = this.ensureTask();
    const run = this.ledger.startRun(task.id);
    this.testRun = undefined;
    this.error = undefined;
    task.error = undefined;
    task.run = { id: run.id, taskId: task.id, phase: 'running', toolErrors: false };
    this.active = { id: run.id, kind: 'prompt', taskId: task.id, cancelRequested: false };
    const item: TimelineItem = { kind: 'message', id: randomUUID(), role: 'user', text };
    if (!task.timeline.length) task.title = text.replace(/\s+/g, ' ').slice(0, 32);
    task.timeline.push(item);
    this.emit({ type: 'message.started', id: item.id, role: 'user' });
    this.emit({ type: 'message.ended', id: item.id, text });
    this.emitRun(task);
    this.emitSnapshot();
    this.active.done = this.runPrompt(task, run.id, text);
    return { runId: run.id };
  }

  async implementPlan(): Promise<{ runId: string }> {
    const task = this.requireTask();
    if (task.permission.userMode !== 'plan' || !task.timeline.some(item => item.kind === 'message' && item.role === 'assistant')) {
      throw new Error('当前没有可实施的计划');
    }
    await this.setPermission('accept_edits');
    return this.startMessage(IMPLEMENT_PLAN_TEXT);
  }

  testModel(): Promise<{ text: string }> {
    this.assertConfigured();
    this.assertIdle();
    const id = randomUUID();
    this.error = undefined;
    this.testRun = { id, taskId: '', phase: 'running', toolErrors: false };
    this.active = { id, kind: 'test', cancelRequested: false };
    this.emit({ type: 'run.changed', value: this.testRun });
    const done = this.runModelTest(id);
    this.active.done = done;
    return done;
  }

  cancelRun(runId: string): void {
    if (!this.active || this.active.id !== runId) throw new Error('当前执行已结束');
    this.active.cancelRequested = true;
    const task = this.taskOf(this.active);
    if (task?.run) task.run = { ...task.run, phase: 'cancelling' };
    else if (this.testRun) this.testRun = { ...this.testRun, phase: 'cancelling' };
    this.emitRun(task);
    this.active.agent?.abort();
  }

  decideApproval(approvalId: string, decision: ApprovalDecision): void {
    const request = this.broker.current;
    if (request?.id === approvalId && decision === 'allow_task' && !request.grantKey) throw new Error('此操作不支持任务级授权');
    this.broker.decide(approvalId, decision);
  }

  async getChanges(): Promise<ChangesView> {
    const task = this.requireTask();
    if (task.permission.userMode !== 'plan') await this.refreshChanges(task);
    return task.changes ?? { taskId: task.id, computedAt: Date.now(), roots: [] };
  }

  async getDiff(rootId: string, path: string): Promise<DiffView> {
    const task = this.requireTask();
    const root = task.roots.find(item => item.id === rootId);
    const entry = task.changes?.roots.find(item => item.rootId === rootId);
    if (!root || !entry?.git) throw new Error('该目录没有可用的差异');
    return git.diff(root.path, entry.git.baseTree, entry.git.nowTree, rootId, path);
  }

  getRunEvents(runId: string): RunEvent[] {
    return this.ledger.events(runId);
  }

  async shutdown(): Promise<void> {
    const active = this.active;
    if (active) {
      this.cancelRun(active.id);
      await active.done;
    }
    await this.mcp.closeAll();
    const granted = new Set(this.tasks.flatMap(task => task.roots.filter(root => root.sandboxGranted).map(root => root.path)));
    for (const path of granted) await this.sandbox?.revoke(path).catch(() => undefined);
  }

  // ---- Run ----

  private async runPrompt(task: TaskState, runId: string, text: string): Promise<void> {
    let unsubscribe: (() => void) | undefined;
    try {
      const profile = this.profile!;
      const mode = task.permission.userMode;
      await this.assertRootsExist(task);
      const rules = await readWorkspaceRules(task.roots, this.rulesPath);
      await this.refreshRoots(task);
      const tools = this.buildTools(task);
      this.ledger.appendEvent(runId, 'run.started', {
        modelId: profile.modelId, permission: task.permission, sandboxStatus: this.sandboxStatus(),
        roots: task.roots.map(({ id, alias, path }) => ({ id, alias, path })),
        toolNames: tools.map(tool => tool.name), ruleSources: rules.sources, userTextPreview: text.slice(0, 200), trigger: 'user',
      });
      if (mode !== 'plan') await this.snapshotRoots(task, runId, 'run_start');
      const agent = new Agent({
        initialState: {
          model: this.createModel(profile),
          messages: task.session.buildSessionContext().messages as AgentMessage[],
          systemPrompt: `${rules.text}\n\n${this.modeStatement(task)}`,
          tools,
        },
        streamFn: (currentModel, context, options) => streamSimple(currentModel as Model<'openai-completions'>, context, {
          ...options,
          apiKey: this.apiKey,
          maxTokens: profile.maxOutputTokens,
          maxRetries: 0,
        }),
        toolExecution: 'sequential',
        beforeToolCall: (context, signal) => this.beforeToolCall(task, runId, context, signal),
      });
      if (this.active?.id === runId) this.active.agent = agent;
      unsubscribe = agent.subscribe(event => this.onAgentEvent(task, runId, event));
      const prompting = agent.prompt(text);
      if (this.active?.cancelRequested) agent.abort();
      await prompting;
      await agent.waitForIdle();
      const lastAssistant = [...agent.state.messages].reverse().find(message => message.role === 'assistant');
      const stopReason = lastAssistant?.role === 'assistant' ? lastAssistant.stopReason : undefined;
      if (this.active?.cancelRequested || stopReason === 'aborted') {
        await this.endRun(task, runId, 'cancelled', 'cancelled');
      } else if (agent.state.errorMessage || stopReason === 'error') {
        await this.endRun(task, runId, 'failed', 'agent_error', createError('MODEL_REQUEST_FAILED', '模型请求失败', agent.state.errorMessage || lastAssistant?.errorMessage, this.apiKey));
      } else if (stopReason === 'length') {
        await this.endRun(task, runId, 'failed', 'agent_error', createError('OUTPUT_LENGTH_LIMIT', '已达到输出长度限制', undefined, this.apiKey));
      } else {
        await this.endRun(task, runId, 'finished', 'passed');
      }
    } catch (error) {
      if (this.active?.cancelRequested) await this.endRun(task, runId, 'cancelled', 'cancelled');
      else if ((error as { appCode?: string }).appCode === 'ROOT_MISSING') await this.endRun(task, runId, 'failed', 'agent_error', { code: 'ROOT_MISSING', message: (error as Error).message });
      else await this.endRun(task, runId, 'failed', 'agent_error', createError('RUN_FAILED', '执行失败', error, this.apiKey));
    } finally {
      unsubscribe?.();
      if (this.active?.id === runId) this.active = undefined;
    }
  }

  private async endRun(task: TaskState, runId: string, phase: Exclude<RunPhase, 'running' | 'awaiting_approval' | 'cancelling'>, stopReason: string, error?: AppError): Promise<void> {
    if (task.permission.userMode !== 'plan') {
      await this.refreshChanges(task, await this.snapshotRoots(task, runId, 'run_end'));
    }
    if (!this.ledger.events(runId).some(event => event.type === 'run.started')) {
      this.ledger.appendEvent(runId, 'run.started', { permission: task.permission, roots: task.roots.map(({ id, alias, path }) => ({ id, alias, path })), trigger: 'user' });
    }
    this.ledger.appendEvent(runId, 'run.ended', { phase, stopReason, error });
    this.ledger.endRun(runId, phase);
    task.run = { ...task.run!, phase };
    if (error) {
      task.error = error;
      this.emit({ type: 'error', value: error });
    }
    this.emitRun(task);
    this.emitSnapshot();
  }

  private async runModelTest(id: string): Promise<{ text: string }> {
    const profile = this.profile!;
    const agent = new Agent({
      initialState: { model: this.createModel(profile), systemPrompt: '请简短使用中文回答。', tools: [] },
      streamFn: (model, context, options) => streamSimple(model as Model<'openai-completions'>, context, {
        ...options,
        apiKey: this.apiKey,
        maxTokens: Math.min(profile.maxOutputTokens, 128),
        maxRetries: 0,
      }),
    });
    if (this.active?.id === id) this.active.agent = agent;
    const timer = setTimeout(() => agent.abort(), 30000);
    const finish = (phase: 'finished' | 'cancelled' | 'failed') => {
      this.testRun = { ...this.testRun!, phase };
      this.emit({ type: 'run.changed', value: this.testRun });
    };
    try {
      const prompting = agent.prompt('请用一句中文回复“连接成功”。');
      if (this.active?.cancelRequested) agent.abort();
      await prompting;
      if (this.active?.cancelRequested) {
        finish('cancelled');
        throw new Error('连接测试已取消');
      }
      const last = agent.state.messages.at(-1);
      if (agent.state.errorMessage || last?.role !== 'assistant' || last.stopReason === 'error' || last.stopReason === 'aborted') {
        throw new Error(agent.state.errorMessage || (last?.role === 'assistant' ? last.errorMessage : undefined) || '模型未返回有效响应');
      }
      finish('finished');
      return { text: last.content.filter(block => block.type === 'text').map(block => block.text).join('') };
    } catch (error) {
      if (this.testRun?.phase === 'running' || this.testRun?.phase === 'cancelling') {
        if (this.active?.cancelRequested) finish('cancelled');
        else {
          finish('failed');
          this.error = createError('MODEL_TEST_FAILED', '连接测试失败', error, this.apiKey);
          this.emit({ type: 'error', value: this.error });
        }
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (this.active?.id === id) this.active = undefined;
    }
  }

  private buildTools(task: TaskState) {
    const mode = task.permission.userMode;
    if (!task.roots.length) return [];
    const trusted = this.trustedMcpNames();
    const mcpTools = this.mcp.tools().filter(tool => registered(mode, classify(tool.name, trusted)));
    return [
      ...createRootTools({
        roots: task.roots,
        fullAccess: mode === 'bypass',
        sandbox: this.sandbox,
        includeEdit: mode !== 'plan',
        includeShell: mode !== 'plan',
        onStarted: (toolCallId, root) => this.markToolRunning(task, toolCallId, root),
        runnerOf: toolCallId => this.runners.get(toolCallId) ?? 'direct',
      }),
      ...mcpTools.map(tool => ({
        ...tool,
        execute: (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any) => {
          this.markToolRunning(task, toolCallId);
          return tool.execute(toolCallId, params, signal, onUpdate);
        },
      })),
    ];
  }

  private trustedMcpNames(): Set<string> {
    return new Set([...this.mcp.bindings].filter(([, binding]) => binding.trustedReadOnly).map(([name]) => name));
  }

  private async beforeToolCall(task: TaskState, runId: string, context: BeforeToolCallContext, signal?: AbortSignal) {
    const name = context.toolCall.name;
    const toolCallId = context.toolCall.id;
    const args = (context.args ?? {}) as Record<string, unknown>;
    const cls = classify(name, this.trustedMcpNames());
    const mode = task.permission.userMode;
    const root = this.rootFor(task, args);
    const binding = this.mcp.bindings.get(name);
    const sandboxReady = this.sandboxReady(task);
    const runner: RunnerKind | undefined = cls === 'shell' ? (mode !== 'bypass' && sandboxReady ? 'sandbox' : 'direct') : undefined;
    if (runner) this.runners.set(toolCallId, runner);
    const grantKey = cls === 'shell' && root ? `shell:${root.id}:${String(args.command)}` : binding ? `mcp:${binding.server}.${binding.tool}` : undefined;
    const record = (decision: string, by: 'policy' | 'user') =>
      this.ledger.appendEvent(runId, 'permission.decided', { toolCallId, decision, by, userMode: mode, runnerKind: runner });

    if (!this.active || this.active.id !== runId) return { block: true, reason: '当前执行已结束' };
    const outcome = verdict(mode, cls, sandboxReady);
    if (outcome === 'allow') {
      record('allow', 'policy');
      return undefined;
    }
    if (outcome === 'block') {
      record('deny', 'policy');
      this.updateTool(task, toolCallId, { state: 'denied' });
      return { block: true, reason: 'Auto 模式只在已验证的沙箱内自动执行命令，当前沙箱不可用或目录未授权，命令未执行。' };
    }
    if (grantKey && task.permission.grants.includes(grantKey)) {
      record('allow_task', 'policy');
      return undefined;
    }

    const argsText = JSON.stringify(args, null, 2);
    const request: ApprovalRequest = {
      id: randomUUID(),
      runId,
      toolCallId,
      tool: name,
      summary: cls === 'shell' ? String(args.command) : binding ? `${binding.server}.${binding.tool}` : String(args.path ?? name),
      rootId: root?.id,
      rootAlias: root?.alias,
      cwd: root?.path,
      argsText: argsText.slice(0, APPROVAL_ARGS_LIMIT),
      grantKey: cls === 'edit' ? undefined : grantKey,
      runner,
    };
    task.run = { ...task.run!, phase: 'awaiting_approval' };
    this.updateTool(task, toolCallId, { state: 'awaiting_approval' });
    this.emitRun(task);
    const pending = this.broker.request(request, signal);
    this.emit({ type: 'approval.requested', value: request });
    this.emitSnapshot();
    const decision = await pending;
    if (task.run?.phase === 'awaiting_approval') task.run = { ...task.run, phase: 'running' };
    this.emitRun(task);
    this.emitSnapshot();
    record(decision, 'user');
    if (decision === 'cancel') {
      this.updateTool(task, toolCallId, { state: 'cancelled' });
      return { block: true, reason: '用户已取消，操作未执行' };
    }
    if (decision === 'deny') {
      this.updateTool(task, toolCallId, { state: 'denied' });
      return { block: true, reason: '用户拒绝执行，操作未运行。请说明原因或采用可行替代。' };
    }
    if (decision === 'allow_task' && grantKey && !task.permission.grants.includes(grantKey)) {
      task.permission = { ...task.permission, grants: [...task.permission.grants, grantKey] };
    }
    return undefined;
  }

  private onAgentEvent(task: TaskState, runId: string, event: AgentEvent): void {
    if (event.type === 'message_end') {
      task.session.appendMessage(event.message as Parameters<SessionManager['appendMessage']>[0]);
      // Provider 没有返回 token 数时不记录。
      if (event.message.role === 'assistant' && event.message.usage?.totalTokens > 0) {
        this.ledger.appendEvent(runId, 'model.usage', { ...event.message.usage });
      }
    }
    if (event.type === 'message_start' && event.message.role === 'assistant') {
      this.assistantId = randomUUID();
      const item: TimelineItem = { kind: 'message', id: this.assistantId, role: 'assistant', text: '' };
      task.timeline.push(item);
      this.emit({ type: 'message.started', id: item.id, role: 'assistant' });
    } else if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta' && this.assistantId) {
      const delta = event.assistantMessageEvent.delta;
      const item = task.timeline.find((value): value is Extract<TimelineItem, { kind: 'message' }> => value.kind === 'message' && value.id === this.assistantId);
      if (item) item.text += delta;
      this.emit({ type: 'message.delta', id: this.assistantId, text: delta });
    } else if (event.type === 'message_end' && event.message.role === 'assistant') {
      const textContent = event.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
      if (this.assistantId) {
        const item = task.timeline.find((value): value is Extract<TimelineItem, { kind: 'message' }> => value.kind === 'message' && value.id === this.assistantId);
        if (item) item.text = textContent;
        this.emit({ type: 'message.ended', id: this.assistantId, text: textContent });
        this.assistantId = undefined;
      }
    } else if (event.type === 'tool_execution_start') {
      const args = (event.args ?? {}) as Record<string, unknown>;
      const root = this.rootFor(task, args);
      const binding = this.mcp.bindings.get(event.toolName);
      const item: ToolItem = {
        kind: 'tool', toolCallId: event.toolCallId, name: event.toolName, args: event.args, state: 'requested', output: '',
        ...(binding ? {} : { rootId: root?.id, rootAlias: root?.alias, cwd: root?.path }),
        source: binding ? { mcpServer: binding.server, tool: binding.tool } : undefined,
      };
      task.timeline.push(item);
      this.emit({ type: 'tool.updated', value: item });
      this.ledger.appendEvent(runId, 'tool.requested', {
        toolCallId: event.toolCallId, name: event.toolName, rootId: item.rootId, cwd: item.cwd,
        argsText: JSON.stringify(event.args).slice(0, ARGS_TEXT_LIMIT),
      });
    } else if (event.type === 'tool_execution_update') {
      this.updateTool(task, event.toolCallId, { state: 'running', output: resultText(event.partialResult) });
    } else if (event.type === 'tool_execution_end') {
      this.finishTool(task, runId, event.toolCallId, event.result, event.isError);
    }
  }

  private finishTool(task: TaskState, runId: string, toolCallId: string, result: unknown, isError: boolean): void {
    const current = task.timeline.find((item): item is ToolItem => item.kind === 'tool' && item.toolCallId === toolCallId);
    const cancelled = this.active?.cancelRequested || current?.state === 'cancelled';
    const denied = current?.state === 'denied';
    const failed = isError || (typeof result === 'object' && result !== null && 'isError' in result && result.isError === true);
    const state = denied ? 'denied' : cancelled ? 'cancelled' : failed ? 'failed' : 'succeeded';
    const exitCode = current?.name === 'powershell' ? exitCodeOf(result) : undefined;
    const started = this.startedAt.get(toolCallId);
    const durationMs = started ? Date.now() - started : undefined;
    const output = resultText(result);
    this.updateTool(task, toolCallId, {
      state, output, exitCode, durationMs,
      error: failed && !denied && !cancelled ? { code: 'TOOL_FAILED', message: '工具执行失败' } : undefined,
    });
    if (failed && !denied && !cancelled && task.run) {
      task.run = { ...task.run, toolErrors: true };
      this.emitRun(task);
    }
    const details = (typeof result === 'object' && result !== null && 'details' in result ? result.details : undefined) as { fullOutputPath?: string; mcp?: unknown } | undefined;
    const structured = current?.source && typeof result === 'object' && result !== null && 'structuredContent' in result ? result.structuredContent : undefined;
    const runner = this.runners.get(toolCallId);
    this.ledger.appendEvent(runId, 'tool.finished', {
      toolCallId, name: current?.name, state, runnerKind: runner,
      sandboxOutcome: runner === 'sandbox' ? 'enforced' : current?.name === 'powershell' ? 'not_sandboxed' : undefined,
      exitCode, durationMs, outputPreview: output.slice(-OUTPUT_PREVIEW_LIMIT), fullOutputPath: details?.fullOutputPath,
      structuredContent: structured, mcp: details?.mcp,
    });
    this.startedAt.delete(toolCallId);
  }

  private markToolRunning(task: TaskState, toolCallId: string, root?: RootView): void {
    const runId = task.run!.id;
    this.startedAt.set(toolCallId, Date.now());
    this.updateTool(task, toolCallId, { state: 'running', runner: this.runners.get(toolCallId) });
    this.ledger.appendEvent(runId, 'tool.started', { toolCallId, rootId: root?.id });
    if (task.run && task.run.phase !== 'cancelling') {
      task.run = { ...task.run, phase: 'running' };
      this.emitRun(task);
    }
  }

  private updateTool(task: TaskState, toolCallId: string, update: Partial<ToolItem>): void {
    const index = task.timeline.findIndex(item => item.kind === 'tool' && item.toolCallId === toolCallId);
    if (index < 0) return;
    const value = { ...task.timeline[index], ...update } as ToolItem;
    task.timeline[index] = value;
    this.emit({ type: 'tool.updated', value });
  }

  // ---- Roots, Git and sandbox ----

  private rootFor(task: TaskState, args: Record<string, unknown>): RootView | undefined {
    if (!task.roots.length) return undefined;
    return typeof args.root === 'string' ? task.roots.find(root => root.alias === args.root) : task.roots.find(root => root.primary);
  }

  private async assertRootsExist(task: TaskState): Promise<void> {
    for (const root of task.roots) {
      const exists = await stat(root.path).then(value => value.isDirectory(), () => false);
      if (!exists) throw Object.assign(new Error(`目录不存在或已移除：${root.path}`), { appCode: 'ROOT_MISSING' });
    }
  }

  private async refreshRoots(task: TaskState): Promise<void> {
    for (const root of task.roots) root.git = await git.detect(root.path);
  }

  private async snapshotRoots(task: TaskState, runId: string, kind: 'run_start' | 'run_end'): Promise<Map<string, string>> {
    const trees = new Map<string, string>();
    for (const root of task.roots) {
      if (!root.git) continue;
      const started = Date.now();
      try {
        const tree = await git.snapshot(root.path);
        this.ledger.appendEvent(runId, 'git.snapshot', { kind, rootId: root.id, tree, head: root.git.head, branch: root.git.branch, durationMs: Date.now() - started });
        if (kind === 'run_start' && !task.baselines.has(root.id)) task.baselines.set(root.id, { tree, commit: root.git.head, branch: root.git.branch });
        trees.set(root.id, tree);
      } catch (error) {
        this.ledger.appendEvent(runId, 'git.snapshot', { kind, rootId: root.id, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started });
      }
    }
    return trees;
  }

  private async refreshChanges(task: TaskState, trees?: Map<string, string>): Promise<void> {
    const roots: RootChanges[] = [];
    for (const root of task.roots) {
      const baseline = task.baselines.get(root.id);
      if (!root.git) {
        roots.push({ rootId: root.id, git: null, reason: '无 Git 仓库，无法生成差异' });
        continue;
      }
      if (!baseline) continue;
      try {
        const nowTree = trees?.get(root.id) ?? await git.snapshot(root.path);
        const files = await git.changes(root.path, baseline.tree, nowTree);
        roots.push({ rootId: root.id, git: { branch: root.git.branch, baseCommit: baseline.commit, baseTree: baseline.tree, nowTree }, files });
      } catch (error) {
        roots.push({ rootId: root.id, git: null, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    task.changes = { taskId: task.id, computedAt: Date.now(), roots };
    this.emit({ type: 'changes.updated', value: task.changes });
  }

  private rootsChanged(task: TaskState): void {
    task.permission = { ...task.permission, grants: [] };
    task.changes = undefined;
    this.emitSnapshot();
  }

  private async grant(root: RootView): Promise<void> {
    if (root.sandboxGranted) return;
    await this.sandbox!.grant(root.path);
    root.sandboxGranted = true;
  }

  private sandboxStatus(): SandboxStatus {
    return this.sandbox?.status ?? 'unavailable';
  }

  private sandboxReady(task: TaskState): boolean {
    return this.sandbox?.status === 'available' && task.roots.length > 0 && task.roots.every(root => root.sandboxGranted);
  }

  // ---- State ----

  private modeStatement(task: TaskState): string {
    const roots = task.roots.map(root => `- ${root.alias}${root.primary ? '（主目录）' : ''}：${root.path}${root.git ? `，Git 分支 ${root.git.branch ?? '未知'}` : '，非 Git'}`).join('\n');
    const mode = { plan: '计划：只读，仅可读取与搜索，不要修改任何文件，给出分步实施计划', manual: '手动：编辑与命令均需用户批准', accept_edits: '接受编辑：范围内文件编辑自动通过，命令需批准', auto: '自动：编辑自动通过，命令仅在沙箱内自动执行', bypass: '绕过权限：不再逐项询问' }[task.permission.userMode];
    return `你是 CodeAgent 中文工作台中的编程助手。只使用显式提供的工具，所有文件路径必须位于下列目录内；工具可用 root 参数选择目录，默认主目录。根据真实工具结果回答，不要声称未执行的验证已经通过。\n工作目录：\n${roots || '（未选择目录）'}\n当前权限模式：${mode}`;
  }

  private createModel(profile: ModelInput): Model<'openai-completions'> {
    return {
      id: profile.modelId,
      name: profile.modelId,
      api: 'openai-completions',
      provider: 'codeagent',
      baseUrl: profile.baseUrl,
      reasoning: false,
      input: ['text'],
      contextWindow: profile.contextWindow,
      maxTokens: profile.maxOutputTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  }

  private createTask(roots: RootView[]): TaskState {
    if (roots.length) roots[0].primary = true;
    const task: TaskState = {
      id: randomUUID(), title: '新任务', updatedAt: Date.now(), roots, permission: permissionFor('manual'),
      session: SessionManager.inMemory(roots[0]?.path), timeline: [], baselines: new Map(),
    };
    this.tasks.push(task);
    this.taskId = task.id;
    return task;
  }

  private ensureTask(): TaskState {
    return this.tasks.find(item => item.id === this.taskId) ?? this.createTask([]);
  }

  private requireTask(): TaskState {
    const task = this.tasks.find(item => item.id === this.taskId);
    if (!task) throw new Error('当前没有任务');
    return task;
  }

  private taskOf(active: ActiveRun): TaskState | undefined {
    return this.tasks.find(item => item.id === active.taskId);
  }

  private assertConfigured(): void {
    if (!this.profile || !this.apiKey) throw new Error('请先保存完整的模型配置和 API Key');
  }

  private assertIdle(): void {
    if (this.active) throw new Error('当前执行尚未结束');
  }

  private emitRun(task?: TaskState): void {
    const run = task?.run ?? this.testRun;
    if (run) this.emit({ type: 'run.changed', value: run });
  }

  private emitSnapshot(): void {
    this.emit({ type: 'snapshot', value: this.snapshot() });
  }

  private snapshot(): WorkbenchSnapshot {
    const task = this.tasks.find(item => item.id === this.taskId);
    const summaries: TaskSummary[] = [...this.tasks].sort((a, b) => b.updatedAt - a.updatedAt).map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
    return structuredClone({
      host: 'ready',
      model: this.profile ? { ...this.profile, hasApiKey: Boolean(this.apiKey) } : undefined,
      models: this.models,
      tasks: summaries,
      taskId: task?.id,
      roots: task?.roots ?? [],
      permission: task?.permission ?? permissionFor('manual'),
      sandboxStatus: this.sandboxStatus(),
      run: this.testRun ?? task?.run,
      timeline: task?.timeline ?? [],
      approval: this.broker.current,
      error: task?.error ?? this.error,
      mcp: this.mcp.statuses(),
      changes: task?.changes,
    });
  }

  private emit(payload: WorkbenchEvent['payload']): void {
    const task = this.tasks.find(item => item.id === this.taskId);
    if (task) task.updatedAt = Date.now();
    this.send({
      hostInstanceId: this.hostInstanceId,
      seq: ++this.seq,
      at: Date.now(),
      runId: this.active?.id,
      payload: structuredClone(payload),
    });
  }
}

function resultText(result: unknown): string {
  if (!result || typeof result !== 'object' || !('content' in result) || !Array.isArray(result.content)) return '';
  return result.content.filter(block => block?.type === 'text').map(block => block.text).join('');
}

function exitCodeOf(result: unknown): number | undefined {
  if (!result || typeof result !== 'object' || !('structuredContent' in result)) return undefined;
  const structured = result.structuredContent;
  if (!structured || typeof structured !== 'object' || !('exit_code' in structured)) return undefined;
  return typeof structured.exit_code === 'number' ? structured.exit_code : undefined;
}

function createError(code: string, message: string, detail: unknown, apiKey?: string): AppError {
  let text = detail instanceof Error ? detail.message : typeof detail === 'string' ? detail : detail ? String(detail) : '';
  if (apiKey) text = text.replaceAll(apiKey, '[已隐藏]');
  if (/\b(401|403)\b/.test(text)) message = '模型认证或访问失败';
  return { code, message, detail: text || undefined };
}
