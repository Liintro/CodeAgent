import type { ComponentProps, ReactNode } from 'react';
import { Switch as SwitchPrimitive, Tooltip as TooltipPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn('inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-surface-3 transition-colors data-[state=checked]:bg-accent disabled:cursor-not-allowed disabled:opacity-50', className)}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[15px]" />
    </SwitchPrimitive.Root>
  );
}

export const TooltipProvider = TooltipPrimitive.Provider;

export function Tooltip({ content, children, side = 'bottom' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content side={side} sideOffset={6} className="z-50 max-w-80 rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-panel">
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

const tones = {
  neutral: 'bg-surface-2 text-muted',
  accent: 'bg-accent-soft text-accent',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
} as const;
export type Tone = keyof typeof tones;

export function Badge({ tone = 'neutral', className, ...props }: ComponentProps<'span'> & { tone?: Tone }) {
  return <span className={cn('inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 text-[11px] font-medium', tones[tone], className)} {...props} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd aria-hidden="true" className="rounded border border-current/25 px-1 font-sans text-[10px] leading-4 opacity-70">{children}</kbd>;
}

export function Spinner({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn('inline-block size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent', className)} />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-xs text-subtle">{children}</p>;
}
