import { useRef } from 'react';
import { Tabs } from 'radix-ui';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { panelTitles } from '@/i18n/zh';
import { AcceptancePanel } from '@/features/acceptance/AcceptancePanel';
import { ChangesPanel } from '@/features/changes/ChangesPanel';
import { MemoryPanel } from '@/features/memory/MemoryPanel';
import { RunPanel } from '@/features/run/RunPanel';
import { useUi, type PanelTab } from '@/store/ui';

const tabs: PanelTab[] = ['changes', 'acceptance', 'memory', 'run'];

export function ContextPanel({ tab }: { tab: PanelTab }) {
  const width = useUi(state => state.panelWidth);
  return (
    <aside aria-label={panelTitles[tab]} className="relative flex shrink-0 flex-col border-l border-border bg-surface" style={{ width }}>
      <ResizeHandle />
      <Tabs.Root value={tab} onValueChange={value => useUi.getState().openPanel(value as PanelTab)} className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
          <Tabs.List className="flex flex-1 gap-0.5">
            {tabs.map(value => (
              <Tabs.Trigger
                key={value}
                value={value}
                className={cn('h-7 rounded-md px-2.5 text-xs font-medium text-muted hover:text-foreground', 'data-[state=active]:bg-surface-3 data-[state=active]:text-foreground')}
              >
                {panelTitles[value]}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
          <Button variant="ghost" size="icon-sm" aria-label="关闭面板" onClick={() => useUi.getState().closePanel()}><X /></Button>
        </div>
        <Tabs.Content value="changes" className="flex min-h-0 flex-1 flex-col outline-none"><ChangesPanel /></Tabs.Content>
        <Tabs.Content value="acceptance" className="flex min-h-0 flex-1 flex-col outline-none"><AcceptancePanel /></Tabs.Content>
        <Tabs.Content value="memory" className="flex min-h-0 flex-1 flex-col outline-none"><MemoryPanel /></Tabs.Content>
        <Tabs.Content value="run" className="flex min-h-0 flex-1 flex-col outline-none"><RunPanel /></Tabs.Content>
      </Tabs.Root>
    </aside>
  );
}

function ResizeHandle() {
  const start = useRef<{ x: number; width: number }>(undefined);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="调整面板宽度"
      className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-accent/20 active:bg-accent/30"
      onPointerDown={event => {
        start.current = { x: event.clientX, width: useUi.getState().panelWidth };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        if (start.current) useUi.getState().setPanelWidth(start.current.width + start.current.x - event.clientX);
      }}
      onPointerUp={() => { start.current = undefined; }}
      onDoubleClick={() => useUi.getState().setPanelWidth(420)}
    />
  );
}
