import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Badge as BaseBadge } from './badge';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

// 应用层的小组件，建立在 shadcn/ui 官方组件之上。

const tones = {
  neutral: 'bg-secondary text-muted-foreground',
  accent: 'bg-primary-soft text-primary',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-destructive-soft text-destructive',
} as const;
export type Tone = keyof typeof tones;

/** 状态标签：shadcn Badge 加上语义色。 */
export function Badge({ tone = 'neutral', className, ...props }: ComponentProps<'span'> & { tone?: Tone }) {
  return <BaseBadge variant="secondary" className={cn('h-5 rounded px-1.5 text-[11px] font-medium', tones[tone], className)} {...props} />;
}

/** 只有一段文字内容的提示。 */
export function Tip({ content, children, side = 'bottom' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{content}</TooltipContent>
    </Tooltip>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-xs text-subtle">{children}</p>;
}
