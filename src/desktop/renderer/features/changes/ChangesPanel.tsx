import { useEffect, useState } from 'react';
import { Check, Columns2, GitBranch, GitCommitHorizontal, RefreshCw, Rows2, Undo2, X } from 'lucide-react';
import type { DiffView, RootDelivery, WorkbenchSnapshot } from '../../../../shared/contracts';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Checkbox, Textarea } from '@/components/ui/form';
import { Badge, Empty, type Tone } from '@/components/ui/misc';
import { bridge, call } from '@/lib/bridge';
import { cn } from '@/lib/utils';
import { deliveryText, resultText, rootStateText } from '@/i18n/zh';
import { notifyInfo } from '@/features/notifications/notify';
import { useActive, useView } from '@/store/snapshot';
import { useUi } from '@/store/ui';
import { DiffViewer } from './DiffViewer';

const stateTone = (state: string): Tone => state === 'verified' || state === 'committed' || state === 'accepted' ? 'success'
  : state === 'verification_failed' ? 'danger' : state === 'unverified' ? 'warning' : 'neutral';

const statusLabel = { A: '新增', M: '修改', D: '删除', R: '重命名' } as const;
const statusTone = { A: 'text-success', M: 'text-accent', D: 'text-danger', R: 'text-warning' } as const;

export function ChangesPanel() {
  const view = useView(value => value);
  const active = useActive();
  const target = useUi(state => state.diff);
  const [diff, setDiff] = useState<DiffView>();
  const [inline, setInline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [committing, setCommitting] = useState<RootDelivery>();

  useEffect(() => {
    if (!target) {
      setDiff(undefined);
      return;
    }
    let live = true;
    void call(bridge().getDiff(target.rootId, target.path)).then(value => { if (live && value) setDiff(value); });
    return () => { live = false; };
  }, [target, view.changes?.computedAt]);

  async function refresh() {
    setRefreshing(true);
    if (await call(bridge().getChanges())) void bridge().getDelivery();
    setRefreshing(false);
  }

  async function restore(rootId: string) {
    const result = await call(bridge().restoreRoot(rootId));
    if (result) notifyInfo(result.skipped.length ? `已还原。以下文件在任务之后又被修改，已跳过：${result.skipped.join('、')}` : '已还原');
    useUi.setState({ diff: undefined });
  }

  const delivery = view.delivery;
  const partial = delivery?.state === 'unverified' && delivery.roots.some(root => root.state === 'verified');
  const summary = delivery && delivery.state !== 'none' ? (partial ? '部分已验证' : deliveryText[delivery.state]) : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        {summary
          ? <Badge data-testid="delivery-state" data-state={delivery!.state} tone={stateTone(delivery!.state)}>{summary}</Badge>
          : <span className="text-xs text-subtle">尚无交付状态</span>}
        <span className="flex-1 truncate text-xs text-muted">{deliveryLine(view)}</span>
        <Button variant="ghost" size="icon-sm" aria-label="刷新" title="刷新" onClick={refresh} disabled={active || refreshing}>
          <RefreshCw className={cn(refreshing && 'animate-spin')} />
        </Button>
      </div>
      <div className={cn('overflow-y-auto', diff ? 'max-h-[42%] shrink-0 border-b border-border' : 'min-h-0 flex-1')}>
        {!view.changes?.roots.length && <Empty>运行后显示 Agent 的文件变更</Empty>}
        {view.changes?.roots.map(entry => {
          const root = view.roots.find(item => item.id === entry.rootId);
          const info = delivery?.roots.find(item => item.rootId === entry.rootId);
          return (
            <section key={entry.rootId} className="border-b border-border px-3 py-2.5 last:border-b-0">
              <h3 className="flex items-center gap-2 pb-1.5 text-xs font-semibold">
                <span className="truncate">{root?.alias ?? entry.rootId}</span>
                {entry.git && <span className="flex items-center gap-0.5 font-normal text-subtle"><GitBranch className="size-3" />{entry.git.branch ?? '无分支'} · {entry.git.baseCommit?.slice(0, 7) ?? '无提交'}</span>}
                {info && info.state !== 'none' && <Badge data-testid="delivery-state" data-state={info.state} tone={stateTone(info.state)} className="ml-auto">{rootStateText[info.state]}</Badge>}
              </h3>
              {!entry.git && <p className="text-xs text-subtle">{entry.reason}</p>}
              {entry.git && !entry.files.length && <p className="text-xs text-subtle">无变更</p>}
              {entry.git && entry.files.map(file => {
                const current = target?.rootId === entry.rootId && target.path === file.path;
                return (
                  <button
                    key={file.path}
                    aria-label={`${statusLabel[file.status]} ${file.path}`}
                    aria-current={current || undefined}
                    className={cn('flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-surface-2', current && 'bg-accent-soft')}
                    onClick={() => useUi.getState().openDiff({ rootId: entry.rootId, path: file.path })}
                  >
                    <span className={cn('w-3 shrink-0 font-mono font-semibold', statusTone[file.status])}>{file.status}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={file.path}>{file.path}</span>
                    <span className="shrink-0 font-mono text-[11px]"><span className="text-success">+{file.additions}</span> <span className="text-danger">−{file.deletions}</span></span>
                  </button>
                );
              })}
              {info && info.state !== 'none' && <DeliveryBlock info={info} hasFiles={Boolean(entry.git && entry.files.length)} active={active} onCommit={() => setCommitting(info)} onRestore={() => restore(info.rootId)} />}
            </section>
          );
        })}
      </div>
      {diff && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
            <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={diff.path}>{diff.path}</span>
            <Button variant="ghost" size="icon-sm" aria-label="并排对比" aria-pressed={!inline} title="并排" onClick={() => setInline(false)} className={cn(!inline && 'bg-surface-3 text-foreground')}><Columns2 /></Button>
            <Button variant="ghost" size="icon-sm" aria-label="行内对比" aria-pressed={inline} title="行内" onClick={() => setInline(true)} className={cn(inline && 'bg-surface-3 text-foreground')}><Rows2 /></Button>
            <Button variant="ghost" size="icon-sm" aria-label="关闭差异" title="关闭" onClick={() => useUi.setState({ diff: undefined })}><X /></Button>
          </div>
          <DiffViewer diff={diff} inline={inline} />
        </div>
      )}
      {committing && <CommitDialog info={committing} onClose={() => setCommitting(undefined)} />}
    </div>
  );
}

function deliveryLine(view: WorkbenchSnapshot): string {
  const delivery = view.delivery;
  if (!delivery || delivery.state === 'none') return '';
  if (delivery.state === 'verified') return '每个改动的目录都有当前有效的通过证据';
  if (delivery.state === 'verification_failed') return '最近一次验证失败';
  if (delivery.state === 'unverified') return '代码在最近一次验证之后有变化，或没有验收命令';
  return '';
}

function DeliveryBlock({ info, hasFiles, active, onCommit, onRestore }: { info: RootDelivery; hasFiles: boolean; active: boolean; onCommit: () => void; onRestore: () => void }) {
  return (
    <div className="mt-2 flex flex-col gap-1.5 rounded-lg bg-surface-2 p-2">
      {info.verification.map(result => (
        <div key={result.commandId} className="flex items-center gap-2 text-xs">
          <span className={cn('size-1.5 rounded-full', result.status === 'passed' ? 'bg-success' : 'bg-danger')} />
          <span className="min-w-0 flex-1 truncate">{result.label}</span>
          <span className={result.status === 'passed' ? 'text-success' : 'text-danger'}>{resultText[result.status]}{result.exitCode !== undefined && result.status !== 'passed' ? ` · 退出码 ${result.exitCode}` : ''}</span>
          <span className="text-[11px] text-subtle tabular-nums">{(result.durationMs / 1000).toFixed(1)} s</span>
        </div>
      ))}
      {info.noCommands && <p className="text-xs text-warning">该目录有改动但没有验收命令，不能视为已验证。</p>}
      {info.state === 'unverified' && info.verification.length === 0 && !info.noCommands && <p className="text-xs text-muted">代码在上次验证之后又有变化，需要重新验证。</p>}
      {info.dirtyAtBaseline && <p className="text-xs text-muted">任务开始时该目录已有您未提交的修改。</p>}
      {info.commitSha && <p className="text-xs text-muted">提交 {info.commitSha.slice(0, 7)}（未推送）</p>}
      {info.git && hasFiles && (
        <div className="flex gap-1.5 pt-0.5">
          <Button variant="secondary" size="xs" disabled={active || info.state === 'accepted' || info.state === 'committed'} onClick={() => call(bridge().acceptRoot(info.rootId))}><Check />接受</Button>
          <Button variant="secondary" size="xs" disabled={active || info.state === 'committed'} onClick={onRestore}><Undo2 />还原</Button>
          <Button variant="secondary" size="xs" disabled={active || info.state === 'committed'} onClick={onCommit}><GitCommitHorizontal />提交…</Button>
        </div>
      )}
    </div>
  );
}

function CommitDialog({ info, onClose }: { info: RootDelivery; onClose: () => void }) {
  const active = useActive();
  const [message, setMessage] = useState('');
  const [confirmShared, setConfirmShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const shared = info.sharedPaths.length > 0;

  async function commit() {
    setBusy(true);
    const result = await call(bridge().commitRoot(info.rootId, message, confirmShared));
    setBusy(false);
    if (!result) return;
    notifyInfo(`已提交 ${result.commitSha?.slice(0, 7)}`);
    onClose();
  }

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent title={`提交到 ${info.alias}${info.branch ? ` · ${info.branch}` : ''}`}>
        <DialogBody>
          <Textarea aria-label="提交说明" autoFocus value={message} onChange={event => setMessage(event.target.value)} placeholder="提交说明" rows={3} />
          <div>
            <p className="pb-1 text-xs font-medium text-muted">将提交 {info.files.length} 个文件</p>
            <ul className="max-h-40 overflow-auto rounded-md border border-border bg-surface-2 px-2 py-1">
              {info.files.map(file => (
                <li key={file.path} className="flex items-center gap-2 py-0.5 text-xs">
                  <span className={cn('w-3 font-mono font-semibold', statusTone[file.status])}>{file.status}</span>
                  <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
                </li>
              ))}
            </ul>
          </div>
          {shared && (
            <Checkbox
              checked={confirmShared}
              onChange={event => setConfirmShared(event.target.checked)}
              label={<span className="text-warning">提交将包含您在这些文件上已有的修改：{info.sharedPaths.join('、')}</span>}
            />
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button disabled={busy || active || !message.trim() || (shared && !confirmShared)} onClick={commit}>提交所选改动</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
