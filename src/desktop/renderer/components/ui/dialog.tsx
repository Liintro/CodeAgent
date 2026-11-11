import type { ComponentProps, ReactNode } from 'react';
import { Dialog as Primitive } from 'radix-ui';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export const Dialog = Primitive.Root;
export const DialogClose = Primitive.Close;

export function DialogContent({ title, className, children, ...props }: ComponentProps<typeof Primitive.Content> & { title: string }) {
  return (
    <Primitive.Portal>
      <Primitive.Overlay className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]" />
      <Primitive.Content
        aria-describedby={undefined}
        className={cn('fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(520px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-surface shadow-panel', className)}
        {...props}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <Primitive.Title className="text-sm font-semibold">{title}</Primitive.Title>
          <Primitive.Close className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-foreground" aria-label="关闭">
            <X className="size-4" />
          </Primitive.Close>
        </div>
        {children}
      </Primitive.Content>
    </Primitive.Portal>
  );
}

export function DialogBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('flex flex-col gap-3 overflow-auto px-4 py-3', className)}>{children}</div>;
}

export function DialogFooter({ children }: { children: ReactNode }) {
  return <div className="flex justify-end gap-2 border-t border-border px-4 py-3">{children}</div>;
}
