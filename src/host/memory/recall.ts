import { basename, extname } from 'node:path';
import { estimateTokens } from '@earendil-works/pi-coding-agent';
import type { MemoryKind, MemoryValidity, RootView } from '../../shared/contracts.js';
import { repoOf, type RepoRef } from './repo.js';
import type { Anchor, MemoryRow, MemoryStore } from './store.js';
import { driftNote, evaluate, type Evaluation } from './validity.js';

// 所有可调数值集中在这里。
export const RECALL = {
  maxItems: 5,
  candidates: 20,
  budgetTokens: 1200,
  budgetRatio: 0.03,
  minScore: 1.0,
  /** 已漂移的条目必须有足够强的相关性才注入。 */
  driftedMinRelevance: 2.0,
  driftedWeight: 0.5,
  weights: { path: 2.0, failure: 1.5, identifier: 1.0, phrase: 1.5, confirmed: 0.5, recency: 0.1, rank: 0.3 },
  /** 查询里至少有这么多个 3 字片段出现在条目中（即共享约 5 个连续汉字）才算短语命中；命中 phraseFull 个即满分。 */
  minPhraseGrams: 3,
  phraseFull: 6,
  maxQueryTerms: 40,
  excerptChars: 600,
};

const STOPWORDS = new Set(['test', 'tests', 'testing', 'java', 'python', 'error', 'errors', 'fail', 'failed', 'failure', 'class', 'method', 'function', 'file', 'files',
  'code', 'with', 'from', 'this', 'that', 'have', 'into', 'name', 'value', 'build', 'main', 'src', 'true', 'false', 'null', 'none', 'public', 'private', 'static',
  'return', 'import', 'package', 'string', 'import', 'help', 'please', 'make', 'need', 'want', 'using', 'write', 'read', 'update', 'change', 'check', 'find', 'when', 'what', 'which',
  'there', 'about', 'should', 'would', 'could', 'expected', 'actual', 'assert', 'exception', 'maven', 'pytest']);

export type Slot = { anchorTimestamp: number; anchorText: string; text: string };
export type RecalledItem = { id: string; kind: MemoryKind; validity: MemoryValidity; score: number; injected: boolean; tokens: number };
export type Recalled = { text: string; tokens: number; items: RecalledItem[] };
export type Failure = { hash: string; outputTail: string };
export type RecallRequest = {
  roots: RootView[];
  query: string;
  /** 本 Task 已变更的文件（相对 Git 顶层）。 */
  changedPaths: string[];
  contextWindow: number;
  /** 修复阶段：只召回同一失败的历史修复。 */
  failure?: Failure;
};

// ---- 查询 ----

type Query = { ids: string[]; paths: string[]; grams: string[] };

export function parseQuery(text: string): Query {
  const ids = [...new Set((text.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? []).filter(word => !STOPWORDS.has(word.toLowerCase())))];
  const paths = [...new Set((text.match(/[\w./\\-]+\.[A-Za-z0-9]{1,8}\b/g) ?? []).map(path => path.replaceAll('\\', '/')))];
  const grams = new Set<string>();
  for (const run of text.match(/[㐀-鿿]{3,}/g) ?? []) for (let index = 0; index + 3 <= run.length; index++) grams.add(run.slice(index, index + 3));
  return { ids, paths, grams: [...grams] };
}

// FTS5 trigram 只能匹配 3 个字符以上的子串，更短的片段被丢弃。
function ftsQueryOf(query: Query, changedPaths: string[]): string {
  const terms = [...query.paths, ...query.ids, ...changedPaths, ...query.grams].filter(term => term.length >= 3);
  return [...new Set(terms)].slice(0, RECALL.maxQueryTerms).map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
}

// ---- 评分 ----

function relevance(item: MemoryRow, anchors: Anchor[], query: Query, changedPaths: string[], failure?: Failure): { relevance: number; failureMatch: boolean } {
  const haystack = `${item.text} ${(item.evidence.failureLines as string[] | undefined)?.join(' ') ?? ''} ${anchors.map(anchor => anchor.path).join(' ')}`.toLowerCase();
  // 驼峰、下划线或较长的标识符本身就很有区分度，一个命中即可；普通英文单词要多个命中。
  const identifier = Math.min(1, query.ids.filter(id => haystack.includes(id.toLowerCase())).reduce((sum, id) => sum + (isSpecific(id) ? 1 : 0.5), 0));
  const stems = new Set(anchors.map(anchor => basename(anchor.path, extname(anchor.path)).toLowerCase()));
  const stemHit = query.ids.some(id => (isSpecific(id) || id.length >= 6) && stems.has(id.toLowerCase()));
  const names = new Set(anchors.map(anchor => basename(anchor.path).toLowerCase()));
  const pathHit = query.paths.some(path => anchors.some(anchor => anchor.path.toLowerCase().endsWith(path.toLowerCase()) || names.has(basename(path).toLowerCase())))
    || changedPaths.some(path => anchors.some(anchor => anchor.path === path))
    || stemHit;
  const sharedGrams = query.grams.filter(gram => haystack.includes(gram)).length;
  const phrase = sharedGrams >= RECALL.minPhraseGrams ? Math.min(1, sharedGrams / RECALL.phraseFull) : 0;
  const failureMatch = Boolean(failure && item.kind === 'fix' && (item.evidence.failureHash === failure.hash || failureOverlap(item, failure)));
  const w = RECALL.weights;
  return { relevance: w.path * Number(pathHit) + w.failure * Number(failureMatch) + w.identifier * identifier + w.phrase * phrase, failureMatch };
}

const isSpecific = (id: string) => /[a-z][A-Z]|_|\d/.test(id) || id.length >= 10;

function failureOverlap(item: MemoryRow, failure: Failure): boolean {
  const lines = ((item.evidence.failureLines as string[] | undefined) ?? []).join(' ').toLowerCase();
  return parseQuery(failure.outputTail).ids.some(id => lines.includes(id.toLowerCase()));
}

// ---- 召回 ----

export async function recall(store: MemoryStore, request: RecallRequest): Promise<Recalled> {
  const repos = new Map<string, RepoRef>();
  for (const root of request.roots) {
    const repo = await repoOf(root);
    if (!repos.has(repo.id)) repos.set(repo.id, repo);
  }
  const query = parseQuery(request.failure ? `${request.query} ${request.failure.outputTail}` : request.query);
  const candidates = store.search([...repos.keys()], ftsQueryOf(query, request.changedPaths), RECALL.candidates)
    .filter(item => !request.failure || item.kind === 'fix');
  if (!candidates.length) return { text: '', tokens: 0, items: [] };
  const anchors = store.anchors(candidates.map(item => item.id));
  const evaluations = new Map<string, Evaluation>();
  for (const [id, repo] of repos) for (const [key, value] of await evaluate(repo, candidates.filter(item => item.repoId === id), anchors)) evaluations.set(key, value);

  const w = RECALL.weights;
  const now = Date.now();
  const scored = candidates.map((item, index) => {
    const { relevance: rel, failureMatch } = relevance(item, anchors.get(item.id) ?? [], query, request.changedPaths, request.failure);
    const evaluation = evaluations.get(item.id)!;
    const usable = evaluation.validity === 'current' || (evaluation.validity === 'drifted' && rel >= RECALL.driftedMinRelevance)
      || (evaluation.validity === 'unverifiable' && item.confirmed);
    const base = rel > 0 ? rel + w.confirmed * Number(item.confirmed) + w.recency * Math.exp(-(now - item.updatedAt) / (30 * 86400000)) + w.rank * (1 - index / candidates.length) : 0;
    const score = usable ? base * (evaluation.validity === 'drifted' ? RECALL.driftedWeight : 1) : 0;
    return { item, evaluation, score, failureMatch };
  });
  const budget = Math.min(RECALL.budgetTokens, Math.floor(request.contextWindow * RECALL.budgetRatio));
  const eligible = scored.filter(entry => entry.score >= RECALL.minScore && (!request.failure || entry.failureMatch)).sort((a, b) => b.score - a.score);

  const chosen: { entry: (typeof scored)[number]; line: string }[] = [];
  const header = request.failure ? '[相关历史修复·仅供参考，一切以当前代码为准]' : '[记忆引用·仅供参考，一切以当前代码为准]';
  let tokens = tokensOf(header);
  for (const entry of eligible) {
    if (chosen.length >= RECALL.maxItems) break;
    const line = await render(chosen.length + 1, entry.item, entry.evaluation, repos.get(entry.item.repoId)!, Boolean(request.failure));
    const cost = tokensOf(line);
    if (tokens + cost > budget) continue;
    tokens += cost;
    chosen.push({ entry, line });
  }
  const injected = new Set(chosen.map(({ entry }) => entry.item.id));
  const items = scored.map(entry => ({ id: entry.item.id, kind: entry.item.kind, validity: entry.evaluation.validity, score: Number(entry.score.toFixed(3)), injected: injected.has(entry.item.id), tokens: 0 }));
  return chosen.length ? { text: [header, ...chosen.map(({ line }) => line)].join('\n'), tokens, items } : { text: '', tokens: 0, items };
}

const KIND_LABEL: Record<MemoryKind, string> = { fix: '修复', change: '变更', convention: '约定', note: '备注' };

async function render(index: number, item: MemoryRow, evaluation: Evaluation, repo: RepoRef, withExcerpt: boolean): Promise<string> {
  const date = new Date(item.updatedAt).toISOString().slice(0, 10);
  const state = evaluation.validity === 'drifted' ? `已漂移（${await driftNote(repo, item, evaluation.changed)}）` : evaluation.validity === 'unverifiable' ? '无法用 Git 校验' : '当前有效';
  const excerpt = withExcerpt && typeof item.evidence.fixExcerpt === 'string' ? `\n   修复差异：\n${indent(item.evidence.fixExcerpt.slice(0, RECALL.excerptChars))}` : '';
  return `${index}. ${KIND_LABEL[item.kind]}｜${state}｜${date}｜${item.repoLabel}\n   ${item.text}${excerpt}`;
}

const indent = (text: string) => text.split('\n').map(line => `   ${line}`).join('\n');

export function tokensOf(text: string): number {
  return estimateTokens({ role: 'user', content: [{ type: 'text', text }], timestamp: 0 });
}

// ---- 请求级注入：纯函数，不读写任何存储 ----

/** 在锚点消息之前插入召回文本；没有槽位时原样返回同一个数组，请求体与没有记忆时完全一致。 */
export function injectSlots<T extends { role: string; timestamp?: number; content?: unknown }>(messages: T[], slots: Slot[], make: (text: string) => T): T[] {
  if (!slots.length) return messages;
  return messages.flatMap(message => [...slots.filter(slot => message.role === 'user' && message.timestamp === slot.anchorTimestamp && textOf(message) === slot.anchorText).map(slot => make(slot.text)), message]);
}

function textOf(message: { content?: unknown }): string {
  const { content } = message;
  return typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => (part as { text?: string }).text ?? '').join('') : '';
}
