import { useCallback, useEffect, useState } from 'react';
import type { AppError, MemoryItemView, MemoryKind, MemoryValidity, WorkbenchSnapshot } from '../../shared/contracts';

type Call = <T>(action: Promise<{ ok: true; value: T } | { ok: false; error: AppError }>) => Promise<T | undefined>;

export const kindText: Record<MemoryKind, string> = { fix: '修复', change: '变更', convention: '约定', note: '备注' };
export const validityText: Record<MemoryValidity, string> = { current: '当前', drifted: '已漂移', reverted: '已回退', not_in_history: '不在当前历史', unverifiable: '无法校验' };

export function MemoryPanel({ view, active, call }: { view: WorkbenchSnapshot; active: boolean; call: Call }) {
  const [items, setItems] = useState<MemoryItemView[]>([]);
  const [editing, setEditing] = useState<string>();
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const refreshKey = `${view.taskId}:${view.run?.id}:${view.run?.phase}`;

  const refresh = useCallback(async () => {
    const reply = await window.codeAgent.listMemory();
    if (reply.ok) setItems(reply.value);
  }, []);
  useEffect(() => { void refresh(); }, [refresh, refreshKey]);

  async function change(action: Parameters<typeof window.codeAgent.changeMemory>[0]) {
    await call(window.codeAgent.changeMemory(action));
    setEditing(undefined);
    await refresh();
  }

  async function addNote() {
    const reply = await window.codeAgent.addMemoryNote(note);
    if (reply.ok) {
      setNote('');
      await refresh();
    } else await call(Promise.resolve(reply));
  }

  return (
    <div className="panel-body">
      <div className="changes-header">
        <label className="checkbox-label">
          <input type="checkbox" role="switch" aria-label="启用记忆" checked={view.memoryEnabled} onChange={event => call(window.codeAgent.setMemoryEnabled(event.target.checked))} disabled={active} />
          <span>启用记忆</span>
        </label>
        <button className="text-button" onClick={refresh}>刷新</button>
      </div>
      <div className="memory-add">
        <textarea aria-label="记忆备注" rows={2} value={note} onChange={event => setNote(event.target.value)} placeholder="添加备注" />
        <button className="secondary small" disabled={!note.trim() || !view.roots.length} onClick={addNote}>添加</button>
      </div>
      {!items.length && <p className="changes-empty">暂无记忆</p>}
      {items.map(item => (
        <article key={item.id} className={`memory-item ${item.status}`} aria-label={`记忆 ${kindText[item.kind]}`}>
          <div className="memory-meta">
            <span className="tag">{kindText[item.kind]}</span>
            <span className={`delivery-chip validity-${item.validity}`}>{item.status === 'rejected' ? '已标记错误' : validityText[item.validity]}</span>
            <span className="tool-meta">{item.repoLabel}{item.taskTitle ? ` · ${item.taskTitle}` : ''} · {new Date(item.updatedAt).toLocaleDateString('zh-CN')}</span>
          </div>
          {editing === item.id ? (
            <div className="commit-form">
              <textarea aria-label="编辑记忆" rows={4} value={draft} onChange={event => setDraft(event.target.value)} />
              <div className="delivery-actions">
                <button className="primary small" disabled={!draft.trim()} onClick={() => change({ id: item.id, action: 'edit', text: draft })}>保存</button>
                <button className="secondary small" onClick={() => setEditing(undefined)}>取消</button>
              </div>
            </div>
          ) : (
            <p className="memory-text">{item.text}</p>
          )}
          {editing !== item.id && (
            <div className="delivery-actions">
              {item.status === 'active' ? (
                <>
                  <button className="secondary small" onClick={() => { setEditing(item.id); setDraft(item.text); }}>编辑</button>
                  <button className="secondary small" onClick={() => change({ id: item.id, action: 'reject' })}>标记错误</button>
                </>
              ) : (
                <button className="secondary small" onClick={() => change({ id: item.id, action: 'restore' })}>恢复</button>
              )}
              <button className="secondary small" onClick={() => change({ id: item.id, action: 'delete' })}>删除</button>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
