import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleStop, Loader2, RotateCw, ShieldAlert, ShieldCheck, XCircle } from 'lucide-react';
import type { ApprovalDecision, ApprovalRequest } from '../../../../shared/contracts';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { bridge, call } from '@/lib/bridge';
import { cn, formatDuration } from '@/lib/utils';
import { runPhaseText, toolTitles } from '@/i18n/zh';
import { useActive, useView } from '@/store/snapshot';
import { useUi, type PanelTab } from '@/store/ui';
import { toolCallsSinceLastUser } from '../timeline/group';

/** 停靠区：输入框上方，固定显示需要用户处理的事项与运行状态，不随时间线滚走。 */
export function Dock() {
  const approval = useView(view => view.approval);
  const hostFailed = useView(view => view.host === 'failed');
  return (
    <div className="mx-auto flex w-full max-w-[820px] flex-col gap-2 px-6">
      {hostFailed && <HostFailed />}
      {approval && <ApprovalCard key={approval.id} approval={approval} />}
      <StatusStrip />
      <RunStatus />
    </div>
  );
}

function HostFailed() {
  return (
    <section role="region" aria-label="运行进程" className="flex items-center gap-3 rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-[13px] text-danger">
      <XCircle className="size-4 shrink-0" />
      <span className="flex-1">运行进程已退出</span>
      <Button size="sm" variant="outline" onClick={() => call(bridge().restartHost())}><RotateCw />重启运行进程</Button>
    </section>
  );
}

function ApprovalCard({ approval }: { approval: ApprovalRequest }) {
  const card = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const decide = async (decision: ApprovalDecision) => {
    if (busy) return;
    setBusy(true);
    await call(bridge().decideApproval(approval.id, decision));
    setBusy(false);
  };

  // Enter 允许本次，Ctrl+Enter 本任务内允许，Esc 拒绝；焦点在输入控件里时不拦截。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // 刚发送完消息时焦点通常还在空的输入框里，这时也响应快捷键。
      const emptyComposer = target instanceof HTMLTextAreaElement && target.getAttribute('aria-label') === '任务输入' && !target.value;
      if (target !== card.current && !emptyComposer && target && target !== document.body && target.closest('input, textarea, select, button, [contenteditable], [role="menu"], [role="dialog"]')) return;
      if (event.key === 'Escape') decide('deny');
      else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { if (approval.grantKey) decide('allow_task'); }
      else if (event.key === 'Enter') decide('allow');
      else return;
      event.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });
  useEffect(() => {
    const focused = document.activeElement;
    if (!focused || focused === document.body) card.current?.focus({ preventScroll: true });
  }, []);

  const direct = approval.runner === 'direct';
  return (
    <section
      ref={card}
      tabIndex={-1}
      role="region"
      aria-label="需要批准"
      className="rounded-xl border border-warning/50 bg-surface shadow-panel outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2">
        <AlertTriangle className="size-4 text-warning" />
        <strong className="text-[13px] font-semibold">批准 {toolTitles[approval.tool] ?? approval.summary}</strong>
        <span className="min-w-0 truncate text-xs text-subtle" title={approval.cwd}>{approval.rootAlias ? `目录：${approval.rootAlias} · ` : ''}{approval.cwd}</span>
      </div>
      <div className="flex flex-col gap-2 px-3.5 py-2.5">
        <pre data-testid="approval-summary" className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-surface-2 px-2.5 py-1.5 text-[12px]">{approval.summary}</pre>
        {approval.tool !== 'powershell' && approval.argsText !== approval.summary && (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">完整参数</summary>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-surface-2 px-2.5 py-1.5 text-[11.5px]">{approval.argsText}</pre>
          </details>
        )}
        {approval.runner && (
          <p className={cn('flex items-center gap-1.5 text-xs', direct ? 'text-warning' : 'text-success')}>
            {direct ? <ShieldAlert className="size-3.5" /> : <ShieldCheck className="size-3.5" />}
            {direct ? '将以当前 Windows 用户权限运行，可访问项目外资源。' : '将在沙箱内运行：仅所选目录可写。'}
          </p>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border px-3.5 py-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => decide('deny')}>拒绝 <Kbd aria-hidden="true">Esc</Kbd></Button>
        {approval.grantKey && <Button variant="outline" size="sm" disabled={busy} onClick={() => decide('allow_task')}>允许本任务 <Kbd aria-hidden="true">Ctrl ⏎</Kbd></Button>}
        <Button size="sm" disabled={busy} onClick={() => decide('allow')}>允许本次 <Kbd aria-hidden="true">⏎</Kbd></Button>
      </div>
    </section>
  );
}

/** 运行状态条：阶段、已用时、工具调用次数、停止。 */
function RunStatus() {
  const run = useView(view => view.run);
  const active = useActive();
  const maxRepairs = useView(view => view.acceptance.maxRepairs);
  const calls = useView(view => toolCallsSinceLastUser(view.timeline));
  const started = useRunStart(active ? run?.id : undefined);
  const now = useNow(active);
  if (!active || !run) return null;
  const phase = run.phase === 'running' && run.attempt ? `修复 ${run.attempt}/${maxRepairs}` : runPhaseText[run.phase];
  return (
    <div role="status" aria-label="运行状态" className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin text-primary" />
      <span className="text-foreground">{phase}</span>
      <span>·</span>
      <span className="tabular-nums">{formatDuration(Math.max(0, now - started))}</span>
      {calls > 0 && <><span>·</span><span>{calls} 次调用</span></>}
      <Button variant="ghost" size="xs" className="ml-auto" disabled={run.phase === 'cancelling'} onClick={() => call(bridge().cancelRun(run.id))}>
        <CircleStop />停止
      </Button>
    </div>
  );
}

// 已用时只在渲染层计时：从看到这次运行开始算起，不依赖 Host。
const runStarts = new Map<string, number>();
function useRunStart(runId: string | undefined): number {
  if (runId && !runStarts.has(runId)) runStarts.set(runId, Date.now());
  return runId ? runStarts.get(runId)! : Date.now();
}

function useNow(enabled: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

type Strip = { tone: 'info' | 'ok' | 'warn' | 'danger'; text: string; actions: { label: string; onClick: () => void; primary?: boolean }[] };

function useStrip(): Strip | undefined {
  const view = useView(value => value);
  const active = useActive();
  const openPanel = (tab: PanelTab) => () => useUi.getState().openPanel(tab);
  const last = view.timeline.at(-1);
  const mode = view.permission.userMode;
  const task = view.tasks.find(item => item.id === view.taskId);
  const changed = view.delivery?.roots.filter(root => root.files.length > 0 || (!root.git && root.state !== 'none')) ?? [];
  const canVerify = mode !== 'plan' && view.acceptance.commands.length > 0;
  const verify = () => void call(bridge().verifyNow());

  if (active) return undefined;
  if (mode === 'plan' && last?.kind === 'message' && last.role === 'assistant' && last.text) {
    return { tone: 'info', text: '计划已就绪', actions: [{ label: '实施此计划', primary: true, onClick: () => void call(bridge().implementPlan()) }] };
  }
  if (task?.interrupted) {
    return { tone: 'warn', text: '上次执行被意外中断。将按当前真实的文件与 Git 状态继续，不会重放已发出的操作。', actions: [{ label: '继续任务', primary: true, onClick: () => void call(bridge().continueTask()) }] };
  }
  if (!changed.length) return undefined;
  const state = view.delivery!.state;
  if (state === 'verified') return { tone: 'ok', text: '改动已通过验收', actions: [{ label: '查看交付', onClick: openPanel('changes') }] };
  if (state === 'verification_failed') {
    return { tone: 'danger', text: '验证未通过', actions: [{ label: '查看详情', onClick: openPanel('changes') }, ...(canVerify ? [{ label: '重新验证', onClick: verify }] : [])] };
  }
  if (state === 'unverified') {
    const missing = changed.filter(root => root.state === 'unverified' && root.noCommands);
    return {
      tone: 'warn',
      text: missing.length ? `${missing.map(root => root.alias).join('、')} 有改动但未设置验收命令` : '改动尚未验证',
      actions: [...(missing.length ? [{ label: '设置验收', onClick: openPanel('acceptance') }] : []), ...(canVerify ? [{ label: '立即验证', onClick: verify }] : [])],
    };
  }
  return undefined;
}

const stripStyles = {
  info: 'border-primary/30 bg-primary-soft text-foreground',
  ok: 'border-success/30 bg-success-soft text-success',
  warn: 'border-warning/40 bg-warning-soft text-warning',
  danger: 'border-danger/40 bg-danger-soft text-danger',
};
const stripIcons = { info: CheckCircle2, ok: CheckCircle2, warn: AlertTriangle, danger: XCircle };

function StatusStrip() {
  const strip = useStrip();
  if (!strip) return null;
  const Icon = stripIcons[strip.tone];
  return (
    <div data-testid="status-strip" data-tone={strip.tone} className={cn('flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px]', stripStyles[strip.tone])}>
      <Icon className="size-4 shrink-0" />
      <span className="flex-1">{strip.text}</span>
      {strip.actions.map(action => (
        <Button key={action.label} size="xs" variant={action.primary ? 'default' : 'ghost'} className={action.primary ? '' : 'text-current hover:bg-black/5'} onClick={action.onClick}>{action.label}</Button>
      ))}
    </div>
  );
}
