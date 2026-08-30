import { execFileSync } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const output = resolve('resources/generated');
await mkdir(output, { recursive: true });
await copyFile(resolve('AGENTS.md'), resolve(output, 'AGENTS.md'));

// 沙箱辅助程序用系统自带的 .NET Framework 编译器构建，不引入新的工具链。
const csc = join(process.env.SystemRoot ?? 'C:\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
execFileSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/optimize', `/out:${resolve(output, 'codeagent-sandbox.exe')}`, resolve('native/sandbox/Sandbox.cs')], { stdio: 'inherit' });
