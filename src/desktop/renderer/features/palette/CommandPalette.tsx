import { Command } from 'cmdk';
import { Dialog as Primitive } from 'radix-ui';
import { Activity, BookOpen, Bot, FileDiff, ListChecks, MessageSquare, Plus, Settings, Shield } from 'lucide-react';
import type { ReactNode } from 'react';
import { bridge, call } from '@/lib/bridge';
import { modes, settingsSections } from '@/i18n/zh';
import { useActive, useView } from '@/store/snapshot';
import { useUi } from '@/store/ui';

/** Ctrl+K：切换任务、模型、模式，打开面板与设置。 */
export function CommandPalette() {
  const open = useUi(state => state.paletteOpen);
  const tasks = useView(view => view.tasks);
  const taskId = useView(view => view.taskId);
  const models = useView(view => view.models);
  const modelId = useView(view => view.model?.id);
  const userMode = useView(view => view.permission.userMode);
  const active = useActive();
  const close = () => useUi.getState().setPalette(false);
  const run = (action: () => unknown) => () => {
    close();
    void action();
  };

  return (
    <Primitive.Root open={open} onOpenChange={value => useUi.getState().setPalette(value)}>
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 z-40 bg-black/25" />
        <Primitive.Content aria-describedby={undefined} className="fixed left-1/2 top-[15vh] z-50 w-[min(560px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-surface shadow-panel">
          <Primitive.Title className="sr-only">命令面板</Primitive.Title>
          <Command label="命令面板" className="flex flex-col" loop>
            <Command.Input autoFocus placeholder="搜索任务、模型或命令…" className="h-11 border-b border-border bg-transparent px-4 text-[13.5px] placeholder:text-subtle focus:outline-none" />
            <Command.List className="max-h-[50vh] overflow-y-auto p-1.5">
              <Command.Empty className="py-6 text-center text-xs text-subtle">没有匹配的结果</Command.Empty>
              <Command.Group heading="操作" className={group}>
                <Item icon={<Plus />} disabled={active} onSelect={run(() => call(bridge().newTask()))} hint="Ctrl N">新任务</Item>
                <Item icon={<FileDiff />} onSelect={run(() => useUi.getState().openPanel('changes'))}>打开变更面板</Item>
                <Item icon={<ListChecks />} onSelect={run(() => useUi.getState().openPanel('acceptance'))}>打开验收面板</Item>
                <Item icon={<BookOpen />} onSelect={run(() => useUi.getState().openPanel('memory'))}>打开记忆面板</Item>
                <Item icon={<Activity />} onSelect={run(() => useUi.getState().openPanel('run'))}>打开运行面板</Item>
              </Command.Group>
              <Command.Group heading="任务" className={group}>
                {tasks.map(task => (
                  <Item key={task.id} value={`任务 ${task.title} ${task.project ?? ''} ${task.id}`} icon={<MessageSquare />} disabled={active && task.id !== taskId}
                    onSelect={run(() => { useUi.getState().closeSettings(); if (task.id !== taskId) return call(bridge().selectTask(task.id)); })}
                    hint={task.id === taskId ? '当前' : task.project}
                  >
                    {task.title}
                  </Item>
                ))}
              </Command.Group>
              {models.length > 1 && (
                <Command.Group heading="模型" className={group}>
                  {models.map(model => (
                    <Item key={model.id} value={`模型 ${model.name} ${model.modelId}`} icon={<Bot />} disabled={active || model.id === modelId} onSelect={run(() => call(bridge().selectModel(model.id)))} hint={model.id === modelId ? '当前' : undefined}>
                      切换到 {model.name}
                    </Item>
                  ))}
                </Command.Group>
              )}
              <Command.Group heading="权限模式" className={group}>
                {modes.map(mode => (
                  <Item key={mode.value} value={`模式 ${mode.label} ${mode.hint}`} icon={<Shield />} disabled={active || mode.value === userMode} onSelect={run(() => call(bridge().setPermission(mode.value)))} hint={mode.value === userMode ? '当前' : undefined}>
                    {mode.label}模式
                  </Item>
                ))}
              </Command.Group>
              <Command.Group heading="设置" className={group}>
                {settingsSections.map(section => (
                  <Item key={section} value={`设置 ${section}`} icon={<Settings />} onSelect={run(() => useUi.getState().openSettings(section))}>设置：{section}</Item>
                ))}
              </Command.Group>
            </Command.List>
          </Command>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}

const group = '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-subtle';

function Item({ icon, hint, children, ...props }: { icon: ReactNode; hint?: string; children: ReactNode; value?: string; disabled?: boolean; onSelect: () => void }) {
  return (
    <Command.Item
      {...props}
      className="flex h-8 cursor-default items-center gap-2.5 rounded-md px-2 text-[13px] data-[disabled=true]:opacity-40 data-[selected=true]:bg-surface-2 [&_svg]:size-4 [&_svg]:text-muted"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 text-[11px] text-subtle">{hint}</span>}
    </Command.Item>
  );
}
