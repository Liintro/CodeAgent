import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createLocalPowerShellOperations, type PowerShellOperations } from '@earendil-works/pi-coding-agent';
import { FEEDBACK_PREFIX } from '../../shared/constants.js';
import type { ParsedFailure, RootView, VerificationResult, VerifyCommand } from '../../shared/contracts/index.js';
import { parseFailure, sandboxBlocked } from '../engineering/index.js';
import type { TaskState, Workbench } from './workbench.js';

type Exec = PowerShellOperations['exec'];

const LOG_CAP = 5 * 1024 * 1024;

type TailLimit = { lines: number; chars: number };

export type VerifyContext = {
  evidenceDir: string;
  attempt: number;
  exec: Exec;
  sandboxed: boolean;
  /** 失败反馈里保留的输出尾部。 */
  tail: TailLimit;
  signal?: AbortSignal;
  onStart: (command: VerifyCommand, root: RootView) => void;
  onFinish: (result: VerificationResult, root: RootView) => void;
};

// 与交互式 Shell 使用同一种运行方式：Auto 只用已验证的沙箱，沙箱失败绝不改用直接运行。
export async function runVerification(wb: Workbench, task: TaskState, runId: string, attempt: number, targets: { root: RootView; tree: string }[]): Promise<VerificationResult[]> {
  const mode = task.permission.userMode;
  const sandboxed = mode !== 'bypass' && wb.sandboxReady(task);
  const exec = sandboxed
    ? wb.sandbox!.operations().exec
    : mode === 'auto'
      ? async () => { throw new Error('Auto 模式需要已验证且已授权的沙箱，验证命令未执行'); }
      : (wb.sandbox?.directOperations() ?? createLocalPowerShellOperations()).exec;
  wb.setPhase(task, 'verifying', attempt);
  const itemId = (commandId: string) => `${runId}-${attempt}-${commandId}`;
  return verifyRoots(
    {
      evidenceDir: join(wb.evidenceRoot(), task.id, runId), attempt, exec, sandboxed, signal: wb.active?.verifyAbort.signal,
      tail: { lines: wb.policy.settings.output.verificationTailLines, chars: wb.policy.settings.output.verificationTailChars },
      onStart: (command, root) => {
        wb.ledger.appendEvent(runId, 'verification.started', { attempt, commandId: command.id, label: command.label, command: command.command, rootId: root.id, runnerKind: sandboxed ? 'sandbox' : 'direct' });
        wb.upsertVerification(task, { kind: 'verification', id: itemId(command.id), attempt, rootAlias: root.alias, commandLabel: command.label, command: command.command, state: 'running', outputTail: '' });
      },
      onFinish: (result, root) => {
        wb.ledger.appendEvent(runId, 'verification.finished', { ...result });
        wb.upsertVerification(task, {
          kind: 'verification', id: itemId(result.commandId), attempt, rootAlias: root.alias, commandLabel: result.label, command: result.command,
          state: result.status, exitCode: result.exitCode, durationMs: result.durationMs, outputTail: result.outputTail, logFile: result.logFile, failure: result.failure,
        });
      },
    },
    targets.map(({ root, tree }) => ({ root, tree, commands: wb.commandsOf(task, root.id) })),
  );
}

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
    commandId: command.id, rootId: root.id, label: command.label, command: command.command, attempt: ctx.attempt, status, exitCode, durationMs: Date.now() - started, logFile, outputTail: tail(output, ctx.tail), treeAtStart: tree,
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

export function tail(output: string, limit: TailLimit): string {
  const lines = output.split(/\r?\n/);
  const text = lines.slice(-limit.lines).join('\n');
  return text.length > limit.chars ? text.slice(-limit.chars) : text;
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
