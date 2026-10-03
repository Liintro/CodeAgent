import type { SessionManager } from '@earendil-works/pi-coding-agent';
import { FEEDBACK_PREFIX, RECOVERY_PREFIX } from '../../shared/constants.js';
import type { MemoryShown, RootView, RunEvent, TimelineItem, ToolItem, ToolState, VerificationItem } from '../../shared/contracts.js';

type Timed = { at: number; item: TimelineItem };

// 时间线由 Pi 会话（说了什么）与账本事件（发生了什么）重建；不存在第二份对话副本。
export function rebuildTimeline(session: SessionManager, events: RunEvent[], roots: RootView[]): TimelineItem[] {
  const requested = new Map<string, RunEvent>();
  const finished = new Map<string, RunEvent>();
  for (const event of events) {
    if (event.type === 'tool.requested') requested.set(String(event.data.toolCallId), event);
    else if (event.type === 'tool.finished') finished.set(String(event.data.toolCallId), event);
  }
  const items: Timed[] = [];
  const tools = new Map<string, ToolItem>();
  for (const entry of session.getEntries()) {
    if (entry.type === 'compaction') {
      items.push({ at: Date.parse(entry.timestamp), item: { kind: 'notice', id: entry.id, text: '较早的对话已压缩为摘要' } });
      continue;
    }
    if (entry.type !== 'message') continue;
    const message = entry.message;
    const at = typeof message.timestamp === 'number' ? message.timestamp : Date.parse(entry.timestamp);
    if (message.role === 'user') {
      const text = typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text).join('');
      items.push({ at, item: { kind: 'message', id: entry.id, role: 'user', text, harness: text.startsWith(FEEDBACK_PREFIX) || text.startsWith(RECOVERY_PREFIX) || undefined } });
    } else if (message.role === 'assistant') {
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('');
      if (text) items.push({ at, item: { kind: 'message', id: entry.id, role: 'assistant', text } });
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
      items.push({ at: event.at, item: { kind: 'memory', id: `${event.runId}-${event.seq}`, items: event.data.shown as MemoryShown[] } });
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
