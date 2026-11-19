import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import { normalizeContext, type Model, type ToolResultMessage, type Usage } from '@earendil-works/pi-ai';
import type { CompactionSettings } from '../runtime/policy.js';
import type { FileStamp, SessionEntry, SessionStore } from './session.js';
import { messageTokens } from './tokens.js';

export type ToolCallInfo = { name: string; args: Record<string, unknown> };
export type CompactionOutcome = {
  layer: 'trim' | 'summary';
  tokensBefore: number;
  tokensAfter: number;
  /** 本次新省略的工具结果数（裁剪层）。 */
  trimmedResults?: number;
  /** 并入摘要的消息数与记下内容标识的文件数（摘要层）。 */
  summarizedMessages?: number;
  files?: number;
  usage?: Usage;
};
export type CompactionRequest = {
  session: SessionStore;
  model: Model<any>;
  streamFn: StreamFn;
  /** 不在会话里、但每次请求都会带上的内容：system 消息、召回槽位、尾部状态。 */
  fixedTokens: number;
  tuning: CompactionSettings;
  signal?: AbortSignal;
  force: boolean;
  /** 分层压缩时为摘要涉及的文件记下当前内容标识。 */
  stamp?: (calls: ToolCallInfo[]) => Promise<FileStamp[]>;
};

type Kept = { seq: number; message: AgentMessage };

export const SUMMARY_PREFIX = '[较早对话的摘要：由系统压缩生成，替代了更早的对话记录]';

const SUMMARY_SYSTEM = '你负责为编程任务的对话写交接摘要（summary），供接手的助手继续工作。只输出摘要正文，不要继续对话，也不要调用工具。';
const INSTRUCTIONS = [
  '请用中文写摘要，并且必须完整保留以下信息，不得省略：',
  '1. 用户的目标与验收标准（验收命令，以及最近一次验证的结果）。',
  '2. 每个工作目录中已创建、修改、删除的文件，以及修改的原因。',
  '3. 已做出的决定、约束，以及用户明确提出的要求。',
  '4. 尚未解决的错误、失败的测试名称和关键报错信息。',
  '5. 结果未知的工具调用（例如被中断的命令）。',
].join('\n');

// pi-ai 把 max_tokens 限制在“窗口 - 当前上下文 - 4096”以内，所以预留量必须至少是一次完整输出加这个余量，否则模型会因输出空间耗尽以 length 结束。
export const OUTPUT_SAFETY = 4096;

// 比这更短的工具结果省略了也省不下多少，原样保留。
const TRIM_MIN_CHARS = 400;
const LINE_CHARS = 200;
const CALL_ARGS_CHARS = 1000;

// 窗口由用户填写，所以预留与保留都按窗口比例封顶。
export function settingsFor(contextWindow: number, maxOutputTokens: number, tuning: CompactionSettings): { reserveTokens: number; keepRecentTokens: number } {
  const reserve = Math.max(maxOutputTokens + OUTPUT_SAFETY, Math.min(tuning.reserveCapTokens, Math.floor(contextWindow * tuning.reserveRatio)));
  return {
    reserveTokens: Math.min(reserve, Math.floor(contextWindow * tuning.reserveMaxRatio)),
    keepRecentTokens: Math.min(tuning.keepRecentTokens, Math.floor(contextWindow * tuning.keepRecentRatio)),
  };
}

// ---- 请求上下文 ----

/** 发给模型的会话部分：最近的摘要（如有）+ 摘要之后的消息，已省略的工具结果换成占位说明。 */
export function sessionContext(entries: readonly SessionEntry[]): AgentMessage[] {
  const compaction = lastOf(entries, 'compaction');
  const kept = keptMessages(entries).map(entry => entry.message);
  return compaction ? [summaryMessage(compaction), ...kept] : kept;
}

/** 当前摘要涉及的文件及摘要形成时的内容标识。 */
export function summaryFiles(entries: readonly SessionEntry[]): FileStamp[] {
  return lastOf(entries, 'compaction')?.files ?? [];
}

function keptMessages(entries: readonly SessionEntry[]): Kept[] {
  const compaction = lastOf(entries, 'compaction');
  const trim = lastOf(entries, 'trim');
  const calls = toolCalls(entries);
  const kept: Kept[] = [];
  for (const entry of entries) {
    if (entry.type !== 'message' || (compaction && entry.seq < compaction.firstKeptSeq)) continue;
    const old = trim && entry.seq < trim.beforeSeq && entry.message.role === 'toolResult';
    kept.push({ seq: entry.seq, message: old ? trimmed(entry.message as ToolResultMessage, calls.get((entry.message as ToolResultMessage).toolCallId)) : entry.message });
  }
  return kept;
}

function summaryMessage(compaction: Extract<SessionEntry, { type: 'compaction' }>): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text: `${SUMMARY_PREFIX}\n${compaction.summary}` }], timestamp: compaction.at };
}

// 读取与搜索类的结果可以重新获取，只留下怎样重新获取；编辑与命令的结果是已发生的事实，留下首行或末行。
function trimmed(message: ToolResultMessage, call: ToolCallInfo | undefined): ToolResultMessage {
  const text = message.content.map(block => block.type === 'text' ? block.text : '').join('');
  if (text.length <= TRIM_MIN_CHARS && message.content.every(block => block.type === 'text')) return message;
  const args = call?.args ?? {};
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  let note: string;
  if (message.toolName === 'edit' || message.toolName === 'write') note = `[较早的结果已省略] ${(lines[0] ?? '').slice(0, LINE_CHARS)}`;
  else if (message.toolName === 'powershell') note = `[已省略较早的命令输出：${String(args.command ?? '').slice(0, LINE_CHARS)}；末行：${(lines.at(-1) ?? '').slice(0, LINE_CHARS)}]`;
  else {
    const target = [args.path, args.file, args.pattern, args.query, args.symbol].find(value => typeof value === 'string');
    note = `[已省略较早的 ${message.toolName} 输出${target ? `，需要时可重新读取：${target}` : '，需要时可重新调用'}]`;
  }
  return { ...message, content: [{ type: 'text', text: note }] };
}

// ---- 估算 ----

/**
 * 上下文大小：优先用提供方在最近一次回复里报告的真实用量，再加上其后新增消息的估算。
 * 压缩或裁剪之后旧的用量不再可信，退回到“固定部分 + 会话消息”的估算。
 */
export function contextTokens(entries: readonly SessionEntry[], fixedTokens: number): number {
  const reset = entries.findLastIndex(entry => entry.type !== 'message');
  const reported = entries.findLastIndex(entry => entry.type === 'message' && entry.message.role === 'assistant'
    && entry.message.stopReason !== 'error' && entry.message.stopReason !== 'aborted' && usageTokens(entry.message.usage) > 0);
  if (reported < 0 || reported < reset) return fixedTokens + sessionContext(entries).reduce((sum, message) => sum + messageTokens(message), 0);
  const entry = entries[reported] as Extract<SessionEntry, { type: 'message' }>;
  const after = entries.slice(reported + 1).reduce((sum, item) => sum + (item.type === 'message' ? messageTokens(item.message) : 0), 0);
  return usageTokens((entry.message as { usage?: Usage }).usage) + after;
}

/** 一次请求最多能要多少输出：窗口减去估算的上下文与安全余量，不超过模型的输出上限，至少为 1。 */
export function outputBudget(contextWindow: number, maxOutputTokens: number, contextTokens: number): number {
  return Math.max(1, Math.min(maxOutputTokens, contextWindow - contextTokens - OUTPUT_SAFETY));
}

function usageTokens(usage: Usage | undefined): number {
  if (!usage) return 0;
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

// ---- 压缩 ----

/**
 * 超出预算时逐层压缩：先省略较早的工具结果（不调用模型），仍超出才把较早的对话摘要成一段文字。
 * 关闭分层（tuning.layers = false）时只做摘要。摘要失败抛出异常，由调用方决定本次请求不压缩照常发送。
 */
export async function compactIfNeeded(request: CompactionRequest): Promise<CompactionOutcome | undefined> {
  const { session, model, tuning } = request;
  const contextWindow = model.contextWindow!;
  const settings = settingsFor(contextWindow, model.maxTokens!, tuning);
  const limit = contextWindow - settings.reserveTokens;
  const tokensBefore = contextTokens(session.entries(), request.fixedTokens);
  if (!request.force && tokensBefore <= limit) return undefined;

  let trimmed: CompactionOutcome | undefined;
  if (tuning.layers) {
    const trimmedResults = trimToolResults(session, tuning.keepToolResults, settings.keepRecentTokens);
    if (trimmedResults) trimmed = { layer: 'trim', tokensBefore, tokensAfter: contextTokens(session.entries(), request.fixedTokens), trimmedResults };
    if (trimmed && trimmed.tokensAfter <= limit) return trimmed;
  }
  // 裁剪之后剩下的对话已不足以切出一段摘要时，只报告裁剪；两层都做了时摘要结果里带上裁剪数。
  const summary = await summarize(request, settings, tokensBefore);
  return summary ? { ...summary, trimmedResults: trimmed?.trimmedResults } : trimmed;
}

// 原样保留最近的工具结果：不超过 keep 个，合计也不超过 keepTokens（至少保留最新的一个）；返回本次新省略的数量。
function trimToolResults(session: SessionStore, keep: number, keepTokens: number): number {
  const entries = session.entries();
  const start = lastOf(entries, 'compaction')?.firstKeptSeq ?? 0;
  const results = entries.filter(entry => entry.type === 'message' && entry.message.role === 'toolResult' && entry.seq >= start) as Extract<SessionEntry, { type: 'message' }>[];
  let kept = 0;
  for (let total = 0; kept < Math.min(keep, results.length); kept++) {
    total += messageTokens(results[results.length - 1 - kept].message);
    if (kept > 0 && total > keepTokens) break;
  }
  if (kept >= results.length) return 0;
  const beforeSeq = results[results.length - kept].seq;
  const current = lastOf(entries, 'trim')?.beforeSeq ?? 0;
  const count = results.filter(entry => entry.seq >= current && entry.seq < beforeSeq).length;
  if (!count) return 0;
  session.appendTrim(beforeSeq);
  return count;
}

async function summarize(request: CompactionRequest, settings: { reserveTokens: number; keepRecentTokens: number }, tokensBefore: number): Promise<CompactionOutcome | undefined> {
  const { session, model, tuning } = request;
  const entries = session.entries();
  const kept = keptMessages(entries);
  const cut = cutIndex(kept, settings.keepRecentTokens);
  if (cut <= 0) return undefined;

  const summarized = kept.slice(0, cut).map(entry => entry.message);
  const previous = lastOf(entries, 'compaction');
  let prompt = `<conversation>\n${serialize(summarized, tuning.summaryToolResultChars)}\n</conversation>\n\n`;
  if (previous) prompt += `<previous-summary>\n${previous.summary}\n</previous-summary>\n\n请把上面的对话合并进已有摘要。\n`;
  prompt += INSTRUCTIONS;
  // 摘要请求的输出上限取预留量；窗口放宽，避免 pi-ai 按“窗口 - 上下文”把输出裁得过小。
  const summaryModel = { ...model, contextWindow: model.contextWindow! + 2 * settings.reserveTokens, maxTokens: settings.reserveTokens };
  const response = await request.streamFn(summaryModel, normalizeContext({
    systemPrompt: SUMMARY_SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], timestamp: Date.now() }],
  }), { signal: request.signal, maxTokens: settings.reserveTokens });
  const message = await response.result();
  if (message.stopReason === 'error' || message.stopReason === 'aborted') throw new Error(message.errorMessage || '摘要请求失败');
  const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('').trim();
  if (!text) throw new Error('摘要为空');

  const stamps = tuning.layers && request.stamp ? await request.stamp(callsIn(summarized)) : [];
  const files = mergeStamps(previous?.files ?? [], stamps);
  session.appendCompaction(text, kept[cut].seq, tokensBefore, files);
  return {
    layer: 'summary', tokensBefore, tokensAfter: contextTokens(session.entries(), request.fixedTokens),
    summarizedMessages: summarized.length, files: files.length, usage: message.usage,
  };
}

// 从最新的消息往前累计到 keepRecent，切在不早于该处的第一条 user 或 assistant 消息上（不把工具调用和结果拆开）。
function cutIndex(kept: Kept[], keepRecent: number): number {
  const valid = (index: number) => ['user', 'assistant'].includes(kept[index].message.role);
  let total = 0;
  for (let index = kept.length - 1; index > 0; index--) {
    total += messageTokens(kept[index].message);
    if (total < keepRecent) continue;
    for (let next = index; next < kept.length; next++) if (valid(next)) return next;
    for (let prev = index - 1; prev > 0; prev--) if (valid(prev)) return prev;
    return 0;
  }
  return 0;
}

function serialize(messages: AgentMessage[], toolResultChars: number): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === 'user') parts.push(`[用户]：${textOf(message.content)}`);
    else if (message.role === 'assistant') {
      const text = textOf(message.content);
      if (text) parts.push(`[助手]：${text}`);
      for (const block of message.content) {
        if (block.type === 'toolCall') parts.push(`[助手调用 ${block.name}]：${JSON.stringify(block.arguments).slice(0, CALL_ARGS_CHARS)}`);
      }
    } else if (message.role === 'toolResult') {
      const text = textOf(message.content);
      parts.push(`[工具结果 ${message.toolName}${message.isError ? '，失败' : ''}]：${text.length > toolResultChars ? `${text.slice(0, toolResultChars)}…（共 ${text.length} 字符，其余省略）` : text}`);
    }
  }
  return parts.join('\n\n');
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  return (content as { type: string; text?: string }[]).filter(block => block.type === 'text').map(block => block.text ?? '').join('');
}

function toolCalls(entries: readonly SessionEntry[]): Map<string, ToolCallInfo> {
  const calls = new Map<string, ToolCallInfo>();
  for (const entry of entries) {
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
    for (const block of entry.message.content) if (block.type === 'toolCall') calls.set(block.id, { name: block.name, args: block.arguments });
  }
  return calls;
}

function callsIn(messages: AgentMessage[]): ToolCallInfo[] {
  return messages.flatMap(message => message.role === 'assistant'
    ? message.content.flatMap(block => block.type === 'toolCall' ? [{ name: block.name, args: block.arguments }] : [])
    : []);
}

// 新摘要覆盖了同一文件时以新的内容标识为准。
function mergeStamps(previous: FileStamp[], next: FileStamp[]): FileStamp[] {
  const merged = new Map(previous.map(stamp => [`${stamp.rootId}\n${stamp.path}`, stamp]));
  for (const stamp of next) merged.set(`${stamp.rootId}\n${stamp.path}`, stamp);
  return [...merged.values()];
}

function lastOf<T extends SessionEntry['type']>(entries: readonly SessionEntry[], type: T): Extract<SessionEntry, { type: T }> | undefined {
  return entries.findLast(entry => entry.type === type) as Extract<SessionEntry, { type: T }> | undefined;
}

