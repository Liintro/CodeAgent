import { basename, extname } from 'node:path';
import type { MemoryKind, MemoryValidity, RootView } from '../../shared/contracts/index.js';
import { repoOf, type RepoRef } from './repo.js';
import type { Anchor, MemoryRow, MemoryStore } from './store.js';
import type { RecallSettings } from '../runtime/policy.js';
import { driftNote, evaluate, type Evaluation } from './validity.js';
import { tokensOf } from '../kernel/tokens.js';

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
function ftsQueryOf(query: Query, changedPaths: string[], maxQueryTerms: number): string {
  const terms = [...query.paths, ...query.ids, ...changedPaths, ...query.grams].filter(term => term.length >= 3);
  return [...new Set(terms)].slice(0, maxQueryTerms).map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
}

// ---- 评分 ----

function relevance(settings: RecallSettings, item: MemoryRow, anchors: Anchor[], query: Query, changedPaths: string[], failure?: Failure): { relevance: number; failureMatch: boolean } {
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
  const phrase = sharedGrams >= settings.minPhraseGrams ? Math.min(1, sharedGrams / settings.phraseFull) : 0;
  const failureMatch = Boolean(failure && item.kind === 'fix' && (item.evidence.failureHash === failure.hash || failureOverlap(item, failure)));
  const w = settings.weights;
  return { relevance: w.path * Number(pathHit) + w.failure * Number(failureMatch) + w.identifier * identifier + w.phrase * phrase, failureMatch };
}

const isSpecific = (id: string) => /[a-z][A-Z]|_|\d/.test(id) || id.length >= 10;

function failureOverlap(item: MemoryRow, failure: Failure): boolean {
  const lines = ((item.evidence.failureLines as string[] | undefined) ?? []).join(' ').toLowerCase();
  return parseQuery(failure.outputTail).ids.some(id => lines.includes(id.toLowerCase()));
}

// ---- 召回 ----

export async function recall(store: MemoryStore, request: RecallRequest, settings: RecallSettings): Promise<Recalled> {
  const repos = new Map<string, RepoRef>();
  for (const root of request.roots) {
    const repo = await repoOf(root);
    if (!repos.has(repo.id)) repos.set(repo.id, repo);
  }
  const query = parseQuery(request.failure ? `${request.query} ${request.failure.outputTail}` : request.query);
  const candidates = store.search([...repos.keys()], ftsQueryOf(query, request.changedPaths, settings.maxQueryTerms), settings.candidates)
    .filter(item => !request.failure || item.kind === 'fix');
  if (!candidates.length) return { text: '', tokens: 0, items: [] };
  const anchors = store.anchors(candidates.map(item => item.id));
  const evaluations = new Map<string, Evaluation>();
  for (const [id, repo] of repos) for (const [key, value] of await evaluate(repo, candidates.filter(item => item.repoId === id), anchors)) evaluations.set(key, value);

  const w = settings.weights;
  const now = Date.now();
  const scored = candidates.map((item, index) => {
    const { relevance: rel, failureMatch } = relevance(settings, item, anchors.get(item.id) ?? [], query, request.changedPaths, request.failure);
    const evaluation = evaluations.get(item.id)!;
    const usable = evaluation.validity === 'current' || (evaluation.validity === 'drifted' && rel >= settings.driftedMinRelevance)
      || (evaluation.validity === 'unverifiable' && item.confirmed);
    const base = rel > 0 ? rel + w.confirmed * Number(item.confirmed) + w.recency * Math.exp(-(now - item.updatedAt) / (30 * 86400000)) + w.rank * (1 - index / candidates.length) : 0;
    const score = usable ? base * (evaluation.validity === 'drifted' ? settings.driftedWeight : 1) : 0;
    return { item, evaluation, score, failureMatch };
  });
  const budget = Math.min(settings.budgetTokens, Math.floor(request.contextWindow * settings.budgetRatio));
  const eligible = scored.filter(entry => entry.score >= settings.minScore && (!request.failure || entry.failureMatch)).sort((a, b) => b.score - a.score);

  const chosen: { entry: (typeof scored)[number]; line: string }[] = [];
  const header = request.failure ? '[相关历史修复·仅供参考，一切以当前代码为准]' : '[记忆引用·仅供参考，一切以当前代码为准]';
  let tokens = tokensOf(header);
  for (const entry of eligible) {
    if (chosen.length >= settings.maxItems) break;
    const line = await render(chosen.length + 1, entry.item, entry.evaluation, repos.get(entry.item.repoId)!, request.failure ? settings.excerptChars : undefined);
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

async function render(index: number, item: MemoryRow, evaluation: Evaluation, repo: RepoRef, excerptChars?: number): Promise<string> {
  const date = new Date(item.updatedAt).toISOString().slice(0, 10);
  const state = evaluation.validity === 'drifted' ? `已漂移（${await driftNote(repo, item, evaluation.changed)}）` : evaluation.validity === 'unverifiable' ? '无法用 Git 校验' : '当前有效';
  // 只有修复召回带差异摘录。
  const excerpt = excerptChars !== undefined && typeof item.evidence.fixExcerpt === 'string' ? `\n   修复差异：\n${indent(item.evidence.fixExcerpt.slice(0, excerptChars))}` : '';
  return `${index}. ${KIND_LABEL[item.kind]}｜${state}｜${date}｜${item.repoLabel}\n   ${item.text}${excerpt}`;
}

const indent = (text: string) => text.split('\n').map(line => `   ${line}`).join('\n');

// ---- 请求级注入：纯函数，不读写任何存储 ----

/** 在锚点消息之前插入召回文本；没有槽位时原样返回同一个数组，请求体与没有记忆时完全一致。 */
export function injectSlots<T extends { role: string; timestamp?: number; content?: unknown }>(messages: T[], slots: Slot[], make: (text: string) => T): T[] {
  if (!slots.length) return messages;
  return messages.flatMap(message => [...slots.filter(slot => anchors(message, slot)).map(slot => make(slot.text)), message]);
}

/**
 * 压缩后锚点消息可能已并入摘要：这些槽位改锚到第一条保留的 user 或 assistant 消息，召回文本照常随请求注入。
 * 不锚到 toolResult，以免把工具调用和它的结果拆开。
 */
export function reanchorSlots(slots: Slot[], messages: { role: string; timestamp?: number; content?: unknown }[]): void {
  const target = messages.find(message => message.role === 'user' || message.role === 'assistant');
  if (!target?.timestamp) return;
  for (const slot of slots) {
    if (messages.some(message => anchors(message, slot))) continue;
    slot.anchorTimestamp = target.timestamp;
    slot.anchorText = textOf(target);
  }
}

function anchors(message: { timestamp?: number; content?: unknown }, slot: Slot): boolean {
  return message.timestamp === slot.anchorTimestamp && textOf(message) === slot.anchorText;
}

function textOf(message: { content?: unknown }): string {
  const { content } = message;
  return typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => (part as { text?: string }).text ?? '').join('') : '';
}
