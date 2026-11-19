import type { DatabaseSync } from 'node:sqlite';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

/** 摘要形成时某个文件的内容标识；之后内容变了，摘要里关于它的描述就可能过期。 */
export type FileStamp = { rootId: string; path: string; blob?: string };

/**
 * 会话按 seq 只追加：message 是对话本身；compaction 之前（firstKeptSeq 之前）的消息由摘要代替；
 * trim 之后，seq 小于 beforeSeq 的工具结果在请求里换成占位说明（原文仍在这里）。
 */
export type SessionEntry =
  | { seq: number; at: number; type: 'message'; message: AgentMessage }
  | { seq: number; at: number; type: 'compaction'; summary: string; firstKeptSeq: number; tokensBefore: number; files: FileStamp[] }
  | { seq: number; at: number; type: 'trim'; beforeSeq: number };

type NewEntry = SessionEntry extends infer E ? E extends SessionEntry ? Omit<E, 'seq' | 'at'> : never : never;

/** 一个任务的对话记录，存在账本数据库的 session_entry 表里；读入一次后在内存里追加。 */
export class SessionStore {
  private readonly list: SessionEntry[];

  constructor(private readonly db: DatabaseSync, readonly taskId: string) {
    this.list = (db.prepare('SELECT seq, type, at, data_json FROM session_entry WHERE task_id = ? ORDER BY seq').all(taskId) as Record<string, any>[])
      .map(row => ({ seq: row.seq, at: row.at, type: row.type, ...JSON.parse(row.data_json) }));
  }

  entries(): readonly SessionEntry[] {
    return this.list;
  }

  appendMessage(message: AgentMessage): void {
    this.append({ type: 'message', message });
  }

  appendCompaction(summary: string, firstKeptSeq: number, tokensBefore: number, files: FileStamp[]): void {
    this.append({ type: 'compaction', summary, firstKeptSeq, tokensBefore, files });
  }

  appendTrim(beforeSeq: number): void {
    this.append({ type: 'trim', beforeSeq });
  }

  /** 重试前移除失败的那条 assistant 消息；它的错误已记在账本的 model.retry 里。 */
  dropLastAssistant(): void {
    const last = this.list.at(-1);
    if (last?.type !== 'message' || last.message.role !== 'assistant') return;
    this.db.prepare('DELETE FROM session_entry WHERE task_id = ? AND seq = ?').run(this.taskId, last.seq);
    this.list.pop();
  }

  private append(entry: NewEntry): void {
    const { type, ...data } = entry;
    const value = { ...entry, seq: (this.list.at(-1)?.seq ?? 0) + 1, at: Date.now() } as SessionEntry;
    this.db.prepare('INSERT INTO session_entry (task_id, seq, type, at, data_json) VALUES (?, ?, ?, ?, ?)').run(this.taskId, value.seq, type, value.at, JSON.stringify(data));
    this.list.push(value);
  }
}
