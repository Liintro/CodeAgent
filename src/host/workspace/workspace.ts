import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { WorkspaceRoot } from '../../shared/contracts.js';

export async function openWorkspace(path: string): Promise<WorkspaceRoot> {
  const resolved = await realpath(path);
  if (!(await stat(resolved)).isDirectory()) throw new Error('所选路径不是目录');
  return { id: randomUUID(), name: basename(resolved) || resolved, path: resolved };
}

export async function readWorkspaceRules(root: WorkspaceRoot | undefined, builtInRulesPath: string): Promise<string> {
  const builtIn = await readFile(builtInRulesPath, 'utf8');
  if (!root) return builtIn;
  let project = '';
  try {
    project = await readFile(join(root.path, 'AGENTS.md'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return `${builtIn}\n\n当前项目目录：${root.path}\n${project ? `\n项目 AGENTS.md：\n${project}` : ''}`;
}
