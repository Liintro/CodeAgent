import { stat } from 'node:fs/promises';
import { posix } from 'node:path';
import type { MemoryValidity } from '../../shared/contracts.js';
import * as git from '../workspace/git.js';
import type { RepoRef } from './repo.js';
import type { Anchor, MemoryRow } from './store.js';

type AnchorResult = 'match' | 'reverted' | 'missing' | 'drifted';
export type Evaluation = { validity: MemoryValidity; changed: string[] };

// 内容标识（blob）比较当前工作区：只看文件内容是否与记忆形成时一致，不看文本差异，也不依赖提交历史。
export async function evaluate(repo: RepoRef, items: MemoryRow[], anchorsOf: Map<string, Anchor[]>): Promise<Map<string, Evaluation>> {
  const result = new Map<string, Evaluation>();
  if (!repo.gitRoot) {
    for (const item of items) result.set(item.id, { validity: 'unverifiable', changed: [] });
    return result;
  }
  const gitRoot = repo.gitRoot;
  const paths = [...new Set(items.flatMap(item => (anchorsOf.get(item.id) ?? []).map(anchor => anchor.path)))];
  const present = (await Promise.all(paths.map(path => stat(posix.join(gitRoot.replaceAll('\\', '/'), path)).then(() => true, () => false))));
  const existing = paths.filter((_, index) => present[index]);
  const hashes = await git.hashFiles(gitRoot, existing);
  const current = new Map<string, string>(existing.map((path, index) => [path, hashes[index]]));
  // 路径已不存在时，按 blob 在索引中找内容未变的重命名；找到就按新路径重新判断。
  const lostBlobs = items.flatMap(item => (anchorsOf.get(item.id) ?? []).filter(anchor => !current.has(anchor.path) && anchor.postBlob).map(anchor => anchor.postBlob!));
  const renamed = lostBlobs.length ? await git.pathsWithBlob(gitRoot, lostBlobs) : new Map<string, string>();
  const ancestors = new Map(await Promise.all([...new Set(items.flatMap(item => item.commitSha ? [item.commitSha] : []))]
    .map(async commit => [commit, await git.isAncestor(gitRoot, commit)] as const)));

  for (const item of items) {
    const outcomes = (anchorsOf.get(item.id) ?? []).map(anchor => ({ anchor, outcome: judge(anchor, current.get(anchor.path), renamed) }));
    const changed = outcomes.filter(({ outcome }) => outcome === 'drifted' || outcome === 'missing').map(({ anchor }) => anchor.path);
    const allMatch = outcomes.every(({ outcome }) => outcome === 'match');
    let validity: MemoryValidity = 'current';
    if (outcomes.some(({ outcome }) => outcome === 'reverted')) validity = 'reverted';
    else if (item.commitSha && ancestors.get(item.commitSha) === false && !allMatch) validity = 'not_in_history';
    else if (changed.length) validity = 'drifted';
    result.set(item.id, { validity, changed });
  }
  return result;
}

function judge(anchor: Anchor, now: string | undefined, renamed: Map<string, string>): AnchorResult {
  const current = now ?? (anchor.postBlob && renamed.has(anchor.postBlob) ? anchor.postBlob : undefined);
  if (current === anchor.postBlob) return 'match';
  if (anchor.preBlob !== anchor.postBlob && current === anchor.preBlob) return 'reverted';
  return current === undefined ? 'missing' : 'drifted';
}

// 提示给模型的变化说明：漂移文件在记忆形成之后又被多少次提交触及。
export async function driftNote(repo: RepoRef, item: MemoryRow, changed: string[]): Promise<string> {
  const since = item.commitSha ?? item.baseCommit;
  const shown = changed.slice(0, 3).map(path => posix.basename(path)).join('、');
  if (!since || !repo.gitRoot) return `${shown} 已变化`;
  const commits = await git.logSince(repo.gitRoot, since, changed);
  if (!commits.length) return `${shown} 已变化（尚未提交）`;
  return `${shown} 此后有 ${commits.length >= 20 ? '20+' : commits.length} 次提交：${commits.slice(0, 2).join('；')}`;
}
