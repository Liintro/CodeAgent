import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { delimiter, join, relative, sep } from 'node:path';
import type { Diagnostic, ParsedFailure } from '../../shared/contracts.js';

// 每个生态一个普通对象：检测项目、给出建议命令（PowerShell 5.1 语法）、解析真实输出。没有注册表或插件机制。
export type Proposal = { label: string; command: string; timeoutSeconds: number; toolchain?: string; problem?: string };
export type Adapter = {
  id: string;
  detect(root: string, sandboxed: boolean): Promise<Proposal[]>;
  parse(output: string): ParsedFailure;
  /** 只在 Auto 沙箱里出现、源码修改无法解决的失败：验证记为 unavailable，而不是交给模型修复。 */
  sandboxBlocked?: { pattern: RegExp; reason: string };
};

const EXTENSIONS = ['.exe', '.cmd', '.bat'];

export function findExecutable(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    for (const extension of EXTENSIONS) {
      const candidate = join(directory, name + extension);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

// 运行版本命令；失败（不存在、崩溃、超时）返回 undefined。.cmd/.bat 需要经 cmd.exe 启动。
export function probe(executable: string, args: string[], timeoutMs = 15000): Promise<string | undefined> {
  const batch = /\.(cmd|bat)$/i.test(executable);
  const [file, argv] = batch ? ['cmd.exe', ['/d', '/s', '/c', `"${executable}" ${args.join(' ')}`]] : [executable, args];
  return new Promise(resolve => {
    execFile(file, argv, { windowsHide: true, timeout: timeoutMs, windowsVerbatimArguments: batch }, (error, stdout, stderr) => {
      resolve(error ? undefined : `${stdout}${stderr}`.trim().split(/\r?\n/)[0]);
    });
  });
}

export const has = (root: string, name: string) => existsSync(join(root, name));

export function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

export function readText(path: string): string {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

export function listFiles(directory: string): string[] {
  try { return readdirSync(directory); } catch { return []; }
}

// PowerShell 单引号字面量。
export const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;

// 第一个命令失败时不再运行后面的；退出码原样返回给验证。
export function sequence(...commands: string[]): string {
  if (commands.length === 1) return commands[0];
  return `${commands.map((command, index) => index ? `if ($LASTEXITCODE -eq 0) { ${command} }` : command).join('; ')}; exit $LASTEXITCODE`;
}

export function missing(tool: string): string {
  return `未在 PATH 中找到 ${tool}`;
}

// 输出里的绝对路径换成相对工作目录的路径，正反斜杠统一为 /。
export function relativize(file: string, root: string): string {
  const normalized = file.replaceAll('/', sep);
  const relation = relative(root, normalized);
  const inside = /^[a-z]:/i.test(normalized) && !relation.startsWith('..');
  return (inside ? relation : file).replaceAll('\\', '/').replace(/^\.\//, '');
}

export function diagnostic(file: string, line: string | number, col: string | number | undefined, message: string, severity: Diagnostic['severity'] = 'error', code?: string): Diagnostic {
  return { file, line: Number(line), ...(col !== undefined && col !== '' ? { col: Number(col) } : {}), severity, ...(code ? { code } : {}), message: message.trim() };
}

export function matches(output: string, pattern: RegExp): RegExpMatchArray[] {
  return [...output.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))];
}
