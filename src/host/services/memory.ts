import { randomUUID } from 'node:crypto';
import type { ApprovalRequest, DeliveryView, MemoryChange, MemoryItemView, MemoryOutcome, VerificationResult } from '../../shared/contracts/index.js';
import { captureOutcome } from '../memory/capture.js';
import { correctionLesson, rejectionLesson, routeLessons } from '../memory/lessons.js';
import { recall, search, type Failure, type SearchRequest } from '../memory/recall.js';
import type { NewMemory } from '../memory/store.js';
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
    else if (change.action === 'confirm') this.wb.memory.confirm(change.id);
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
      const recalled = await recall(this.wb.memory, { roots: task.roots.filter(root => !root.missing), query, changedPaths: await this.changedPaths(task), contextWindow: this.wb.profile!.contextWindow, failure, runId }, this.wb.policy.settings.recall);
      this.wb.memory.recordUse(recalled.items.map(item => ({ runId, itemId: item.id, point, validity: item.validity, score: item.score, injected: item.injected })));
      if (!recalled.text) return undefined;
      const shown = recalled.items.filter(item => item.injected).map(item => {
        const row = this.wb.memory.get(item.id)!;
        return { id: item.id, kind: item.kind, validity: item.validity, repoLabel: row.repoLabel, text: row.text };
      });
      this.wb.ledger.appendEvent(runId, 'memory.recalled', { point, tokens: recalled.tokens, items: recalled.items, shown, text: recalled.text });
      task.timeline.push({ kind: 'memory', id: randomUUID(), runId, items: shown });
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

  /** 只有任务所在仓库里有可用记忆时才提供 memory_search：空库时请求与没有记忆功能时完全相同。 */
  async searchAvailable(task: TaskState): Promise<boolean> {
    return this.wb.memoryEnabled && this.wb.memory.hasActive([...(await this.taskRepos(task)).keys()]);
  }

  // memory_search 工具：结果同样记入 memory_use，所以也参与之后的效果加权。
  async searchForTool(task: TaskState, runId: string, request: Omit<SearchRequest, 'roots' | 'runId'>): Promise<string> {
    const found = await search(this.wb.memory, { ...request, roots: task.roots.filter(root => !root.missing), runId }, this.wb.policy.settings.recall);
    this.wb.memory.recordUse(found.items.map(item => ({ runId, itemId: item.id, point: 'search', validity: item.validity, score: item.score, injected: true })));
    return found.text;
  }

  /** Run 结束：用过的记忆记下这次的结果，时间线的记忆行随之显示是否起了作用。无从判断的结果（取消、出错、未验证）不记。 */
  recordOutcome(task: TaskState, runId: string, stopReason: string): void {
    const outcome: MemoryOutcome | undefined = stopReason === 'passed' ? 'passed' : ['verification_failed', 'budget_exhausted', 'no_progress', 'budget_exceeded'].includes(stopReason) ? 'failed' : undefined;
    if (!outcome) return;
    this.wb.memory.setOutcome(runId, outcome);
    for (const item of task.timeline) if (item.kind === 'memory' && item.runId === runId) item.outcome = outcome;
  }

  /** 用户还原了这个 Task 的改动：其中用过的记忆都算没有起作用。 */
  markRejected(task: TaskState): void {
    this.wb.memory.rejectTaskOutcomes(task.id);
    for (const item of task.timeline) if (item.kind === 'memory' && item.outcome) item.outcome = 'rejected';
  }

  async captureRejection(task: TaskState, runId: string, request: ApprovalRequest, args: Record<string, unknown>, reason: string): Promise<void> {
    const root = task.roots.find(item => item.id === request.rootId) ?? task.roots.find(item => item.primary);
    if (!root || root.missing) return;
    const repo = await repoOf(root);
    const path = request.tool === 'edit' || request.tool === 'write' ? `${repo.prefix}${String(args.path ?? '').replaceAll('\\', '/')}` : undefined;
    await this.saveLessons(runId, [await rejectionLesson(repo, { repoId: repo.id, repoLabel: repo.label, taskId: task.id, runId }, request, path, reason)]);
  }

  /** 任务里的后续消息像是在纠正上一个回答时，记成待确认的教训。 */
  async captureCorrection(task: TaskState, runId: string, text: string): Promise<void> {
    const root = task.roots.find(item => item.primary && !item.missing);
    if (!root) return;
    const repo = await repoOf(root);
    const lesson = correctionLesson({ repoId: repo.id, repoLabel: repo.label, taskId: task.id, runId }, text);
    if (lesson) await this.saveLessons(runId, [lesson]);
  }

  private async saveLessons(runId: string, lessons: NewMemory[]): Promise<void> {
    try {
      const items = this.wb.memory.transaction(() => lessons.map(item => ({ id: this.wb.memory.save(item), kind: item.kind })));
      if (items.length) this.wb.ledger.appendEvent(runId, 'memory.captured', { items });
    } catch (error) {
      this.wb.ledger.appendEvent(runId, 'memory.capture_failed', { message: error instanceof Error ? error.message : String(error) });
    }
  }

  // 在 Run 结束前同步完成（不是后台任务）；失败只记录原因，Run 照常结束。
  async captureMemory(task: TaskState, runId: string, view: DeliveryView): Promise<void> {
    try {
      const commitShas = new Map(this.wb.ledger.deliveryRows(task.id).flatMap(row => row.commitSha ? [[row.rootId, row.commitSha] as const] : []));
      const items = await captureOutcome(this.wb.memory, this.wb.ledger, task, view, runId, commitShas);
      if (items.length) this.wb.ledger.appendEvent(runId, 'memory.captured', { items });
      await this.saveLessons(runId, await this.routeLessons(task, runId));
    } catch (error) {
      this.wb.ledger.appendEvent(runId, 'memory.capture_failed', { message: error instanceof Error ? error.message : String(error) });
    }
  }

  // 换路线的教训不要求这次 Run 最终通过：放弃的方案本身就是经验。
  private async routeLessons(task: TaskState, runId: string): Promise<NewMemory[]> {
    const results = this.wb.ledger.events(runId).filter(event => event.type === 'verification.finished').map(event => ({ runId, result: event.data as unknown as VerificationResult }));
    const lessons: NewMemory[] = [];
    for (const root of task.roots.filter(item => item.git && !item.missing)) {
      const repo = await repoOf(root);
      lessons.push(...await routeLessons(repo, { repoId: repo.id, repoLabel: repo.label, taskId: task.id, runId }, root.id, results));
    }
    return lessons;
  }

  // 用户接受或提交之后再捕获一次：同样的签名只会补上 commit_sha。
  async captureAfterAction(): Promise<void> {
    const task = this.wb.requireTask();
    const last = this.wb.ledger.lastRun(task.id);
    if (last && task.deliveryView) await this.captureMemory(task, last.id, task.deliveryView);
  }
}
