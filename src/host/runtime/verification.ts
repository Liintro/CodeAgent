import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { PowerShellOperations } from '@earendil-works/pi-coding-agent';
import { FEEDBACK_PREFIX } from '../../shared/constants.js';
import type { ParsedFailure, RootView, VerificationResult, VerifyCommand } from '../../shared/contracts.js';
import { parseFailure, sandboxBlocked } from '../engineering/index.js';

type Exec = PowerShellOperations['exec'];

const LOG_CAP = 5 * 1024 * 1024;
const TAIL_LINES = 200;
const TAIL_BYTES = 16 * 1024;

export type VerifyContext = {
  evidenceDir: string;
  attempt: number;
  exec: Exec;
  sandboxed: boolean;
  signal?: AbortSignal;
  onStart: (command: VerifyCommand, root: RootView) => void;
  onFinish: (result: VerificationResult, root: RootView) => void;
};

// 按顺序执行；第一个失败即停止，其后的命令不再运行。
export async function verifyRoots(ctx: VerifyContext, targets: { root: RootView; commands: VerifyCommand[]; tree?: string }[]): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];
  await mkdir(ctx.evidenceDir, { recursive: true });
  for (const { root, commands, tree } of targets) {
    for (const command of commands) {
      ctx.onStart(command, root);
      const result = await runCommand(ctx, root, command, tree);
      results.push(result);
      ctx.onFinish(result, root);
      if (result.status !== 'passed') return results;
    }
  }
  return results;
}

async function runCommand(ctx: VerifyContext, root: RootView, command: VerifyCommand, tree?: string): Promise<VerificationResult> {
  const capture = new OutputCapture();
  const started = Date.now();
  let status: VerificationResult['status'];
  let exitCode: number | undefined;
  try {
    const result = await ctx.exec(command.command, root.path, { onData: chunk => capture.push(chunk), signal: ctx.signal, timeout: command.timeoutSeconds, env: process.env });
    exitCode = result.exitCode ?? undefined;
    status = exitCode === 0 ? 'passed' : 'failed';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (ctx.signal?.aborted || message === 'aborted') status = 'cancelled';
    else if (message.startsWith('timeout:')) status = 'timeout';
    else {
      status = 'unavailable';
      capture.push(Buffer.from(message));
    }
  }
  let output = capture.text();
  const blocked = status === 'failed' && ctx.sandboxed ? sandboxBlocked(output) : undefined;
  if (blocked) {
    status = 'unavailable';
    output += `
${blocked}`;
  }
  const logFile = join(ctx.evidenceDir, `verify-${ctx.attempt}-${command.id}.log`);
  await writeFile(logFile, output, 'utf8');
  const failure = status === 'failed' || status === 'timeout' ? parseFailure(output, root.path) : undefined;
  return {
    commandId: command.id, rootId: root.id, label: command.label, command: command.command, attempt: ctx.attempt, status, exitCode, durationMs: Date.now() - started, logFile, outputTail: tail(output), treeAtStart: tree,
    ...(failure && (failure.tests.length || failure.diagnostics.length) ? { failure } : {}),
  };
}

// 日志保留开头与结尾，中间超限部分以标记替代。
class OutputCapture {
  private readonly decoder = new StringDecoder('utf8');
  private head = '';
  private tailText = '';
  private truncated = false;

  push(chunk: Buffer): void {
    const text = this.decoder.write(chunk);
    if (!this.truncated && this.head.length + text.length <= LOG_CAP) {
      this.head += text;
      return;
    }
    this.truncated = true;
    this.tailText = (this.tailText + text).slice(-LOG_CAP / 2);
  }

  text(): string {
    const rest = this.decoder.end();
    if (!this.truncated) return this.head + rest;
    return `${this.head.slice(0, LOG_CAP / 2)}\n…（输出过长，中间部分已省略）…\n${this.tailText + rest}`;
  }
}

export function tail(output: string): string {
  const lines = output.split(/\r?\n/);
  const text = lines.slice(-TAIL_LINES).join('\n');
  return text.length > TAIL_BYTES ? text.slice(-TAIL_BYTES) : text;
}

// 比较两次失败是否相同：能解析出失败测试与诊断时只比较它们的身份（行号会随编辑移动，不计入）；
// 否则只看带失败标记的行（编译进度等信息行首次与增量构建不同），并去掉耗时与时间戳。
export function failureHash(result: VerificationResult): string {
  if (result.failure) {
    const identity = [...result.failure.tests, ...result.failure.diagnostics.map(item => `${item.file}:${item.code ?? ''}:${item.message}`)].sort().join('\n');
    return createHash('sha1').update(`${result.status}:${result.exitCode}:parsed:${identity}`).digest('hex');
  }
  const lines = result.outputTail.split('\n').filter(line => /error|fail|exception|assert|expected|traceback/i.test(line));
  const normalized = (lines.length ? lines.join('\n') : result.outputTail)
    .replace(/\d{4}-\d\d-\d\d[T ][\d:.+Z-]+/g, '')
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|seconds)\b/g, '');
  return createHash('sha1').update(`${result.status}:${result.exitCode}:${normalized}`).digest('hex');
}

export function feedbackMessage(result: VerificationResult, rootAlias: string, attempt: number, maxRepairs: number): string {
  const outcome = result.status === 'timeout' ? '超时' : `退出码 ${result.exitCode ?? '未知'}`;
  return [
    `${FEEDBACK_PREFIX} 第 ${attempt}/${maxRepairs} 次修复`,
    `目录：${rootAlias}`,
    `命令：${result.command}`,
    `结果：${outcome}`,
    ...failureLines(result.failure),
    '输出（末尾部分）：',
    '```',
    result.outputTail,
    '```',
    '请修复导致失败的源码原因。不要修改验收命令；除非任务明确要求，不要为了通过验证而修改测试、删除测试或放宽断言。',
  ].join('\n');
}

function failureLines(failure?: ParsedFailure): string[] {
  if (!failure) return [];
  const lines: string[] = [];
  if (failure.tests.length) lines.push(`失败的测试（${failure.tests.length}）：`, ...failure.tests.map(name => `- ${name}`));
  if (failure.diagnostics.length) {
    lines.push(`编译与运行诊断（${failure.diagnostics.length}）：`);
    lines.push(...failure.diagnostics.map(item => `- ${item.file}:${item.line}${item.col ? `:${item.col}` : ''} ${item.severity === 'warning' ? '警告' : '错误'}${item.code ? ` ${item.code}` : ''}：${item.message}`));
  }
  return lines;
}
