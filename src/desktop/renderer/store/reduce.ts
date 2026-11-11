import type { RunPhase, SnapshotEnvelope, WorkbenchEvent } from '../../../shared/contracts';

// 这个文件只依赖类型，单元测试可以直接用 Node 加载它。

export const activePhases: RunPhase[] = ['running', 'awaiting_approval', 'verifying', 'cancelling'];
export const terminalPhases: RunPhase[] = ['finished', 'failed', 'cancelled', 'interrupted'];

export const initialEnvelope: SnapshotEnvelope = {
  hostInstanceId: '',
  seq: 0,
  value: {
    host: 'starting', models: [], tasks: [], roots: [], timeline: [], mcp: [], sandboxStatus: 'untested', acceptance: { commands: [], maxRepairs: 3 },
    permission: { userMode: 'manual', phase: 'act', approval: 'ask_writes_and_commands', scope: 'selected_roots', grants: [] }, memoryEnabled: true,
    webSearch: { enabled: false, hasApiKey: false }, documents: [],
  },
};

// 只复制发生变化的部分：未变化的时间线条目保持原对象，React 不会重绘它们。
export function applyEvent(current: SnapshotEnvelope, event: WorkbenchEvent): SnapshotEnvelope {
  if (event.hostInstanceId === current.hostInstanceId && event.seq <= current.seq) return current;
  if (event.payload.type === 'snapshot') return { hostInstanceId: event.hostInstanceId, seq: event.seq, value: event.payload.value };
  if (event.hostInstanceId !== current.hostInstanceId) return current;
  const next = { ...current.value };
  const payload = event.payload;
  switch (payload.type) {
    case 'message.started':
      if (!next.timeline.some(item => item.kind === 'message' && item.id === payload.id)) {
        next.timeline = [...next.timeline, { kind: 'message', id: payload.id, role: payload.role, text: '' }];
      }
      break;
    case 'message.delta':
      next.timeline = next.timeline.map(item => item.kind === 'message' && item.id === payload.id ? { ...item, text: item.text + payload.text } : item);
      break;
    case 'message.ended':
      next.timeline = next.timeline.map(item => item.kind === 'message' && item.id === payload.id ? { ...item, text: payload.text } : item);
      break;
    case 'tool.updated': {
      const tool = payload.value;
      const index = next.timeline.findIndex(item => item.kind === 'tool' && item.toolCallId === tool.toolCallId);
      next.timeline = index < 0 ? [...next.timeline, tool] : next.timeline.map((item, position) => position === index ? tool : item);
      break;
    }
    case 'verification.updated': {
      const entry = payload.value;
      const index = next.timeline.findIndex(item => item.kind === 'verification' && item.id === entry.id);
      next.timeline = index < 0 ? [...next.timeline, entry] : next.timeline.map((item, position) => position === index ? entry : item);
      break;
    }
    case 'approval.requested':
      next.approval = payload.value;
      break;
    case 'run.changed':
      next.run = payload.value;
      if (terminalPhases.includes(payload.value.phase)) next.approval = undefined;
      break;
    case 'sandbox.updated':
      next.sandboxStatus = payload.value;
      break;
    case 'changes.updated':
      next.changes = payload.value;
      break;
    case 'delivery.updated':
      next.delivery = payload.value;
      break;
    case 'mcp.updated':
      next.mcp = payload.value;
      break;
    case 'error':
      next.error = payload.value;
      break;
  }
  return { hostInstanceId: event.hostInstanceId, seq: event.seq, value: next };
}
