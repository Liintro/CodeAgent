import { randomUUID } from 'node:crypto';
import type { AgentMessage, PrepareRequest, StreamFn } from '@earendil-works/pi-agent-core';
import { compactIfNeeded, contextTokens, outputBudget, sessionContext, summaryFiles, type CompactionOutcome } from '../kernel/compaction.js';
import { tokensOf } from '../kernel/tokens.js';
import { injectSlots, reanchorSlots, type Slot } from '../memory/recall.js';
import { NOTICE } from '../runtime/timeline.js';
import { stampFiles, tailState } from './tail.js';
import { createError, userMessage, type TaskState, type Workbench } from './workbench.js';

const NO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/**
 * 一个 Run 里每次模型请求的组装：从会话重建对话（会话是唯一来源，压缩、裁剪与重试后的请求都与它一致），
 * 运行中排队的用户消息先写进会话；超出预算时分层压缩，召回槽位插到锚点之前，任务状态附在末尾。
 */
export class RequestAssembly {
  // 尾部状态与上下文大小在 prepareRequest 里算好，随后的 transformContext 与输出上限直接使用。
  private tail = '';
  private used = 0;

  constructor(
    private readonly wb: Workbench,
    private readonly task: TaskState,
    private readonly runId: string,
    /** 召回的历史记忆只存在于这个数组里，从不写入会话；修复轮次会追加。 */
    private readonly slots: Slot[],
    private readonly streamFn: StreamFn,
  ) {}

  messages(): AgentMessage[] {
    return sessionContext(this.task.session.entries());
  }

  // 输出上限只按自己的估算决定。pi-ai 会拿上下文里最后一条 assistant 消息报告的用量来估算，
  // 而裁剪之后那份用量已经过期（偏大），会把输出上限压到 1；用量不发给提供方，所以交给 pi-ai 前清零。
  readonly stream: StreamFn = (model, context, options) => this.streamFn(
    model,
    { ...context, messages: context.messages.map(message => message.role === 'assistant' ? { ...message, usage: NO_USAGE } : message) },
    { ...options, maxTokens: outputBudget(model.contextWindow!, model.maxTokens!, this.used) },
  );

  readonly transformContext = async (messages: AgentMessage[]): Promise<AgentMessage[]> =>
    [...injectSlots(messages, this.slots, text => userMessage(text)), userMessage(this.tail)];

  readonly prepareRequest: PrepareRequest = async (request, signal) => {
    const { task, wb, runId } = this;
    // 系统提示是对话记录开头的 system 消息，不在会话里，原样放回。
    const leading = request.context.messages.filter(message => message.role === 'system');
    for (const text of wb.takeQueued(task)) {
      task.session.appendMessage(userMessage(text));
      wb.ledger.appendEvent(runId, 'steering.inserted', { textPreview: text.slice(0, 200) });
    }
    await this.refreshTail();
    const force = wb.active?.id === runId && wb.active.forceCompaction === true;
    if (force) wb.active!.forceCompaction = false;
    let outcome: CompactionOutcome | undefined;
    try {
      outcome = await compactIfNeeded({
        session: task.session, model: request.model, streamFn: this.streamFn, fixedTokens: this.fixedTokens(leading),
        tuning: wb.policy.settings.compaction, signal, force, stamp: calls => stampFiles(wb, task, calls),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      // 摘要失败不终止 Run：本次请求不压缩照常发送；若因此以 length 停止，由 length 恢复路径处理。
      this.recordFailure(error);
    }
    const messages = this.messages();
    if (outcome) {
      this.record(outcome);
      // 摘要消息本身不能做锚点：槽位要紧挨在第一条保留的消息之前。
      reanchorSlots(this.slots, task.session.entries().some(entry => entry.type === 'compaction') ? messages.slice(1) : messages);
      await this.refreshTail();
    }
    this.used = contextTokens(task.session.entries(), this.fixedTokens(leading));
    return { context: { ...request.context, messages: [...leading, ...messages] } };
  };

  // system 消息除正文外还带 sections 与工具定义，按整条消息的 JSON 计数。
  private fixedTokens(leading: AgentMessage[]): number {
    return tokensOf(JSON.stringify(leading)) + this.slots.reduce((sum, slot) => sum + tokensOf(slot.text), 0) + tokensOf(this.tail);
  }

  private async refreshTail(): Promise<void> {
    const entries = this.task.session.entries();
    const backfill = this.wb.policy.settings.compaction.layers && entries.some(entry => entry.type === 'compaction');
    this.tail = await tailState(this.wb, this.task, backfill ? { files: summaryFiles(entries) } : undefined);
  }

  private record(outcome: CompactionOutcome): void {
    const { usage, ...data } = outcome;
    this.wb.ledger.appendEvent(this.runId, 'compaction.done', { ...data, usage });
    if (usage?.totalTokens) this.wb.ledger.appendEvent(this.runId, 'model.usage', { ...usage, purpose: 'compaction' });
    // 与重建时间线一致：裁剪与摘要各一条提示。
    if (outcome.trimmedResults) this.task.timeline.push({ kind: 'notice', id: randomUUID(), text: NOTICE.trim });
    if (outcome.layer === 'summary') this.task.timeline.push({ kind: 'notice', id: randomUUID(), text: NOTICE.compaction });
    this.wb.emitSnapshot();
  }

  private recordFailure(error: unknown): void {
    this.wb.ledger.appendEvent(this.runId, 'compaction.failed', { error: createError('COMPACTION_FAILED', '上下文压缩失败', error, this.wb.apiKey) });
    this.task.timeline.push({ kind: 'notice', id: randomUUID(), text: '上下文压缩失败，本次请求不压缩继续' });
    this.wb.emitSnapshot();
  }
}
