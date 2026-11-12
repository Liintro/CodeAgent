import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronDown } from 'lucide-react';
import type { UserMode } from '../../../../shared/contracts';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { bridge, call } from '@/lib/bridge';
import { cn } from '@/lib/utils';
import { modes } from '@/i18n/zh';
import { useActive, useReady, useView } from '@/store/snapshot';
import { useUi } from '@/store/ui';

export function Composer() {
  const active = useActive();
  const ready = useReady();
  const hasModel = useView(view => Boolean(view.model));
  const [input, setInput] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [input]);

  async function send() {
    const text = input.trim();
    if (!text || active) return;
    const reply = await bridge().startMessage(text);
    if (reply.ok) {
      setInput('');
      return;
    }
    if (!hasModel) useUi.getState().openSettings('模型');
    await call(Promise.resolve(reply));
  }

  return (
    <div className="mx-auto w-full max-w-[820px] px-6 pb-4 pt-2">
      <div className="rounded-xl border border-border bg-surface shadow-panel transition-colors focus-within:border-border-strong">
        <textarea
          ref={field}
          aria-label="任务输入"
          value={input}
          rows={2}
          onChange={event => setInput(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder="描述任务或提问，Enter 发送，Shift+Enter 换行"
          disabled={!ready}
          className="block w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-[13.5px] leading-relaxed placeholder:text-subtle focus:outline-none disabled:opacity-60"
        />
        <div className="flex items-center gap-2 px-2.5 pb-2.5">
          <ModeControl disabled={active || !ready} />
          <ModelSwitch disabled={active} />
          <Button size="icon-sm" className="ml-auto rounded-lg" aria-label="发送" title="发送" onClick={send} disabled={!input.trim() || active || !ready}>
            <ArrowUp />
          </Button>
        </div>
      </div>
    </div>
  );
}

const modeTone: Record<UserMode, string> = {
  plan: 'bg-primary', manual: 'bg-subtle', accept_edits: 'bg-success', auto: 'bg-warning', bypass: 'bg-danger',
};

/** 模式与命令运行方式合并为一个控件：左边选模式，右边是命令在哪里运行。 */
function ModeControl({ disabled }: { disabled: boolean }) {
  const userMode = useView(view => view.permission.userMode);
  const sandboxStatus = useView(view => view.sandboxStatus);
  const sandboxed = useView(view => view.sandboxStatus === 'available' && view.roots.length > 0 && view.roots.every(item => item.sandboxGranted));
  const current = modes.find(mode => mode.value === userMode)!;
  const choose = (mode: UserMode) => call(bridge().setPermission(mode));
  const runner = runnerText(userMode, sandboxed);

  return (
    <div className="flex items-center rounded-lg border border-border bg-surface-2 text-xs">
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <button aria-label="权限模式" title={current.hint} className="flex h-7 items-center gap-1.5 rounded-l-lg px-2.5 font-medium hover:bg-surface-3 disabled:opacity-50">
            <span className={cn('size-2 rounded-full', modeTone[current.value])} />
            {current.label}
            <ChevronDown className="size-3 text-subtle" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-64" aria-label="权限模式">
          <DropdownMenuRadioGroup value={current.value} onValueChange={value => value !== current.value && choose(value as UserMode)}>
            {modes.map(mode => {
              const unavailable = mode.value === 'auto' && sandboxStatus !== 'available';
              return (
                <DropdownMenuRadioItem key={mode.value} value={mode.value} disabled={unavailable} className="items-start">
                  <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', modeTone[mode.value])} />
                  <span className="flex flex-1 flex-col">
                    <strong className="font-medium">{mode.label}</strong>
                    <small className="text-[11px] text-muted-foreground">{unavailable ? '原生沙箱不可用' : mode.hint}</small>
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {runner && (
        <span aria-label="命令运行方式" className={cn('flex h-7 items-center gap-1.5 border-l border-border px-2.5', runner.tone)}>
          <span className={cn('size-1.5 rounded-full bg-current')} />
          {runner.text}
          {userMode === 'auto' && !sandboxed && sandboxStatus === 'available' && (
            <button className="text-primary hover:underline" onClick={() => choose('auto')}>授权沙箱</button>
          )}
        </span>
      )}
    </div>
  );
}

function runnerText(mode: UserMode, sandboxed: boolean): { text: string; tone: string } | undefined {
  if (mode === 'plan') return undefined;
  if (mode === 'bypass') return { text: '命令直接运行', tone: 'text-danger' };
  if (sandboxed) return { text: '命令在沙箱内运行', tone: 'text-success' };
  if (mode === 'auto') return { text: '沙箱不可用', tone: 'text-warning' };
  return { text: '命令直接运行（无沙箱）', tone: 'text-muted-foreground' };
}

function ModelSwitch({ disabled }: { disabled: boolean }) {
  const models = useView(view => view.models);
  const model = useView(view => view.model);
  if (models.length <= 1) return null;
  return (
    <select
      aria-label="切换模型"
      value={model?.id}
      disabled={disabled}
      onChange={event => call(bridge().selectModel(event.target.value))}
      className="h-7 max-w-44 cursor-pointer truncate rounded-lg border border-transparent bg-transparent px-1.5 text-xs text-muted-foreground hover:bg-surface-2 focus:outline-none disabled:opacity-50"
    >
      {models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select>
  );
}

