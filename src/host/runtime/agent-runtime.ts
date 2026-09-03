import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, type AgentEvent, type AgentMessage, type BeforeToolCallContext, type StreamFn } from '@earendil-works/pi-agent-core';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import type { Model } from '@earendil-works/pi-ai';
import { convertToLlm, createLocalPowerShellOperations, SessionManager } from '@earendil-works/pi-coding-agent';
import {

  type Acceptance,
  type AppError,
  type ApprovalDecision,
  type ApprovalRequest,
  type ChangesView,
  type Delivery,
  type DeliveryActionResult,
  type DeliveryView,
  type DetectedCommand,
  type DiffView,
  type McpServerDefinition,
  type ModelInput,
  type ModelProfile,
  type PermissionSetting,
  type RootChanges,
  type RootView,
  type RunEvent,
  type RunPhase,
  type RunView,
  type RunnerKind,
  type SandboxStatus,
  type SnapshotEnvelope,
  type TaskSummary,
  type TimelineItem,
  type ToolItem,
  type UserMode,
  type VerificationItem,
  type VerificationResult,
  type WorkbenchEvent,
  type WorkbenchSnapshot,
} from '../../shared/contracts.js';
import { DEFAULT_MAX_REPAIRS } from '../../shared/constants.js';
import { McpManager } from '../tools/mcp.js';
import { createRootTools } from '../tools/native-tools.js';
import { ApprovalBroker, classify, permissionFor, registered, verdict } from '../tools/permission.js';
import { SandboxRunner } from '../tools/sandbox.js';
import * as delivery from '../workspace/delivery.js';
import * as git from '../workspace/git.js';
import { openRoot, readWorkspaceRules } from '../workspace/workspace.js';
import { compactIfNeeded, type CompactionOutcome } from './compaction.js';
import { Ledger, type TaskRecord } from './ledger.js';
import { recoveryBrief, repairDanglingToolCalls, unknownCalls, type RootRecovery } from './recovery.js';
import { rebuildTimeline } from './timeline.js';
import { detectCommands, failureHash, feedbackMessage, verifyRoots } from './verification.js';

type TaskState = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  roots: RootView[];
  permission: PermissionSetting;
  acceptance: Acceptance;
  delivery: Delivery;
  deliveryView?: DeliveryView;
  /** 非 Git 目录没有树对象，用工具修改次数代替。 */
  mutations: Map<string, number>;
  interrupted: boolean;
  loaded: boolean;
  session: SessionManager;
  timeline: TimelineItem[];
  run?: RunView;
  error?: AppError;
  changes?: ChangesView;
};
type ActiveRun = {
  id: string;
  kind: 'prompt' | 'test';
  taskId?: string;
  agent?: Agent;
  verifyAbort: AbortController;
  cancelRequested: boolean;
  done?: Promise<unknown>;
};
type RunEnd = { phase: 'finished' | 'failed' | 'cancelled'; stopReason: string; error?: AppError };
type RunOptions = { verifyOnly?: boolean; resumed?: boolean };
type SandboxOptions = { exe: string; tempDir: string };

const ARGS_TEXT_LIMIT = 4 * 1024;
const APPROVAL_ARGS_LIMIT = 8 * 1024;
const OUTPUT_PREVIEW_LIMIT = 8 * 1024;
const IMPLEMENT_PLAN_TEXT = '请按照上面的计划开始实施。';
const CONTINUE_TEXT = '请从当前的实际状态继续完成上一次被中断的任务。';

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
  private readonly ledger: Ledger;
  private readonly broker = new ApprovalBroker();
  private readonly mcp: McpManager;
  private readonly sandbox?: SandboxRunner;
  private readonly runners = new Map<string, RunnerKind>();
  private readonly startedAt = new Map<string, number>();

  // 未提供 dataDir 时（Batch 1/2 的运行时测试）账本与会话都只在内存中。
  constructor(
    private readonly hostInstanceId: string,
    private readonly rulesPath: string,
    private readonly send: (event: WorkbenchEvent) => void,
    sandbox?: SandboxOptions,
    private readonly dataDir?: string,
  ) {
    this.ledger = new Ledger(dataDir ? join(dataDir, 'data', 'tasks.sqlite') : ':memory:');
    this.mcp = new McpManager(() => this.emit({ type: 'mcp.updated', value: this.mcp.statuses() }));
    if (sandbox) {
      this.sandbox = new SandboxRunner(sandbox.exe, sandbox.tempDir);
      void this.sandbox.verify().then(status => this.emit({ type: 'sandbox.updated', value: status }));
    }
    this.restoreTasks();
  }

  // 上次异常退出时遗留的授权：新的 Host 不再持有它们，直接撤销。
  async revokeStaleGrants(paths: string[]): Promise<void> {
    for (const path of paths) await this.sandbox?.revoke(path).catch(() => undefined);
  }

  // 重启后核对目录是否仍然存在并刷新 Git 信息。
  async revalidateRoots(): Promise<void> {
    for (const task of this.tasks) {
      for (const root of task.roots) {
        root.missing = !(await stat(root.path).then(value => value.isDirectory(), () => false));
        root.git = root.missing ? undefined : await git.detect(root.path);
      }
    }
    this.emitSnapshot();
    const current = this.tasks.find(item => item.id === this.taskId);
    if (current) await this.restoreViews(current);
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
    const task = this.tasks.find(item => item.id === taskId);
    if (!task) throw new Error('任务不存在');
    this.load(task);
    this.taskId = taskId;
    this.testRun = undefined;
    this.emitSnapshot();
    void this.restoreViews(task);
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
    task.acceptance = { ...task.acceptance, commands: task.acceptance.commands.filter(command => command.rootId !== rootId) };
    if (root.primary && task.roots.length) task.roots[0].primary = true;
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
    task.roots.sort((a, b) => Number(b.primary) - Number(a.primary));
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
    this.save(task);
    this.emitSnapshot();
    return task.permission;
  }

  startMessage(text: string): { runId: string } {
    this.assertConfigured();
    return this.beginRun(text, {});
  }

  async implementPlan(): Promise<{ runId: string }> {
    const task = this.requireTask();
    if (task.permission.userMode !== 'plan' || !task.timeline.some(item => item.kind === 'message' && item.role === 'assistant')) {
      throw new Error('当前没有可实施的计划');
    }
    await this.setPermission('accept_edits');
    return this.startMessage(IMPLEMENT_PLAN_TEXT);
  }

  continueTask(): { runId: string } {
    this.assertConfigured();
    if (!this.requireTask().interrupted) throw new Error('当前任务没有被中断的执行');
    return this.beginRun(CONTINUE_TEXT, {});
  }

  verifyNow(): { runId: string } {
    const task = this.requireTask();
    if (task.permission.userMode === 'plan') throw new Error('计划模式不执行验证命令');
    if (!task.acceptance.commands.length) throw new Error('请先确认验收命令');
    return this.beginRun('手动验证', { verifyOnly: true });
  }

  detectAcceptance(): DetectedCommand[] {
    return this.requireTask().roots.filter(root => !root.missing).flatMap(root => detectCommands(root));
  }

  setAcceptance(acceptance: Acceptance): void {
    this.assertIdle();
    const task = this.requireTask();
    const known = new Set(task.roots.map(root => root.id));
    if (acceptance.commands.some(command => !known.has(command.rootId))) throw new Error('验收命令所属目录不在当前任务中');
    task.acceptance = acceptance;
    this.save(task);
    this.emitSnapshot();
  }

  testModel(): Promise<{ text: string }> {
    this.assertConfigured();
    this.assertIdle();
    const id = randomUUID();
    this.error = undefined;
    this.testRun = { id, taskId: '', phase: 'running', toolErrors: false };
    this.active = { id, kind: 'test', cancelRequested: false, verifyAbort: new AbortController() };
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
    this.active.verifyAbort.abort();
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

  // ---- 交付：报告与用户动作 ----

  async getDelivery(): Promise<DeliveryView> {
    return this.refreshDelivery(this.requireTask());
  }

  async acceptRoot(rootId: string): Promise<void> {
    await this.deliveryAction(rootId, input => delivery.acceptRoot(input, rootId));
  }

  restoreRoot(rootId: string): Promise<DeliveryActionResult> {
    return this.deliveryAction(rootId, input => delivery.restoreRoot(input, rootId));
  }

  commitRoot(rootId: string, message: string, confirmShared: boolean): Promise<DeliveryActionResult> {
    return this.deliveryAction(rootId, input => delivery.commitRoot(input, rootId, message, confirmShared));
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
    this.ledger.close();
  }

  // ---- Run ----

  private beginRun(text: string, options: RunOptions): { runId: string } {
    this.assertIdle();
    const task = this.ensureTask();
    this.load(task);
    const resumed = task.interrupted && !options.verifyOnly ? this.ledger.lastRun(task.id) : undefined;
    const run = this.ledger.startRun(task.id, resumed ? 'recovery' : 'user', resumed?.id);
    this.testRun = undefined;
    this.error = undefined;
    task.error = undefined;
    task.interrupted = false;
    task.run = { id: run.id, taskId: task.id, phase: 'running', toolErrors: false };
    this.active = { id: run.id, kind: 'prompt', taskId: task.id, cancelRequested: false, verifyAbort: new AbortController() };
    if (options.verifyOnly) {
      task.timeline.push({ kind: 'notice', id: randomUUID(), text: '手动验证' });
    } else {
      if (!task.timeline.length) task.title = text.replace(/\s+/g, ' ').slice(0, 32);
      this.pushMessage(task, { text });
    }
    this.save(task);
    this.emitRun(task);
    this.emitSnapshot();
    this.active.done = this.runPrompt(task, run.id, text, { ...options, resumed: Boolean(resumed) }, resumed?.id);
    return { runId: run.id };
  }

  private async runPrompt(task: TaskState, runId: string, text: string, options: RunOptions, resumedFrom?: string): Promise<void> {
    let unsubscribe: (() => void) | undefined;
    try {
      const profile = this.profile;
      const mode = task.permission.userMode;
      await this.assertRootsExist(task);
      const rules = await readWorkspaceRules(task.roots, this.rulesPath);
      await this.refreshRoots(task);
      const tools = this.buildTools(task);
      this.ledger.appendEvent(runId, 'run.started', {
        modelId: profile?.modelId, permission: task.permission, sandboxStatus: this.sandboxStatus(),
        roots: task.roots.map(({ id, alias, path }) => ({ id, alias, path })),
        toolNames: tools.map(tool => tool.name), ruleSources: rules.sources, userTextPreview: text.slice(0, 200),
        trigger: resumedFrom ? 'recovery' : 'user', ...(resumedFrom ? { resumedFrom } : {}),
      });
      const startTrees = mode !== 'plan' ? await this.snapshotRoots(task, runId, 'run_start') : new Map<string, string>();
      const mutationsAtStart = new Map(task.mutations);
      const first = options.verifyOnly ? undefined : await this.firstPrompt(task, text, resumedFrom);
      const buildPrompt = () => `${rules.text}\n\n${this.modeStatement(task)}\n\n${this.stateBlock(task)}`;
      let agent: Agent | undefined;
      if (first) {
        const streamFn = this.streamFn(profile!);
        agent = new Agent({
          initialState: {
            model: this.createModel(profile!),
            messages: task.session.buildSessionContext().messages as AgentMessage[],
            systemPrompt: `${rules.text}

${this.modeStatement(task)}

${this.stateBlock(task)}`,
            tools,
          },
          convertToLlm,
          streamFn,
          toolExecution: 'sequential',
          beforeToolCall: (context, signal) => this.beforeToolCall(task, runId, context, signal),
          prepareRequest: async (request, signal) => {
            // 系统提示是对话记录开头的 system 消息，不在会话里；压缩后需要原样放回。
            const leading = request.context.messages.filter(message => message.role === 'system');
            const outcome = await compactIfNeeded(task.session, request.model, this.apiKey, streamFn, Math.ceil(JSON.stringify(leading).length / 4), signal);
            if (!outcome) return undefined;
            this.recordCompaction(task, runId, outcome);
            return { context: { ...request.context, messages: [...leading, ...task.session.buildSessionContext().messages as AgentMessage[]] } };
          },
        });
        if (this.active?.id === runId) this.active.agent = agent;
        unsubscribe = agent.subscribe(event => this.onAgentEvent(task, runId, event));
      }
      const end = await this.drive(task, runId, agent, first, options, startTrees, mutationsAtStart);
      await this.endRun(task, runId, end.phase, end.stopReason, end.error);
    } catch (error) {
      if (this.active?.cancelRequested) await this.endRun(task, runId, 'cancelled', 'cancelled');
      else if ((error as { appCode?: string }).appCode === 'ROOT_MISSING') await this.endRun(task, runId, 'failed', 'agent_error', { code: 'ROOT_MISSING', message: (error as Error).message });
      else await this.endRun(task, runId, 'failed', 'agent_error', createError('RUN_FAILED', '执行失败', error, this.apiKey));
    } finally {
      unsubscribe?.();
      if (this.active?.id === runId) this.active = undefined;
    }
  }

  // 中断过的 Task 先核对真实状态，并把恢复说明作为单独的标注消息放在用户消息之前。
  private async firstPrompt(task: TaskState, text: string, resumedFrom?: string): Promise<AgentMessage[]> {
    const user = userMessage(text);
    if (!resumedFrom) return [user];
    repairDanglingToolCalls(task.session);
    const brief = await this.buildRecoveryBrief(task, resumedFrom);
    this.pushMessage(task, { text: brief, harness: true, beforeLast: true });
    return [userMessage(brief), user];
  }

  // 提示 -> 验证 -> 修复；预算、无进展、取消、模型错误都会结束循环。
  private async drive(
    task: TaskState, runId: string, agent: Agent | undefined, first: AgentMessage[] | undefined, options: RunOptions,
    startTrees: Map<string, string>, mutationsAtStart: Map<string, number>,
  ): Promise<RunEnd> {
    let input = first;
    let previous: { hash: string; fingerprint: string } | undefined;
    for (let attempt = 0; ; attempt++) {
      if (input) {
        const ended = await this.promptOnce(agent!, input);
        if (ended) return ended;
      }
      if (task.permission.userMode === 'plan') return { phase: 'finished', stopReason: 'passed' };
      const view = await this.refreshDelivery(task);
      const startOf = (rootId: string, git: boolean, now?: string) => startTrees.get(rootId) ?? (git ? now : delivery.treeOfPlainRoot(mutationsAtStart.get(rootId) ?? 0));
      // 恢复的 Run 要接着验证：中断前的修改还没有来得及验证。
      const changed = options.verifyOnly || options.resumed || view.roots.some(root => root.finalTree !== startOf(root.rootId, root.git, root.finalTree));
      const pending = view.roots.filter(root => (root.state === 'unverified' || root.state === 'verification_failed') && this.commandsOf(task, root.rootId).length);
      if (!changed || !pending.length) return { phase: 'finished', stopReason: changed && view.state === 'unverified' ? 'unverified' : 'passed' };

      const results = await this.verify(task, runId, attempt, pending.map(root => ({ root: task.roots.find(item => item.id === root.rootId)!, tree: root.finalTree! })));
      const failed = results.find(result => result.status !== 'passed');
      if (!failed) {
        const after = await this.refreshDelivery(task);
        return { phase: 'finished', stopReason: after.state === 'verified' ? 'passed' : 'unverified' };
      }
      if (failed.status === 'cancelled') return { phase: 'cancelled', stopReason: 'cancelled' };
      if (failed.status === 'unavailable') return { phase: 'finished', stopReason: 'verification_unavailable', error: { code: 'VERIFY_UNAVAILABLE', message: '验证命令未能执行', detail: failed.outputTail } };
      if (options.verifyOnly) return { phase: 'finished', stopReason: 'verification_failed' };
      if (attempt >= task.acceptance.maxRepairs) return { phase: 'finished', stopReason: 'budget_exhausted' };

      const fingerprint = view.roots.map(root => `${root.rootId}:${root.finalTree}`).join('|');
      const hash = failureHash(failed);
      if (previous?.hash === hash && previous.fingerprint === fingerprint) return { phase: 'finished', stopReason: 'no_progress' };
      previous = { hash, fingerprint };

      const alias = task.roots.find(root => root.id === failed.rootId)?.alias ?? failed.rootId;
      const feedback = feedbackMessage(failed, alias, attempt + 1, task.acceptance.maxRepairs);
      this.ledger.appendEvent(runId, 'repair.requested', { attempt: attempt + 1, reason: failed.status, commandId: failed.commandId });
      this.setPhase(task, 'running', attempt + 1);
      this.pushMessage(task, { text: feedback, harness: true });
      input = [userMessage(feedback)];
    }
  }

  private async promptOnce(agent: Agent, input: AgentMessage[]): Promise<RunEnd | undefined> {
    const prompting = agent.prompt(input);
    if (this.active?.cancelRequested) agent.abort();
    await prompting;
    await agent.waitForIdle();
    const lastAssistant = [...agent.state.messages].reverse().find(message => message.role === 'assistant');
    const stopReason = lastAssistant?.role === 'assistant' ? lastAssistant.stopReason : undefined;
    if (this.active?.cancelRequested || stopReason === 'aborted') return { phase: 'cancelled', stopReason: 'cancelled' };
    if (agent.state.errorMessage || stopReason === 'error') {
      return { phase: 'failed', stopReason: 'agent_error', error: createError('MODEL_REQUEST_FAILED', '模型请求失败', agent.state.errorMessage || (lastAssistant?.role === 'assistant' ? lastAssistant.errorMessage : undefined), this.apiKey) };
    }
    if (stopReason === 'length') return { phase: 'failed', stopReason: 'agent_error', error: createError('OUTPUT_LENGTH_LIMIT', '已达到输出长度限制', undefined, this.apiKey) };
    return undefined;
  }

  // 与交互式 Shell 使用同一种运行方式：Auto 只用已验证的沙箱，沙箱失败绝不改用直接运行。
  private async verify(task: TaskState, runId: string, attempt: number, targets: { root: RootView; tree: string }[]): Promise<VerificationResult[]> {
    const mode = task.permission.userMode;
    const sandboxed = mode !== 'bypass' && this.sandboxReady(task);
    const exec = sandboxed
      ? this.sandbox!.operations().exec
      : mode === 'auto'
        ? async () => { throw new Error('Auto 模式需要已验证且已授权的沙箱，验证命令未执行'); }
        : createLocalPowerShellOperations().exec;
    this.setPhase(task, 'verifying', attempt);
    const itemId = (commandId: string) => `${runId}-${attempt}-${commandId}`;
    return verifyRoots(
      {
        evidenceDir: join(this.evidenceRoot(), task.id, runId), attempt, exec, signal: this.active?.verifyAbort.signal,
        onStart: (command, root) => {
          this.ledger.appendEvent(runId, 'verification.started', { attempt, commandId: command.id, label: command.label, command: command.command, rootId: root.id, runnerKind: sandboxed ? 'sandbox' : 'direct' });
          this.upsertVerification(task, { kind: 'verification', id: itemId(command.id), attempt, rootAlias: root.alias, commandLabel: command.label, command: command.command, state: 'running', outputTail: '' });
        },
        onFinish: (result, root) => {
          this.ledger.appendEvent(runId, 'verification.finished', { ...result });
          this.upsertVerification(task, {
            kind: 'verification', id: itemId(result.commandId), attempt, rootAlias: root.alias, commandLabel: result.label, command: result.command,
            state: result.status, exitCode: result.exitCode, durationMs: result.durationMs, outputTail: result.outputTail, logFile: result.logFile,
          });
        },
      },
      targets.map(({ root, tree }) => ({ root, tree, commands: this.commandsOf(task, root.id) })),
    );
  }

  private async endRun(task: TaskState, runId: string, phase: RunEnd['phase'], stopReason: string, error?: AppError): Promise<void> {
    if (!this.ledger.events(runId).some(event => event.type === 'run.started')) {
      this.ledger.appendEvent(runId, 'run.started', { permission: task.permission, roots: task.roots.map(({ id, alias, path }) => ({ id, alias, path })), trigger: 'user' });
    }
    if (task.permission.userMode !== 'plan') {
      const trees = await this.snapshotRoots(task, runId, 'run_end');
      await this.refreshChanges(task, trees);
      await this.finalizeDelivery(task, runId, trees);
    }
    this.ledger.appendEvent(runId, 'run.ended', { phase, stopReason, error });
    this.ledger.endRun(runId, phase, stopReason, this.profile?.modelId);
    task.run = { ...task.run!, phase };
    if (error) {
      task.error = error;
      this.emit({ type: 'error', value: error });
    }
    this.save(task);
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

  private streamFn(profile: ModelInput): StreamFn {
    return (currentModel, context, options) => streamSimple(currentModel as Model<'openai-completions'>, context, {
      ...options,
      apiKey: this.apiKey,
      maxTokens: options?.maxTokens ?? profile.maxOutputTokens,
      maxRetries: 0,
    });
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
      this.save(task);
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
    if (state === 'succeeded' && (current?.name === 'edit' || current?.name === 'write') && current.rootId) {
      task.mutations.set(current.rootId, (task.mutations.get(current.rootId) ?? 0) + 1);
    }
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

  private upsertVerification(task: TaskState, item: VerificationItem): void {
    const index = task.timeline.findIndex(value => value.kind === 'verification' && value.id === item.id);
    if (index < 0) task.timeline.push(item);
    else task.timeline[index] = item;
    this.emit({ type: 'verification.updated', value: item });
  }

  // 用户消息、自动验证反馈、恢复说明都是进入会话的 user 消息；harness 标记它们在界面上折叠显示。
  private pushMessage(task: TaskState, message: { text: string; harness?: boolean; beforeLast?: boolean }): void {
    const item: TimelineItem = { kind: 'message', id: randomUUID(), role: 'user', text: message.text, harness: message.harness || undefined };
    if (message.beforeLast) {
      task.timeline.splice(task.timeline.length - 1, 0, item);
      this.emitSnapshot();
      return;
    }
    task.timeline.push(item);
    this.emit({ type: 'message.started', id: item.id, role: 'user' });
    this.emit({ type: 'message.ended', id: item.id, text: message.text });
  }

  private setPhase(task: TaskState, phase: RunPhase, attempt?: number): void {
    if (!task.run || task.run.phase === 'cancelling') return;
    task.run = { ...task.run, phase, attempt };
    this.emitRun(task);
  }

  // ---- Compaction ----

  private recordCompaction(task: TaskState, runId: string, outcome: CompactionOutcome): void {
    const usage = outcome.usage as { totalTokens?: number } | undefined;
    this.ledger.appendEvent(runId, 'compaction.done', { tokensBefore: outcome.tokensBefore, tokensAfter: outcome.tokensAfter, firstKeptEntryId: outcome.firstKeptEntryId, usage });
    if (usage?.totalTokens) this.ledger.appendEvent(runId, 'model.usage', { ...usage, purpose: 'compaction' });
    task.timeline.push({ kind: 'notice', id: randomUUID(), text: '较早的对话已压缩为摘要' });
    this.emitSnapshot();
  }

  // 每个 Run 的系统提示末尾的状态块：压缩无法丢弃这些事实。
  private stateBlock(task: TaskState): string {
    const lines = ['## 任务状态（由系统生成）'];
    const commands = task.acceptance.commands.map(command => `- ${task.roots.find(root => root.id === command.rootId)?.alias ?? command.rootId}：${command.command}`);
    lines.push(commands.length ? `验收命令（用户已确认，不得修改）：\n${commands.join('\n')}` : '验收命令：未设置');
    for (const entry of task.deliveryView?.roots ?? []) {
      const last = entry.verification.map(result => `${result.label}${result.status === 'passed' ? '通过' : `未通过（退出码 ${result.exitCode ?? '无'}）`}`).join('、');
      lines.push(`目录 ${entry.alias}：交付状态 ${entry.state}${last ? `；当前代码上的验证：${last}` : ''}`);
      if (entry.files.length) lines.push(`  自任务起点以来变更的文件：${entry.files.slice(0, 50).map(file => `${file.status} ${file.path}`).join('；')}${entry.files.length > 50 ? ` 等共 ${entry.files.length} 个` : ''}`);
    }
    return lines.join('\n');
  }

  // ---- Roots, Git, delivery and sandbox ----

  private rootFor(task: TaskState, args: Record<string, unknown>): RootView | undefined {
    if (!task.roots.length) return undefined;
    return typeof args.root === 'string' ? task.roots.find(root => root.alias === args.root) : task.roots.find(root => root.primary);
  }

  private commandsOf(task: TaskState, rootId: string) {
    return task.acceptance.commands.filter(command => command.rootId === rootId);
  }

  private async assertRootsExist(task: TaskState): Promise<void> {
    for (const root of task.roots) {
      const exists = await stat(root.path).then(value => value.isDirectory(), () => false);
      if (!exists) throw Object.assign(new Error(`目录不存在或已移除：${root.path}`), { appCode: 'ROOT_MISSING' });
    }
  }

  private async refreshRoots(task: TaskState): Promise<void> {
    for (const root of task.roots) {
      root.missing = false;
      root.git = await git.detect(root.path);
    }
  }

  private async snapshotRoots(task: TaskState, runId: string, kind: 'run_start' | 'run_end'): Promise<Map<string, string>> {
    const trees = new Map<string, string>();
    for (const root of task.roots) {
      if (!root.git) continue;
      const started = Date.now();
      try {
        const tree = await git.snapshot(root.path);
        this.ledger.appendEvent(runId, 'git.snapshot', { kind, rootId: root.id, tree, head: root.git.head, branch: root.git.branch, durationMs: Date.now() - started });
        if (kind === 'run_start' && !this.baselineOf(task, root.id)) {
          this.ledger.saveDelivery({ taskId: task.id, rootId: root.id, state: 'none', baseTree: tree, baseCommit: root.git.head });
        }
        trees.set(root.id, tree);
      } catch (error) {
        this.ledger.appendEvent(runId, 'git.snapshot', { kind, rootId: root.id, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started });
      }
    }
    return trees;
  }

  private baselineOf(task: TaskState, rootId: string) {
    const row = this.ledger.deliveryRows(task.id).find(item => item.rootId === rootId);
    return row?.baseTree ? { tree: row.baseTree, commit: row.baseCommit } : undefined;
  }

  private async refreshChanges(task: TaskState, trees?: Map<string, string>): Promise<void> {
    const roots: RootChanges[] = [];
    for (const root of task.roots) {
      const baseline = this.baselineOf(task, root.id);
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

  private deliveryInput(task: TaskState): delivery.DeliveryInput {
    const verifications = this.ledger.taskEvents(task.id, 'verification.finished').map(event => event.data as unknown as VerificationResult);
    return { taskId: task.id, roots: task.roots.filter(root => !root.missing), ledger: this.ledger, acceptance: task.acceptance, verifications, mutations: task.mutations };
  }

  // 只读刷新：计算当前交付视图（含验证是否仍然有效），不改动数据库中的交付行。
  private async refreshDelivery(task: TaskState, trees?: Map<string, string>): Promise<DeliveryView> {
    const view = await delivery.buildDelivery(this.deliveryInput(task), trees);
    task.deliveryView = view;
    task.delivery = view.state;
    this.emit({ type: 'delivery.updated', value: view });
    return view;
  }

  // 结束阶段的记账失败（例如目录已被删除）不能让 Run 卡在运行中，只记录原因。
  private async finalizeDelivery(task: TaskState, runId: string, trees: Map<string, string>): Promise<void> {
    try {
      const view = await delivery.persistDelivery(this.deliveryInput(task), await this.refreshDelivery(task, trees), this.evidenceRoot());
      this.ledger.appendEvent(runId, 'delivery.changed', { state: view.state, roots: view.roots.map(root => ({ rootId: root.rootId, state: root.state, reportFile: root.reportFile })) });
    } catch (error) {
      this.ledger.appendEvent(runId, 'delivery.changed', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private evidenceRoot(): string {
    return join(this.dataDir ?? join(tmpdir(), 'codeagent-evidence'), 'evidence');
  }

  private async deliveryAction<T>(rootId: string, action: (input: delivery.DeliveryInput) => Promise<T>): Promise<T> {
    this.assertIdle();
    const task = this.requireTask();
    const result = await action(this.deliveryInput(task));
    await this.refreshDelivery(task);
    const last = this.ledger.lastRun(task.id);
    if (last) this.ledger.appendEvent(last.id, 'delivery.changed', { rootId, state: task.deliveryView?.roots.find(root => root.rootId === rootId)?.state, action: true });
    this.save(task);
    this.emitSnapshot();
    return result;
  }

  private rootsChanged(task: TaskState): void {
    task.permission = { ...task.permission, grants: [] };
    task.changes = undefined;
    task.deliveryView = undefined;
    this.save(task);
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

  // 重启或切换任务后，变更与交付状态要重新按当前真实的 Git 状态计算；失败（例如目录已被删除）时保持原样。
  private async restoreViews(task: TaskState): Promise<void> {
    if (task.permission.userMode === 'plan' || task.roots.every(root => root.missing)) return;
    try {
      await this.refreshChanges(task);
      await this.refreshDelivery(task);
      this.emitSnapshot();
    } catch {
      // 保持原有视图
    }
  }

  // ---- Recovery ----

  // 以真实的 Git/工作区状态为准，列出变更与结果未知的调用；不重放任何东西。
  private async buildRecoveryBrief(task: TaskState, interruptedRunId: string): Promise<string> {
    const events = this.ledger.events(interruptedRunId);
    const roots: RootRecovery[] = [];
    for (const root of task.roots) {
      const exists = await stat(root.path).then(value => value.isDirectory(), () => false);
      if (!exists || !root.git) {
        roots.push({ alias: root.alias, sinceRun: [], sinceBaseline: [], missing: !exists });
        continue;
      }
      const now = await git.snapshot(root.path);
      const start = events.find(event => event.type === 'git.snapshot' && event.data.kind === 'run_start' && event.data.rootId === root.id)?.data.tree as string | undefined;
      const base = this.baselineOf(task, root.id)?.tree;
      roots.push({
        alias: root.alias,
        sinceRun: start ? await git.changes(root.path, start, now) : [],
        sinceBaseline: base ? await git.changes(root.path, base, now) : [],
      });
    }
    const calls = unknownCalls(events, rootId => task.roots.find(root => root.id === rootId)?.alias);
    const last = this.ledger.taskEvents(task.id, 'verification.finished').at(-1)?.data as unknown as VerificationResult | undefined;
    const lastText = last ? `${task.roots.find(root => root.id === last.rootId)?.alias ?? last.rootId} ${last.label}：${last.status === 'passed' ? '通过' : `未通过（退出码 ${last.exitCode ?? '无'}）`}` : undefined;
    return recoveryBrief(roots, calls, lastText);
  }

  // ---- 持久化与状态 ----

  private restoreTasks(): void {
    this.ledger.interruptOpenRuns();
    for (const record of this.ledger.listTasks()) this.tasks.push(this.taskFromRecord(record));
    this.taskId = this.tasks[0]?.id;
    if (this.tasks[0]) this.load(this.tasks[0]);
  }

  private taskFromRecord(record: TaskRecord): TaskState {
    const mutations = new Map<string, number>();
    for (const row of this.ledger.deliveryRows(record.id)) if (row.finalTree?.startsWith('mut:')) mutations.set(row.rootId, Number(row.finalTree.slice(4)));
    const last = this.ledger.lastRun(record.id);
    return {
      id: record.id, title: record.title, createdAt: record.createdAt, updatedAt: record.updatedAt,
      roots: record.roots.map((root, index) => ({ id: root.id, alias: root.alias, path: root.path, primary: index === 0, sandboxGranted: false })),
      permission: permissionFor(record.userMode, record.grants), acceptance: record.acceptance, delivery: record.delivery, mutations,
      interrupted: last?.phase === 'interrupted', loaded: false, session: undefined as never, timeline: [],
      run: last && { id: last.id, taskId: record.id, phase: last.phase, toolErrors: false },
    };
  }

  // 会话与时间线在第一次使用时才读入。
  private load(task: TaskState): void {
    if (task.loaded) return;
    task.session = this.openSession(task);
    const events = this.ledger.taskEvents(task.id, 'tool.requested', 'tool.finished', 'verification.finished');
    task.timeline = rebuildTimeline(task.session, events, task.roots);
    task.loaded = true;
  }

  private openSession(task: TaskState): SessionManager {
    const cwd = task.roots[0]?.path ?? process.cwd();
    if (!this.dataDir) return SessionManager.inMemory(cwd);
    // 会话文件名以时间戳开头；目录可能是在添加目录之前创建的，所以不按 cwd 匹配，直接打开最新的文件。
    const directory = join(this.dataDir, 'sessions', task.id);
    const latest = existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith('.jsonl')).sort().at(-1) : undefined;
    return latest ? SessionManager.open(join(directory, latest), directory) : SessionManager.create(cwd, directory);
  }

  private save(task: TaskState): void {
    task.updatedAt = Date.now();
    this.ledger.saveTask({
      id: task.id, title: task.title, createdAt: task.createdAt, updatedAt: task.updatedAt, userMode: task.permission.userMode,
      grants: task.permission.grants, acceptance: task.acceptance, delivery: task.delivery,
      roots: task.roots.map(root => ({ id: root.id, alias: root.alias, path: root.path, gitRoot: root.git?.gitRoot })),
    }, task.session?.getSessionFile());
  }

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
      id: randomUUID(), title: '新任务', createdAt: Date.now(), updatedAt: Date.now(), roots, permission: permissionFor('manual'),
      acceptance: { commands: [], maxRepairs: DEFAULT_MAX_REPAIRS }, delivery: 'none', mutations: new Map(), interrupted: false, loaded: true,
      session: undefined as never, timeline: [],
    };
    task.session = this.openSession(task);
    this.tasks.push(task);
    this.taskId = task.id;
    this.save(task);
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
    const summaries: TaskSummary[] = [...this.tasks].sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ id, title, updatedAt, delivery: state, interrupted }) => ({ id, title, updatedAt, delivery: state, interrupted }));
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
      acceptance: task?.acceptance ?? { commands: [], maxRepairs: DEFAULT_MAX_REPAIRS },
      delivery: task?.deliveryView,
    });
  }

  private emit(payload: WorkbenchEvent['payload']): void {
    this.send({
      hostInstanceId: this.hostInstanceId,
      seq: ++this.seq,
      at: Date.now(),
      runId: this.active?.id,
      payload: structuredClone(payload),
    });
  }
}

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() };
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
