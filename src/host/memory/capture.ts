import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { CONTINUE_TEXT, IMPLEMENT_PLAN_TEXT, VERIFY_ONLY_TEXT } from '../../shared/constants.js';
import type { Acceptance, DeliveryView, RootDelivery, RootView, VerificationResult } from '../../shared/contracts.js';
import type { Ledger } from '../runtime/ledger.js';
import { failureHash } from '../runtime/verification.js';
import * as git from '../workspace/git.js';
import { repoOf, type RepoRef } from './repo.js';
import type { Anchor, MemoryStore, NewMemory } from './store.js';

const GOAL_LIMIT = 120;
const FAILURE_LINES = 3;
const FAILURE_LINE_LIMIT = 160;
const EXCERPT_LIMIT = 1500;
const MAX_ANCHORS = 50;
const HIDDEN = '[已隐藏]';

export type CaptureTask = { id: string; title: string; roots: RootView[]; acceptance: Acceptance };

// ---- 最小的密钥过滤：常见的令牌形态，不声称完备 ----

const SECRET_FILE = /^\.env|\.pem$|\.key$|secret|credential/i;
const SECRET_LINE = [
  /sk-[A-Za-z0-9_-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /(api[_-]?key|secret|token|passw(or)?d)\s*[:=]\s*\S+/i,
  /Authorization:\s*Bearer\s+\S+/i,
];

// 私钥块从 BEGIN 行到 END 行整段隐藏，其余按行匹配。
export function scrub(text: string): string {
  let inKey = false;
  return text.split('\n').map(line => {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line)) inKey = !/-----END [A-Z ]*PRIVATE KEY-----/.test(line);
    else if (inKey) inKey = !/-----END [A-Z ]*PRIVATE KEY-----/.test(line);
    else return SECRET_LINE.some(pattern => pattern.test(line)) ? HIDDEN : line;
    return HIDDEN;
  }).join('\n');
}

// 密钥类文件只保留路径；其余文件的差异逐行过滤。
function scrubDiff(diff: string): string {
  return diff.split(/^(?=diff --git )/m).map(section => {
    const path = /^diff --git a\/(.+?) b\//.exec(section)?.[1];
    if (path && SECRET_FILE.test(basename(path))) return `# ${path}（内容未保存）\n`;
    return scrub(section.split('\n').filter(line => !line.startsWith('index ')).join('\n'));
  }).join('');
}

// ---- 捕获 ----

/**
 * 从已验证的结果生成记忆。先异步读取 Git，再用一个 SQLite 事务写入全部条目：任一步失败都不会留下半截数据。
 * 同一结果可以重复调用（签名去重），Accept 与 Commit 之后再次调用以补上 commit_sha。
 */
export async function captureOutcome(store: MemoryStore, ledger: Ledger, task: CaptureTask, view: DeliveryView, runId: string, commitShas: Map<string, string>): Promise<{ id: string; kind: string }[]> {
  const items: NewMemory[] = [];
  for (const entry of view.roots) {
    const root = task.roots.find(item => item.id === entry.rootId);
    if (!root?.git || !isEligible(entry, task.acceptance)) continue;
    const repo = await repoOf(root);
    const goal = goalOf(ledger, task, entry.rootId);
    const base = { repoId: repo.id, repoLabel: repo.label, origin: 'harness' as const, confirmed: false, taskId: task.id, runId, branch: entry.branch, baseCommit: entry.baseCommit, commitSha: commitShas.get(entry.rootId) };
    const passed = entry.verification.filter(result => result.status === 'passed');
    items.push(
      await changeItem(base, repo, entry, passed, goal, task.id),
      ...await conventionItems(base, repo, entry, passed, root.path),
      ...await fixItems(base, repo, entry, ledger.taskEvents(task.id, 'verification.finished').map(event => ({ runId: event.runId, result: event.data as unknown as VerificationResult }))),
    );
  }
  return store.transaction(() => items.map(item => ({ id: store.save(item), kind: item.kind })));
}

// 该目录已有变更，且它的每条验收命令在当前这棵树上都通过；与交付状态（含用户已接受/提交）无关，已还原的目录不捕获。
function isEligible(entry: RootDelivery, acceptance: Acceptance): boolean {
  if (!entry.git || !entry.baseTree || !entry.finalTree || !entry.files.length || entry.state === 'restored') return false;
  const commands = acceptance.commands.filter(command => command.rootId === entry.rootId);
  return commands.length > 0 && commands.every(command => entry.verification.some(result => result.commandId === command.id && result.status === 'passed'));
}

type Base = Pick<NewMemory, 'repoId' | 'repoLabel' | 'origin' | 'confirmed' | 'taskId' | 'runId' | 'branch' | 'baseCommit' | 'commitSha'>;

async function changeItem(base: Base, repo: RepoRef, entry: RootDelivery, passed: VerificationResult[], goal: string, taskId: string): Promise<NewMemory> {
  const files = entry.files.slice(0, MAX_ANCHORS);
  const paths = files.map(file => repo.prefix + file.path);
  const anchors = await anchorsBetween(repo, entry.baseTree!, entry.finalTree!, paths);
  const shown = files.slice(0, 5).map(file => file.path).join('、');
  const commands = [...new Set(passed.map(result => `\`${scrub(result.command)}\``))].join('、');
  return {
    ...base, kind: 'change', signature: signature('change', repo.id, `${taskId}|${entry.rootId}`), anchors,
    text: `${scrub(`任务：${goal}`)}。变更 ${entry.files.length} 个文件：${shown}${entry.files.length > 5 ? ' 等' : ''}。已由 ${commands} 验证。`,
    evidence: { goal: scrub(goal), commands: passed.map(({ command, label, exitCode, durationMs }) => ({ command: scrub(command), label, exitCode, durationMs })), files: files.map(({ path, status, additions, deletions }) => ({ path, status, additions, deletions })), baseTree: entry.baseTree, finalTree: entry.finalTree },
  };
}

// 验证命令通过一次就是一条“可用的验证命令”；锚点是触发该检测的构建文件，它变了这条记忆就降为 drifted。
async function conventionItems(base: Base, repo: RepoRef, entry: RootDelivery, passed: VerificationResult[], rootPath: string): Promise<NewMemory[]> {
  const items: NewMemory[] = [];
  for (const result of new Map(passed.map(item => [item.commandId, item])).values()) {
    const candidates = buildFilesFor(result.command).map(name => repo.prefix + name);
    const blobs = await git.blobsAt(repo.gitRoot!, entry.finalTree!, candidates);
    const anchors: Anchor[] = candidates.flatMap((path, index) => blobs[index] ? [{ path, preBlob: blobs[index], postBlob: blobs[index] }] : []);
    items.push({
      ...base, kind: 'convention', signature: signature('convention', repo.id, `${result.command}|${repo.label}`), anchors,
      text: `${repo.label} 的可用验证命令：\`${scrub(result.command)}\`（${result.label}，耗时约 ${Math.max(1, Math.round(result.durationMs / 1000))}s）`,
      evidence: { command: scrub(result.command), label: result.label, durationMs: result.durationMs, rootPath },
    });
  }
  return items;
}

function buildFilesFor(command: string): string[] {
  if (/\b(mvn|mvnw)/i.test(command)) return ['pom.xml'];
  if (/\bgradle/i.test(command)) return ['build.gradle', 'build.gradle.kts'];
  if (/pytest/i.test(command)) return ['pyproject.toml', 'pytest.ini'];
  return [];
}

// 同一次 Run 内同一条命令先失败、后通过：失败与通过之间的差异就是被验证过的修复。
async function fixItems(base: Base, repo: RepoRef, entry: RootDelivery, results: { runId: string; result: VerificationResult }[]): Promise<NewMemory[]> {
  const pending = new Map<string, VerificationResult>();
  const items: NewMemory[] = [];
  for (const { runId, result } of results) {
    if (result.rootId !== entry.rootId) continue;
    const key = `${runId}|${result.commandId}`;
    const failed = pending.get(key);
    if (result.status === 'passed' && failed?.treeAtStart && result.treeAtStart && failed.treeAtStart !== result.treeAtStart) {
      pending.delete(key);
      items.push(await fixItem(base, repo, failed, result));
    } else if (result.status === 'failed' || result.status === 'timeout') {
      pending.set(key, result);
    }
  }
  return items;
}

async function fixItem(base: Base, repo: RepoRef, failed: VerificationResult, fixed: VerificationResult): Promise<NewMemory> {
  const paths = (await git.treeChanges(repo.gitRoot!, failed.treeAtStart!, fixed.treeAtStart!)).slice(0, MAX_ANCHORS);
  const anchors = await anchorsBetween(repo, failed.treeAtStart!, fixed.treeAtStart!, paths);
  const lines = failureLines(failed.outputTail);
  const excerpt = scrubDiff(await git.treeDiff(repo.gitRoot!, failed.treeAtStart!, fixed.treeAtStart!)).slice(0, EXCERPT_LIMIT);
  const hash = failureHash(failed);
  return {
    ...base, kind: 'fix', anchors, signature: signature('fix', repo.id, `${hash}|${[...paths].sort().join(',')}`),
    text: `${repo.label}：\`${scrub(failed.command)}\` 失败：${lines.join('；') || '无输出'}。修复涉及 ${paths.slice(0, 5).join('、')}${paths.length > 5 ? ' 等' : ''}；修复后通过。`,
    evidence: { command: scrub(failed.command), failureHash: hash, failureLines: lines, fixExcerpt: excerpt, failedTree: failed.treeAtStart, fixedTree: fixed.treeAtStart },
  };
}

function failureLines(outputTail: string): string[] {
  const noise = /^\[(INFO|ERROR)\]\s*(Failures:|Errors:|Tests run:|BUILD|Failed to execute|-> \[Help|To see|Re-run|For more|\s*$)/;
  return scrub(outputTail).split(/\r?\n/).map(line => line.trim()).filter(line => /error|fail|expected|assert|exception/i.test(line) && !noise.test(line))
    .slice(0, FAILURE_LINES).map(line => line.slice(0, FAILURE_LINE_LIMIT));
}

async function anchorsBetween(repo: RepoRef, before: string, after: string, paths: string[]): Promise<Anchor[]> {
  const [pre, post] = await Promise.all([git.blobsAt(repo.gitRoot!, before, paths), git.blobsAt(repo.gitRoot!, after, paths)]);
  return paths.map((path, index) => ({ path, preBlob: pre[index], postBlob: post[index] }));
}

// 目标取自第一个真正改动了该目录的 Run 的用户请求；“继续”“实施计划”“手动验证”这类通用文本不算。
function goalOf(ledger: Ledger, task: CaptureTask, rootId: string): string {
  const generic = new Set([CONTINUE_TEXT, IMPLEMENT_PLAN_TEXT, VERIFY_ONLY_TEXT]);
  const runs = new Map<string, { text: string; start?: unknown; end?: unknown }>();
  for (const event of ledger.taskEvents(task.id, 'run.started', 'git.snapshot')) {
    const run = runs.get(event.runId) ?? { text: '' };
    if (event.type === 'run.started') run.text = String(event.data.userTextPreview ?? '');
    else if (event.data.rootId === rootId) run[event.data.kind === 'run_start' ? 'start' : 'end'] = event.data.tree;
    runs.set(event.runId, run);
  }
  const usable = [...runs.values()].filter(run => run.text && !generic.has(run.text));
  const text = usable.find(run => run.start && run.end && run.start !== run.end)?.text ?? usable[0]?.text ?? task.title;
  return text.replace(/\s+/g, ' ').slice(0, GOAL_LIMIT);
}

function signature(kind: string, repoId: string, key: string): string {
  return createHash('sha1').update(`${kind}|${repoId}|${key}`).digest('hex');
}
