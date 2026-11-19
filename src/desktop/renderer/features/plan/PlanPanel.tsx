import { useState } from 'react';
import { Check, ChevronDown, ChevronRight, Circle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useView } from '@/store/snapshot';

/** update_plan 的当前计划，固定在输入框上方；可以收起成一行。 */
export function PlanPanel() {
  const plan = useView(view => view.plan);
  const [open, setOpen] = useState(true);
  if (!plan.length) return null;
  const done = plan.filter(item => item.status === 'completed').length;
  const current = plan.find(item => item.status === 'in_progress');
  return (
    <section aria-label="计划" className="mx-auto w-full max-w-[820px] px-6 pt-2">
      <div className="rounded-xl border border-border bg-surface px-3 py-2 text-[12.5px]">
        <button className="flex w-full items-center gap-1.5 text-left font-medium" onClick={() => setOpen(value => !value)}>
          {open ? <ChevronDown className="size-3.5 text-subtle" /> : <ChevronRight className="size-3.5 text-subtle" />}
          计划 <span className="text-subtle">{done}/{plan.length}</span>
          {!open && current && <span className="min-w-0 truncate font-normal text-muted-foreground">· {current.content}</span>}
        </button>
        {open && (
          <ol className="mt-1.5 space-y-1">
            {plan.map((item, index) => (
              <li key={index} data-status={item.status} className={cn('flex items-start gap-2', item.status === 'completed' && 'text-subtle line-through')}>
                {item.status === 'completed' ? <Check className="mt-0.5 size-3.5 shrink-0 text-success" />
                  : item.status === 'in_progress' ? <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-primary" />
                    : <Circle className="mt-0.5 size-3.5 shrink-0 text-subtle" />}
                <span className="min-w-0 [overflow-wrap:anywhere]">{item.content}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
