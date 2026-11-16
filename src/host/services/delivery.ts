import type { ChangesView, DeliveryActionResult, DeliveryView, DiffView, RootChanges, VerificationResult } from '../../shared/contracts/index.js';
import { repoOf } from '../memory/repo.js';
import * as delivery from '../workspace/delivery.js';
import * as git from '../workspace/git.js';
import type { MemoryService } from './memory.js';
import type { TaskService } from './task-service.js';
import type { TaskState, Workbench } from './workbench.js';

type DeliveryInputDocuments = delivery.DeliveryInput['documents'];

/** 变更与差异、交付报告、用户的接受/还原/提交，以及 Git 快照。 */
export class DeliveryService {
  constructor(
    private readonly wb: Workbench,
    private readonly tasks: TaskService,
    private readonly memory: MemoryService,
  ) {}

  async getChanges(): Promise<ChangesView> {
    const task = this.wb.requireTask();
    if (task.permission.userMode !== 'plan') await this.refreshChanges(task);
    return task.changes ?? { taskId: task.id, computedAt: Date.now(), roots: [] };
  }

  async getDiff(rootId: string, path: string): Promise<DiffView> {
    const task = this.wb.requireTask();
    const root = task.roots.find(item => item.id === rootId);
    const entry = task.changes?.roots.find(item => item.rootId === rootId);
    if (!root || !entry?.git) throw new Error('该目录没有可用的差异');
    return git.diff(root.path, entry.git.baseTree, entry.git.nowTree, rootId, path);
  }

  async getDelivery(): Promise<DeliveryView> {
    return this.refreshDelivery(this.wb.requireTask());
  }

  async acceptRoot(rootId: string): Promise<void> {
    await this.deliveryAction(rootId, input => delivery.acceptRoot(input, rootId));
    await this.memory.captureAfterAction();
  }

  // 还原后，该 Task 在这个仓库产生的记忆不再可信。
  async restoreRoot(rootId: string): Promise<DeliveryActionResult> {
    const result = await this.deliveryAction(rootId, input => delivery.restoreRoot(input, rootId));
    const task = this.wb.requireTask();
    const root = task.roots.find(item => item.id === rootId);
    const rejected = root && this.wb.memory.rejectTask(task.id, (await repoOf(root)).id);
    const last = this.wb.ledger.lastRun(task.id);
    if (rejected && last) this.wb.ledger.appendEvent(last.id, 'memory.changed', { action: 'rejected_by_restore', count: rejected, rootId });
    return result;
  }

  async commitRoot(rootId: string, message: string, confirmShared: boolean): Promise<DeliveryActionResult> {
    const result = await this.deliveryAction(rootId, input => delivery.commitRoot(input, rootId, message, confirmShared));
    await this.memory.captureAfterAction();
    return result;
  }

  async snapshotRoots(task: TaskState, runId: string, kind: 'run_start' | 'run_end'): Promise<Map<string, string>> {
    const trees = new Map<string, string>();
    for (const root of task.roots) {
      if (!root.git) continue;
      const started = Date.now();
      try {
        const tree = await git.snapshot(root.path);
        this.wb.ledger.appendEvent(runId, 'git.snapshot', { kind, rootId: root.id, tree, head: root.git.head, branch: root.git.branch, durationMs: Date.now() - started });
        if (kind === 'run_start' && !this.baselineOf(task, root.id)) {
          this.wb.ledger.saveDelivery({ taskId: task.id, rootId: root.id, state: 'none', baseTree: tree, baseCommit: root.git.head });
        }
        trees.set(root.id, tree);
      } catch (error) {
        this.wb.ledger.appendEvent(runId, 'git.snapshot', { kind, rootId: root.id, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started });
      }
    }
    return trees;
  }

  baselineOf(task: TaskState, rootId: string) {
    const row = this.wb.ledger.deliveryRows(task.id).find(item => item.rootId === rootId);
    return row?.baseTree ? { tree: row.baseTree, commit: row.baseCommit } : undefined;
  }

  async refreshChanges(task: TaskState, trees?: Map<string, string>): Promise<void> {
    const roots: RootChanges[] = [];
    for (const root of task.roots) {
      const baseline = this.baselineOf(task, root.id);
      if (!root.git) {
        roots.push({ rootId: root.id, git: null, reason: '无 Git 仓库，无法生成差异' });
        continue;
      }
      if (!baseline) continue;
      try {
        const nowTree = trees?.get(root.id) ?? await git.snapshot(root.path);
        const files = await git.changes(root.path, baseline.tree, nowTree);
        roots.push({ rootId: root.id, git: { branch: root.git.branch, baseCommit: baseline.commit, baseTree: baseline.tree, nowTree }, files });
      } catch (error) {
        roots.push({ rootId: root.id, git: null, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    task.changes = { taskId: task.id, computedAt: Date.now(), roots };
    this.wb.emit({ type: 'changes.updated', value: task.changes });
  }

  private deliveryInput(task: TaskState): delivery.DeliveryInput {
    const verifications = this.wb.ledger.taskEvents(task.id, 'verification.finished').map(event => event.data as unknown as VerificationResult);
    return { taskId: task.id, roots: task.roots.filter(root => !root.missing), ledger: this.wb.ledger, acceptance: task.acceptance, verifications, mutations: task.mutations, documents: this.citations(task) };
  }

  // 交付报告里的文档引用：Agent 通过 doc_read 实际读取过的页、章节与查询。
  private citations(task: TaskState): DeliveryInputDocuments {
    const calls = this.wb.ledger.taskEvents(task.id, 'tool.requested').map(event => event.data).filter(data => data.name === 'doc_read' || data.name === 'doc_outline');
    return task.documents.map(doc => {
      const refs = new Set<string>();
      for (const call of calls) {
        let args: { document?: string; refs?: unknown; query?: unknown } = {};
        try { args = JSON.parse(String(call.argsText)); } catch { continue; }
        if (args.document !== doc.name && args.document !== doc.id) continue;
        if (call.name === 'doc_outline') refs.add('outline');
        else if (typeof args.query === 'string') refs.add(`query:${args.query}`);
        else for (const ref of Array.isArray(args.refs) && args.refs.length ? args.refs : ['全文']) refs.add(String(ref));
      }
      return { name: doc.name, kind: doc.kind, sha256: doc.sha256, citations: [...refs] };
    });
  }

  // 只读刷新：计算当前交付视图（含验证是否仍然有效），不改动数据库中的交付行。
  async refreshDelivery(task: TaskState, trees?: Map<string, string>): Promise<DeliveryView> {
    const view = await delivery.buildDelivery(this.deliveryInput(task), trees);
    task.deliveryView = view;
    task.delivery = view.state;
    this.wb.emit({ type: 'delivery.updated', value: view });
    return view;
  }

  // 结束阶段的记账失败（例如目录已被删除）不能让 Run 卡在运行中，只记录原因。
  async finalizeDelivery(task: TaskState, runId: string, trees: Map<string, string>): Promise<DeliveryView | undefined> {
    try {
      const view = await delivery.persistDelivery(this.deliveryInput(task), await this.refreshDelivery(task, trees), this.wb.evidenceRoot());
      this.wb.ledger.appendEvent(runId, 'delivery.changed', { state: view.state, roots: view.roots.map(root => ({ rootId: root.rootId, state: root.state, reportFile: root.reportFile })) });
      return view;
    } catch (error) {
      this.wb.ledger.appendEvent(runId, 'delivery.changed', { error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }

  private async deliveryAction<T>(rootId: string, action: (input: delivery.DeliveryInput) => Promise<T>): Promise<T> {
    this.wb.assertIdle();
    const task = this.wb.requireTask();
    const result = await action(this.deliveryInput(task));
    await this.refreshDelivery(task);
    const last = this.wb.ledger.lastRun(task.id);
    if (last) this.wb.ledger.appendEvent(last.id, 'delivery.changed', { rootId, state: task.deliveryView?.roots.find(root => root.rootId === rootId)?.state, action: true });
    this.tasks.save(task);
    this.wb.emitSnapshot();
    return result;
  }

  // 重启或切换任务后，变更与交付状态要重新按当前真实的 Git 状态计算；失败（例如目录已被删除）时保持原样。
  async restoreViews(task: TaskState): Promise<void> {
    if (task.permission.userMode === 'plan' || task.roots.every(root => root.missing)) return;
    try {
      await this.refreshChanges(task);
      await this.refreshDelivery(task);
      this.wb.emitSnapshot();
    } catch {
      // 保持原有视图
    }
  }
}
