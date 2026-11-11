import type { ComponentProps } from 'react';
import { ContextMenu as Context, DropdownMenu as Dropdown } from 'radix-ui';
import { cn } from '@/lib/utils';

const content = 'z-50 min-w-40 overflow-hidden rounded-lg border border-border bg-surface p-1 text-[13px] shadow-panel';
const item = 'relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[highlighted]:bg-surface-2 [&_svg]:size-4 [&_svg]:text-muted';

export const DropdownMenu = Dropdown.Root;
export const DropdownMenuTrigger = Dropdown.Trigger;
export const DropdownMenuRadioGroup = Dropdown.RadioGroup;

export function DropdownMenuContent({ className, sideOffset = 4, ...props }: ComponentProps<typeof Dropdown.Content>) {
  return <Dropdown.Portal><Dropdown.Content sideOffset={sideOffset} className={cn(content, className)} {...props} /></Dropdown.Portal>;
}
export function DropdownMenuItem({ className, ...props }: ComponentProps<typeof Dropdown.Item>) {
  return <Dropdown.Item className={cn(item, className)} {...props} />;
}
export function DropdownMenuRadioItem({ className, ...props }: ComponentProps<typeof Dropdown.RadioItem>) {
  return <Dropdown.RadioItem className={cn(item, className)} {...props} />;
}
export function DropdownMenuSeparator() {
  return <Dropdown.Separator className="-mx-1 my-1 h-px bg-border" />;
}

export const ContextMenu = Context.Root;
export const ContextMenuTrigger = Context.Trigger;
export function ContextMenuContent({ className, ...props }: ComponentProps<typeof Context.Content>) {
  return <Context.Portal><Context.Content className={cn(content, className)} {...props} /></Context.Portal>;
}
export function ContextMenuItem({ className, ...props }: ComponentProps<typeof Context.Item>) {
  return <Context.Item className={cn(item, className)} {...props} />;
}
