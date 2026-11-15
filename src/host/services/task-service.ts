import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { Acceptance, DetectedCommand, DocumentView, PermissionSetting, RootView, UserMode } from '../../shared/contracts/index.js';
import { DEFAULT_MAX_REPAIRS } from '../../shared/constants.js';
import { detectCommands } from '../engineering/index.js';
import type { TaskRecord } from '../runtime/ledger.js';
import { rebuildTimeline } from '../runtime/timeline.js';
import { permissionFor } from '../tools/permission.js';
import * as git from '../workspace/git.js';
import { openRoot } from '../workspace/workspace.js';
import { documentView, type TaskState, type Workbench } from './workbench.js';

/** 任务的增删改、目录与文档、权限模式、验收命令，以及任务在账本和会话文件中的持久化。 */
export class TaskService {
  constructor(
    private readonly wb: Workbench,
    /** 切换或重新打开任务后按真实 Git 状态刷新变更与交付视图。 */
    private readonly restoreViews: (task: TaskState) => Promise<void>,
  ) {}

  // 重启后核对目录是否仍然存在并刷新 Git 信息。
  async revalidateRoots(): Promise<void> {
    for (const task of this.wb.tasks) {
      for (const root of task.roots) {
        root.missing = !(await stat(root.path).then(value => value.isDirectory(), () => false));
        root.git = root.missing ? undefined : await git.detect(root.path);
      }
    }
    this.wb.emitSnapshot();
    const current = this.wb.tasks.find(item => item.id === this.wb.taskId);
    if (current) await this.restoreViews(current);
  }

  async newTask(rootPaths: string[] = []): Promise<void> {
    this.wb.assertIdle();
    const roots: RootView[] = [];
    for (const path of rootPaths) {
      try {
        roots.push(await openRoot(path, roots));
      } catch {
        // 已不存在的最近目录在播种新任务时直接丢弃。
      }
    }
    this.wb.testRun = undefined;
    this.createTask(roots);
    this.wb.emitSnapshot();
  }

  selectTask(taskId: string): void {
    this.wb.assertIdle();
    const task = this.wb.tasks.find(item => item.id === taskId);
    if (!task) throw new Error('任务不存在');
    this.load(task);
    this.wb.taskId = taskId;
    this.wb.testRun = undefined;
    this.wb.emitSnapshot();
    void this.restoreViews(task);
  }

  renameTask(taskId: string, title: string): void {
    const task = this.wb.tasks.find(item => item.id === taskId);
    if (!task) throw new Error('任务不存在');
    task.title = title;
    this.save(task);
    this.wb.emitSnapshot();
  }

  async deleteTask(taskId: string): Promise<void> {
    this.wb.assertIdle();
    const task = this.wb.tasks.find(item => item.id === taskId);
    if (!task) throw new Error('任务不存在');
    this.wb.tasks = this.wb.tasks.filter(item => item.id !== taskId);
    this.wb.ledger.archiveTask(taskId);
    for (const root of task.roots) {
      if (root.sandboxGranted && !this.wb.tasks.some(item => item.roots.some(other => other.path === root.path && other.sandboxGranted))) {
        await this.wb.sandbox?.revoke(root.path).catch(() => undefined);
      }
    }
    if (this.wb.taskId === taskId) {
      const next = [...this.wb.tasks].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (next) {
        this.load(next);
        this.wb.taskId = next.id;
        void this.restoreViews(next);
      } else this.createTask([]);
    }
    this.wb.emitSnapshot();
  }

  async addRoot(path: string, grantSandbox = false): Promise<RootView> {
    this.wb.assertIdle();
    const task = this.ensureTask();
    const root = await openRoot(path, task.roots);
    if (grantSandbox) await this.grant(root);
    task.roots.push(root);
    this.rootsChanged(task);
    return root;
  }

  async removeRoot(rootId: string): Promise<void> {
    this.wb.assertIdle();
    const task = this.wb.requireTask();
    const root = task.roots.find(item => item.id === rootId);
    if (!root) throw new Error('目录不存在');
    task.roots = task.roots.filter(item => item.id !== rootId);
    task.acceptance = { ...task.acceptance, commands: task.acceptance.commands.filter(command => command.rootId !== rootId) };
    if (root.primary && task.roots.length) task.roots[0].primary = true;
    this.rootsChanged(task);
    if (root.sandboxGranted && !this.wb.tasks.some(item => item.roots.some(other => other.path === root.path && other.sandboxGranted))) {
      await this.wb.sandbox?.revoke(root.path).catch(() => undefined);
    }
  }

  async addDocument(path: string): Promise<DocumentView> {
    this.wb.assertIdle();
    const task = this.ensureTask();
    const record = await this.wb.library.inspect(path);
    if (task.documents.some(doc => doc.sha256 === record.sha256)) throw new Error('该文档已在任务中');
    if (task.documents.some(doc => doc.name === record.name)) throw new Error(`任务中已有同名文档：${record.name}`);
    task.documents.push(record);
    this.wb.ledger.saveDocuments(task.id, task.documents);
    this.save(task);
    this.wb.emitSnapshot();
    return documentView(record);
  }

  removeDocument(documentId: string): void {
    this.wb.assertIdle();
    const task = this.wb.requireTask();
    if (!task.documents.some(doc => doc.id === documentId)) throw new Error('文档不存在');
    task.documents = task.documents.filter(doc => doc.id !== documentId);
    this.wb.ledger.saveDocuments(task.id, task.documents);
    this.save(task);
    this.wb.emitSnapshot();
  }

  setPrimaryRoot(rootId: string): void {
    this.wb.assertIdle();
    const task = this.wb.requireTask();
    if (!task.roots.some(root => root.id === rootId)) throw new Error('目录不存在');
    for (const root of task.roots) root.primary = root.id === rootId;
    task.roots.sort((a, b) => Number(b.primary) - Number(a.primary));
    this.rootsChanged(task);
  }

  async setPermission(userMode: UserMode): Promise<PermissionSetting> {
    this.wb.assertIdle();
    const task = this.ensureTask();
    if (userMode === 'auto') {
      if (this.wb.sandbox?.status !== 'available') throw new Error('Auto 需要已验证的原生沙箱，当前不可用');
      for (const root of task.roots) await this.grant(root);
    }
    task.permission = permissionFor(userMode, task.permission.grants);
    this.save(task);
    this.wb.emitSnapshot();
    return task.permission;
  }

  async detectAcceptance(): Promise<DetectedCommand[]> {
    const found: DetectedCommand[] = [];
    const task = this.wb.requireTask();
    const sandboxed = task.permission.userMode === 'auto';
    for (const root of task.roots.filter(item => !item.missing)) found.push(...await detectCommands(root, sandboxed));
    return found;
  }

  setAcceptance(acceptance: Acceptance): void {
    this.wb.assertIdle();
    const task = this.wb.requireTask();
    const known = new Set(task.roots.map(root => root.id));
    if (acceptance.commands.some(command => !known.has(command.rootId))) throw new Error('验收命令所属目录不在当前任务中');
    task.acceptance = acceptance;
    this.save(task);
    this.wb.emitSnapshot();
  }

  async assertRootsExist(task: TaskState): Promise<void> {
    for (const root of task.roots) {
      const exists = await stat(root.path).then(value => value.isDirectory(), () => false);
      if (!exists) throw Object.assign(new Error(`目录不存在或已移除：${root.path}`), { appCode: 'ROOT_MISSING' });
    }
  }

  async refreshRoots(task: TaskState): Promise<void> {
    for (const root of task.roots) {
      root.missing = false;
      root.git = await git.detect(root.path);
    }
  }

  private rootsChanged(task: TaskState): void {
    task.permission = { ...task.permission, grants: [] };
    task.changes = undefined;
    task.deliveryView = undefined;
    this.save(task);
    this.wb.emitSnapshot();
  }

  private async grant(root: RootView): Promise<void> {
    if (root.sandboxGranted) return;
    await this.wb.sandbox!.grant(root.path);
    root.sandboxGranted = true;
  }

  // ---- 持久化 ----

  restoreTasks(): void {
    this.wb.ledger.interruptOpenRuns();
    for (const record of this.wb.ledger.listTasks()) this.wb.tasks.push(this.taskFromRecord(record));
    this.wb.taskId = this.wb.tasks[0]?.id;
    if (this.wb.tasks[0]) this.load(this.wb.tasks[0]);
  }

  private taskFromRecord(record: TaskRecord): TaskState {
    const mutations = new Map<string, number>();
    for (const row of this.wb.ledger.deliveryRows(record.id)) if (row.finalTree?.startsWith('mut:')) mutations.set(row.rootId, Number(row.finalTree.slice(4)));
    const last = this.wb.ledger.lastRun(record.id);
    return {
      id: record.id, title: record.title, createdAt: record.createdAt, updatedAt: record.updatedAt,
      roots: record.roots.map((root, index) => ({ id: root.id, alias: root.alias, path: root.path, primary: index === 0, sandboxGranted: false })),
      documents: this.wb.ledger.documents(record.id),
      permission: permissionFor(record.userMode, record.grants), acceptance: record.acceptance, delivery: record.delivery, mutations,
      interrupted: last?.phase === 'interrupted', loaded: false, session: undefined as never, timeline: [],
      run: last && { id: last.id, taskId: record.id, phase: last.phase, toolErrors: false },
    };
  }

  // 会话与时间线在第一次使用时才读入。
  load(task: TaskState): void {
    if (task.loaded) return;
    task.session = this.openSession(task);
    const events = this.wb.ledger.taskEvents(task.id, 'tool.requested', 'tool.finished', 'verification.finished', 'memory.recalled');
    task.timeline = rebuildTimeline(task.session, events, task.roots);
    task.loaded = true;
  }

  private openSession(task: TaskState): SessionManager {
    const cwd = task.roots[0]?.path ?? process.cwd();
    if (!this.wb.dataDir) return SessionManager.inMemory(cwd);
    // 会话文件名以时间戳开头；目录可能是在添加目录之前创建的，所以不按 cwd 匹配，直接打开最新的文件。
    const directory = join(this.wb.dataDir, 'sessions', task.id);
    const latest = existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith('.jsonl')).sort().at(-1) : undefined;
    return latest ? SessionManager.open(join(directory, latest), directory) : SessionManager.create(cwd, directory);
  }

  save(task: TaskState): void {
    task.updatedAt = Date.now();
    this.wb.ledger.saveTask({
      id: task.id, title: task.title, createdAt: task.createdAt, updatedAt: task.updatedAt, userMode: task.permission.userMode,
      grants: task.permission.grants, acceptance: task.acceptance, delivery: task.delivery,
      roots: task.roots.map(root => ({ id: root.id, alias: root.alias, path: root.path, gitRoot: root.git?.gitRoot })),
    }, task.session?.getSessionFile());
  }

  private createTask(roots: RootView[]): TaskState {
    if (roots.length) roots[0].primary = true;
    const task: TaskState = {
      id: randomUUID(), title: '新任务', createdAt: Date.now(), updatedAt: Date.now(), roots, documents: [], permission: permissionFor('manual'),
      acceptance: { commands: [], maxRepairs: DEFAULT_MAX_REPAIRS }, delivery: 'none', mutations: new Map(), interrupted: false, loaded: true,
      session: undefined as never, timeline: [],
    };
    task.session = this.openSession(task);
    this.wb.tasks.push(task);
    this.wb.taskId = task.id;
    this.save(task);
    return task;
  }

  ensureTask(): TaskState {
    return this.wb.tasks.find(item => item.id === this.wb.taskId) ?? this.createTask([]);
  }
}
