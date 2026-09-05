import { useEffect, useRef, useState } from 'react';
import type { UserMode, WorkbenchSnapshot } from '../../shared/contracts';
import type { PanelTab } from './SidePanel';

export const modes: { value: UserMode; label: string; hint: string }[] = [
  { value: 'plan', label: '计划', hint: '只读调查，给出实施计划' },
  { value: 'manual', label: '手动', hint: '编辑与命令都需要批准' },
  { value: 'accept_edits', label: '接受编辑', hint: '编辑自动通过，命令需批准' },
  { value: 'auto', label: '自动', hint: '编辑与沙箱内命令自动执行' },
  { value: 'bypass', label: '绕过权限', hint: '不再询问，以当前用户权限运行' },
];

type Props = {
  view: WorkbenchSnapshot;
  active: boolean;
  ready: boolean;
  onSend: (text: string) => Promise<boolean>;
  onCancel: () => void;
  onMode: (mode: UserMode) => void;
  onImplement: () => void;
  onContinue: () => void;
  onVerify: () => void;
  onOpenPanel: (tab: PanelTab) => void;
};

export function Composer({ view, active, ready, onSend, onCancel, onMode, onImplement, onContinue, onVerify, onOpenPanel }: Props) {
  const [input, setInput] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [input]);

  async function send() {
    const text = input.trim();
    if (!text || active) return;
    if (await onSend(text)) setInput('');
  }

  return (
    <footer className="composer-area">
      <Strip view={view} active={active} onImplement={onImplement} onContinue={onContinue} onVerify={onVerify} onOpenPanel={onOpenPanel} />
      <div className="composer">
        <textarea
          ref={field}
          aria-label="任务输入"
          value={input}
          rows={2}
          onChange={event => setInput(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder="输入任务或问题，Enter 发送，Shift+Enter 换行"
          disabled={!ready}
        />
        <div className="composer-bar">
          <ModeMenu view={view} disabled={active || !ready} onMode={onMode} />
          <div className="composer-actions">
            {active && <button className="danger-button" onClick={onCancel}>取消</button>}
            <button className="primary" onClick={send} disabled={!input.trim() || active || !ready}>发送</button>
          </div>
        </div>
      </div>
    </footer>
  );
}

function ModeMenu({ view, disabled, onMode }: { view: WorkbenchSnapshot; disabled: boolean; onMode: (mode: UserMode) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const current = modes.find(mode => mode.value === view.permission.userMode)!;
  const sandboxed = view.sandboxStatus === 'available' && view.roots.length > 0 && view.roots.every(item => item.sandboxGranted);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  return (
    <div className="mode-area" ref={root}>
      <button className={`mode-trigger mode-${current.value}`} aria-label="权限模式" aria-haspopup="menu" aria-expanded={open} disabled={disabled} title={current.hint} onClick={() => setOpen(value => !value)}>
        <span className="mode-dot" />{current.label}<span className="chevron">▾</span>
      </button>
      {open && (
        <div className="mode-menu" role="menu" aria-label="权限模式">
          {modes.map(mode => {
            const unavailable = mode.value === 'auto' && view.sandboxStatus !== 'available';
            return (
              <button
                key={mode.value}
                role="menuitemradio"
                aria-checked={mode.value === current.value}
                className={`mode-item mode-${mode.value}`}
                disabled={unavailable}
                onClick={() => {
                  setOpen(false);
                  if (mode.value !== current.value) onMode(mode.value);
                }}
              >
                <span className="mode-dot" />
                <span className="mode-text"><strong>{mode.label}</strong><small>{unavailable ? '原生沙箱不可用' : mode.hint}</small></span>
                {mode.value === current.value && <span className="mode-check">✓</span>}
              </button>
            );
          })}
        </div>
      )}
      {current.value !== 'plan' && (
        <span className="runner-state" aria-label="命令运行方式">
          {current.value === 'bypass' ? '命令直接运行'
            : sandboxed ? '命令在沙箱内运行'
              : current.value === 'auto' ? '沙箱不可用' : '命令直接运行（无沙箱）'}
          {current.value === 'auto' && !sandboxed && view.sandboxStatus === 'available' && (
            <button className="link-button" onClick={() => onMode('auto')}>授权沙箱</button>
          )}
        </span>
      )}
    </div>
  );
}

function Strip({ view, active, onImplement, onContinue, onVerify, onOpenPanel }: Pick<Props, 'view' | 'active' | 'onImplement' | 'onContinue' | 'onVerify' | 'onOpenPanel'>) {
  const last = view.timeline.at(-1);
  const mode = view.permission.userMode;
  const run = view.run;
  const task = view.tasks.find(item => item.id === view.taskId);
  const changed = view.delivery?.roots.filter(root => root.files.length > 0 || (!root.git && root.state !== 'none')) ?? [];
  const canVerify = mode !== 'plan' && view.acceptance.commands.length > 0;

  if (mode === 'plan' && !active && last?.kind === 'message' && last.role === 'assistant' && last.text) {
    return <div className="strip info"><span>计划已就绪</span><button className="primary small" onClick={onImplement}>实施此计划</button></div>;
  }
  if (run?.phase === 'verifying') {
    return <div className="strip busy"><span className="spinner" />正在验证{run.attempt ? ` · 第 ${run.attempt} 次修复之后` : ''}</div>;
  }
  if (active && run?.attempt) {
    return <div className="strip busy"><span className="spinner" />正在修复 · 第 {run.attempt}/{view.acceptance.maxRepairs} 次</div>;
  }
  if (!active && task?.interrupted) {
    return (
      <div className="strip warn">
        <span>上次执行被意外中断。将按当前真实的文件与 Git 状态继续，不会重放已发出的操作。</span>
        <button className="primary small" onClick={onContinue}>继续任务</button>
      </div>
    );
  }
  if (!active && changed.length) {
    const state = view.delivery!.state;
    const unverifiedRoots = changed.filter(root => root.state === 'unverified');
    if (state === 'verified') {
      return <div className="strip ok"><span>改动已通过验收</span><button className="link-button" onClick={() => onOpenPanel('changes')}>查看交付</button></div>;
    }
    if (state === 'verification_failed') {
      return (
        <div className="strip danger">
          <span>验证未通过</span>
          <span className="strip-actions">
            <button className="link-button" onClick={() => onOpenPanel('changes')}>查看详情</button>
            {canVerify && <button className="link-button" onClick={onVerify}>重新验证</button>}
          </span>
        </div>
      );
    }
    if (state === 'unverified') {
      const missing = unverifiedRoots.filter(root => root.noCommands);
      return (
        <div className="strip warn">
          <span>{missing.length ? `${missing.map(root => root.alias).join('、')} 有改动但未设置验收命令` : '改动尚未验证'}</span>
          <span className="strip-actions">
            {missing.length > 0 && <button className="link-button" onClick={() => onOpenPanel('acceptance')}>设置验收</button>}
            {canVerify && <button className="link-button" onClick={onVerify}>立即验证</button>}
          </span>
        </div>
      );
    }
  }
  return null;
}
