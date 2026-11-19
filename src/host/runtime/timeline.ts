import type { SessionStore } from '../kernel/session.js';
import { FEEDBACK_PREFIX, RECOVERY_PREFIX, STOP_PREFIX } from '../../shared/constants.js';
import type { MemoryOutcome, MemoryShown, RootView, RunEvent, SubagentStep, TimelineItem, ToolItem, ToolState, VerificationItem } from '../../shared/contracts/index.js';

type Timed = { at: number; item: TimelineItem };

export const NOTICE = { compaction: '较早的对话已压缩为摘要', trim: '较早的工具输出已从上下文中省略' } as const;

// 时间线由会话（说了什么）与账本事件（发生了什么）重建；不存在第二份对话副本。
export function rebuildTimeline(session: SessionStore, events: RunEvent[], roots: RootView[], outcomes: Map<string, MemoryOutcome> = new Map()): TimelineItem[] {
  const requested = new Map<string, RunEvent>();
  const finished = new Map<string, RunEvent>();
  // 子智能体按会话 id 归组：探索者挂在触发它的 explore 调用上（key 即调用 id），验证者单独成行。
  const steps = new Map<string, SubagentStep[]>();
  const answers = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'tool.requested') requested.set(String(event.data.toolCallId), event);
    else if (event.type === 'tool.finished') finished.set(String(event.data.toolCallId), event);
    else if (event.type === 'subagent.tool') {
      const { sessionId, toolCallId, name, target, state } = event.data as Record<string, string>;
      steps.set(sessionId, [...steps.get(sessionId) ?? [], { toolCallId, name, target, state: state as SubagentStep['state'] }]);
    } else if (event.type === 'subagent.finished') answers.set(String(event.data.sessionId), String(event.data.answer ?? ''));
  }
  const items: Timed[] = [];
  const tools = new Map<string, ToolItem>();
  for (const entry of session.entries()) {
    const id = `${session.taskId}-${entry.seq}`;
    if (entry.type !== 'message') {
      items.push({ at: entry.at, item: { kind: 'notice', id, text: NOTICE[entry.type] } });
      continue;
    }
    const message = entry.message;
    const at = typeof message.timestamp === 'number' ? message.timestamp : entry.at;
    if (message.role === 'user') {
      const text = typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text).join('');
      items.push({ at, item: { kind: 'message', id, role: 'user', text, harness: [FEEDBACK_PREFIX, RECOVERY_PREFIX, STOP_PREFIX].some(prefix => text.startsWith(prefix)) || undefined } });
    } else if (message.role === 'assistant') {
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('');
      if (text) items.push({ at, item: { kind: 'message', id, role: 'assistant', text } });
      for (const block of message.content) {
        if (block.type !== 'toolCall') continue;
        const request = requested.get(block.id);
        const rootId = request?.data.rootId as string | undefined;
        const tool: ToolItem = {
          kind: 'tool', toolCallId: block.id, name: block.name, args: block.arguments, state: 'unknown', output: '',
          rootId, rootAlias: roots.find(root => root.id === rootId)?.alias, cwd: request?.data.cwd as string | undefined,
        };
        tools.set(block.id, tool);
        items.push({ at, item: tool });
      }
    } else if (message.role === 'toolResult') {
      const tool = tools.get(message.toolCallId);
      if (!tool) continue;
      tool.output = message.content.filter(block => block.type === 'text').map(block => block.text).join('');
      const hostExited = (message.details as { hostExited?: boolean } | undefined)?.hostExited;
      tool.state = hostExited ? 'unknown' : message.isError ? 'failed' : 'succeeded';
    }
  }
  for (const event of events) {
    if (event.type !== 'subagent.started') continue;
    const { sessionId, kind, key } = event.data as Record<string, string>;
    if (kind === 'explorer') {
      const tool = tools.get(key);
      if (tool) tool.steps = steps.get(sessionId) ?? [];
      continue;
    }
    items.push({ at: event.at, item: { kind: 'tool', toolCallId: sessionId, name: 'verifier', args: { command: String(event.data.title ?? '') }, state: answers.has(sessionId) ? 'succeeded' : 'unknown', output: answers.get(sessionId) ?? '', steps: steps.get(sessionId) ?? [] } });
  }
  for (const [id, tool] of tools) {
    const event = finished.get(id);
    if (!event) continue;
    tool.state = event.data.state as ToolState;
    tool.exitCode = event.data.exitCode as number | undefined;
    tool.durationMs = event.data.durationMs as number | undefined;
    tool.runner = event.data.runnerKind as ToolItem['runner'];
  }
  for (const event of events) {
    if (event.type === 'memory.recalled' && Array.isArray(event.data.shown) && event.data.shown.length) {
      items.push({ at: event.at, item: { kind: 'memory', id: `${event.runId}-${event.seq}`, runId: event.runId, items: event.data.shown as MemoryShown[], outcome: outcomes.get(event.runId) } });
    }
    if (event.type !== 'verification.finished') continue;
    const data = event.data;
    items.push({
      at: event.at,
      item: {
        kind: 'verification', id: `${event.runId}-${event.seq}`, attempt: Number(data.attempt), rootAlias: roots.find(root => root.id === data.rootId)?.alias ?? String(data.rootId),
        commandLabel: String(data.label), command: String(data.command), state: data.status as 'passed', exitCode: data.exitCode as number | undefined,
        durationMs: data.durationMs as number | undefined, outputTail: String(data.outputTail ?? ''), logFile: data.logFile as string | undefined,
        failure: data.failure as VerificationItem['failure'],
      },
    });
  }
  return items.map((value, index) => ({ ...value, index })).sort((a, b) => a.at - b.at || a.index - b.index).map(value => value.item);
}
