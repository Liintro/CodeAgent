import type { AppError, ApprovalRequest, ChangesView, DeliveryView, McpServerStatus, RunView, SandboxStatus, ToolItem, VerificationItem, WorkbenchSnapshot } from './views.js';

export type RunEventType =
  | 'run.started' | 'git.snapshot' | 'tool.requested' | 'permission.decided' | 'tool.started'
  | 'tool.finished' | 'model.usage' | 'run.ended'
  | 'verification.started' | 'verification.finished' | 'repair.requested' | 'compaction.done' | 'compaction.failed' | 'delivery.changed'
  | 'memory.recalled' | 'memory.captured' | 'memory.capture_failed' | 'memory.changed' | 'model.retry' | 'budget.updated';
export type RunEvent = { runId: string; seq: number; at: number; type: RunEventType; data: Record<string, unknown> };

export type SnapshotEnvelope = { hostInstanceId: string; seq: number; value: WorkbenchSnapshot };

export type WorkbenchEvent = {
  hostInstanceId: string;
  seq: number;
  at: number;
  runId?: string;
  payload:
    | { type: 'snapshot'; value: WorkbenchSnapshot }
    | { type: 'message.started'; id: string; role: 'user' | 'assistant' }
    | { type: 'message.delta'; id: string; text: string }
    | { type: 'message.ended'; id: string; text: string }
    | { type: 'tool.updated'; value: ToolItem }
    | { type: 'approval.requested'; value: ApprovalRequest }
    | { type: 'run.changed'; value: RunView }
    | { type: 'sandbox.updated'; value: SandboxStatus }
    | { type: 'changes.updated'; value: ChangesView }
    | { type: 'mcp.updated'; value: McpServerStatus[] }
    | { type: 'verification.updated'; value: VerificationItem }
    | { type: 'delivery.updated'; value: DeliveryView }
    | { type: 'error'; value: AppError };
};
