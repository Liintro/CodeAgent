import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { loadProjectContextFiles } from '@earendil-works/pi-coding-agent';
import type { RootView } from '../../shared/contracts.js';
import { detect } from './git.js';

export async function openRoot(path: string, existing: RootView[]): Promise<RootView> {
  const resolved = await realpath(path);
  if (!(await stat(resolved)).isDirectory()) throw new Error('所选路径不是目录');
  if (existing.some(root => root.path.toLowerCase() === resolved.toLowerCase())) throw new Error('该目录已在当前任务中');
  const base = basename(resolved) || resolved;
  let alias = base;
  for (let suffix = 2; existing.some(root => root.alias === alias); suffix++) alias = `${base}-${suffix}`;
  return { id: randomUUID(), alias, path: resolved, primary: existing.length === 0, git: await detect(resolved), sandboxGranted: false };
}

export type RulesResult = { text: string; sources: string[] };

// agentDir 指向不存在的目录，避免用户级 Pi 规则混入；每个目录的规则文件按所属根标注。
export async function readWorkspaceRules(roots: RootView[], builtInRulesPath: string): Promise<RulesResult> {
  const sources: string[] = [];
  const sections = [await readFile(builtInRulesPath, 'utf8')];
  const agentDir = join(tmpdir(), 'codeagent-no-user-rules');
  for (const root of roots) {
    const files = loadProjectContextFiles({ cwd: root.path, agentDir });
    sections.push(`## Rules for root ${root.alias} (applies to files under ${root.path})${files.length ? '' : '\n（无项目规则文件）'}`);
    for (const file of files) {
      sources.push(file.path);
      sections.push(`### ${file.path}\n${file.content}`);
    }
  }
  return { text: sections.join('\n\n'), sources };
}
