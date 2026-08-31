import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import {
  estimateTokens, findCutPoint, generateSummaryWithUsage, sessionEntryToContextMessages, shouldCompact,
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

// 窗口由用户填写，所以预留量与保留量按窗口比例取较小值。
export function settingsFor(contextWindow: number): Settings {
  return {
    enabled: true,
    reserveTokens: Math.min(16384, Math.floor(contextWindow * 0.25)),
    keepRecentTokens: Math.min(20000, Math.floor(contextWindow * 0.35)),
  };
}

// fixedTokens 是不属于会话的前导系统消息（系统提示与工具声明）的估算量。
export function contextTokens(messages: AgentMessage[], fixedTokens: number): number {
  return fixedTokens + messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

// 仅使用 Pi 导出的原语：估算、切点、摘要。摘要写入 Pi 会话，调用方用 buildSessionContext 取得新上下文。
export async function compactIfNeeded(
  session: SessionManager, model: Model<any>, apiKey: string | undefined, streamFn: StreamFn, fixedTokens: number, signal?: AbortSignal,
): Promise<CompactionOutcome | undefined> {
  const contextWindow = model.contextWindow!;
  const settings = settingsFor(contextWindow);
  const tokensBefore = contextTokens(session.buildSessionContext().messages, fixedTokens);
  if (!shouldCompact(tokensBefore, contextWindow, settings)) return undefined;

  const entries = session.getBranch();
  const previousIndex = entries.findLastIndex(entry => entry.type === 'compaction');
  const previous = previousIndex >= 0 ? entries[previousIndex] as Extract<SessionEntry, { type: 'compaction' }> : undefined;
  const keptStart = previous ? entries.findIndex(entry => entry.id === previous.firstKeptEntryId) : 0;
  const start = keptStart >= 0 ? keptStart : previousIndex + 1;
  const cut = findCutPoint(entries, start, entries.length, settings.keepRecentTokens);
  const firstKept = entries[cut.firstKeptEntryIndex];
  if (!firstKept || cut.firstKeptEntryIndex <= start) return undefined;

  // 切在回合中间时，该回合的前半段一并并入摘要，保留的尾部从切点开始。
  const messages = entries.slice(start, cut.firstKeptEntryIndex).flatMap(entry => sessionEntryToContextMessages(entry));
  const { text, usage } = await generateSummaryWithUsage(messages, model, undefined, apiKey, undefined, signal, INSTRUCTIONS, previous?.summary, undefined, streamFn);
  session.appendCompaction(text, firstKept.id, tokensBefore, undefined, false, usage);
  const tokensAfter = contextTokens(session.buildSessionContext().messages, fixedTokens);
  return { tokensBefore, tokensAfter, firstKeptEntryId: firstKept.id, usage };
}
