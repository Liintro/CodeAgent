import type { ApprovalDecision, ApprovalRequest, PermissionSetting, UserMode } from '../../shared/contracts.js';

export type ToolClass = 'read' | 'edit' | 'shell' | 'mcp' | 'mcp_trusted';
export type Verdict = 'allow' | 'ask' | 'block';

const readTools = new Set(['read', 'grep', 'find', 'ls', 'git']);

export function classify(name: string, trustedMcp: ReadonlySet<string>): ToolClass {
  if (readTools.has(name)) return 'read';
  if (name === 'edit' || name === 'write') return 'edit';
  if (name === 'powershell') return 'shell';
  return trustedMcp.has(name) ? 'mcp_trusted' : 'mcp';
}

export function permissionFor(userMode: UserMode, grants: string[] = []): PermissionSetting {
  return {
    userMode,
    phase: userMode === 'plan' ? 'plan' : 'act',
    approval: { plan: 'ask_writes_and_commands', manual: 'ask_writes_and_commands', accept_edits: 'ask_commands', auto: 'auto_sandbox', bypass: 'never' }[userMode] as PermissionSetting['approval'],
    scope: userMode === 'bypass' ? 'host_full_access' : 'selected_roots',
    grants,
  };
}

// Plan 的只读性来自工具注册表：非只读工具根本不会注册给模型。
export function registered(userMode: UserMode, cls: ToolClass): boolean {
  return userMode !== 'plan' || cls === 'read' || cls === 'mcp_trusted';
}

export function verdict(userMode: UserMode, cls: ToolClass, sandboxReady: boolean): Verdict {
  if (cls === 'read' || cls === 'mcp_trusted' || userMode === 'bypass') return 'allow';
  if (cls === 'edit') return userMode === 'manual' ? 'ask' : 'allow';
  if (cls === 'shell' && userMode === 'auto') return sandboxReady ? 'allow' : 'block';
  return 'ask';
}

type Pending = { request: ApprovalRequest; settle: (decision: ApprovalDecision | 'cancel') => void };

// 同一时刻只有一个待决审批（工具串行执行）。
export class ApprovalBroker {
  private pending?: Pending;

  get current(): ApprovalRequest | undefined {
    return this.pending?.request;
  }

  request(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision | 'cancel'> {
    return new Promise(resolve => {
      const settle = (decision: ApprovalDecision | 'cancel') => {
        signal?.removeEventListener('abort', onAbort);
        if (this.pending?.request.id === request.id) this.pending = undefined;
        resolve(decision);
      };
      const onAbort = () => settle('cancel');
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending = { request, settle };
    });
  }

  decide(approvalId: string, decision: ApprovalDecision): ApprovalRequest {
    if (!this.pending || this.pending.request.id !== approvalId) throw new Error('审批已结束');
    const { request, settle } = this.pending;
    this.pending = undefined;
    settle(decision);
    return request;
  }
}
