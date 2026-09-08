import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, copyFile, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const output = resolve('resources/generated');
await mkdir(output, { recursive: true });
await copyFile(resolve('AGENTS.md'), resolve(output, 'AGENTS.md'));

// 沙箱辅助程序用系统自带的 .NET Framework 编译器构建，不引入新的工具链。
const csc = join(process.env.SystemRoot ?? 'C:\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
execFileSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/optimize', `/out:${resolve(output, 'codeagent-sandbox.exe')}`, resolve('native/sandbox/Sandbox.cs')], { stdio: 'inherit' });

// 固定版本的 rg/fd 随应用分发；复制前按 tools.json 中的 SHA-256 校验。
const tools = JSON.parse(await readFile(resolve('resources/tools/tools.json'), 'utf8'));
for (const { file, sha256 } of Object.values(tools)) {
  const actual = createHash('sha256').update(await readFile(resolve('resources/tools', file))).digest('hex');
  if (actual !== sha256) throw new Error(`${file} 的 SHA-256 与 tools.json 不一致：${actual}`);
}
await cp(resolve('resources/tools'), resolve(output, 'tools'), { recursive: true });
