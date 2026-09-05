import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import {
  calculateContextTokens, estimateTokens, findCutPoint, generateSummaryWithUsage, sessionEntryToContextMessages, shouldCompact,
  type SessionEntry, type SessionManager,
} from '@earendil-works/pi-coding-agent';

type Settings = { enabled: boolean; reserveTokens: number; keepRecentTokens: number };

export type CompactionOutcome = { tokensBefore: number; tokensAfter: number; firstKeptEntryId: string; usage?: unknown };

const INSTRUCTIONS = [
  '请用中文写摘要，并且必须完整保留以下信息，不得省略：',
  '1. 用户的目标与验收标准（验收命令，以及最近一次验证的结果）。',
  '2. 每个工作目录中已创建、修改、删除的文件，以及修改的原因。',
  '3. 已做出的决定、约束，以及用户明确提出的要求。',
  '4. 尚未解决的错误、失败的测试名称和关键报错信息。',
  '5. 结果未知的工具调用（例如被中断的命令）。',
].join('\n');

// Pi 把 max_tokens 限制在“窗口 - 当前上下文 - 4096”以内，所以预留量必须至少是一次完整输出加这个余量，否则模型会因输出空间耗尽以 length 结束。
const PI_OUTPUT_SAFETY = 4096;

// 窗口由用户填写，所以预留与保留都按窗口比例封顶。
export function settingsFor(contextWindow: number, maxOutputTokens: number): Settings {
  const reserve = Math.max(maxOutputTokens + PI_OUTPUT_SAFETY, Math.min(16384, Math.floor(contextWindow * 0.25)));
  return {
    enabled: true,
    reserveTokens: Math.min(reserve, Math.floor(contextWindow * 0.5)),
    keepRecentTokens: Math.min(20000, Math.floor(contextWindow * 0.35)),
  };
}

// 上下文大小：优先用提供方在最近一次回复里报告的真实用量，再加上其后新增消息的估算。
// 只按字符数估算会严重低估中文内容；压缩之后旧的用量不再可信，退回到“系统消息估算 + 会话消息估算”。
export function contextTokens(session: SessionManager, fixedTokens: number): number {
  const entries = session.getBranch();
  const lastCompaction = entries.findLastIndex(entry => entry.type === 'compaction');
  const reported = entries.findLastIndex(entry => entry.type === 'message' && entry.message.role === 'assistant'
    && entry.message.stopReason !== 'error' && entry.message.stopReason !== 'aborted' && (entry.message.usage?.totalTokens ?? 0) > 0);
  const estimate = (list: SessionEntry[]) => list.flatMap(entry => sessionEntryToContextMessages(entry)).reduce((sum, message) => sum + estimateTokens(message), 0);
  if (reported < 0 || reported < lastCompaction) {
    return fixedTokens + session.buildSessionContext().messages.reduce((sum, message) => sum + estimateTokens(message), 0);
  }
  const entry = entries[reported];
  const usage = entry.type === 'message' && entry.message.role === 'assistant' ? calculateContextTokens(entry.message.usage) : 0;
  return usage + estimate(entries.slice(reported + 1));
}

// 仅使用 Pi 导出的原语：估算、切点、摘要。摘要写入 Pi 会话，调用方用 buildSessionContext 取得新上下文。
export async function compactIfNeeded(
  session: SessionManager, model: Model<any>, apiKey: string | undefined, streamFn: StreamFn, fixedTokens: number, signal?: AbortSignal,
): Promise<CompactionOutcome | undefined> {
  const contextWindow = model.contextWindow!;
  const settings = settingsFor(contextWindow, model.maxTokens!);
  const tokensBefore = contextTokens(session, fixedTokens);
  if (!shouldCompact(tokensBefore, contextWindow, settings)) return undefined;

  const entries = session.getBranch();
  const previousIndex = entries.findLastIndex(entry => entry.type === 'compaction');
  const previous = previousIndex >= 0 ? entries[previousIndex] as Extract<SessionEntry, { type: 'compaction' }> : undefined;
  const keptStart = previous ? entries.findIndex(entry => entry.id === previous.firstKeptEntryId) : 0;
  const start = keptStart >= 0 ? keptStart : previousIndex + 1;
  const cut = findCutPoint(entries, start, entries.length, settings.keepRecentTokens);
  const firstKept = entries[cut.firstKeptEntryIndex];
  if (!firstKept || cut.firstKeptEntryIndex <= start) return undefined;

  // 要被摘要的对话本身已经超出预算，而 Pi 会按“窗口 - 当前上下文”裁剪输出上限，所以摘要请求使用放宽后的窗口，
  // 输出上限取预留量，保证摘要放得下完整的任务状态。
  const summaryModel = { ...model, contextWindow: contextWindow + 2 * settings.reserveTokens, maxTokens: settings.reserveTokens };
  const summaryStream: StreamFn = (target, context, options) => streamFn(target, context, { ...options, maxTokens: settings.reserveTokens });
  // 切在回合中间时，该回合的前半段一并并入摘要，保留的尾部从切点开始。
  const messages = entries.slice(start, cut.firstKeptEntryIndex).flatMap(entry => sessionEntryToContextMessages(entry));
  const { text, usage } = await generateSummaryWithUsage(messages, summaryModel, undefined, apiKey, undefined, signal, INSTRUCTIONS, previous?.summary, undefined, summaryStream);
  session.appendCompaction(text, firstKept.id, tokensBefore, undefined, false, usage);
  const tokensAfter = contextTokens(session, fixedTokens);
  return { tokensBefore, tokensAfter, firstKeptEntryId: firstKept.id, usage };
}
