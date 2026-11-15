import { randomUUID } from 'node:crypto';
import type { DeliveryView, MemoryChange, MemoryItemView } from '../../shared/contracts/index.js';
import { captureOutcome } from '../memory/capture.js';
import { recall, type Failure } from '../memory/recall.js';
import { repoOf, type RepoRef } from '../memory/repo.js';
import { evaluate, type Evaluation } from '../memory/validity.js';
import type { TaskState, Workbench } from './workbench.js';

/** 记忆的召回、捕获与用户管理接口。 */
export class MemoryService {
  constructor(private readonly wb: Workbench) {}

  setEnabled(enabled: boolean): void {
    this.wb.memoryEnabled = enabled;
    this.wb.emitSnapshot();
  }

  // 当前 Task 各仓库的记忆；有效性按此刻的工作区实时计算。
  async listMemory(): Promise<MemoryItemView[]> {
    const repos = await this.taskRepos(this.wb.requireTask());
    const items = this.wb.memory.list([...repos.keys()]).slice(0, 300);
    const anchors = this.wb.memory.anchors(items.map(item => item.id));
    const evaluations = new Map<string, Evaluation>();
    for (const [repoId, repo] of repos) {
      for (const [id, value] of await evaluate(repo, items.filter(item => item.repoId === repoId && item.status === 'active'), anchors)) evaluations.set(id, value);
    }
    return items.map(item => ({
      id: item.id, kind: item.kind, text: item.text, status: item.status as 'active' | 'rejected', origin: item.origin, confirmed: item.confirmed, repoLabel: item.repoLabel,
      taskId: item.taskId, taskTitle: this.wb.tasks.find(task => task.id === item.taskId)?.title, paths: (anchors.get(item.id) ?? []).map(anchor => anchor.path),
      validity: evaluations.get(item.id)?.validity ?? 'unverifiable', updatedAt: item.updatedAt,
    }));
  }

  // 执行期间不改记忆：修改在下一个召回点（下一个 Run 的开始或下一次修复）起生效。
  changeMemory(change: MemoryChange): void {
    this.wb.assertIdle();
    if (change.action === 'edit') this.wb.memory.edit(change.id, change.text);
    else if (change.action === 'delete') this.wb.memory.remove(change.id);
    else this.wb.memory.setStatus(change.id, change.action === 'reject' ? 'rejected' : 'active');
    this.recordMemoryChange(change.action, change.id);
  }

  async addMemoryNote(text: string): Promise<void> {
    this.wb.assertIdle();
    const task = this.wb.requireTask();
    const root = task.roots.find(item => item.primary && !item.missing);
    if (!root) throw new Error('请先添加目录');
    const repo = await repoOf(root);
    const id = this.wb.memory.save({ repoId: repo.id, repoLabel: repo.label, kind: 'note', text, signature: randomUUID(), origin: 'user', confirmed: true, taskId: task.id, evidence: {}, anchors: [] });
    this.recordMemoryChange('note', id);
  }

  private recordMemoryChange(action: string, itemId: string): void {
    const last = this.wb.ledger.lastRun(this.wb.requireTask().id);
    if (last) this.wb.ledger.appendEvent(last.id, 'memory.changed', { action, itemId });
  }

  private async taskRepos(task: TaskState): Promise<Map<string, RepoRef>> {
    const repos = new Map<string, RepoRef>();
    for (const root of task.roots.filter(item => !item.missing)) {
      const repo = await repoOf(root);
      if (!repos.has(repo.id)) repos.set(repo.id, repo);
    }
    return repos;
  }

  // 取出与本次请求相关、且在当前代码上仍然有效的历史记忆，返回要发给模型的文本；召回失败不影响 Run。
  async recallSlot(task: TaskState, runId: string, point: 'start' | 'repair', query: string, failure?: Failure): Promise<string | undefined> {
    if (!this.wb.memoryEnabled) return undefined;
    try {
      const recalled = await recall(this.wb.memory, { roots: task.roots.filter(root => !root.missing), query, changedPaths: await this.changedPaths(task), contextWindow: this.wb.profile!.contextWindow, failure });
      this.wb.memory.recordUse(recalled.items.map(item => ({ runId, itemId: item.id, point, validity: item.validity, score: item.score, injected: item.injected })));
      if (!recalled.text) return undefined;
      const shown = recalled.items.filter(item => item.injected).map(item => {
        const row = this.wb.memory.get(item.id)!;
        return { id: item.id, kind: item.kind, validity: item.validity, repoLabel: row.repoLabel, text: row.text };
      });
      this.wb.ledger.appendEvent(runId, 'memory.recalled', { point, tokens: recalled.tokens, items: recalled.items, shown, text: recalled.text });
      task.timeline.push({ kind: 'memory', id: randomUUID(), items: shown });
      this.wb.emitSnapshot();
      return recalled.text;
    } catch (error) {
      this.wb.ledger.appendEvent(runId, 'memory.recalled', { point, error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }

  private async changedPaths(task: TaskState): Promise<string[]> {
    const paths: string[] = [];
    for (const entry of task.deliveryView?.roots ?? []) {
      const root = task.roots.find(item => item.id === entry.rootId);
      if (!root?.git) continue;
      const prefix = (await repoOf(root)).prefix;
      paths.push(...entry.files.map(file => prefix + file.path));
    }
    return paths;
  }

  // 在 Run 结束前同步完成（不是后台任务）；失败只记录原因，Run 照常结束。
  async captureMemory(task: TaskState, runId: string, view: DeliveryView): Promise<void> {
    try {
      const commitShas = new Map(this.wb.ledger.deliveryRows(task.id).flatMap(row => row.commitSha ? [[row.rootId, row.commitSha] as const] : []));
      const items = await captureOutcome(this.wb.memory, this.wb.ledger, task, view, runId, commitShas);
      if (items.length) this.wb.ledger.appendEvent(runId, 'memory.captured', { items });
    } catch (error) {
      this.wb.ledger.appendEvent(runId, 'memory.capture_failed', { message: error instanceof Error ? error.message : String(error) });
    }
  }

  // 用户接受或提交之后再捕获一次：同样的签名只会补上 commit_sha。
  async captureAfterAction(): Promise<void> {
    const task = this.wb.requireTask();
    const last = this.wb.ledger.lastRun(task.id);
    if (last && task.deliveryView) await this.captureMemory(task, last.id, task.deliveryView);
  }
}
