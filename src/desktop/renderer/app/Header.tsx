import { Activity, ArrowLeft, BookOpen, FileDiff, ListChecks } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/misc';
import { cn } from '@/lib/utils';
import { Workspace } from '@/features/workspace/Workspace';
import { useView } from '@/store/snapshot';
import { useUi, type PanelTab } from '@/store/ui';

const toggles: { tab: PanelTab; label: string; title: string; icon: typeof FileDiff }[] = [
  { tab: 'changes', label: '变更面板', title: '变更', icon: FileDiff },
  { tab: 'acceptance', label: '验收面板', title: '验收', icon: ListChecks },
  { tab: 'memory', label: '记忆面板', title: '记忆', icon: BookOpen },
  { tab: 'run', label: '运行面板', title: '运行', icon: Activity },
];

// 右侧留出系统窗口按钮（titleBarOverlay）的位置。
const overlayGap = 'pr-[150px]';

export function Header() {
  const settings = useUi(state => state.view === 'settings');
  return settings ? <SettingsHeader /> : <WorkbenchHeader />;
}

function WorkbenchHeader() {
  const title = useView(view => view.tasks.find(task => task.id === view.taskId)?.title ?? '新任务');
  const empty = useView(view => !view.timeline.length);
  const changeCount = useView(view => view.changes?.roots.reduce((sum, root) => sum + (root.git ? root.files.length : 0), 0) ?? 0);
  const panel = useUi(state => state.panel);
  return (
    <header className={cn('drag flex h-12 shrink-0 items-center gap-3 border-b border-border bg-surface pl-4', overlayGap)}>
      <h1 className="max-w-72 shrink-0 truncate text-[13px] font-semibold" title={title}>{title}</h1>
      <div className="min-w-0 flex-1">{!empty && <Workspace compact />}</div>
      <div className="no-drag flex shrink-0 items-center gap-0.5">
        {toggles.map(({ tab, label, title: tip, icon: Icon }) => (
          <Tooltip key={tab} content={tip}>
            <Button
              variant="ghost"
              size={tab === 'changes' && changeCount ? 'sm' : 'icon-sm'}
              aria-label={label}
              aria-pressed={panel === tab}
              className={cn(panel === tab && 'bg-surface-3 text-foreground')}
              onClick={() => useUi.getState().togglePanel(tab)}
            >
              <Icon />{tab === 'changes' && changeCount > 0 && <span className="tabular-nums">{changeCount}</span>}
            </Button>
          </Tooltip>
        ))}
      </div>
    </header>
  );
}

function SettingsHeader() {
  return (
    <header className={cn('drag flex h-12 shrink-0 items-center gap-2 border-b border-border bg-surface pl-2', overlayGap)}>
      <Button variant="ghost" size="sm" className="no-drag" onClick={() => useUi.getState().closeSettings()}><ArrowLeft />返回工作台</Button>
      <h1 className="text-[13px] font-semibold">设置</h1>
    </header>
  );
}
