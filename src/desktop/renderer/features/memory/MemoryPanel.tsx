import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { MemoryChange, MemoryItemView } from '../../../../shared/contracts';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/form';
import { Badge, Empty, Switch } from '@/components/ui/misc';
import { bridge, call } from '@/lib/bridge';
import { cn } from '@/lib/utils';
import { kindText, validityText } from '@/i18n/zh';
import { useActive, useView } from '@/store/snapshot';

export function MemoryPanel() {
  const enabled = useView(view => view.memoryEnabled);
  const hasRoots = useView(view => view.roots.length > 0);
  const refreshKey = useView(view => `${view.taskId}:${view.run?.id}:${view.run?.phase}`);
  const active = useActive();
  const [items, setItems] = useState<MemoryItemView[]>([]);
  const [editing, setEditing] = useState<string>();
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');

  const refresh = useCallback(async () => {
    const reply = await bridge().listMemory();
    if (reply.ok) setItems(reply.value);
  }, []);
  useEffect(() => { void refresh(); }, [refresh, refreshKey]);

  async function change(action: MemoryChange) {
    await call(bridge().changeMemory(action));
    setEditing(undefined);
    await refresh();
  }

  async function addNote() {
    const reply = await bridge().addMemoryNote(note);
    if (!reply.ok) {
      await call(Promise.resolve(reply));
      return;
    }
    setNote('');
    await refresh();
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <MemorySwitch enabled={enabled} disabled={active} />
        <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="刷新" title="刷新" onClick={refresh}><RefreshCw /></Button>
      </div>
      <div className="flex gap-2 border-b border-border px-3 py-2">
        <Textarea aria-label="记忆备注" rows={2} value={note} onChange={event => setNote(event.target.value)} placeholder="添加备注" className="text-xs" />
        <Button variant="secondary" size="sm" className="self-end" disabled={!note.trim() || !hasRoots} onClick={addNote}>添加</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {!items.length && <Empty>暂无记忆</Empty>}
        {items.map(item => (
          <article key={item.id} aria-label={`记忆 ${kindText[item.kind]}`} className={cn('mb-2 rounded-lg border border-border p-2.5', item.status === 'rejected' && 'opacity-60')}>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge>{kindText[item.kind]}</Badge>
              <Badge tone={item.status === 'rejected' ? 'danger' : item.validity === 'current' ? 'success' : 'warning'}>{item.status === 'rejected' ? '已标记错误' : validityText[item.validity]}</Badge>
              <span className="min-w-0 truncate text-[11px] text-subtle">{item.repoLabel}{item.taskTitle ? ` · ${item.taskTitle}` : ''} · {new Date(item.updatedAt).toLocaleDateString('zh-CN')}</span>
            </div>
            {editing === item.id ? (
              <div className="mt-2 flex flex-col gap-1.5">
                <Textarea aria-label="编辑记忆" rows={4} value={draft} onChange={event => setDraft(event.target.value)} className="text-xs" />
                <div className="flex gap-1.5">
                  <Button size="xs" disabled={!draft.trim()} onClick={() => change({ id: item.id, action: 'edit', text: draft })}>保存</Button>
                  <Button variant="secondary" size="xs" onClick={() => setEditing(undefined)}>取消</Button>
                </div>
              </div>
            ) : (
              <>
                <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed">{item.text}</p>
                <div className="mt-2 flex gap-1.5">
                  {item.status === 'active' ? (
                    <>
                      <Button variant="secondary" size="xs" onClick={() => { setEditing(item.id); setDraft(item.text); }}>编辑</Button>
                      <Button variant="secondary" size="xs" onClick={() => change({ id: item.id, action: 'reject' })}>标记错误</Button>
                    </>
                  ) : (
                    <Button variant="secondary" size="xs" onClick={() => change({ id: item.id, action: 'restore' })}>恢复</Button>
                  )}
                  <Button variant="destructive-outline" size="xs" onClick={() => change({ id: item.id, action: 'delete' })}>删除</Button>
                </div>
              </>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}

export function MemorySwitch({ enabled, disabled }: { enabled: boolean; disabled: boolean }) {
  return (
    <label className="flex items-center gap-2 text-[13px]">
      <Switch aria-label="启用记忆" checked={enabled} disabled={disabled} onCheckedChange={value => call(bridge().setMemoryEnabled(value))} />
      启用记忆
    </label>
  );
}
