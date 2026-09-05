import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DiffView, FileChange } from '../../shared/contracts.js';

export type GitInfo = { gitRoot: string; branch?: string; head?: string };

const DIFF_LIMIT = 256 * 1024;

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}, maxBuffer = 64 * 1024 * 1024): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile('git', ['-c', 'core.quotepath=off', ...args], {
      cwd,
      windowsHide: true,
      maxBuffer,
      env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', ...env },
    }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr }));
      else resolveOutput(stdout);
    });
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
