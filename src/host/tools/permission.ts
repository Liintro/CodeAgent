import type { ApprovalDecision, ApprovalRequest, PermissionSetting, UserMode } from '../../shared/contracts/index.js';

export type ToolClass = 'read' | 'edit' | 'shell' | 'mcp' | 'mcp_trusted';
export type Verdict = 'allow' | 'ask' | 'block';

const readTools = new Set(['read', 'grep', 'find', 'ls', 'git', 'doc_outline', 'doc_read', 'doc_view', 'code_outline', 'find_symbol', 'related_files', 'web_search', 'web_fetch', 'memory_search', 'update_plan']);

export function classify(name: string, trustedMcp: ReadonlySet<string>): ToolClass {
  if (readTools.has(name)) return 'read';
  if (name === 'edit' || name === 'write') return 'edit';
  if (name === 'powershell') return 'shell';
  return trustedMcp.has(name) ? 'mcp_trusted' : 'mcp';
}

// 含有这些字符的命令可能串联或嵌入别的命令，只能按整条命令授权。
const SHELL_META = /[;&|<>`$(){}\r\n]/;
const PREFIX_WORD = /^[A-Za-z][\w:-]*$/;

/**
 * 任务级授权：命令开头至多 words 个普通单词组成前缀（如 npm run build），之后同前缀的命令都放行。
 * 只有一个单词时（python、node 后面跟脚本）前缀等于放行任意代码，所以至少两个单词，否则按整条命令。
 */
export function shellGrant(rootId: string, command: string, words: number): { key: string; label: string } {
  const prefix = SHELL_META.test(command) ? [] : takeWhile(command.trim().split(/\s+/), word => PREFIX_WORD.test(word)).slice(0, words);
  if (prefix.length < 2) return { key: `shell:${rootId}:${command}`, label: command };
  return { key: `shell-prefix:${rootId}:${prefix.join(' ')}`, label: `${prefix.join(' ')} …` };
}

export function shellGranted(grants: readonly string[], rootId: string, command: string): boolean {
  if (grants.includes(`shell:${rootId}:${command}`)) return true;
  if (SHELL_META.test(command)) return false;
  const text = command.trim().split(/\s+/).join(' ');
  const mark = `shell-prefix:${rootId}:`;
  return grants.some(grant => grant.startsWith(mark) && (text === grant.slice(mark.length) || text.startsWith(`${grant.slice(mark.length)} `)));
}

function takeWhile<T>(items: T[], test: (item: T) => boolean): T[] {
  const index = items.findIndex(item => !test(item));
  return index < 0 ? items : items.slice(0, index);
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
