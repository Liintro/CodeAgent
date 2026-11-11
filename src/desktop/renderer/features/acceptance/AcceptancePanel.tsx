import { useEffect, useState } from 'react';
import { Play, Plus, ScanSearch, X } from 'lucide-react';
import type { DetectedCommand, VerifyCommand } from '../../../../shared/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/form';
import { Empty } from '@/components/ui/misc';
import { bridge, call } from '@/lib/bridge';
import { useActive, useView } from '@/store/snapshot';

export function AcceptancePanel() {
  const acceptance = useView(view => view.acceptance);
  const roots = useView(view => view.roots);
  const taskId = useView(view => view.taskId);
  const plan = useView(view => view.permission.userMode === 'plan');
  const active = useActive();
  const [commands, setCommands] = useState<VerifyCommand[]>(acceptance.commands);
  const [maxRepairs, setMaxRepairs] = useState(acceptance.maxRepairs);
  const [suggestions, setSuggestions] = useState<DetectedCommand[]>([]);
  const savedKey = JSON.stringify(acceptance);

  useEffect(() => {
    setCommands(acceptance.commands);
    setMaxRepairs(acceptance.maxRepairs);
    setSuggestions([]);
  }, [taskId, savedKey]);

  const update = (id: string, patch: Partial<VerifyCommand>) => setCommands(list => list.map(item => item.id === id ? { ...item, ...patch } : item));
  const add = (command: VerifyCommand) => setCommands(list => list.some(item => item.id === command.id) ? list : [...list, command]);
  const detect = async () => setSuggestions(await call(bridge().detectAcceptance()) ?? []);
  const saved = JSON.stringify({ commands, maxRepairs }) === savedKey;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <p className="pb-2 text-xs text-muted">确认后的命令会在 Agent 修改文件之后自动运行；失败的真实输出会交给 Agent 修复。</p>
        {!roots.length && <Empty>先添加工作目录</Empty>}
        {roots.map(root => {
          const own = commands.filter(command => command.rootId === root.id);
          return (
            <section key={root.id} className="border-b border-border py-2.5 last:border-b-0">
              <h3 className="pb-1.5 text-xs font-semibold">{root.alias}</h3>
              {!own.length && <p className="pb-1 text-xs text-subtle">未设置验收命令</p>}
              {own.map(command => (
                <div key={command.id} className="mb-1.5 grid grid-cols-[1fr_auto] gap-1.5 rounded-lg border border-border p-2">
                  <Input aria-label="命令名称" className="h-7 text-xs" value={command.label} onChange={event => update(command.id, { label: event.target.value })} />
                  <Button variant="ghost" size="icon-sm" aria-label="删除命令" onClick={() => setCommands(list => list.filter(item => item.id !== command.id))}><X /></Button>
                  <Input aria-label="验收命令" className="col-span-2 h-7 font-mono text-xs" value={command.command} onChange={event => update(command.id, { command: event.target.value })} />
                  <label className="col-span-2 flex items-center gap-1.5 text-xs text-muted">
                    超时
                    <Input aria-label="超时秒数" type="number" min={1} max={3600} className="h-6 w-20 text-xs" value={command.timeoutSeconds} onChange={event => update(command.id, { timeoutSeconds: Number(event.target.value) })} />
                    秒
                  </label>
                </div>
              ))}
              <Button variant="ghost" size="xs" disabled={active} onClick={() => add({ id: crypto.randomUUID(), rootId: root.id, label: '验收命令', command: '', timeoutSeconds: 600 })}><Plus />添加命令</Button>
            </section>
          );
        })}
        {suggestions.length > 0 && (
          <section className="py-2.5">
            <h3 className="pb-1.5 text-xs font-semibold">检测到的命令</h3>
            {suggestions.map(item => (
              <div key={item.id} className="mb-1 flex items-center gap-2 rounded-md bg-surface-2 px-2 py-1.5 text-xs">
                <span className="min-w-0 flex-1">
                  <span className="text-muted">{roots.find(root => root.id === item.rootId)?.alias} · </span><code className="font-mono">{item.command}</code>
                  {item.problem ? <small className="block text-warning">{item.problem}</small> : item.toolchain && <small className="block text-subtle">{item.toolchain}</small>}
                </span>
                <Button variant="secondary" size="xs" onClick={() => add({ id: item.id, rootId: item.rootId, label: item.label, command: item.command, timeoutSeconds: item.timeoutSeconds })}>添加</Button>
              </div>
            ))}
          </section>
        )}
      </div>
      <div className="flex flex-col gap-2 border-t border-border px-3 py-2.5">
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted">
            最多修复
            <Input aria-label="修复次数上限" type="number" min={0} max={10} className="h-7 w-14 text-xs" value={maxRepairs} onChange={event => setMaxRepairs(Number(event.target.value))} />
            次
          </label>
          <Button variant="secondary" size="sm" className="ml-auto" onClick={detect} disabled={active || !roots.length}><ScanSearch />检测</Button>
          <Button size="sm" onClick={() => call(bridge().setAcceptance({ commands, maxRepairs }))} disabled={active || saved || commands.some(command => !command.command.trim())}>{saved ? '已保存' : '保存并确认'}</Button>
        </div>
        <Button variant="secondary" onClick={() => call(bridge().verifyNow())} disabled={active || plan || !acceptance.commands.length}><Play />立即验证</Button>
        {plan && <p className="text-xs text-subtle">计划模式不执行验证命令。</p>}
      </div>
    </div>
  );
}
