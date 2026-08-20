import { randomUUID } from 'node:crypto';
import { Agent, type AgentMessage, type BeforeToolCallContext } from '@earendil-works/pi-agent-core';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import type { Model } from '@earendil-works/pi-ai';
import type {
  AppError,
  ApprovalRequest,
  InvocationView,
  ModelInput,
  ModelProfile,
  SnapshotEnvelope,
  TimelineItem,
  WorkbenchEvent,
  WorkbenchSnapshot,
  WorkspaceRoot,
} from '../../shared/contracts.js';
import { createNativeTools } from '../tools/native-tools.js';
import { readWorkspaceRules } from '../workspace/workspace.js';

type ActiveRun = {
  id: string;
  kind: 'prompt' | 'test';
  agent?: Agent;
  cancelRequested: boolean;
  done?: Promise<unknown>;
};

type PendingApproval = {
  request: ApprovalRequest;
  settle: (decision: 'allow' | 'deny' | 'cancel') => void;
};

type ToolItem = Extract<TimelineItem, { kind: 'tool' }>;

export class AgentRuntime {
  private profile?: ModelInput;
  private apiKey?: string;
  private root?: WorkspaceRoot;
  private agent?: Agent;
  private unsubscribe?: () => void;
  private timeline: TimelineItem[] = [];
  private invocation?: InvocationView;
  private approval?: PendingApproval;
  private error?: AppError;
  private active?: ActiveRun;
  private assistantId?: string;
  private seq = 0;

  constructor(
    private readonly hostInstanceId: string,
    private readonly rulesPath: string,
    private readonly send: (event: WorkbenchEvent) => void,
  ) {}

  getSnapshot(): SnapshotEnvelope {
    return { hostInstanceId: this.hostInstanceId, seq: this.seq, value: this.snapshot() };
  }

  setModel(profile: ModelInput, apiKey?: string): ModelProfile {
    this.assertIdle();
    this.profile = profile;
    this.apiKey = apiKey;
    this.clearConversation();
    this.emitSnapshot();
    return { ...profile, hasApiKey: Boolean(apiKey) };
  }

  setWorkspace(root: WorkspaceRoot): WorkspaceRoot {
    this.assertIdle();
    this.root = root;
    this.clearConversation();
    this.emitSnapshot();
    return root;
  }

  clearWorkspace(): void {
    this.assertIdle();
    this.root = undefined;
    this.clearConversation();
    this.emitSnapshot();
  }

  startMessage(text: string): { invocationId: string } {
    this.assertConfigured();
    this.assertIdle();
    const id = randomUUID();
    this.error = undefined;
    this.invocation = { id, phase: 'running', toolErrors: false };
    this.active = { id, kind: 'prompt', cancelRequested: false };
    const item: TimelineItem = { kind: 'message', id: randomUUID(), role: 'user', text };
    this.timeline.push(item);
    this.emit({ type: 'message.started', id: item.id, role: 'user' });
    this.emit({ type: 'message.ended', id: item.id, text });
    this.emitInvocation();
    const run = this.runPrompt(id, text);
    this.active.done = run;
    return { invocationId: id };
  }

  testModel(): Promise<{ text: string }> {
    this.assertConfigured();
    this.assertIdle();
    const id = randomUUID();
    this.error = undefined;
    this.invocation = { id, phase: 'running', toolErrors: false };
    this.active = { id, kind: 'test', cancelRequested: false };
    this.emitInvocation();
    const run = this.runModelTest(id);
    this.active.done = run;
    return run;
  }

  cancelInvocation(invocationId: string): void {
    if (!this.active || this.active.id !== invocationId) throw new Error('当前执行已结束');
    this.active.cancelRequested = true;
    this.invocation = { ...this.invocation!, phase: 'cancelling' };
    this.emitInvocation();
    this.active.agent?.abort();
  }

  decideApproval(approvalId: string, decision: 'allow' | 'deny'): void {
    if (!this.approval || this.approval.request.id !== approvalId) throw new Error('审批已结束');
    const pending = this.approval;
    this.approval = undefined;
    if (decision === 'deny') this.updateTool(pending.request.toolCallId, { state: 'denied' });
    if (this.invocation && this.invocation.phase === 'awaiting_approval') {
      this.invocation = { ...this.invocation, phase: 'running' };
      this.emitInvocation();
    }
    this.emitSnapshot();
    pending.settle(decision);
  }

  newConversation(): void {
    this.assertIdle();
    this.clearConversation();
    this.emitSnapshot();
  }

  async shutdown(): Promise<void> {
    const active = this.active;
    if (active) {
      this.cancelInvocation(active.id);
      await active.done;
    }
    this.unsubscribe?.();
  }

  private async runPrompt(id: string, text: string): Promise<void> {
    try {
      const profile = this.profile!;
      const model = this.createModel(profile);
      const previous = this.agent?.state.messages.filter(message => message.role !== 'system') ?? [];
      this.unsubscribe?.();
      const tools = this.root ? createNativeTools(this.root.path, toolCallId => this.markToolRunning(toolCallId)) : [];
      const systemPrompt = await readWorkspaceRules(this.root, this.rulesPath);
      const agent = new Agent({
        initialState: {
          model,
          messages: previous,
          systemPrompt: `${systemPrompt}\n\n你是 CodeAgent 中文工作台中的编程助手。只使用显式提供的工具；读取限定在当前项目目录。PowerShell 每次都需要用户批准。根据真实工具结果回答，不要声称未执行的验证已经通过。`,
          tools,
        },
        streamFn: (currentModel, context, options) => streamSimple(currentModel as Model<'openai-completions'>, context, {
          ...options,
          apiKey: this.apiKey,
          maxTokens: profile.maxOutputTokens,
          maxRetries: 0,
        }),
        toolExecution: 'sequential',
        beforeToolCall: (context, signal) => this.beforeToolCall(context, signal),
      });
      this.agent = agent;
      if (this.active?.id === id) this.active.agent = agent;
      this.unsubscribe = agent.subscribe(event => {
        if (event.type === 'message_start' && event.message.role === 'assistant') {
          this.assistantId = randomUUID();
          const item: TimelineItem = { kind: 'message', id: this.assistantId, role: 'assistant', text: '' };
          this.timeline.push(item);
          this.emit({ type: 'message.started', id: item.id, role: 'assistant' });
        } else if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta' && this.assistantId) {
          const delta = event.assistantMessageEvent.delta;
          const item = this.timeline.find((value): value is Extract<TimelineItem, { kind: 'message' }> => value.kind === 'message' && value.id === this.assistantId);
          if (item) item.text += delta;
          this.emit({ type: 'message.delta', id: this.assistantId, text: delta });
        } else if (event.type === 'message_end' && event.message.role === 'assistant') {
          const textContent = event.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
          if (this.assistantId) {
            const item = this.timeline.find((value): value is Extract<TimelineItem, { kind: 'message' }> => value.kind === 'message' && value.id === this.assistantId);
            if (item) item.text = textContent;
            this.emit({ type: 'message.ended', id: this.assistantId, text: textContent });
            this.assistantId = undefined;
          }
        } else if (event.type === 'tool_execution_start') {
          const item: ToolItem = {
            kind: 'tool',
            toolCallId: event.toolCallId,
            name: event.toolName,
            cwd: event.toolName === 'powershell' ? this.root?.path : undefined,
            args: event.args,
            state: 'requested',
            output: '',
          };
          this.timeline.push(item);
          this.emit({ type: 'tool.updated', value: item });
        } else if (event.type === 'tool_execution_update') {
          this.updateTool(event.toolCallId, { state: 'running', output: resultText(event.partialResult) });
        } else if (event.type === 'tool_execution_end') {
          const current = this.findTool(event.toolCallId);
          const cancelled = this.active?.cancelRequested || current?.state === 'cancelled';
          const denied = current?.state === 'denied';
          const state = denied ? 'denied' : cancelled ? 'cancelled' : event.isError ? 'failed' : 'succeeded';
          const exitCode = exitCodeOf(event.result);
          this.updateTool(event.toolCallId, {
            state,
            output: resultText(event.result),
            exitCode,
            error: event.isError && !denied && !cancelled ? { code: 'TOOL_FAILED', message: '工具执行失败' } : undefined,
          });
          if (event.isError && !denied && !cancelled && this.invocation) {
            this.invocation = { ...this.invocation, toolErrors: true };
            this.emitInvocation();
          }
        }
      });
      const prompting = agent.prompt(text);
      if (this.active?.cancelRequested) agent.abort();
      await prompting;
      await agent.waitForIdle();
      if (!this.active || this.active.id !== id) return;
      const lastAssistant = [...agent.state.messages].reverse().find(message => message.role === 'assistant');
      const stopReason = lastAssistant?.role === 'assistant' ? lastAssistant.stopReason : undefined;
      if (this.active.cancelRequested || stopReason === 'aborted') {
        this.settleInvocation('cancelled');
      } else if (agent.state.errorMessage || stopReason === 'error') {
        this.failInvocation('MODEL_REQUEST_FAILED', '模型请求失败', agent.state.errorMessage || lastAssistant?.errorMessage);
      } else if (stopReason === 'length') {
        this.failInvocation('OUTPUT_LENGTH_LIMIT', '已达到输出长度限制');
      } else {
        this.settleInvocation('finished');
      }
    } catch (error) {
      if (this.active?.id === id) {
        if (this.active.cancelRequested) this.settleInvocation('cancelled');
        else this.failInvocation('INVOCATION_FAILED', '执行失败', error);
      }
    } finally {
      if (this.active?.id === id) this.active = undefined;
    }
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
    try {
      const prompting = agent.prompt('请用一句中文回复“连接成功”。');
      if (this.active?.cancelRequested) agent.abort();
      await prompting;
      if (this.active?.cancelRequested) {
        this.settleInvocation('cancelled');
        throw new Error('连接测试已取消');
      }
      const last = agent.state.messages.at(-1);
      if (agent.state.errorMessage || last?.role !== 'assistant' || last.stopReason === 'error' || last.stopReason === 'aborted') {
        throw new Error(agent.state.errorMessage || (last?.role === 'assistant' ? last.errorMessage : undefined) || '模型未返回有效响应');
      }
      const text = last.content.filter(block => block.type === 'text').map(block => block.text).join('');
      this.settleInvocation('finished');
      return { text };
    } catch (error) {
      if (this.active?.cancelRequested) this.settleInvocation('cancelled');
      else this.failInvocation('MODEL_TEST_FAILED', '连接测试失败', error);
      throw error;
    } finally {
      clearTimeout(timer);
      if (this.active?.id === id) this.active = undefined;
    }
  }

  private async beforeToolCall(context: BeforeToolCallContext, signal?: AbortSignal) {
    if (context.toolCall.name !== 'powershell') return undefined;
    if (!this.active || !this.root || !this.invocation) return { block: true, reason: '当前执行已结束' };
    const args = context.args as { command: string };
    const request: ApprovalRequest = {
      id: randomUUID(),
      invocationId: this.active.id,
      toolCallId: context.toolCall.id,
      command: args.command,
      cwd: this.root.path,
    };
    this.invocation = { ...this.invocation, phase: 'awaiting_approval' };
    this.updateTool(request.toolCallId, { state: 'awaiting_approval' });
    this.emitInvocation();
    const decision = await new Promise<'allow' | 'deny' | 'cancel'>(resolve => {
      let settled = false;
      const settle = (value: 'allow' | 'deny' | 'cancel') => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = () => settle('cancel');
      signal?.addEventListener('abort', onAbort, { once: true });
      this.approval = { request, settle };
      this.emit({ type: 'approval.requested', value: request });
    });
    this.approval = undefined;
    this.emitSnapshot();
    if (decision === 'cancel') {
      this.updateTool(request.toolCallId, { state: 'cancelled' });
      return { block: true, reason: '用户已取消，命令未执行' };
    }
    if (decision === 'deny') {
      return { block: true, reason: '用户拒绝执行，命令未运行。请说明原因或采用可行替代。' };
    }
    return undefined;
  }

  private markToolRunning(toolCallId: string): void {
    this.updateTool(toolCallId, { state: 'running' });
    if (this.invocation && this.invocation.phase !== 'cancelling') {
      this.invocation = { ...this.invocation, phase: 'running' };
      this.emitInvocation();
    }
  }

  private updateTool(toolCallId: string, update: Partial<ToolItem>): void {
    const index = this.timeline.findIndex(item => item.kind === 'tool' && item.toolCallId === toolCallId);
    if (index < 0) return;
    const value = { ...this.timeline[index], ...update } as ToolItem;
    this.timeline[index] = value;
    this.emit({ type: 'tool.updated', value });
  }

  private findTool(toolCallId: string): ToolItem | undefined {
    return this.timeline.find((item): item is ToolItem => item.kind === 'tool' && item.toolCallId === toolCallId);
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

  private assertConfigured(): void {
    if (!this.profile || !this.apiKey) throw new Error('请先保存完整的模型配置和 API Key');
  }

  private assertIdle(): void {
    if (this.active) throw new Error('当前执行尚未结束');
  }

  private clearConversation(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.agent = undefined;
    this.timeline = [];
    this.invocation = undefined;
    this.approval = undefined;
    this.error = undefined;
    this.assistantId = undefined;
  }

  private settleInvocation(phase: 'finished' | 'cancelled'): void {
    if (!this.invocation) return;
    this.invocation = { ...this.invocation, phase };
    this.emitInvocation();
  }

  private failInvocation(code: string, message: string, detail?: unknown): void {
    const error = createError(code, message, detail, this.apiKey);
    this.error = error;
    if (this.invocation) this.invocation = { ...this.invocation, phase: 'failed' };
    this.emit({ type: 'error', value: error });
    this.emitInvocation();
  }

  private emitInvocation(): void {
    if (this.invocation) this.emit({ type: 'invocation.changed', value: this.invocation });
  }

  private emitSnapshot(): void {
    this.emit({ type: 'snapshot', value: this.snapshot() });
  }

  private snapshot(): WorkbenchSnapshot {
    return structuredClone({
      host: 'ready',
      model: this.profile ? { ...this.profile, hasApiKey: Boolean(this.apiKey) } : undefined,
      root: this.root,
      invocation: this.invocation,
      timeline: this.timeline,
      approval: this.approval?.request,
      error: this.error,
    });
  }

  private emit(payload: WorkbenchEvent['payload']): void {
    this.send({
      hostInstanceId: this.hostInstanceId,
      seq: ++this.seq,
      at: Date.now(),
      invocationId: this.invocation?.id,
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
