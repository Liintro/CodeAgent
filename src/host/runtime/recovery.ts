import type { SessionManager } from '@earendil-works/pi-coding-agent';
import { RECOVERY_PREFIX } from '../../shared/constants.js';
import type { FileChange, RunEvent } from '../../shared/contracts.js';

export type UnknownCall = { name: string; rootAlias?: string; detail: string; at: number };
export type RootRecovery = { alias: string; sinceRun: FileChange[]; sinceBaseline: FileChange[]; missing?: boolean };

const HOST_EXITED = 'Host 已意外退出，此工具调用的结果未知，它可能已部分或全部执行。请先检查当前文件与状态，再决定是否重复。';

// 提供方会拒绝没有结果的 tool call；为中断时仍悬空的调用补一个明确的“结果未知”错误结果。
export function repairDanglingToolCalls(session: SessionManager): number {
  const entries = session.getBranch().filter(entry => entry.type === 'message');
  const answered = new Set<string>();
  for (const entry of entries) if (entry.message.role === 'toolResult') answered.add(entry.message.toolCallId);
  let repaired = 0;
  for (const entry of entries) {
    if (entry.message.role !== 'assistant') continue;
    for (const block of entry.message.content) {
      if (block.type !== 'toolCall' || answered.has(block.id)) continue;
      session.appendMessage({
        role: 'toolResult', toolCallId: block.id, toolName: block.name, content: [{ type: 'text', text: HOST_EXITED }],
        details: { hostExited: true }, isError: true, timestamp: Date.now(),
      });
      repaired++;
    }
  }
  return repaired;
}

// 事件里 tool.requested 有而 tool.finished 没有的调用，结果未知。
export function unknownCalls(events: RunEvent[], aliasOf: (rootId?: string) => string | undefined): UnknownCall[] {
  const finished = new Set(events.filter(event => event.type === 'tool.finished').map(event => event.data.toolCallId));
  return events
    .filter(event => event.type === 'tool.requested' && !finished.has(event.data.toolCallId))
    .map(event => {
      const args = safeParse(String(event.data.argsText));
      return {
        name: String(event.data.name),
        rootAlias: aliasOf(event.data.rootId as string | undefined),
        detail: typeof args.command === 'string' ? args.command : typeof args.path === 'string' ? args.path : String(event.data.argsText),
        at: event.at,
      };
    });
}

export function recoveryBrief(roots: RootRecovery[], calls: UnknownCall[], lastVerification?: string): string {
  const list = (files: FileChange[]) => files.length ? files.slice(0, 50).map(file => `${file.status} ${file.path}`).join('；') : '无';
  const lines = [`${RECOVERY_PREFIX} 上一次执行因运行进程意外退出而中断。以下是重新核对后的真实状态，请据此继续，不要重复已完成的步骤。`];
  for (const root of roots) {
    if (root.missing) lines.push(`目录 ${root.alias}：已不存在。`);
    else lines.push(`目录 ${root.alias}：中断的那次执行期间变更：${list(root.sinceRun)}；相对任务起点共变更 ${root.sinceBaseline.length} 个文件。`);
  }
  if (calls.length) {
    lines.push('结果未知的工具调用（已发出但没有结果记录）：');
    for (const call of calls) lines.push(`- ${call.name}${call.rootAlias ? `（目录 ${call.rootAlias}）` : ''}：${call.detail}`);
    lines.push('它们可能已经部分或全部执行。重复任何有副作用的步骤之前，先检查当前状态。');
  }
  if (lastVerification) lines.push(`最近一次验证：${lastVerification}`);
  lines.push('请先确认上述状态，再继续完成用户的任务。');
  return lines.join('\n');
}

function safeParse(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
