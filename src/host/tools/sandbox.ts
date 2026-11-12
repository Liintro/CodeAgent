import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { delimiter, join } from 'node:path';
import type { PowerShellOperations } from '@earendil-works/pi-coding-agent';
import type { SandboxStatus } from '../../shared/contracts.js';

const UTF8_OUTPUT_PREFIX = 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n';

export class SandboxRunner {
  readonly capSid: string;
  status: SandboxStatus = 'untested';
  detail?: string;

  constructor(private readonly exe: string, private tempDir: string) {
    const digest = createHash('sha256').update(`CodeAgent|${hostname()}|${userInfo().username}`).digest();
    const parts = [0, 4, 8, 12].map(offset => digest.readUInt32LE(offset));
    this.capSid = `S-1-5-21-${parts.join('-')}`;
  }

  // 真实自检：必须先证明同一用户能写到沙箱外（且该目录对 Everyone 可写），再证明受限进程及其子进程被操作系统拒绝。
  async verify(): Promise<SandboxStatus> {
    // Low 完整性进程无法解析 8.3 短路径（如 TEMP 为 C:\Users\ABCDEF~1\…），交给沙箱的路径一律先换成长路径。
    const base = await realpath(await mkdtemp(join(tmpdir(), 'codeagent-sbx-')));
    try {
      await access(this.exe);
      await mkdir(this.tempDir, { recursive: true });
      this.tempDir = await realpath(this.tempDir);
      await this.grant(this.tempDir);
      const root = join(base, 'root');
      const outside = join(base, 'outside');
      await mkdir(root);
      await mkdir(outside);
      await this.grant(root);
      await writeFile(join(outside, 'control.txt'), 'control');
      await helper('icacls', [outside, '/grant', '*S-1-1-0:(OI)(CI)M']);
      const shell = findPowerShell();
      const attempt = (name: string) => `try { Set-Content -LiteralPath '${quote(join(outside, name))}' -Value x -ErrorAction Stop } catch {}`;
      const encodedChild = Buffer.from(attempt('child.txt'), 'utf16le').toString('base64');
      // 注册表主体（HKCU\Software）同样必须写不进去；AppDataLow 是 Low 令牌的已知例外，不在此列。
      const registryKey = `HKCU\\Software\\codeagent-sbx-${process.pid}-${Date.now()}`;
      const script = [
        `Set-Content -LiteralPath '${quote(join(root, 'inside.txt'))}' -Value ok`,
        attempt('parent.txt'),
        `& '${quote(shell)}' -NoProfile -NonInteractive -EncodedCommand ${encodedChild}`,
        `try { New-Item -Path 'Registry::${quote(registryKey.replace('HKCU', 'HKEY_CURRENT_USER'))}' -ErrorAction Stop | Out-Null } catch {}`,
        'exit 0',
      ].join('; ');
      const result = await this.run(script, root);
      const exists = (path: string) => access(path).then(() => true, () => false);
      const registryWritten = await helper('reg', ['query', registryKey]).then(() => true, () => false);
      if (registryWritten) await helper('reg', ['delete', registryKey, '/f']).catch(() => undefined);
      const ok = result.exitCode === 0 && await exists(join(root, 'inside.txt')) && !registryWritten
        && !await exists(join(outside, 'parent.txt')) && !await exists(join(outside, 'child.txt'));
      this.status = ok ? 'available' : 'failed';
      this.detail = ok ? undefined : `自检未通过（退出码 ${result.exitCode}）：${result.output.slice(0, 300)}`;
    } catch (error) {
      this.status = 'unavailable';
      this.detail = error instanceof Error ? error.message : String(error);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
    return this.status;
  }

  async grant(path: string): Promise<void> {
    await helper(this.exe, ['grant', '--cap', this.capSid, '--path', path]);
  }

  async revoke(path: string): Promise<void> {
    await helper(this.exe, ['revoke', '--cap', this.capSid, '--path', path]);
  }

  operations(): PowerShellOperations {
    return this.execute(false);
  }

  // 直接运行（不受限制的令牌）也经过同一个 helper，只为获得 Job Object：Host 被强制结束时，命令进程树随之终止。
  directOperations(): PowerShellOperations | undefined {
    return existsSync(this.exe) ? this.execute(true) : undefined;
  }

  private execute(direct: boolean): PowerShellOperations {
    return {
      exec: async (command, cwd, { onData, signal, timeout, env }) => {
        if (!direct && this.status !== 'available') throw new Error('沙箱不可用，命令未执行');
        if (signal?.aborted) throw new Error('aborted');
        const child = this.spawnRunner(UTF8_OUTPUT_PREFIX + command, cwd, env, direct);
        let timedOut = false;
        let head = '';
        const kill = () => { if (child.pid) killTree(child.pid); };
        const timer = timeout && timeout > 0 ? setTimeout(() => { timedOut = true; kill(); }, timeout * 1000) : undefined;
        signal?.addEventListener('abort', kill, { once: true });
        const collect = (chunk: Buffer) => {
          if (head.length < 64) head += chunk.toString('utf8', 0, 64);
          onData(chunk);
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        try {
          const exitCode = await new Promise<number | null>((resolveExit, reject) => {
            child.on('error', reject);
            child.on('close', resolveExit);
          });
          if (signal?.aborted) throw new Error('aborted');
          if (timedOut) throw new Error(`timeout:${timeout}`);
          if (exitCode === 125 && head.startsWith('sandbox: ')) throw new Error(`${direct ? '命令启动失败' : '沙箱启动失败'}，命令未执行：${head.trim()}`);
          return { exitCode };
        } finally {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', kill);
        }
      },
    };
  }

  private run(command: string, cwd: string): Promise<{ exitCode: number | null; output: string }> {
    return new Promise((resolveRun, reject) => {
      const child = this.spawnRunner(command, cwd);
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      child.on('error', reject);
      child.on('close', exitCode => resolveRun({ exitCode, output }));
    });
  }

  private spawnRunner(command: string, cwd: string, env: NodeJS.ProcessEnv = process.env, direct = false) {
    const shellArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command];
    const cmdline = [findPowerShell(), ...shellArgs].map(quoteArg).join(' ');
    // --parent：Host 退出时 helper 终止整个 Job。
    // 只有受限令牌需要长路径；直接运行保持调用方给出的工作目录。
    const common = ['--parent', String(process.pid), '--cwd', direct ? cwd : longPath(cwd), '--cmdline', cmdline];
    if (direct) return spawn(this.exe, ['run', '--mode', 'direct', ...common], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
    // PowerShell 在 TEMP 不可写时会静默降级为 ConstrainedLanguage，因此必须指向已授权目录；uv 与 Go 的构建缓存同理。
    return spawn(this.exe, ['run', '--cap', this.capSid, ...common], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...env, TEMP: this.tempDir, TMP: this.tempDir, UV_CACHE_DIR: join(this.tempDir, 'uv-cache'), GOCACHE: join(this.tempDir, 'go-build') },
    });
  }
}

export function findPowerShell(): string {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory, 'pwsh.exe');
    if (directory && existsSync(candidate)) return candidate;
  }
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

const quote = (value: string) => value.replaceAll("'", "''");

function quoteArg(arg: string): string {
  if (arg && !/[\s"]/.test(arg)) return arg;
  let result = '"';
  let backslashes = 0;
  for (const char of arg) {
    if (char === '\\') { backslashes++; continue; }
    result += char === '"' ? `${'\\'.repeat(backslashes * 2 + 1)}"` : `${'\\'.repeat(backslashes)}${char}`;
    backslashes = 0;
  }
  return `${result}${'\\'.repeat(backslashes * 2)}"`;
}

function longPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function killTree(pid: number): void {
  execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);
}

function helper(exe: string, args: string[]): Promise<void> {
  return new Promise((resolveHelper, reject) => {
    execFile(exe, args, { windowsHide: true }, (error, _stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolveHelper();
    });
  });
}
