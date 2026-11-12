import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { panelTitles } from '@/i18n/zh';
import { AcceptancePanel } from '@/features/acceptance/AcceptancePanel';
import { ChangesPanel } from '@/features/changes/ChangesPanel';
import { MemoryPanel } from '@/features/memory/MemoryPanel';
import { RunPanel } from '@/features/run/RunPanel';
import { useUi, type PanelTab } from '@/store/ui';

const tabs: PanelTab[] = ['changes', 'acceptance', 'memory', 'run'];
const content = 'flex min-h-0 flex-1 flex-col outline-none';

/** 右栏上下文面板；宽度由外层 ResizablePanel 控制。 */
export function ContextPanel({ tab }: { tab: PanelTab }) {
  return (
    <aside aria-label={panelTitles[tab]} className="flex h-full min-w-0 flex-col bg-surface">
      <Tabs value={tab} onValueChange={value => useUi.getState().openPanel(value as PanelTab)} className="min-h-0 flex-1 gap-0">
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
          <TabsList variant="line" className="h-8 flex-1 justify-start">
            {tabs.map(value => <TabsTrigger key={value} value={value} className="flex-none px-2.5 text-xs">{panelTitles[value]}</TabsTrigger>)}
          </TabsList>
          <Button variant="ghost" size="icon-xs" aria-label="关闭面板" onClick={() => useUi.getState().closePanel()}><X /></Button>
        </div>
        <TabsContent value="changes" className={content}><ChangesPanel /></TabsContent>
        <TabsContent value="acceptance" className={content}><AcceptancePanel /></TabsContent>
        <TabsContent value="memory" className={content}><MemoryPanel /></TabsContent>
        <TabsContent value="run" className={content}><RunPanel /></TabsContent>
      </Tabs>
    </aside>
  );
}
