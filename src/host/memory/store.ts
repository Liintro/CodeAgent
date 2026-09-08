import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryKind } from '../../shared/contracts.js';

export type Anchor = { path: string; preBlob?: string; postBlob?: string };

export type NewMemory = {
  repoId: string;
  repoLabel: string;
  kind: MemoryKind;
  text: string;
  signature: string;
  origin: 'harness' | 'user';
  confirmed: boolean;
  taskId?: string;
  runId?: string;
  branch?: string;
  baseCommit?: string;
  commitSha?: string;
  evidence: Record<string, unknown>;
  anchors: Anchor[];
};

export type MemoryRow = Omit<NewMemory, 'anchors' | 'evidence'> & {
  id: string;
  status: 'active' | 'rejected' | 'deleted';
  evidence: Record<string, any>;
  hits: number;
  createdAt: number;
  updatedAt: number;
};

export type Candidate = MemoryRow & { rank: number };
export type Use = { runId: string; itemId: string; point: 'start' | 'repair'; validity: string; score: number; injected: boolean };

export const TEXT_LIMIT = 600;

// memory_item 是事实来源；memory_fts 只是它的文本索引，两者在同一个事务里修改。
export class MemoryStore {
  constructor(private readonly db: DatabaseSync) {}

  /** 在一个 SQLite 事务里执行同步的写入；任何异常都会回滚全部修改。 */
  transaction<T>(write: () => T): T {
    this.db.exec('BEGIN');
    try {
      const value = write();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** 相同签名只保留一条：活动条目被更新并增加命中数，已拒绝或已删除的条目保持原状（不会被再次捕获复活）。 */
  save(item: NewMemory): string {
    const existing = this.db.prepare('SELECT id, status, created_at FROM memory_item WHERE repo_id = ? AND signature = ?').get(item.repoId, item.signature) as { id: string; status: string; created_at: number } | undefined;
    const now = Date.now();
    if (existing && existing.status !== 'active') return existing.id;
    const text = item.text.slice(0, TEXT_LIMIT);
    if (existing) {
      this.db.prepare(`UPDATE memory_item SET repo_label = ?, text = ?, run_id = ?, branch = ?, base_commit = ?, commit_sha = COALESCE(?, commit_sha),
        evidence_json = ?, hits = hits + CASE WHEN run_id IS ? THEN 0 ELSE 1 END, updated_at = ? WHERE id = ?`)
        .run(item.repoLabel, text, item.runId ?? null, item.branch ?? null, item.baseCommit ?? null, item.commitSha ?? null, JSON.stringify(item.evidence), item.runId ?? null, now, existing.id);
      this.db.prepare('DELETE FROM memory_anchor WHERE item_id = ?').run(existing.id);
      this.writeAnchors(existing.id, item.anchors);
      this.index(existing.id, text, item.anchors);
      return existing.id;
    }
    const id = randomUUID();
    this.db.prepare(`INSERT INTO memory_item (id, repo_id, repo_label, kind, text, signature, status, origin, confirmed, task_id, run_id, branch, base_commit, commit_sha, evidence_json, hits, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(id, item.repoId, item.repoLabel, item.kind, text, item.signature, item.origin, item.confirmed ? 1 : 0, item.taskId ?? null, item.runId ?? null,
        item.branch ?? null, item.baseCommit ?? null, item.commitSha ?? null, JSON.stringify(item.evidence), now, now);
    this.writeAnchors(id, item.anchors);
    this.index(id, text, item.anchors);
    return id;
  }

  get(id: string): MemoryRow | undefined {
    const row = this.db.prepare('SELECT * FROM memory_item WHERE id = ?').get(id) as Record<string, any> | undefined;
    return row && toRow(row);
  }

  list(repoIds: string[]): MemoryRow[] {
    if (!repoIds.length) return [];
    return (this.db.prepare(`SELECT * FROM memory_item WHERE status <> 'deleted' AND repo_id IN (${placeholders(repoIds)}) ORDER BY updated_at DESC`)
      .all(...repoIds) as Record<string, any>[]).map(toRow);
  }

  anchors(itemIds: string[]): Map<string, Anchor[]> {
    const result = new Map<string, Anchor[]>();
    if (!itemIds.length) return result;
    for (const row of this.db.prepare(`SELECT * FROM memory_anchor WHERE item_id IN (${placeholders(itemIds)}) ORDER BY path`).all(...itemIds) as Record<string, any>[]) {
      const list = result.get(row.item_id) ?? [];
      list.push({ path: row.path, preBlob: row.pre_blob ?? undefined, postBlob: row.post_blob ?? undefined });
      result.set(row.item_id, list);
    }
    return result;
  }

  /** FTS5 候选，按 bm25 升序（越小越相关）；只返回活动条目。 */
  search(repoIds: string[], ftsQuery: string, limit: number): Candidate[] {
    if (!repoIds.length || !ftsQuery) return [];
    return (this.db.prepare(`SELECT i.*, bm25(memory_fts) AS rank FROM memory_fts JOIN memory_item i ON i.id = memory_fts.item_id
      WHERE memory_fts MATCH ? AND i.status = 'active' AND i.repo_id IN (${placeholders(repoIds)}) ORDER BY rank LIMIT ?`)
      .all(ftsQuery, ...repoIds, limit) as Record<string, any>[]).map(row => ({ ...toRow(row), rank: row.rank }));
  }

  /** 用户编辑：文本即视为已确认。 */
  edit(id: string, text: string): void {
    const value = text.slice(0, TEXT_LIMIT);
    this.transaction(() => {
      this.db.prepare("UPDATE memory_item SET text = ?, confirmed = 1, updated_at = ? WHERE id = ? AND status <> 'deleted'").run(value, Date.now(), id);
      this.index(id, value, [...(this.anchors([id]).get(id) ?? [])]);
    });
  }

  setStatus(id: string, status: 'active' | 'rejected'): void {
    this.db.prepare("UPDATE memory_item SET status = ?, updated_at = ? WHERE id = ? AND status <> 'deleted'").run(status, Date.now(), id);
  }

  /** Restore 一个 Task 的目录：该 Task 在该仓库产生的全部条目标记为已拒绝。 */
  rejectTask(taskId: string, repoId: string): number {
    return Number(this.db.prepare("UPDATE memory_item SET status = 'rejected', updated_at = ? WHERE task_id = ? AND repo_id = ? AND status = 'active'").run(Date.now(), taskId, repoId).changes);
  }

  /** 删除只留下墓碑（签名与状态），文本、证据、锚点和索引全部清除，因此同一结果被再次捕获时不会复活。 */
  remove(id: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE memory_item SET status = 'deleted', text = '', evidence_json = '{}', updated_at = ? WHERE id = ?").run(Date.now(), id);
      this.db.prepare('DELETE FROM memory_anchor WHERE item_id = ?').run(id);
      this.db.prepare('DELETE FROM memory_fts WHERE item_id = ?').run(id);
    });
  }

  recordUse(uses: Use[]): void {
    const insert = this.db.prepare('INSERT OR REPLACE INTO memory_use (run_id, item_id, point, validity, score, injected) VALUES (?, ?, ?, ?, ?, ?)');
    for (const use of uses) insert.run(use.runId, use.itemId, use.point, use.validity, use.score, use.injected ? 1 : 0);
  }

  private writeAnchors(id: string, anchors: Anchor[]): void {
    const insert = this.db.prepare('INSERT OR REPLACE INTO memory_anchor (item_id, path, pre_blob, post_blob) VALUES (?, ?, ?, ?)');
    for (const anchor of anchors) insert.run(id, anchor.path, anchor.preBlob ?? null, anchor.postBlob ?? null);
  }

  private index(id: string, text: string, anchors: Anchor[]): void {
    this.db.prepare('DELETE FROM memory_fts WHERE item_id = ?').run(id);
    this.db.prepare('INSERT INTO memory_fts (item_id, text, paths) VALUES (?, ?, ?)').run(id, text, anchors.map(anchor => anchor.path).join('\n'));
  }
}

const placeholders = (values: unknown[]) => values.map(() => '?').join(',');

function toRow(row: Record<string, any>): MemoryRow {
  return {
    id: row.id, repoId: row.repo_id, repoLabel: row.repo_label, kind: row.kind, text: row.text, signature: row.signature, status: row.status,
    origin: row.origin, confirmed: row.confirmed === 1, taskId: row.task_id ?? undefined, runId: row.run_id ?? undefined, branch: row.branch ?? undefined,
    baseCommit: row.base_commit ?? undefined, commitSha: row.commit_sha ?? undefined, evidence: JSON.parse(row.evidence_json), hits: row.hits,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
