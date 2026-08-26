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
