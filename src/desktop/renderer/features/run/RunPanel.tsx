import { useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { RunEvent } from '../../../../shared/contracts';
import { Button } from '@/components/ui/button';
import { Badge, Empty } from '@/components/ui/misc';
import { bridge } from '@/lib/bridge';
import { formatDuration } from '@/lib/utils';
import { runPhaseText } from '@/i18n/zh';
import { useView } from '@/store/snapshot';

const eventText: Partial<Record<RunEvent['type'], string>> = {
  'run.started': '开始运行', 'run.ended': '运行结束', 'git.snapshot': '记录 Git 基线', 'tool.requested': '请求工具', 'permission.decided': '权限决定',
  'tool.started': '工具开始', 'tool.finished': '工具结束', 'model.usage': '模型用量', 'verification.started': '开始验证', 'verification.finished': '验证结束',
  'repair.requested': '请求修复', 'compaction.done': '压缩上下文', 'delivery.changed': '交付状态变化', 'memory.recalled': '召回记忆', 'memory.captured': '记录记忆',
  'memory.capture_failed': '记录记忆失败', 'memory.changed': '记忆变化', 'model.retry': '模型重试',
};

/** 本次运行的事件明细：直接读取 Host 账本，运行状态变化时刷新。 */
export function RunPanel() {
  const run = useView(view => view.run);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [loading, setLoading] = useState(false);

  const load = async (runId: string) => {
    setLoading(true);
    const reply = await bridge().getRunEvents(runId);
    setEvents(reply.ok ? reply.value : []);
    setLoading(false);
  };
  useEffect(() => {
    if (run?.id && run.taskId) void load(run.id);
    else setEvents([]);
  }, [run?.id, run?.phase, run?.taskId]);

  const stats = useMemo(() => summarize(events), [events]);

  if (!run || !run.taskId) return <Empty>还没有运行记录</Empty>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid grid-cols-2 gap-2 border-b border-border px-3 py-2.5 text-xs">
        <Stat label="状态" value={runPhaseText[run.phase]} />
        <Stat label="已用时" value={stats.duration !== undefined ? formatDuration(stats.duration) : '—'} />
        <Stat label="工具调用" value={String(stats.tools)} />
        <Stat label="Token" value={stats.tokens ? stats.tokens.toLocaleString('zh-CN') : '—'} />
      </div>
      <div className="flex items-center px-3 pt-2 text-[11px] font-medium text-subtle">
        事件 {events.length}
        <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="刷新" title="刷新" onClick={() => load(run.id)} disabled={loading}><RefreshCw /></Button>
      </div>
      <ol className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {events.map(event => (
          <li key={event.seq} className="flex items-baseline gap-2 border-b border-border/60 py-1 text-xs last:border-b-0">
            <span className="w-14 shrink-0 font-mono text-[11px] text-subtle tabular-nums">{stats.start ? `+${((event.at - stats.start) / 1000).toFixed(1)}s` : ''}</span>
            <span className="shrink-0">{eventText[event.type] ?? event.type}</span>
            <span className="min-w-0 truncate text-muted" title={detail(event)}>{detail(event)}</span>
            {event.type === 'tool.finished' && typeof event.data.state === 'string' && event.data.state !== 'succeeded' && <Badge tone="danger" className="ml-auto">{event.data.state}</Badge>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div><div className="text-[11px] text-subtle">{label}</div><div className="font-medium tabular-nums">{value}</div></div>;
}

function summarize(events: RunEvent[]): { start?: number; duration?: number; tools: number; tokens: number } {
  const start = events[0]?.at;
  const end = events.findLast(event => event.type === 'run.ended')?.at ?? events.at(-1)?.at;
  let tokens = 0;
  for (const event of events) {
    if (event.type !== 'model.usage') continue;
    const usage = event.data as Record<string, unknown>;
    const total = usage.totalTokens ?? usage.total ?? (Number(usage.input ?? 0) + Number(usage.output ?? 0));
    tokens += Number(total) || 0;
  }
  return { start, duration: start && end ? end - start : undefined, tools: events.filter(event => event.type === 'tool.requested').length, tokens };
}

function detail(event: RunEvent): string {
  const data = event.data as Record<string, unknown>;
  const parts = [data.name, data.label, data.decision, data.phase, data.state, data.stopReason].filter(value => typeof value === 'string');
  return parts.join(' · ');
}
