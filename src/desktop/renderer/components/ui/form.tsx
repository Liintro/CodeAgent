import { forwardRef, type InputHTMLAttributes, type LabelHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const field = 'w-full rounded-md border border-border bg-surface px-2.5 text-[13px] text-foreground placeholder:text-subtle transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-55';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(field, 'h-8', className)} {...props} />
));
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(field, 'resize-none py-1.5', className)} {...props} />
));
Textarea.displayName = 'Textarea';

// 原生 select：键盘与无障碍行为完整，测试也可以直接 selectOption。
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...props }, ref) => (
  <select ref={ref} className={cn(field, 'h-8 cursor-pointer pr-7', className)} {...props} />
));
Select.displayName = 'Select';

/** 标签包住控件：文字即控件的可访问名称。 */
export function Field({ label, className, children, ...props }: LabelHTMLAttributes<HTMLLabelElement> & { label: string }) {
  return (
    <label className={cn('flex flex-col gap-1 text-xs font-medium text-muted', className)} {...props}>
      {label}
      {children}
    </label>
  );
}

export function Checkbox({ label, className, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: React.ReactNode }) {
  return (
    <label className={cn('inline-flex cursor-pointer items-center gap-2 text-[13px]', props.disabled && 'cursor-not-allowed opacity-55', className)}>
      <input type="checkbox" className="size-3.5 accent-[var(--accent)]" {...props} />
      <span>{label}</span>
    </label>
  );
}
