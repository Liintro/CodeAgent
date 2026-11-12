import { useMemo, useState } from 'react';
import { MoreHorizontal, Pencil, Plus, Search, Settings, Trash2 } from 'lucide-react';
import type { TaskSummary, WorkbenchSnapshot } from '../../../../shared/contracts';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { bridge, call } from '@/lib/bridge';
import { cn } from '@/lib/utils';
import { deliveryText } from '@/i18n/zh';
import { useNotifications } from '@/store/notifications';
import { useActive, useReady, useView } from '@/store/snapshot';
import { useUi } from '@/store/ui';

const NO_PROJECT = '未选择目录';

export function Sidebar() {
  const tasks = useView(view => view.tasks);
  const taskId = useView(view => view.taskId);
  const model = useView(view => view.model);
  const active = useActive();
  const ready = useReady();
  const settingsOpen = useUi(state => state.view === 'settings');
  const [query, setQuery] = useState('');
  const groups = useMemo(() => groupByProject(tasks, query), [tasks, query]);

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="drag flex h-12 shrink-0 items-center gap-2 px-4 text-[13px] font-semibold tracking-tight">
        <span className="grid size-5 place-items-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground">C</span>
        CodeAgent
      </div>
      <div className="flex flex-col gap-2 px-3 pb-2">
        <Button variant="outline" className="justify-start" onClick={() => call(bridge().newTask())} disabled={active || !ready}>
          <Plus />新任务
        </Button>
        <label className="relative flex items-center">
          <Search className="pointer-events-none absolute left-2.5 size-3.5 text-subtle" />
          <input
            aria-label="搜索任务"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="搜索任务"
            className="h-7 w-full rounded-md border border-transparent bg-surface-2 pl-8 pr-2 text-xs placeholder:text-subtle focus:border-primary focus:outline-none"
          />
        </label>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label="任务列表">
        {groups.map(([project, items]) => (
          <section key={project} className="mt-2">
            <h2 className="truncate px-2 pb-1 text-[11px] font-medium text-subtle" title={project}>{project}</h2>
            <ul className="flex flex-col gap-px">
              {items.map(task => <TaskRow key={task.id} task={task} current={task.id === taskId} locked={active && task.id !== taskId} />)}
            </ul>
          </section>
        ))}
        {query && !groups.length && <p className="px-2 py-4 text-xs text-subtle">没有匹配的任务</p>}
      </nav>
      <div className="flex items-center gap-1 border-t border-border px-2 py-2">
        <Button variant="ghost" size="sm" className={cn('flex-1 justify-start', settingsOpen && 'bg-surface-2 text-foreground')} onClick={() => useUi.getState().openSettings()}>
          <Settings />设置
        </Button>
        <span className="max-w-28 truncate px-1 text-[11px] text-subtle" aria-label="当前模型" title={model?.modelId}>{model?.name ?? '未配置模型'}</span>
      </div>
    </aside>
  );
}

function TaskRow({ task, current, locked }: { task: TaskSummary; current: boolean; locked: boolean }) {
  const [renaming, setRenaming] = useState(false);
  const status = useTaskStatus(task, current);
  const select = () => {
    useNotifications.getState().markRead(task.id);
    if (!current) void call(bridge().selectTask(task.id));
    useUi.getState().closeSettings();
  };
  const remove = () => call(bridge().deleteTask(task.id));

  if (renaming) return <RenameRow task={task} onDone={() => setRenaming(false)} />;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li className={cn('group relative flex items-center rounded-md', current ? 'bg-surface-3' : 'hover:bg-surface-2')}>
          <button
            className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2 pr-7 text-left text-[13px] disabled:cursor-not-allowed disabled:opacity-50"
            title={locked ? '运行结束后可以切换任务' : task.title}
            disabled={locked}
            onClick={select}
          >
            <StatusDot status={status.dot} />
            <span className={cn('min-w-0 flex-1 truncate', current && 'font-medium')}>{task.title}</span>
            {status.text && <span className={cn('shrink-0 text-[11px] group-hover:invisible', status.tone)}>{status.text}</span>}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button aria-label={`任务操作 ${task.title}`} className="absolute right-1 hidden rounded p-1 text-muted-foreground hover:bg-surface-3 hover:text-foreground group-hover:block data-[state=open]:block">
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => setRenaming(true)}><Pencil />重命名</DropdownMenuItem>
              <DropdownMenuItem onSelect={remove} disabled={locked || current && status.dot === 'running'} className="text-danger"><Trash2 />删除</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => setRenaming(true)}><Pencil />重命名</ContextMenuItem>
        <ContextMenuItem onSelect={remove} disabled={locked || current && status.dot === 'running'} className="text-danger"><Trash2 />删除</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function RenameRow({ task, onDone }: { task: TaskSummary; onDone: () => void }) {
  const [value, setValue] = useState(task.title);
  const save = async () => {
    if (value.trim() && value.trim() !== task.title) await call(bridge().renameTask(task.id, value));
    onDone();
  };
  return (
    <li className="px-1 py-0.5">
      <input
        aria-label="任务名称"
        autoFocus
        value={value}
        onChange={event => setValue(event.target.value)}
        onFocus={event => event.currentTarget.select()}
        onBlur={save}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) void save();
          if (event.key === 'Escape') onDone();
        }}
        className="h-7 w-full rounded-md border border-primary bg-surface px-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-ring"
      />
    </li>
  );
}

type Dot = 'running' | 'attention' | 'failed' | 'unread' | 'none';

function useTaskStatus(task: TaskSummary, current: boolean): { dot: Dot; text: string; tone: string } {
  const unread = useNotifications(state => state.unread.has(task.id));
  const live = useView(view => current ? liveState(view) : undefined);
  if (live === 'approval') return { dot: 'attention', text: '待批准', tone: 'text-warning' };
  if (live === 'running') return { dot: 'running', text: '运行中', tone: 'text-primary' };
  if (task.interrupted) return { dot: 'attention', text: '已中断', tone: 'text-warning' };
  const text = deliveryText[task.delivery];
  if (task.delivery === 'verification_failed') return { dot: 'failed', text, tone: 'text-danger' };
  return { dot: unread ? 'unread' : 'none', text, tone: task.delivery === 'verified' ? 'text-success' : 'text-subtle' };
}

function liveState(view: WorkbenchSnapshot): 'approval' | 'running' | undefined {
  if (view.approval) return 'approval';
  if (view.run && ['running', 'verifying', 'cancelling', 'awaiting_approval'].includes(view.run.phase) && view.run.taskId === view.taskId) return 'running';
  return undefined;
}

function StatusDot({ status }: { status: Dot }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        status === 'running' && 'animate-pulse-dot bg-primary',
        status === 'attention' && 'bg-warning',
        status === 'failed' && 'bg-danger',
        status === 'unread' && 'bg-primary',
        status === 'none' && 'bg-transparent',
      )}
    />
  );
}

// 按主目录分组，组的顺序跟随组内最近更新的任务。
function groupByProject(tasks: TaskSummary[], query: string): [string, TaskSummary[]][] {
  const needle = query.trim().toLowerCase();
  const groups = new Map<string, TaskSummary[]>();
  for (const task of tasks) {
    if (needle && !task.title.toLowerCase().includes(needle) && !(task.project ?? '').toLowerCase().includes(needle)) continue;
    const key = task.project ?? NO_PROJECT;
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  return [...groups];
}

