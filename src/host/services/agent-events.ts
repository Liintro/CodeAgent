import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { SessionManager } from '@earendil-works/pi-coding-agent';
import type { RootView, RunnerKind, TimelineItem, ToolItem } from '../../shared/contracts/index.js';
import type { TaskState, Workbench } from './workbench.js';

const ARGS_TEXT_LIMIT = 4 * 1024;
const OUTPUT_PREVIEW_LIMIT = 8 * 1024;

/** 把 Agent 的流式事件写进会话、时间线与账本。 */
export class AgentEvents {
  private assistantId?: string;

  constructor(private readonly wb: Workbench) {}

  onAgentEvent(task: TaskState, runId: string, event: AgentEvent): void {
    if (event.type === 'message_end') {
      task.session.appendMessage(event.message as Parameters<SessionManager['appendMessage']>[0]);
      // Provider 没有返回 token 数时不记录。
      if (event.message.role === 'assistant' && event.message.usage?.totalTokens > 0) {
        this.wb.ledger.appendEvent(runId, 'model.usage', { ...event.message.usage });
      }
    }
    if (event.type === 'message_start' && event.message.role === 'assistant') {
      this.assistantId = randomUUID();
      const item: TimelineItem = { kind: 'message', id: this.assistantId, role: 'assistant', text: '' };
      task.timeline.push(item);
      this.wb.emit({ type: 'message.started', id: item.id, role: 'assistant' });
    } else if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta' && this.assistantId) {
      const delta = event.assistantMessageEvent.delta;
      const item = task.timeline.find((value): value is Extract<TimelineItem, { kind: 'message' }> => value.kind === 'message' && value.id === this.assistantId);
      if (item) item.text += delta;
      this.wb.emit({ type: 'message.delta', id: this.assistantId, text: delta });
    } else if (event.type === 'message_end' && event.message.role === 'assistant') {
      const textContent = event.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
      if (this.assistantId) {
        const item = task.timeline.find((value): value is Extract<TimelineItem, { kind: 'message' }> => value.kind === 'message' && value.id === this.assistantId);
        if (item) item.text = textContent;
        this.wb.emit({ type: 'message.ended', id: this.assistantId, text: textContent });
        this.assistantId = undefined;
      }
    } else if (event.type === 'tool_execution_start') {
      const args = (event.args ?? {}) as Record<string, unknown>;
      const root = this.wb.rootFor(task, args);
      const binding = this.wb.mcp.bindings.get(event.toolName);
      const item: ToolItem = {
        kind: 'tool', toolCallId: event.toolCallId, name: event.toolName, args: event.args, state: 'requested', output: '',
        // MCP 与任务文档工具不属于任何工作目录。
        ...(binding || event.toolName.startsWith('doc_') ? {} : { rootId: root?.id, rootAlias: root?.alias, cwd: root?.path }),
        source: binding ? { mcpServer: binding.server, tool: binding.tool } : undefined,
      };
      task.timeline.push(item);
      this.wb.emit({ type: 'tool.updated', value: item });
      this.wb.ledger.appendEvent(runId, 'tool.requested', {
        toolCallId: event.toolCallId, name: event.toolName, rootId: item.rootId, cwd: item.cwd,
        argsText: JSON.stringify(event.args).slice(0, ARGS_TEXT_LIMIT),
      });
    } else if (event.type === 'tool_execution_update') {
      this.wb.updateTool(task, event.toolCallId, { state: 'running', output: resultText(event.partialResult) });
    } else if (event.type === 'tool_execution_end') {
      this.finishTool(task, runId, event.toolCallId, event.result, event.isError);
    }
  }

  markToolRunning(task: TaskState, toolCallId: string, root?: RootView): void {
    const runId = task.run!.id;
    this.wb.startedAt.set(toolCallId, Date.now());
    this.wb.updateTool(task, toolCallId, { state: 'running', runner: this.wb.runners.get(toolCallId) });
    this.wb.ledger.appendEvent(runId, 'tool.started', { toolCallId, rootId: root?.id });
    if (task.run && task.run.phase !== 'cancelling') {
      task.run = { ...task.run, phase: 'running' };
      this.wb.emitRun(task);
    }
  }

  private finishTool(task: TaskState, runId: string, toolCallId: string, result: unknown, isError: boolean): void {
    const current = task.timeline.find((item): item is ToolItem => item.kind === 'tool' && item.toolCallId === toolCallId);
    const cancelled = this.wb.active?.cancelRequested || current?.state === 'cancelled';
    const denied = current?.state === 'denied';
    const failed = isError || (typeof result === 'object' && result !== null && 'isError' in result && result.isError === true);
    const state = denied ? 'denied' : cancelled ? 'cancelled' : failed ? 'failed' : 'succeeded';
    const exitCode = current?.name === 'powershell' ? exitCodeOf(result) : undefined;
    const started = this.wb.startedAt.get(toolCallId);
    const durationMs = started ? Date.now() - started : undefined;
    const output = resultText(result);
    if (state === 'succeeded' && (current?.name === 'edit' || current?.name === 'write') && current.rootId) {
      task.mutations.set(current.rootId, (task.mutations.get(current.rootId) ?? 0) + 1);
    }
    this.wb.updateTool(task, toolCallId, {
      state, output, exitCode, durationMs,
      error: failed && !denied && !cancelled ? { code: 'TOOL_FAILED', message: '工具执行失败' } : undefined,
    });
    if (failed && !denied && !cancelled && task.run) {
      task.run = { ...task.run, toolErrors: true };
      this.wb.emitRun(task);
    }
    const details = (typeof result === 'object' && result !== null && 'details' in result ? result.details : undefined) as { fullOutputPath?: string; mcp?: unknown } | undefined;
    const structured = current?.source && typeof result === 'object' && result !== null && 'structuredContent' in result ? result.structuredContent : undefined;
    const runner = this.wb.runners.get(toolCallId);
    this.wb.ledger.appendEvent(runId, 'tool.finished', {
      toolCallId, name: current?.name, state, runnerKind: runner,
      sandboxOutcome: runner === 'sandbox' ? 'enforced' : current?.name === 'powershell' ? 'not_sandboxed' : undefined,
      exitCode, durationMs, errorClass: errorClassOf(state, runner, output), outputPreview: output.slice(-OUTPUT_PREVIEW_LIMIT), fullOutputPath: details?.fullOutputPath,
      structuredContent: structured, mcp: details?.mcp,
    });
    this.wb.startedAt.delete(toolCallId);
  }
}

function resultText(result: unknown): string {
  if (!result || typeof result !== 'object' || !('content' in result) || !Array.isArray(result.content)) return '';
  return result.content.filter(block => block?.type === 'text').map(block => block.text).join('');
}

// 评测需要按类别统计工具失败：用户拒绝、取消、超时、沙箱拒绝访问、其他工具错误。
function errorClassOf(state: ToolItem['state'], runner: RunnerKind | undefined, output: string): string | undefined {
  if (state === 'succeeded') return undefined;
  if (state === 'denied' || state === 'cancelled') return state;
  if (/timed out|timeout|超时/i.test(output)) return 'timeout';
  if (runner === 'sandbox' && /access (is )?denied|拒绝访问/i.test(output)) return 'sandbox';
  return 'tool_error';
}

function exitCodeOf(result: unknown): number | undefined {
  if (!result || typeof result !== 'object' || !('structuredContent' in result)) return undefined;
  const structured = result.structuredContent;
  if (!structured || typeof structured !== 'object' || !('exit_code' in structured)) return undefined;
  return typeof structured.exit_code === 'number' ? structured.exit_code : undefined;
}
