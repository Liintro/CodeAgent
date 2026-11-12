import { Activity, BookOpen, Bot, FileDiff, ListChecks, MessageSquare, Plus, Settings, Shield } from 'lucide-react';
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut,
} from '@/components/ui/command';
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
  const run = (action: () => unknown) => () => {
    useUi.getState().setPalette(false);
    void action();
  };

  return (
    <CommandDialog open={open} onOpenChange={value => useUi.getState().setPalette(value)} title="命令面板" description="搜索任务、模型或命令" showCloseButton={false}>
      <CommandInput placeholder="搜索任务、模型或命令…" />
      <CommandList>
        <CommandEmpty>没有匹配的结果</CommandEmpty>
        <CommandGroup heading="操作">
          <CommandItem disabled={active} onSelect={run(() => call(bridge().newTask()))}><Plus />新任务<CommandShortcut>Ctrl N</CommandShortcut></CommandItem>
          <CommandItem onSelect={run(() => useUi.getState().openPanel('changes'))}><FileDiff />打开变更面板</CommandItem>
          <CommandItem onSelect={run(() => useUi.getState().openPanel('acceptance'))}><ListChecks />打开验收面板</CommandItem>
          <CommandItem onSelect={run(() => useUi.getState().openPanel('memory'))}><BookOpen />打开记忆面板</CommandItem>
          <CommandItem onSelect={run(() => useUi.getState().openPanel('run'))}><Activity />打开运行面板</CommandItem>
        </CommandGroup>
        <CommandGroup heading="任务">
          {tasks.map(task => (
            <CommandItem
              key={task.id}
              value={`任务 ${task.title} ${task.project ?? ''} ${task.id}`}
              disabled={active && task.id !== taskId}
              onSelect={run(() => {
                useUi.getState().closeSettings();
                if (task.id !== taskId) return call(bridge().selectTask(task.id));
              })}
            >
              <MessageSquare /><span className="truncate">{task.title}</span>
              <CommandShortcut>{task.id === taskId ? '当前' : task.project}</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>
        {models.length > 1 && (
          <CommandGroup heading="模型">
            {models.map(model => (
              <CommandItem key={model.id} value={`模型 ${model.name} ${model.modelId}`} disabled={active || model.id === modelId} onSelect={run(() => call(bridge().selectModel(model.id)))}>
                <Bot />切换到 {model.name}{model.id === modelId && <CommandShortcut>当前</CommandShortcut>}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandGroup heading="权限模式">
          {modes.map(mode => (
            <CommandItem key={mode.value} value={`模式 ${mode.label} ${mode.hint}`} disabled={active || mode.value === userMode} onSelect={run(() => call(bridge().setPermission(mode.value)))}>
              <Shield />{mode.label}模式{mode.value === userMode && <CommandShortcut>当前</CommandShortcut>}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="设置">
          {settingsSections.map(section => (
            <CommandItem key={section} value={`设置 ${section}`} onSelect={run(() => useUi.getState().openSettings(section))}><Settings />设置：{section}</CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
