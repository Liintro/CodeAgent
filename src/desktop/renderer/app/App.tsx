import { useEffect } from 'react';
import { Toaster } from 'sonner';
import { Sparkles } from 'lucide-react';
import { attentionFor } from '../../../shared/attention';
import { TooltipProvider } from '@/components/ui/misc';
import { bridge, call } from '@/lib/bridge';
import { Composer } from '@/features/composer/Composer';
import { Dock } from '@/features/dock/Dock';
import { notifyAttention, notifyError } from '@/features/notifications/notify';
import { CommandPalette } from '@/features/palette/CommandPalette';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { Sidebar } from '@/features/tasks/Sidebar';
import { Timeline } from '@/features/timeline/Timeline';
import { Workspace } from '@/features/workspace/Workspace';
import { useNotifications } from '@/store/notifications';
import { connectHost, getView, useActive, useView } from '@/store/snapshot';
import { useUi } from '@/store/ui';
import { ContextPanel } from './ContextPanel';
import { Header } from './Header';

export default function App() {
  useHostConnection();
  useShortcuts();
  const settings = useUi(state => state.view === 'settings');
  const panel = useUi(state => state.panel);

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col bg-surface">
          <Header />
          <div className="flex min-h-0 flex-1">
            {settings ? <SettingsPage /> : (
              <>
                <main className="flex min-w-0 flex-1 flex-col">
                  <Workbench />
                </main>
                {panel && <ContextPanel tab={panel} />}
              </>
            )}
          </div>
        </div>
      </div>
      <CommandPalette />
      <Toaster position="bottom-right" theme="system" closeButton toastOptions={{ className: 'font-sans text-[13px]' }} />
    </TooltipProvider>
  );
}

function Workbench() {
  const empty = useView(view => !view.timeline.length);
  return (
    <>
      {empty ? <StartScreen /> : <Timeline />}
      <Dock />
      <Composer />
    </>
  );
}

function StartScreen() {
  return (
    <section className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6">
      <span className="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent"><Sparkles className="size-5" /></span>
      <h2 className="text-lg font-semibold">今天要做什么？</h2>
      <div className="w-full max-w-[640px] rounded-xl border border-border bg-background p-3">
        <Workspace />
      </div>
    </section>
  );
}

function useHostConnection() {
  useEffect(() => {
    const disconnect = connectHost(
      (previous, event) => {
        const attention = attentionFor(previous, event);
        if (attention) notifyAttention(attention);
      },
      error => notifyError(error),
      // 启动时已存在的错误（配置损坏、密钥无法解密等）也要显示出来；运行进程退出由停靠区显示。
      view => { if (view.error && view.error.code !== 'HOST_EXITED') notifyError(view.error); },
    );
    const onFocus = () => {
      const taskId = getView().taskId;
      if (taskId) useNotifications.getState().markRead(taskId);
    };
    window.addEventListener('focus', onFocus);
    return () => {
      disconnect();
      window.removeEventListener('focus', onFocus);
    };
  }, []);
}

function useShortcuts() {
  const active = useActive();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const ctrl = event.ctrlKey || event.metaKey;
      if (!ctrl || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'k') useUi.getState().setPalette(!useUi.getState().paletteOpen);
      else if (key === ',') useUi.getState().openSettings();
      else if (key === 'n' && !active) void call(bridge().newTask());
      else if (key === 'b') useUi.getState().togglePanel(useUi.getState().panel ?? 'changes');
      else return;
      event.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active]);
}
