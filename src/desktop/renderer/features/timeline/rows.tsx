import { memo, useEffect, useState, type ReactNode } from 'react';
import {
  AlertTriangle, BookOpen, Check, ChevronRight, CircleSlash, FileCode2, FilePen, FolderSearch, Globe, Info, Loader2, Plug, ShieldCheck, Terminal, X,
} from 'lucide-react';
import type { TimelineItem, ToolItem, VerificationItem } from '../../../../shared/contracts';
import { Badge } from '@/components/ui/misc';
import { cn, formatDuration } from '@/lib/utils';
import { kindText, toolStateText, toolTitles, validityText, verificationText } from '@/i18n/zh';
import { useView } from '@/store/snapshot';
import { useUi } from '@/store/ui';
import { exploreSummary } from './group';
import { Markdown } from './Markdown';

export const MessageRow = memo(function MessageRow({ item, pending }: { item: Extract<TimelineItem, { kind: 'message' }>; pending: boolean }) {
  if (item.harness) {
    const recovery = item.text.startsWith('[任务恢复说明]');
    return (
      <Collapsible testId="harness-note" icon={<Info />} title={recovery ? '任务恢复说明（系统生成）' : '自动验证反馈（系统生成）'}>
        <pre className="whitespace-pre-wrap text-xs text-muted-foreground">{item.text}</pre>
      </Collapsible>
    );
  }
  if (item.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-xl rounded-br-sm bg-surface-3 px-3.5 py-2 text-[13px] [overflow-wrap:anywhere]">{item.text}</div>
      </div>
    );
  }
  return (
    <div className="text-[13.5px] leading-relaxed">
      {item.text ? <Markdown text={item.text} /> : pending ? <span className="inline-flex items-center gap-2 text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />正在响应…</span> : null}
    </div>
  );
});

export function NoticeRow({ text }: { text: string }) {
  return <div className="flex items-center gap-2 text-xs text-subtle"><span className="h-px flex-1 bg-border" />{text}<span className="h-px flex-1 bg-border" /></div>;
}

export function MemoryRow({ item }: { item: Extract<TimelineItem, { kind: 'memory' }> }) {
  return (
    <Collapsible testId="memory-note" icon={<BookOpen />} title={`已引用 ${item.items.length} 条记忆`}>
      <ul className="flex flex-col gap-1.5">
        {item.items.map(entry => (
          <li key={entry.id} className="flex flex-wrap items-baseline gap-1.5 text-xs">
            <Badge>{kindText[entry.kind]}</Badge>
            <Badge tone={entry.validity === 'current' ? 'success' : 'warning'}>{validityText[entry.validity]}</Badge>
            <span className="text-muted-foreground">{entry.text}</span>
          </li>
        ))}
      </ul>
    </Collapsible>
  );
}

/** 系统生成内容的统一弱化折叠样式。 */
function Collapsible({ testId, icon, title, children }: { testId: string; icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <details data-testid={testId} className="group rounded-lg text-xs text-subtle [&_svg]:size-3.5">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-0.5 hover:text-muted-foreground">
        <ChevronRight className="transition-transform group-open:rotate-90" />{icon}{title}
      </summary>
      <div className="ml-5 mt-1.5 border-l border-border pl-3">{children}</div>
    </details>
  );
}

export const ExploreRow = memo(function ExploreRow({ tools }: { tools: ToolItem[] }) {
  const running = tools.some(tool => tool.state === 'running' || tool.state === 'requested' || tool.state === 'awaiting_approval');
  const failed = tools.filter(tool => tool.state === 'failed').length;
  const duration = tools.reduce((sum, tool) => sum + (tool.durationMs ?? 0), 0);
  return (
    <details className="group text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md py-1 text-muted-foreground hover:text-foreground [&_svg]:size-3.5">
        <ChevronRight className="text-subtle transition-transform group-open:rotate-90" />
        {running ? <Loader2 className="animate-spin text-primary" /> : <FolderSearch className="text-subtle" />}
        <span>{exploreSummary(tools)}</span>
        {failed > 0 && <Badge tone="danger">{failed} 次失败</Badge>}
        {duration > 0 && <span className="ml-auto text-subtle tabular-nums">{formatDuration(duration)}</span>}
      </summary>
      <ul className="ml-5 mt-1 flex flex-col gap-0.5 border-l border-border pl-3">
        {tools.map(tool => <li key={tool.toolCallId}><ToolLine item={tool} /></li>)}
      </ul>
    </details>
  );
});

export const ToolRow = memo(function ToolRow({ item }: { item: ToolItem }) {
  if (item.name === 'edit' || item.name === 'write') return <EditRow item={item} />;
  return <ToolLine item={item} expandable />;
});

function EditRow({ item }: { item: ToolItem }) {
  const path = argPath(item.args);
  const file = useView(view => {
    const root = view.changes?.roots.find(entry => entry.rootId === item.rootId);
    if (!root?.git || !path) return undefined;
    const normalized = path.replaceAll('\\', '/');
    return root.files.find(entry => entry.path === normalized || normalized.endsWith(`/${entry.path}`));
  });
  const open = () => item.rootId && file && useUi.getState().openDiff({ rootId: item.rootId, path: file.path });
  return (
    <div className="flex items-center gap-2 text-xs">
      <StateIcon state={item.state} fallback={<FilePen className="text-subtle" />} />
      <span className="text-muted-foreground">{item.name === 'write' ? '写入' : '编辑'}</span>
      <button className="truncate font-mono text-[12px] text-foreground hover:underline disabled:no-underline" onClick={open} disabled={!file} title={path}>{path}</button>
      {file && <span className="shrink-0 font-mono text-[11px]"><span className="text-success">+{file.additions}</span> <span className="text-danger">−{file.deletions}</span></span>}
      {item.rootAlias && <Badge>{item.rootAlias}</Badge>}
      <ToolTail item={item} />
      {item.state === 'failed' && item.error && <span className="text-danger">{item.error.message}</span>}
    </div>
  );
}

function ToolLine({ item, expandable }: { item: ToolItem; expandable?: boolean }) {
  const title = item.source ? `MCP · ${item.source.mcpServer}.${item.source.tool}` : toolTitles[item.name] ?? item.name;
  const target = item.name === 'powershell' ? commandOf(item.args) ?? item.cwd ?? '' : argPath(item.args) || argQuery(item.args);
  const hasDetail = expandable && Boolean(item.output || item.exitCode !== undefined || item.error);
  const [open, setOpen] = useState(item.state === 'failed');
  useEffect(() => { if (item.state === 'failed') setOpen(true); }, [item.state]);
  const icon = item.source ? <Plug className="text-subtle" /> : item.name === 'powershell' ? <Terminal className="text-subtle" /> : item.name.startsWith('web_') ? <Globe className="text-subtle" /> : <FileCode2 className="text-subtle" />;
  return (
    <div className="text-xs">
      <button
        className={cn('flex w-full items-center gap-2 rounded-md py-0.5 text-left', hasDetail ? 'hover:text-foreground' : 'cursor-default')}
        onClick={() => hasDetail && setOpen(value => !value)}
        aria-expanded={hasDetail ? open : undefined}
      >
        <StateIcon state={item.state} fallback={icon} />
        <span className="shrink-0 text-muted-foreground">{title}</span>
        <span className="min-w-0 truncate font-mono text-[12px] text-foreground" title={target}>{target}</span>
        {item.rootAlias && <Badge>{item.rootAlias}</Badge>}
        {item.runner && <Badge tone={item.runner === 'sandbox' ? 'success' : 'warning'}>{item.runner === 'sandbox' ? '沙箱' : '直接'}</Badge>}
        <ToolTail item={item} />
      </button>
      {hasDetail && open && (
        <div className="ml-5 mt-1 overflow-hidden rounded-md border border-border bg-surface-2">
          {item.exitCode !== undefined && <div className="border-b border-border px-2.5 py-1 text-[11px] text-subtle">退出码 {item.exitCode}</div>}
          {item.output && <pre className="max-h-72 overflow-auto whitespace-pre-wrap px-2.5 py-2 text-[11.5px] leading-snug">{tail(item.output)}</pre>}
          {item.error && <p className="px-2.5 py-1.5 text-danger">{item.error.message}</p>}
        </div>
      )}
    </div>
  );
}

function ToolTail({ item }: { item: ToolItem }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 text-[11px] text-subtle tabular-nums">
      {item.durationMs !== undefined && formatDuration(item.durationMs)}
      {['denied', 'cancelled', 'unknown', 'awaiting_approval'].includes(item.state) && <span>{toolStateText[item.state]}</span>}
    </span>
  );
}

function StateIcon({ state, fallback }: { state: ToolItem['state']; fallback: ReactNode }) {
  const className = 'size-3.5 shrink-0';
  if (state === 'running' || state === 'requested') return <Loader2 className={cn(className, 'animate-spin text-primary')} />;
  if (state === 'awaiting_approval') return <AlertTriangle className={cn(className, 'text-warning')} />;
  if (state === 'failed') return <X className={cn(className, 'text-danger')} />;
  if (state === 'denied' || state === 'cancelled') return <CircleSlash className={cn(className, 'text-subtle')} />;
  return <span className="contents [&_svg]:size-3.5 [&_svg]:shrink-0">{fallback}</span>;
}

export const VerificationRow = memo(function VerificationRow({ item }: { item: VerificationItem }) {
  const passed = item.state === 'passed';
  const running = item.state === 'running';
  const [open, setOpen] = useState(!passed && !item.failure);
  return (
    <div data-testid="verification" data-state={item.state} className={cn('rounded-lg border px-3 py-2 text-xs', passed ? 'border-border' : running ? 'border-border' : 'border-danger/40 bg-danger-soft/40')}>
      <div className="flex items-center gap-2">
        {running ? <Loader2 className="size-3.5 animate-spin text-primary" /> : passed ? <Check className="size-3.5 text-success" /> : <X className="size-3.5 text-danger" />}
        <ShieldCheck className="size-3.5 text-subtle" />
        <span className="font-medium">验证 · {item.commandLabel}</span>
        <Badge>{item.rootAlias}</Badge>
        {item.attempt > 0 && <Badge tone="accent">修复 {item.attempt}</Badge>}
        <span className="min-w-0 truncate font-mono text-[11.5px] text-muted-foreground" title={item.command}>{item.command}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px] tabular-nums">
          {item.durationMs !== undefined && <span className="text-subtle">{formatDuration(item.durationMs)}</span>}
          <span className={passed ? 'text-success' : running ? 'text-primary' : 'text-danger'}>{verificationText[item.state]}</span>
        </span>
      </div>
      {item.failure && (
        <ul className="mt-2 flex flex-col gap-1 pl-5" aria-label="解析出的失败">
          {item.failure.tests.map(name => <li key={`t:${name}`}>测试 <code className="font-mono text-danger">{name}</code></li>)}
          {item.failure.diagnostics.map((entry, index) => <li key={`d:${index}`}><DiagnosticLink file={entry.file} line={entry.line} /> {entry.message}</li>)}
        </ul>
      )}
      {!running && item.outputTail && (
        <details className="mt-1.5" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
          <summary className="cursor-pointer pl-5 text-[11px] text-subtle hover:text-muted-foreground">{item.exitCode !== undefined ? `退出码 ${item.exitCode} · ` : ''}输出末尾{item.logFile ? '（完整日志已保存）' : ''}</summary>
          <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-surface-2 px-2.5 py-2 text-[11.5px] leading-snug">{item.outputTail}</pre>
        </details>
      )}
    </div>
  );
});

// 诊断位置：能对应到本次改动的文件就跳到 diff。
function DiagnosticLink({ file, line }: { file: string; line: number }) {
  const target = useView(view => {
    const normalized = file.replaceAll('\\', '/');
    for (const root of view.changes?.roots ?? []) {
      if (!root.git) continue;
      const match = root.files.find(entry => normalized === entry.path || normalized.endsWith(`/${entry.path}`));
      if (match) return { rootId: root.rootId, path: match.path };
    }
    return undefined;
  });
  const label = <code className="font-mono">{file}:{line}</code>;
  if (!target) return label;
  return <button className="text-primary hover:underline" onClick={() => useUi.getState().openDiff(target)}>{label}</button>;
}

function argPath(args: unknown): string {
  if (args && typeof args === 'object' && 'path' in args && typeof args.path === 'string') return args.path;
  return '';
}

function argQuery(args: unknown): string {
  if (args && typeof args === 'object') {
    for (const key of ['pattern', 'query', 'symbol', 'url', 'op']) {
      const value = (args as Record<string, unknown>)[key];
      if (typeof value === 'string') return value;
    }
  }
  return '';
}

function commandOf(args: unknown): string | undefined {
  return args && typeof args === 'object' && 'command' in args && typeof args.command === 'string' ? args.command : undefined;
}

function tail(text: string): string {
  return text.length > 20000 ? `…\n${text.slice(-20000)}` : text;
}
