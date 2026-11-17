import { randomUUID } from 'node:crypto';
import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import type { Model } from '@earendil-works/pi-ai';
import type { ModelInput } from '../../shared/contracts/index.js';
import { createAgent, type KernelAgent } from '../kernel/index.js';
import { createError, type RunEnd, type TaskState, type Workbench } from './workbench.js';

type PromptEnd = RunEnd & { retry?: 'transient' | 'length' };

// 一次尝试内的模型请求恢复预算：瞬时错误按退避重试，length 停止压缩后重试一次；用尽后照常以错误结束 Run。
export const MODEL_RETRY = { transientDelaysMs: [2000, 8000, 20000], lengthRetries: 1 };
const TRANSIENT = /\b(?:408|409|425|429|500|502|503|504|529)\b|rate.?limit|overloaded|too busy|temporarily unavailable|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|fetch failed|network error|terminated/i;

/** 模型对象与请求函数、连接测试，以及单次模型请求失败后的重试。 */
export class ModelService {
  constructor(private readonly wb: Workbench) {}

  testModel(): Promise<{ text: string }> {
    this.wb.assertConfigured();
    this.wb.assertIdle();
    const id = randomUUID();
    this.wb.error = undefined;
    this.wb.testRun = { id, taskId: '', phase: 'running', toolErrors: false };
    this.wb.active = { id, kind: 'test', cancelRequested: false, verifyAbort: new AbortController() };
    this.wb.emit({ type: 'run.changed', value: this.wb.testRun });
    const done = this.runModelTest(id);
    this.wb.active.done = done;
    return done;
  }

  private async runModelTest(id: string): Promise<{ text: string }> {
    const profile = this.wb.profile!;
    const agent = createAgent(this.wb.kernel, {
      initialState: { model: this.createModel(profile), systemPrompt: '请简短使用中文回答。', tools: [] },
      scheduling: { parallel: false, maxParallel: 1, isReadOnly: () => false },
      streamFn: (model, context, options) => streamSimple(model as Model<'openai-completions'>, context, {
        ...options,
        apiKey: this.wb.apiKey,
        maxTokens: Math.min(profile.maxOutputTokens, 128),
        maxRetries: 0,
      }),
    });
    if (this.wb.active?.id === id) this.wb.active.agent = agent;
    const timer = setTimeout(() => agent.abort(), 30000);
    const finish = (phase: 'finished' | 'cancelled' | 'failed') => {
      this.wb.testRun = { ...this.wb.testRun!, phase };
      this.wb.emit({ type: 'run.changed', value: this.wb.testRun });
    };
    try {
      const prompting = agent.prompt('请用一句中文回复“连接成功”。');
      if (this.wb.active?.cancelRequested) agent.abort();
      await prompting;
      if (this.wb.active?.cancelRequested) {
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
      if (this.wb.testRun?.phase === 'running' || this.wb.testRun?.phase === 'cancelling') {
        if (this.wb.active?.cancelRequested) finish('cancelled');
        else {
          finish('failed');
          this.wb.error = createError('MODEL_TEST_FAILED', '连接测试失败', error, this.wb.apiKey);
          this.wb.emit({ type: 'error', value: this.wb.error });
        }
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (this.wb.active?.id === id) this.wb.active = undefined;
    }
  }

  streamFn(profile: ModelInput): StreamFn {
    return (currentModel, context, options) => streamSimple(currentModel as Model<'openai-completions'>, context, {
      ...options,
      apiKey: this.wb.apiKey,
      maxTokens: options?.maxTokens ?? profile.maxOutputTokens,
      maxRetries: 0,
      // 思考强度随等级透传；端点不支持该参数时会以模型错误呈现，不伪装成已生效。
      ...(profile.reasoning ? { reasoning: profile.reasoning } : {}),
    });
  }

  createModel(profile: ModelInput): Model<'openai-completions'> {
    return {
      id: profile.modelId,
      name: profile.modelId,
      api: 'openai-completions',
      provider: 'codeagent',
      baseUrl: profile.baseUrl,
      // pi-ai 按这个开关决定是否携带思考参数；实际等级在 streamFn 里随请求发送。
      reasoning: profile.reasoning !== false,
      input: profile.vision ? ['text', 'image'] : ['text'],
      contextWindow: profile.contextWindow,
      maxTokens: profile.maxOutputTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  }

  // 只重发失败的那一次模型请求：失败的 assistant 消息从 Agent 状态与会话中移除，然后从原有记录继续，
  // 已完成的工具调用不会重放；取消随时生效，重试用尽后返回原来的错误。
  async promptWithRecovery(task: TaskState, runId: string, agent: KernelAgent, input: AgentMessage[]): Promise<RunEnd | undefined> {
    let ended = await this.promptOnce(agent, () => agent.prompt(input));
    const used = { transient: 0, length: 0 };
    while (ended?.retry) {
      const kind = ended.retry;
      const budget = kind === 'transient' ? MODEL_RETRY.transientDelaysMs.length : MODEL_RETRY.lengthRetries;
      if (used[kind] >= budget) {
        const { retry: _retry, ...terminal } = ended;
        this.wb.ledger.appendEvent(runId, 'model.retry', { kind, attempt: used[kind], exhausted: true, error: terminal.error });
        return kind === 'transient' ? { ...terminal, error: { ...terminal.error!, message: `模型服务持续不可用（已重试 ${used[kind]} 次）` } } : terminal;
      }
      used[kind]++;
      const delayMs = kind === 'transient' ? MODEL_RETRY.transientDelaysMs[used[kind] - 1] : 0;
      this.dropFailedAssistant(task, agent);
      this.wb.ledger.appendEvent(runId, 'model.retry', { kind, attempt: used[kind], delayMs, error: ended.error });
      task.timeline.push({ kind: 'notice', id: randomUUID(), text: kind === 'transient' ? `模型服务暂时不可用，${Math.round(delayMs / 1000)} 秒后重试（第 ${used[kind]} 次）` : '模型输出达到长度上限，压缩上下文后重试' });
      this.wb.emitSnapshot();
      if (kind === 'length' && this.wb.active?.id === runId) this.wb.active.forceCompaction = true;
      if (!await this.waitUnlessCancelled(delayMs)) return { phase: 'cancelled', stopReason: 'cancelled' };
      ended = await this.promptOnce(agent, () => agent.continue());
    }
    return ended;
  }

  private dropFailedAssistant(task: TaskState, agent: KernelAgent): void {
    const last = agent.state.messages.at(-1);
    if (last?.role === 'assistant') agent.state.messages = agent.state.messages.slice(0, -1);
    task.session.dropLastAssistant();
  }

  private async waitUnlessCancelled(ms: number): Promise<boolean> {
    const signal = this.wb.active?.verifyAbort.signal;
    if (ms > 0 && signal && !signal.aborted) {
      await new Promise<void>(done => {
        const timer = setTimeout(done, ms);
        signal.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true });
      });
    }
    return !this.wb.active?.cancelRequested;
  }

  private async promptOnce(agent: KernelAgent, start: () => Promise<void>): Promise<PromptEnd | undefined> {
    const prompting = start();
    if (this.wb.active?.cancelRequested) agent.abort();
    await prompting;
    await agent.waitForIdle();
    const lastAssistant = [...agent.state.messages].reverse().find(message => message.role === 'assistant');
    const stopReason = lastAssistant?.role === 'assistant' ? lastAssistant.stopReason : undefined;
    if (this.wb.active?.cancelRequested || stopReason === 'aborted') return { phase: 'cancelled', stopReason: 'cancelled' };
    if (agent.state.errorMessage || stopReason === 'error') {
      const detail = agent.state.errorMessage || (lastAssistant?.role === 'assistant' ? lastAssistant.errorMessage : undefined);
      const error = createError('MODEL_REQUEST_FAILED', '模型请求失败', detail, this.wb.apiKey);
      return { phase: 'failed', stopReason: 'agent_error', error, ...(TRANSIENT.test(detail ?? '') ? { retry: 'transient' as const } : {}) };
    }
    if (stopReason === 'length') return { phase: 'failed', stopReason: 'agent_error', error: createError('OUTPUT_LENGTH_LIMIT', '已达到输出长度限制', undefined, this.wb.apiKey), retry: 'length' };
    return undefined;
  }
}
