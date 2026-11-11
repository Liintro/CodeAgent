import { FileText, FolderGit2, FolderPlus, GitBranch, Paperclip, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { bridge, call } from '@/lib/bridge';
import { cn } from '@/lib/utils';
import { useActive, useReady, useView } from '@/store/snapshot';

/** 工作目录与任务文档。任务有内容时放在顶栏，空任务时放在起始卡片里。 */
export function Workspace({ compact }: { compact?: boolean }) {
  const roots = useView(view => view.roots);
  const documents = useView(view => view.documents);
  const active = useActive();
  const ready = useReady();
  const chip = 'no-drag group flex h-7 shrink-0 max-w-60 items-center gap-1.5 rounded-md border border-border bg-surface pl-2 pr-1 text-xs';

  return (
    <div className={cn('flex min-w-0 flex-wrap items-center gap-1.5', compact && 'flex-nowrap overflow-x-auto [scrollbar-width:none]')}>
      <div role="group" aria-label="工作目录" className="flex shrink-0 items-center gap-1.5">
        {roots.map(root => (
          <span key={root.id} className={cn(chip, root.missing && 'border-danger/50')} title={root.path}>
            <FolderGit2 className={cn('size-3.5 shrink-0', root.primary ? 'text-accent' : 'text-subtle')} />
            <button className="truncate font-medium disabled:cursor-default" disabled={active || root.primary} onClick={() => call(bridge().setPrimaryRoot(root.id))} aria-label={`设为主目录 ${root.alias}`}>
              {root.alias}
            </button>
            <span className={cn('flex shrink-0 items-center gap-0.5 text-[11px]', root.missing ? 'text-danger' : 'text-subtle')}>
              {root.missing ? '目录不存在' : root.git ? <><GitBranch className="size-3" />{root.git.branch ?? '无分支'}</> : '非 Git'}
            </span>
            <button className="rounded p-0.5 text-subtle opacity-0 hover:bg-surface-2 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 disabled:hidden" disabled={active} onClick={() => call(bridge().removeRoot(root.id))} aria-label={`移除目录 ${root.alias}`}>
              <X className="size-3" />
            </button>
          </span>
        ))}
      </div>
      {!roots.length && <span className="text-xs text-subtle">未选择目录</span>}
      <Button variant="ghost" size="xs" className="no-drag" onClick={() => call(bridge().addRoot())} disabled={active || !ready}><FolderPlus />添加目录</Button>
      <div role="group" aria-label="任务文档" className="flex shrink-0 items-center gap-1.5">
        {documents.map(doc => (
          <span key={doc.id} className={chip} title={`${doc.path}\nsha256 ${doc.sha256}`}>
            <FileText className="size-3.5 shrink-0 text-subtle" />
            <span className="truncate font-medium">{doc.name}</span>
            <span className="shrink-0 text-[11px] text-subtle">{doc.kind === 'pdf' ? `${doc.pages} 页${doc.noTextLayerPages.length ? `，${doc.noTextLayerPages.length} 页无文本层` : ''}` : `${doc.sections} 节`}</span>
            <button className="rounded p-0.5 text-subtle opacity-0 hover:bg-surface-2 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 disabled:hidden" disabled={active} onClick={() => call(bridge().removeDocument(doc.id))} aria-label={`移除文档 ${doc.name}`}>
              <X className="size-3" />
            </button>
          </span>
        ))}
      </div>
      <Button variant="ghost" size="xs" className="no-drag" onClick={() => call(bridge().addDocument())} disabled={active || !ready}><Paperclip />添加文档</Button>
    </div>
  );
}
