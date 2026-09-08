import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DiffView, FileChange } from '../../shared/contracts.js';

export type GitInfo = { gitRoot: string; branch?: string; head?: string };

const DIFF_LIMIT = 256 * 1024;

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}, maxBuffer = 64 * 1024 * 1024, input?: string): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = execFile('git', ['-c', 'core.quotepath=off', ...args], {
      cwd,
      windowsHide: true,
      maxBuffer,
      env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', ...env },
    }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr }));
      else resolveOutput(stdout);
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

// Git 不存在或目录不在仓库内时返回 undefined，Git 功能随之关闭，不影响其他能力。
export async function detect(rootPath: string): Promise<GitInfo | undefined> {
  let toplevel: string;
  try {
    toplevel = (await git(rootPath, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return undefined;
  }
  const branch = await git(rootPath, ['symbolic-ref', '--short', '-q', 'HEAD']).then(value => value.trim() || undefined, () => undefined);
  const head = await git(rootPath, ['rev-parse', '--verify', '-q', 'HEAD']).then(value => value.trim() || undefined, () => undefined);
  return { gitRoot: resolve(toplevel), branch, head };
}

// 在临时索引副本上执行 add -A 并 write-tree：不触碰用户的索引与工作区文件。
export async function snapshot(rootPath: string): Promise<string> {
  const indexPath = (await git(rootPath, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim();
  const toplevel = (await git(rootPath, ['rev-parse', '--show-toplevel'])).trim();
  const directory = await mkdtemp(join(tmpdir(), 'codeagent-index-'));
  const temporary = join(directory, 'index');
  try {
    if (await stat(indexPath).then(() => true, () => false)) await copyFile(indexPath, temporary);
    const env = { GIT_INDEX_FILE: temporary };
    await git(toplevel, ['add', '-A'], env);
    return (await git(toplevel, ['write-tree'], env)).trim();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function changes(rootPath: string, baseTree: string, nowTree: string): Promise<FileChange[]> {
  const base = ['diff', '--find-renames', '--relative', '-z'];
  const [names, numbers] = await Promise.all([
    git(rootPath, [...base, '--name-status', baseTree, nowTree]),
    git(rootPath, [...base, '--numstat', baseTree, nowTree]),
  ]);
  const counts = new Map<string, { additions: number; deletions: number }>();
  const numberTokens = numbers.split('\0');
  for (let index = 0; index < numberTokens.length; index++) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(numberTokens[index]);
    if (!match) continue;
    let path = match[3];
    if (!path) { path = numberTokens[index + 2]; index += 2; }
    counts.set(path, { additions: match[1] === '-' ? 0 : Number(match[1]), deletions: match[2] === '-' ? 0 : Number(match[2]) });
  }
  const files: FileChange[] = [];
  const nameTokens = names.split('\0');
  for (let index = 0; index < nameTokens.length; index++) {
    const status = nameTokens[index];
    if (!status) continue;
    const kind = status[0];
    const path = kind === 'R' || kind === 'C' ? nameTokens[index += 2] : nameTokens[++index];
    files.push({ path, status: kind === 'A' || kind === 'D' || kind === 'R' ? kind : 'M', ...(counts.get(path) ?? { additions: 0, deletions: 0 }) });
  }
  return files;
}

export async function diff(rootPath: string, baseTree: string, nowTree: string, rootId: string, path: string): Promise<DiffView> {
  const patch = await git(rootPath, ['diff', '--find-renames', '--relative', '-U3', baseTree, nowTree, '--', path]);
  const truncated = patch.length > DIFF_LIMIT;
  return { rootId, path, patch: truncated ? patch.slice(0, DIFF_LIMIT) : patch, truncated };
}

export type GitReadOp = 'status' | 'diff' | 'log' | 'show';

// 只读 git 工具使用固定参数表，不经过 shell。
export async function readOnly(rootPath: string, op: GitReadOp, rev?: string, path?: string): Promise<string> {
  for (const value of [rev, path]) if (value?.startsWith('-')) throw new Error('参数不能以 - 开头');
  const args: Record<GitReadOp, string[]> = {
    status: ['status', '--short', '--branch'],
    diff: ['diff', ...(rev ? [rev] : [])],
    log: ['log', '-n', '50', '--oneline', ...(rev ? [rev] : [])],
    show: ['show', '--stat', '--patch', rev ?? 'HEAD'],
  };
  return git(rootPath, [...args[op], ...(path ? ['--', path] : [])]);
}

// ---- 交付：补丁、还原、路径限定提交 ----

export async function patch(rootPath: string, baseTree: string, nowTree: string): Promise<string> {
  return git(rootPath, ['diff', '--find-renames', '--relative', '--binary', baseTree, nowTree]);
}

// 不做重命名检测：还原需要精确的新增、修改、删除路径。
export async function changedPaths(rootPath: string, baseTree: string, nowTree: string): Promise<{ path: string; status: 'A' | 'M' | 'D' }[]> {
  const tokens = (await git(rootPath, ['diff', '--no-renames', '--relative', '--name-status', '-z', baseTree, nowTree])).split('\0');
  const result: { path: string; status: 'A' | 'M' | 'D' }[] = [];
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    if (tokens[index]) result.push({ path: tokens[index + 1], status: tokens[index][0] === 'A' || tokens[index][0] === 'D' ? tokens[index][0] as 'A' | 'D' : 'M' });
  }
  return result;
}

// 某个树对象中该路径的内容标识；不存在返回 undefined。
export async function blobAt(rootPath: string, tree: string, path: string): Promise<string | undefined> {
  return git(rootPath, ['rev-parse', '--verify', '-q', `${tree}:./${path}`]).then(value => value.trim() || undefined, () => undefined);
}

export async function restoreFrom(rootPath: string, tree: string, paths: string[]): Promise<void> {
  if (paths.length) await git(rootPath, ['restore', `--source=${tree}`, '--worktree', '--', ...paths]);
}

// 基线时用户已有的未提交修改所涉及的路径。
export async function dirtyPaths(rootPath: string, baseCommit: string | undefined, baseTree: string): Promise<string[]> {
  const base = baseCommit ?? '4b825dc642cb6eb9a060e54bf8d69288fbf2594e';
  return (await git(rootPath, ['diff', '--no-renames', '--relative', '--name-only', '-z', base, baseTree])).split('\0').filter(Boolean);
}

// 只提交给定路径：新文件先用 add -N 登记意图，再 commit --only；用户索引中其他已暂存内容保持不变。
export async function commitPaths(rootPath: string, message: string, tracked: string[], created: string[]): Promise<string> {
  if (created.length) await git(rootPath, ['add', '-N', '--', ...created]);
  await git(rootPath, ['commit', '--only', '-m', message, '--', ...tracked, ...created]);
  return (await git(rootPath, ['rev-parse', 'HEAD'])).trim();
}

// ---- 记忆：仓库标识、内容标识与有效性检查（只读，路径均相对 Git 顶层目录） ----

// 第一个根提交的哈希，克隆、工作树和目录移动后保持不变。浅克隆的“根”只是截断边界，空仓库没有提交，
// 这两种情况退回到按路径区分的标识。
export async function repoId(gitRoot: string): Promise<string> {
  const shallow = await git(gitRoot, ['rev-parse', '--is-shallow-repository']).then(value => value.trim() === 'true', () => false);
  const roots = shallow ? '' : await git(gitRoot, ['rev-list', '--max-parents=0', 'HEAD']).catch(() => '');
  return roots.split('\n').filter(Boolean).sort()[0] ?? pathRepoId(gitRoot);
}

export function pathRepoId(path: string): string {
  return `path:${createHash('sha1').update(path.toLowerCase()).digest('hex').slice(0, 16)}`;
}

// 目录相对 Git 顶层目录的前缀（目录是子目录时才非空），带结尾的斜杠。
export async function prefixOf(rootPath: string): Promise<string> {
  return (await git(rootPath, ['rev-parse', '--show-prefix'])).trim();
}

// 批量读取树中路径的 blob 标识；路径不存在对应 undefined。一次进程调用，避免逐个路径启动 git（Windows 上每次约 100 ms）。
export async function blobsAt(gitRoot: string, tree: string, paths: string[]): Promise<(string | undefined)[]> {
  if (!paths.length) return [];
  const output = await git(gitRoot, ['cat-file', '--batch-check'], {}, 64 * 1024 * 1024, paths.map(path => `${tree}:${path}`).join('\n') + '\n');
  return output.split('\n').slice(0, paths.length).map(line => /^([0-9a-f]{40}) blob /.exec(line)?.[1]);
}

// 工作区文件当前的 blob 标识（与树中的标识同一算法，含换行转换）；调用方保证文件存在。
export async function hashFiles(gitRoot: string, paths: string[]): Promise<string[]> {
  if (!paths.length) return [];
  return (await git(gitRoot, ['hash-object', '--stdin-paths'], {}, 64 * 1024 * 1024, paths.join('\n') + '\n')).split('\n').filter(Boolean);
}

export async function isAncestor(gitRoot: string, commit: string): Promise<boolean> {
  return git(gitRoot, ['merge-base', '--is-ancestor', commit, 'HEAD']).then(() => true, () => false);
}

// since 之后触及这些路径的提交（最多 20 条，短哈希加标题）。
export async function logSince(gitRoot: string, since: string, paths: string[]): Promise<string[]> {
  const output = await git(gitRoot, ['log', '--format=%h %s', '-n', '20', `${since}..HEAD`, '--', ...paths]).catch(() => '');
  return output.split('\n').filter(Boolean);
}

// 索引中内容为给定 blob 的路径，用于识别未改内容的重命名。
export async function pathsWithBlob(gitRoot: string, blobs: string[]): Promise<Map<string, string>> {
  const wanted = new Set(blobs);
  const found = new Map<string, string>();
  for (const line of (await git(gitRoot, ['ls-files', '-s']).catch(() => '')).split('\n')) {
    const match = /^\d+ ([0-9a-f]{40}) 0\t(.*)$/.exec(line);
    if (match && wanted.has(match[1]) && !found.has(match[1])) found.set(match[1], match[2]);
  }
  return found;
}

// 两个树之间的变更路径（相对 Git 顶层，不做重命名检测）。
export async function treeChanges(gitRoot: string, a: string, b: string): Promise<string[]> {
  return (await git(gitRoot, ['diff', '--no-renames', '--name-only', '-z', a, b])).split('\0').filter(Boolean);
}

// 两个树之间的统一差异，只用于生成千余字符的摘录，所以最多读取前 64 KB。
export async function treeDiff(gitRoot: string, a: string, b: string): Promise<string> {
  return (await git(gitRoot, ['diff', '--no-renames', '--no-color', '-U2', a, b])).slice(0, 64 * 1024);
}
