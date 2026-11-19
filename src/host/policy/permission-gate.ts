import { randomUUID } from 'node:crypto';
import type { BeforeToolCallContext } from '@earendil-works/pi-agent-core';
import type { ApprovalDecision, ApprovalRequest, RunnerKind } from '../../shared/contracts/index.js';
import type { MemoryService } from '../services/memory.js';
import type { TaskService } from '../services/task-service.js';
import type { TaskState, Workbench } from '../services/workbench.js';
import { classify, verdict } from '../tools/permission.js';

const APPROVAL_ARGS_LIMIT = 8 * 1024;

/** 每次工具调用前的权限闸门：选择运行方式（沙箱或直接）、按模式放行或拦截、必要时请求用户批准并记录任务级授权。 */
export class PermissionGate {
  /** 拒绝时用户填写的原因，按审批 id 暂存到 beforeToolCall 取走为止。 */
  private readonly reasons = new Map<string, string>();

  constructor(
    private readonly wb: Workbench,
    private readonly tasks: TaskService,
    private readonly memory: MemoryService,
  ) {}

  decideApproval(approvalId: string, decision: ApprovalDecision, reason?: string): void {
    const request = this.wb.broker.current;
    if (request?.id === approvalId && decision === 'allow_task' && !request.grantKey) throw new Error('此操作不支持任务级授权');
    if (decision === 'deny' && reason) this.reasons.set(approvalId, reason);
    this.wb.broker.decide(approvalId, decision);
  }

  trustedMcpNames(): Set<string> {
    return new Set([...this.wb.mcp.bindings].filter(([, binding]) => binding.trustedReadOnly).map(([name]) => name));
  }

  async beforeToolCall(task: TaskState, runId: string, context: BeforeToolCallContext, signal?: AbortSignal) {
    const name = context.toolCall.name;
    const toolCallId = context.toolCall.id;
    const args = (context.args ?? {}) as Record<string, unknown>;
    const cls = classify(name, this.trustedMcpNames());
    const mode = task.permission.userMode;
    const root = this.wb.rootFor(task, args);
    const binding = this.wb.mcp.bindings.get(name);
    const sandboxReady = this.wb.sandboxReady(task);
    const runner: RunnerKind | undefined = cls === 'shell' ? (mode !== 'bypass' && sandboxReady ? 'sandbox' : 'direct') : undefined;
    if (runner) this.wb.runners.set(toolCallId, runner);
    const grantKey = cls === 'shell' && root ? `shell:${root.id}:${String(args.command)}` : binding ? `mcp:${binding.server}.${binding.tool}` : undefined;
    const record = (decision: string, by: 'policy' | 'user') =>
      this.wb.ledger.appendEvent(runId, 'permission.decided', { toolCallId, decision, by, userMode: mode, runnerKind: runner });

    if (!this.wb.active || this.wb.active.id !== runId) return { block: true, reason: '当前执行已结束' };
    if (this.wb.active.summarizing) {
      record('deny', 'policy');
      this.wb.updateTool(task, toolCallId, { state: 'denied' });
      return { block: true, reason: '已停止修改，不能再调用工具；请直接用文字总结。' };
    }
    const outcome = verdict(mode, cls, sandboxReady);
    if (outcome === 'allow') {
      record('allow', 'policy');
      return undefined;
    }
    if (outcome === 'block') {
      record('deny', 'policy');
      this.wb.updateTool(task, toolCallId, { state: 'denied' });
      return { block: true, reason: 'Auto 模式只在已验证的沙箱内自动执行命令，当前沙箱不可用或目录未授权，命令未执行。' };
    }
    if (grantKey && task.permission.grants.includes(grantKey)) {
      record('allow_task', 'policy');
      return undefined;
    }

    const argsText = JSON.stringify(args, null, 2);
    const request: ApprovalRequest = {
      id: randomUUID(),
      runId,
      toolCallId,
      tool: name,
      summary: cls === 'shell' ? String(args.command) : binding ? `${binding.server}.${binding.tool}` : String(args.path ?? name),
      rootId: root?.id,
      rootAlias: root?.alias,
      cwd: root?.path,
      argsText: argsText.slice(0, APPROVAL_ARGS_LIMIT),
      grantKey: cls === 'edit' ? undefined : grantKey,
      runner,
    };
    task.run = { ...task.run!, phase: 'awaiting_approval' };
    this.wb.updateTool(task, toolCallId, { state: 'awaiting_approval' });
    this.wb.emitRun(task);
    const pending = this.wb.broker.request(request, signal);
    this.wb.emit({ type: 'approval.requested', value: request });
    this.wb.emitSnapshot();
    const decision = await pending;
    if (task.run?.phase === 'awaiting_approval') task.run = { ...task.run, phase: 'running' };
    this.wb.emitRun(task);
    this.wb.emitSnapshot();
    record(decision, 'user');
    if (decision === 'cancel') {
      this.wb.updateTool(task, toolCallId, { state: 'cancelled' });
      return { block: true, reason: '用户已取消，操作未执行' };
    }
    if (decision === 'deny') {
      this.wb.updateTool(task, toolCallId, { state: 'denied' });
      const reason = this.reasons.get(request.id);
      this.reasons.delete(request.id);
      if (!reason) return { block: true, reason: '用户拒绝执行，操作未运行。请说明原因或采用可行替代。' };
      await this.memory.captureRejection(task, runId, request, args, reason);
      return { block: true, reason: `用户拒绝执行，操作未运行。拒绝原因：${reason}` };
    }
    if (decision === 'allow_task' && grantKey && !task.permission.grants.includes(grantKey)) {
      task.permission = { ...task.permission, grants: [...task.permission.grants, grantKey] };
      this.tasks.save(task);
    }
    return undefined;
  }
}
