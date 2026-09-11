import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Acceptance, Delivery, RootDeliveryState, RunEvent, RunEventType, RunPhase, UserMode } from '../../shared/contracts.js';

export type RunRecord = {
  id: string;
  taskId: string;
  seq: number;
  trigger: 'user' | 'recovery';
  startedAt: number;
  endedAt?: number;
  phase: RunPhase;
  stopReason?: string;
  resumedFrom?: string;
};

export type TaskRoot = { id: string; alias: string; path: string; gitRoot?: string };
export type TaskRecord = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  userMode: UserMode;
  grants: string[];
  acceptance: Acceptance;
  delivery: Delivery;
  roots: TaskRoot[];
};

export type DeliveryRow = {
  taskId: string;
  rootId: string;
  state: RootDeliveryState;
  baseTree?: string;
  finalTree?: string;
  baseCommit?: string;
  commitSha?: string;
  patchFile?: string;
  reportFile?: string;
  updatedAt: number;
};

const OPEN_PHASES = ['running', 'awaiting_approval', 'verifying', 'cancelling'];

// 迁移按 PRAGMA user_version 顺序执行；新增结构只追加新条目。
const MIGRATIONS = [`
  CREATE TABLE task (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    user_mode TEXT NOT NULL, grants_json TEXT NOT NULL DEFAULT '[]',
    session_file TEXT, acceptance_json TEXT, delivery TEXT NOT NULL DEFAULT 'none', archived INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE task_root (
    task_id TEXT NOT NULL REFERENCES task(id), root_id TEXT NOT NULL, alias TEXT NOT NULL,
    path TEXT NOT NULL, position INTEGER NOT NULL, git_root TEXT, PRIMARY KEY (task_id, root_id));
  CREATE TABLE run (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES task(id), seq INTEGER NOT NULL,
    phase TEXT NOT NULL, trigger TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
    model_id TEXT, stop_reason TEXT, error_code TEXT, resumed_from TEXT REFERENCES run(id));
  CREATE TABLE run_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES run(id),
    seq INTEGER NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL, data_json TEXT NOT NULL);
  CREATE INDEX run_event_run ON run_event(run_id, seq);
  CREATE TABLE delivery_root (
    task_id TEXT NOT NULL REFERENCES task(id), root_id TEXT NOT NULL, state TEXT NOT NULL,
    base_tree TEXT, final_tree TEXT, base_commit TEXT, commit_sha TEXT, patch_file TEXT,
    report_file TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (task_id, root_id));
`, `
  CREATE TABLE memory_item (
    id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, repo_label TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
    signature TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', origin TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0,
    task_id TEXT REFERENCES task(id), run_id TEXT REFERENCES run(id), branch TEXT, base_commit TEXT, commit_sha TEXT,
    evidence_json TEXT NOT NULL DEFAULT '{}', hits INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE UNIQUE INDEX memory_sig ON memory_item(repo_id, signature);
  CREATE INDEX memory_repo ON memory_item(repo_id, status);
  CREATE TABLE memory_anchor (
    item_id TEXT NOT NULL REFERENCES memory_item(id) ON DELETE CASCADE, path TEXT NOT NULL, pre_blob TEXT, post_blob TEXT,
    PRIMARY KEY (item_id, path));
  CREATE VIRTUAL TABLE memory_fts USING fts5(item_id UNINDEXED, text, paths, tokenize='trigram');
  CREATE TABLE memory_use (
    run_id TEXT NOT NULL REFERENCES run(id), item_id TEXT NOT NULL, point TEXT NOT NULL, validity TEXT NOT NULL,
    score REAL NOT NULL, injected INTEGER NOT NULL, PRIMARY KEY (run_id, item_id, point));
`];

// 只记录事实（发生了什么）；对话内容由 Pi SessionManager 保存。
export class Ledger {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  /** 记忆表与账本在同一个数据库文件里；memory/store.ts 直接使用这个连接。 */
  get database(): DatabaseSync {
    return this.db;
  }

  get schemaVersion(): number {
    return (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  // ---- Task ----

  saveTask(task: TaskRecord, sessionFile?: string): void {
    this.db.prepare(`INSERT INTO task (id, title, created_at, updated_at, user_mode, grants_json, session_file, acceptance_json, delivery)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at, user_mode=excluded.user_mode,
        grants_json=excluded.grants_json, session_file=COALESCE(excluded.session_file, session_file),
        acceptance_json=excluded.acceptance_json, delivery=excluded.delivery`)
      .run(task.id, task.title, task.createdAt, task.updatedAt, task.userMode, JSON.stringify(task.grants), sessionFile ?? null, JSON.stringify(task.acceptance), task.delivery);
    this.db.prepare('DELETE FROM task_root WHERE task_id = ?').run(task.id);
    const insert = this.db.prepare('INSERT INTO task_root (task_id, root_id, alias, path, position, git_root) VALUES (?, ?, ?, ?, ?, ?)');
    task.roots.forEach((root, position) => insert.run(task.id, root.id, root.alias, root.path, position, root.gitRoot ?? null));
  }

  listTasks(): TaskRecord[] {
    const roots = this.db.prepare('SELECT * FROM task_root ORDER BY task_id, position').all() as Record<string, any>[];
    return (this.db.prepare('SELECT * FROM task WHERE archived = 0 ORDER BY updated_at DESC').all() as Record<string, any>[]).map(row => ({
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      userMode: row.user_mode,
      grants: JSON.parse(row.grants_json),
      acceptance: JSON.parse(row.acceptance_json),
      delivery: row.delivery,
      roots: roots.filter(root => root.task_id === row.id).map(root => ({ id: root.root_id, alias: root.alias, path: root.path, gitRoot: root.git_root ?? undefined })),
    }));
  }

  // ---- Run ----

  startRun(taskId: string, trigger: 'user' | 'recovery' = 'user', resumedFrom?: string): RunRecord {
    const seq = ((this.db.prepare('SELECT MAX(seq) AS seq FROM run WHERE task_id = ?').get(taskId) as { seq: number | null }).seq ?? 0) + 1;
    const run: RunRecord = { id: randomUUID(), taskId, seq, trigger, startedAt: Date.now(), phase: 'running', resumedFrom };
    this.db.prepare('INSERT INTO run (id, task_id, seq, phase, trigger, started_at, resumed_from) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(run.id, taskId, seq, run.phase, trigger, run.startedAt, resumedFrom ?? null);
    return run;
  }

  endRun(runId: string, phase: RunPhase, stopReason?: string, modelId?: string): void {
    this.db.prepare('UPDATE run SET phase = ?, ended_at = ?, stop_reason = ?, model_id = COALESCE(?, model_id) WHERE id = ?')
      .run(phase, Date.now(), stopReason ?? null, modelId ?? null, runId);
  }

  lastRun(taskId: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM run WHERE task_id = ? ORDER BY seq DESC LIMIT 1').get(taskId) as Record<string, any> | undefined;
    return row && toRun(row);
  }

  // Host 异常退出后遗留的未结束 Run：标记为 interrupted 并补写 run.ended。
  interruptOpenRuns(): RunRecord[] {
    const rows = this.db.prepare(`SELECT * FROM run WHERE phase IN (${OPEN_PHASES.map(() => '?').join(',')})`).all(...OPEN_PHASES) as Record<string, any>[];
    return rows.map(row => {
      this.appendEvent(row.id, 'run.ended', { phase: 'interrupted', stopReason: 'interrupted' });
      this.endRun(row.id, 'interrupted', 'interrupted');
      return toRun({ ...row, phase: 'interrupted', stop_reason: 'interrupted' });
    });
  }

  // ---- Event ----

  appendEvent(runId: string, type: RunEventType, data: Record<string, unknown>): void {
    const seq = ((this.db.prepare('SELECT MAX(seq) AS seq FROM run_event WHERE run_id = ?').get(runId) as { seq: number | null }).seq ?? 0) + 1;
    this.db.prepare('INSERT INTO run_event (run_id, seq, at, type, data_json) VALUES (?, ?, ?, ?, ?)').run(runId, seq, Date.now(), type, JSON.stringify(data));
  }

  events(runId: string): RunEvent[] {
    return (this.db.prepare('SELECT * FROM run_event WHERE run_id = ? ORDER BY seq').all(runId) as Record<string, any>[]).map(toEvent);
  }

  taskEvents(taskId: string, ...types: RunEventType[]): RunEvent[] {
    const filter = types.length ? ` AND e.type IN (${types.map(() => '?').join(',')})` : '';
    return (this.db.prepare(`SELECT e.* FROM run_event e JOIN run r ON r.id = e.run_id WHERE r.task_id = ?${filter} ORDER BY r.seq, e.seq`)
      .all(taskId, ...types) as Record<string, any>[]).map(toEvent);
  }

  // ---- Delivery ----

  deliveryRows(taskId: string): DeliveryRow[] {
    return (this.db.prepare('SELECT * FROM delivery_root WHERE task_id = ?').all(taskId) as Record<string, any>[]).map(row => ({
      taskId: row.task_id,
      rootId: row.root_id,
      state: row.state,
      baseTree: row.base_tree ?? undefined,
      finalTree: row.final_tree ?? undefined,
      baseCommit: row.base_commit ?? undefined,
      commitSha: row.commit_sha ?? undefined,
      patchFile: row.patch_file ?? undefined,
      reportFile: row.report_file ?? undefined,
      updatedAt: row.updated_at,
    }));
  }

  saveDelivery(row: Omit<DeliveryRow, 'updatedAt'>): void {
    this.db.prepare(`INSERT INTO delivery_root (task_id, root_id, state, base_tree, final_tree, base_commit, commit_sha, patch_file, report_file, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id, root_id) DO UPDATE SET state=excluded.state, base_tree=excluded.base_tree, final_tree=excluded.final_tree,
        base_commit=excluded.base_commit, commit_sha=excluded.commit_sha, patch_file=excluded.patch_file, report_file=excluded.report_file, updated_at=excluded.updated_at`)
      .run(row.taskId, row.rootId, row.state, row.baseTree ?? null, row.finalTree ?? null, row.baseCommit ?? null, row.commitSha ?? null, row.patchFile ?? null, row.reportFile ?? null, Date.now());
  }

  private migrate(): void {
    for (let version = this.schemaVersion; version < MIGRATIONS.length; version++) {
      this.db.exec(`BEGIN; ${MIGRATIONS[version]} PRAGMA user_version = ${version + 1}; COMMIT;`);
    }
  }
}

function toRun(row: Record<string, any>): RunRecord {
  return {
    id: row.id, taskId: row.task_id, seq: row.seq, trigger: row.trigger, startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined, phase: row.phase, stopReason: row.stop_reason ?? undefined, resumedFrom: row.resumed_from ?? undefined,
  };
}

function toEvent(row: Record<string, any>): RunEvent {
  return { runId: row.run_id, seq: row.seq, at: row.at, type: row.type, data: JSON.parse(row.data_json) };
}
