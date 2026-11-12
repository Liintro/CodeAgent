import { forwardRef, useId, type ComponentProps, type ReactNode, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { Checkbox } from './checkbox';
import { Label } from './label';

/** 标签包住控件：文字即控件的可访问名称。 */
export function Field({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <Label className={cn('flex flex-col items-stretch gap-1.5 text-xs font-medium text-muted-foreground', className)}>
      {label}
      {children}
    </Label>
  );
}

/** 带文字的复选框（shadcn Checkbox + Label）。 */
export function CheckboxField({ label, className, onCheckedChange, ...props }: ComponentProps<typeof Checkbox> & { label: ReactNode }) {
  const id = useId();
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Checkbox id={id} onCheckedChange={onCheckedChange} {...props} />
      <Label htmlFor={id} className={cn('text-[13px] font-normal', props.disabled && 'opacity-50')}>{label}</Label>
    </div>
  );
}

// 原生 select：键盘与无障碍行为完整，测试也可以直接 selectOption。样式与 shadcn Input 一致。
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      'h-9 w-full min-w-0 cursor-pointer rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30',
      className,
    )}
    {...props}
  />
));
Select.displayName = 'Select';
