import { randomUUID } from 'node:crypto';
import { Agent, type AgentMessage } from '@earendil-works/pi-agent-core';
import { convertToLlm } from '@earendil-works/pi-coding-agent';
import type { AppError } from '../../shared/contracts/index.js';
import { CONTINUE_TEXT, IMPLEMENT_PLAN_TEXT, VERIFY_ONLY_TEXT } from '../../shared/constants.js';
import { repositoryProfile } from '../engineering/navigation.js';
import { injectSlots, reanchorSlots, tokensOf, type Slot } from '../memory/recall.js';
import type { PermissionGate } from '../policy/permission-gate.js';
import { compactIfNeeded, type CompactionOutcome } from '../runtime/compaction.js';
import { repairDanglingToolCalls } from '../runtime/recovery.js';
import * as delivery from '../workspace/delivery.js';
import { readWorkspaceRules } from '../workspace/workspace.js';
import type { AgentEvents } from './agent-events.js';
import type { DeliveryService } from './delivery.js';
import type { MemoryService } from './memory.js';
import type { ModelService } from './model.js';
import { buildRecoveryBrief, modeStatement, stateBlock } from './prompts.js';
import type { TaskService } from './task-service.js';
import { buildTools } from './toolset.js';
import { failureHash, feedbackMessage, runVerification } from './verification.js';
import { createError, userMessage, type RunEnd, type TaskState, type Workbench } from './workbench.js';

type RunOptions = { verifyOnly?: boolean; resumed?: boolean };
export type RunServices = {
  tasks: TaskService;
  deliveries: DeliveryService;
  memory: MemoryService;
  gate: PermissionGate;
  events: AgentEvents;
  model: ModelService;
};

/** 一次 Run 的生命周期：开始、提示 → 验证 → 修复循环、结束与取消。 */
export class RunController {
  constructor(
    private readonly wb: Workbench,
    private readonly rulesPath: string,
    private readonly services: RunServices,
  ) {}

  startMessage(text: string): { runId: string } {
    this.wb.assertConfigured();
    return this.beginRun(text, {});
  }

  async implementPlan(): Promise<{ runId: string }> {
    const task = this.wb.requireTask();
    if (task.permission.userMode !== 'plan' || !task.timeline.some(item => item.kind === 'message' && item.role === 'assistant')) {
      throw new Error('当前没有可实施的计划');
    }
    await this.services.tasks.setPermission('accept_edits');
    return this.startMessage(IMPLEMENT_PLAN_TEXT);
  }

  continueTask(): { runId: string } {
    this.wb.assertConfigured();
    if (!this.wb.requireTask().interrupted) throw new Error('当前任务没有被中断的执行');
    return this.beginRun(CONTINUE_TEXT, {});
  }

  verifyNow(): { runId: string } {
    const task = this.wb.requireTask();
    if (task.permission.userMode === 'plan') throw new Error('计划模式不执行验证命令');
    if (!task.acceptance.commands.length) throw new Error('请先确认验收命令');
    return this.beginRun(VERIFY_ONLY_TEXT, { verifyOnly: true });
  }

  cancelRun(runId: string): void {
    if (!this.wb.active || this.wb.active.id !== runId) throw new Error('当前执行已结束');
    this.wb.active.cancelRequested = true;
    const task = this.wb.taskOf(this.wb.active);
    if (task?.run) task.run = { ...task.run, phase: 'cancelling' };
    else if (this.wb.testRun) this.wb.testRun = { ...this.wb.testRun, phase: 'cancelling' };
    this.wb.emitRun(task);
    this.wb.active.agent?.abort();
    this.wb.active.verifyAbort.abort();
  }

  private beginRun(text: string, options: RunOptions): { runId: string } {
    this.wb.assertIdle();
    const task = this.services.tasks.ensureTask();
    this.services.tasks.load(task);
    const resumed = task.interrupted && !options.verifyOnly ? this.wb.ledger.lastRun(task.id) : undefined;
    const run = this.wb.ledger.startRun(task.id, resumed ? 'recovery' : 'user', resumed?.id);
    this.wb.testRun = undefined;
    this.wb.error = undefined;
    task.error = undefined;
    task.interrupted = false;
    task.run = { id: run.id, taskId: task.id, phase: 'running', toolErrors: false };
    this.wb.active = { id: run.id, kind: 'prompt', taskId: task.id, cancelRequested: false, verifyAbort: new AbortController() };
    if (options.verifyOnly) {
      task.timeline.push({ kind: 'notice', id: randomUUID(), text: VERIFY_ONLY_TEXT });
    } else {
      if (!task.timeline.length) task.title = text.replace(/\s+/g, ' ').slice(0, 32);
      this.wb.pushMessage(task, { text });
    }
    this.services.tasks.save(task);
    this.wb.emitRun(task);
    this.wb.emitSnapshot();
    this.wb.active.done = this.runPrompt(task, run.id, text, { ...options, resumed: Boolean(resumed) }, resumed?.id);
    return { runId: run.id };
  }

  private async runPrompt(task: TaskState, runId: string, text: string, options: RunOptions, resumedFrom?: string): Promise<void> {
    const { tasks, deliveries, memory, gate, events, model } = this.services;
    let unsubscribe: (() => void) | undefined;
    try {
      const profile = this.wb.profile;
      const mode = task.permission.userMode;
      await tasks.assertRootsExist(task);
      const rules = await readWorkspaceRules(task.roots, this.rulesPath);
      await tasks.refreshRoots(task);
      task.profile = this.wb.navigationEnabled ? (await Promise.all(task.roots.map(root => repositoryProfile(root).catch(() => '')))).filter(Boolean).join('\n') : undefined;
      const tools = buildTools(this.wb, task, events, gate.trustedMcpNames());
      this.wb.ledger.appendEvent(runId, 'run.started', {
        modelId: profile?.modelId, permission: task.permission, sandboxStatus: this.wb.sandboxStatus(),
        roots: task.roots.map(({ id, alias, path }) => ({ id, alias, path })),
        toolNames: tools.map(tool => tool.name), ruleSources: rules.sources, userTextPreview: text.slice(0, 200),
        trigger: resumedFrom ? 'recovery' : 'user', ...(resumedFrom ? { resumedFrom } : {}), policyId: this.wb.policy.id,
      });
      const startTrees = mode !== 'plan' ? await deliveries.snapshotRoots(task, runId, 'run_start') : new Map<string, string>();
      const mutationsAtStart = new Map(task.mutations);
      const first = options.verifyOnly ? undefined : await this.firstPrompt(task, text, resumedFrom);
      let agent: Agent | undefined;
      // 召回的历史记忆只存在于这个数组里：随每次请求插入到锚点消息之前，从不写入 Pi 会话。
      const slots: Slot[] = [];
      if (first) {
        const anchor = first.at(-1) as Extract<AgentMessage, { role: 'user' }>;
        const recalled = await memory.recallSlot(task, runId, 'start', `${task.title} ${text}`);
        if (recalled) slots.push({ anchorTimestamp: anchor.timestamp, anchorText: text, text: recalled });
        const streamFn = model.streamFn(profile!);
        agent = new Agent({
          initialState: {
            model: model.createModel(profile!),
            messages: task.session.buildSessionContext().messages as AgentMessage[],
            systemPrompt: `${rules.text}

${modeStatement(task, this.wb.policy)}

${stateBlock(task, this.wb.profile?.vision)}`,
            tools,
          },
          convertToLlm,
          streamFn,
          toolExecution: 'sequential',
          transformContext: async messages => injectSlots(messages, slots, slotText => userMessage(slotText)),
          beforeToolCall: (context, signal) => gate.beforeToolCall(task, runId, context, signal),
          prepareRequest: async (request, signal) => {
            // 系统提示是对话记录开头的 system 消息，不在会话里；压缩后需要原样放回。
            const leading = request.context.messages.filter(message => message.role === 'system');
            const slotTokens = slots.reduce((sum, slot) => sum + tokensOf(slot.text), 0);
            // system 消息除正文外还带 sections 与工具定义，按整条消息的 JSON 计数。
            const force = this.wb.active?.id === runId && this.wb.active.forceCompaction === true;
            if (force) this.wb.active!.forceCompaction = false;
            let outcome: CompactionOutcome | undefined;
            try {
              outcome = await compactIfNeeded(task.session, request.model, this.wb.apiKey, streamFn, tokensOf(JSON.stringify(leading)) + slotTokens, signal, force);
            } catch (error) {
              if (signal?.aborted) throw error;
              // 摘要失败不终止 Run：本次请求不压缩照常发送；若因此以 length 停止，由 length 恢复路径处理。
              this.recordCompactionFailure(task, runId, error);
              return undefined;
            }
            if (!outcome) return undefined;
            this.recordCompaction(task, runId, outcome);
            const kept = task.session.buildSessionContext().messages as AgentMessage[];
            reanchorSlots(slots, kept);
            return { context: { ...request.context, messages: [...leading, ...kept] } };
          },
        });
        if (this.wb.active?.id === runId) this.wb.active.agent = agent;
        unsubscribe = agent.subscribe(event => events.onAgentEvent(task, runId, event));
      }
      const end = await this.drive(task, runId, agent, first, options, startTrees, mutationsAtStart, slots);
      await this.endRun(task, runId, end.phase, end.stopReason, end.error);
    } catch (error) {
      if (this.wb.active?.cancelRequested) await this.endRun(task, runId, 'cancelled', 'cancelled');
      else if ((error as { appCode?: string }).appCode === 'ROOT_MISSING') await this.endRun(task, runId, 'failed', 'agent_error', { code: 'ROOT_MISSING', message: (error as Error).message });
      else await this.endRun(task, runId, 'failed', 'agent_error', createError('RUN_FAILED', '执行失败', error, this.wb.apiKey));
    } finally {
      unsubscribe?.();
      if (this.wb.active?.id === runId) this.wb.active = undefined;
    }
  }

  // 中断过的 Task 先核对真实状态，并把恢复说明作为单独的标注消息放在用户消息之前。
  private async firstPrompt(task: TaskState, text: string, resumedFrom?: string): Promise<AgentMessage[]> {
    const user = userMessage(text);
    if (!resumedFrom) return [user];
    repairDanglingToolCalls(task.session);
    const brief = await buildRecoveryBrief(this.wb, this.services.deliveries, task, resumedFrom);
    this.wb.pushMessage(task, { text: brief, harness: true, beforeLast: true });
    return [userMessage(brief), user];
  }

  // 提示 -> 验证 -> 修复；预算、无进展、取消、模型错误都会结束循环。
  private async drive(
    task: TaskState, runId: string, agent: Agent | undefined, first: AgentMessage[] | undefined, options: RunOptions,
    startTrees: Map<string, string>, mutationsAtStart: Map<string, number>, slots: Slot[],
  ): Promise<RunEnd> {
    const { deliveries, memory, model } = this.services;
    let input = first;
    let previous: { hash: string; fingerprint: string } | undefined;
    for (let attempt = 0; ; attempt++) {
      if (input) {
        const ended = await model.promptWithRecovery(task, runId, agent!, input);
        if (ended) return ended;
      }
      if (task.permission.userMode === 'plan') return { phase: 'finished', stopReason: 'passed' };
      const view = await deliveries.refreshDelivery(task);
      const startOf = (rootId: string, git: boolean, now?: string) => startTrees.get(rootId) ?? (git ? now : delivery.treeOfPlainRoot(mutationsAtStart.get(rootId) ?? 0));
      // 恢复的 Run 要接着验证：中断前的修改还没有来得及验证。
      const changed = options.verifyOnly || options.resumed || view.roots.some(root => root.finalTree !== startOf(root.rootId, root.git, root.finalTree));
      const pending = view.roots.filter(root => (root.state === 'unverified' || root.state === 'verification_failed') && this.wb.commandsOf(task, root.rootId).length);
      if (!changed || !pending.length) return { phase: 'finished', stopReason: changed && view.state === 'unverified' ? 'unverified' : 'passed' };

      const results = await runVerification(this.wb, task, runId, attempt, pending.map(root => ({ root: task.roots.find(item => item.id === root.rootId)!, tree: root.finalTree! })));
      const failed = results.find(result => result.status !== 'passed');
      if (!failed) {
        const after = await deliveries.refreshDelivery(task);
        return { phase: 'finished', stopReason: after.state === 'verified' ? 'passed' : 'unverified' };
      }
      if (failed.status === 'cancelled') return { phase: 'cancelled', stopReason: 'cancelled' };
      if (failed.status === 'unavailable') return { phase: 'finished', stopReason: 'verification_unavailable', error: { code: 'VERIFY_UNAVAILABLE', message: '验证命令未能执行', detail: failed.outputTail } };
      if (options.verifyOnly) return { phase: 'finished', stopReason: 'verification_failed' };
      if (attempt >= task.acceptance.maxRepairs) return { phase: 'finished', stopReason: 'budget_exhausted' };

      const fingerprint = view.roots.map(root => `${root.rootId}:${root.finalTree}`).join('|');
      const hash = failureHash(failed);
      if (previous?.hash === hash && previous.fingerprint === fingerprint) return { phase: 'finished', stopReason: 'no_progress' };
      previous = { hash, fingerprint };

      const alias = task.roots.find(root => root.id === failed.rootId)?.alias ?? failed.rootId;
      const feedback = feedbackMessage(failed, alias, attempt + 1, task.acceptance.maxRepairs);
      this.wb.ledger.appendEvent(runId, 'repair.requested', { attempt: attempt + 1, reason: failed.status, commandId: failed.commandId });
      this.wb.setPhase(task, 'running', attempt + 1);
      this.wb.pushMessage(task, { text: feedback, harness: true });
      const message = userMessage(feedback);
      const recalled = await memory.recallSlot(task, runId, 'repair', task.title, { hash, outputTail: failed.outputTail });
      if (recalled) slots.push({ anchorTimestamp: message.timestamp, anchorText: feedback, text: recalled });
      input = [message];
    }
  }

  private async endRun(task: TaskState, runId: string, phase: RunEnd['phase'], stopReason: string, error?: AppError): Promise<void> {
    const { tasks, deliveries, memory } = this.services;
    if (!this.wb.ledger.events(runId).some(event => event.type === 'run.started')) {
      this.wb.ledger.appendEvent(runId, 'run.started', { permission: task.permission, roots: task.roots.map(({ id, alias, path }) => ({ id, alias, path })), trigger: 'user' });
    }
    if (task.permission.userMode !== 'plan') {
      const trees = await deliveries.snapshotRoots(task, runId, 'run_end');
      await deliveries.refreshChanges(task, trees);
      const view = await deliveries.finalizeDelivery(task, runId, trees);
      if (view) await memory.captureMemory(task, runId, view);
    }
    this.wb.ledger.appendEvent(runId, 'run.ended', { phase, stopReason, error });
    this.wb.ledger.endRun(runId, phase, stopReason, this.wb.profile?.modelId);
    task.run = { ...task.run!, phase };
    if (error) {
      task.error = error;
      this.wb.emit({ type: 'error', value: error });
    }
    tasks.save(task);
    this.wb.emitRun(task);
    this.wb.emitSnapshot();
  }

  private recordCompaction(task: TaskState, runId: string, outcome: CompactionOutcome): void {
    const usage = outcome.usage as { totalTokens?: number } | undefined;
    this.wb.ledger.appendEvent(runId, 'compaction.done', { tokensBefore: outcome.tokensBefore, tokensAfter: outcome.tokensAfter, firstKeptEntryId: outcome.firstKeptEntryId, usage });
    if (usage?.totalTokens) this.wb.ledger.appendEvent(runId, 'model.usage', { ...usage, purpose: 'compaction' });
    task.timeline.push({ kind: 'notice', id: randomUUID(), text: '较早的对话已压缩为摘要' });
    this.wb.emitSnapshot();
  }

  private recordCompactionFailure(task: TaskState, runId: string, error: unknown): void {
    this.wb.ledger.appendEvent(runId, 'compaction.failed', { error: createError('COMPACTION_FAILED', '上下文压缩失败', error, this.wb.apiKey) });
    task.timeline.push({ kind: 'notice', id: randomUUID(), text: '上下文压缩失败，本次请求不压缩继续' });
    this.wb.emitSnapshot();
  }
}
