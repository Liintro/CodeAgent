import { useLayoutEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useActive, useView } from '@/store/snapshot';
import { groupTimeline, type TimelineEntry } from './group';
import { ExploreRow, MemoryRow, MessageRow, NoticeRow, ToolRow, VerificationRow } from './rows';

export function Timeline() {
  const timeline = useView(view => view.timeline);
  const active = useActive();
  const entries = useMemo(() => groupTimeline(timeline), [timeline]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 48,
    getItemKey: index => entries[index].key,
    overscan: 12,
  });

  // 只有用户本来就停在底部时才跟随输出；向上翻阅历史时不抢滚动位置。
  const totalSize = virtualizer.getTotalSize();
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [timeline, totalSize]);

  const lastIndex = entries.length - 1;
  return (
    <div
      ref={scroller}
      className="min-h-0 flex-1 overflow-y-auto"
      aria-label="对话"
      onScroll={event => {
        const element = event.currentTarget;
        stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      }}
    >
      <div className="relative mx-auto w-full max-w-[820px] px-6" style={{ height: totalSize + 48 }}>
        {virtualizer.getVirtualItems().map(row => (
          <div
            key={row.key}
            data-index={row.index}
            ref={virtualizer.measureElement}
            className="absolute left-6 right-6 py-1.5"
            style={{ transform: `translateY(${row.start + 24}px)` }}
          >
            <Entry entry={entries[row.index]} pending={active && row.index === lastIndex} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Entry({ entry, pending }: { entry: TimelineEntry; pending: boolean }) {
  if (entry.type === 'explore') return <ExploreRow tools={entry.tools} />;
  const item = entry.item;
  switch (item.kind) {
    case 'tool': return <ToolRow item={item} />;
    case 'verification': return <VerificationRow item={item} />;
    case 'notice': return <NoticeRow text={item.text} />;
    case 'memory': return <MemoryRow item={item} />;
    case 'message': return <MessageRow item={item} pending={pending} />;
  }
}
