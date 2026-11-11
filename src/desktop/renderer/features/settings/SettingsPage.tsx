import { useEffect, useState, type ReactNode } from 'react';
import { Tabs } from 'radix-ui';
import { Bell, Bot, BookOpen, Palette, Plug, ShieldCheck } from 'lucide-react';
import type { McpServerStatus, Preferences, ThemePreference } from '../../../../shared/contracts';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input } from '@/components/ui/form';
import { Badge, Empty, Switch, type Tone } from '@/components/ui/misc';
import { bridge, call } from '@/lib/bridge';
import { cn } from '@/lib/utils';
import { mcpStateText, modes, sandboxStatusText, settingsSections, type SettingsSection } from '@/i18n/zh';
import { notifyInfo } from '@/features/notifications/notify';
import { MemorySwitch } from '@/features/memory/MemoryPanel';
import { useActive, useView } from '@/store/snapshot';
import { useUi } from '@/store/ui';
import { ModelSection } from './ModelSection';

const icons: Record<SettingsSection, typeof Bot> = { 模型: Bot, 'MCP 与联网': Plug, 沙箱与权限: ShieldCheck, 记忆: BookOpen, 通知: Bell, 外观: Palette };

export function SettingsPage() {
  const section = useUi(state => state.settingsSection);
  return (
    <Tabs.Root
      orientation="vertical"
      value={section}
      onValueChange={value => useUi.getState().setSettingsSection(value as SettingsSection)}
      className="flex min-h-0 flex-1"
    >
      <Tabs.List aria-label="设置分区" className="flex w-48 shrink-0 flex-col gap-0.5 border-r border-border bg-background p-2">
        {settingsSections.map(name => {
          const Icon = icons[name];
          return (
            <Tabs.Trigger
              key={name}
              value={name}
              className="flex h-8 items-center gap-2 rounded-md px-2.5 text-left text-[13px] text-muted hover:bg-surface-2 hover:text-foreground data-[state=active]:bg-surface-3 data-[state=active]:font-medium data-[state=active]:text-foreground [&_svg]:size-4"
            >
              <Icon />{name}
            </Tabs.Trigger>
          );
        })}
      </Tabs.List>
      {settingsSections.map(name => (
        <Tabs.Content key={name} value={name} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-8 py-6 outline-none">
          <h2 className="pb-4 text-base font-semibold">{name}</h2>
          {name === '模型' && <ModelSection />}
          {name === 'MCP 与联网' && <McpSection />}
          {name === '沙箱与权限' && <SandboxSection />}
          {name === '记忆' && <MemorySection />}
          {name === '通知' && <NotificationSection />}
          {name === '外观' && <AppearanceSection />}
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}

function Group({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="mb-6 max-w-2xl">
      <div className="flex items-center gap-2 pb-2">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        <div className="ml-auto flex items-center gap-2">{aside}</div>
      </div>
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">{children}</div>
    </section>
  );
}

const mcpTone: Record<McpServerStatus['state'], Tone> = { disabled: 'neutral', connecting: 'accent', ready: 'success', failed: 'danger' };

function McpSection() {
  const servers = useView(view => view.mcp);
  const webSearch = useView(view => view.webSearch);
  const [draft, setDraft] = useState({ enabled: webSearch.enabled, searchUrl: webSearch.searchUrl ?? '', apiKeyHeader: webSearch.apiKeyHeader ?? '', apiKey: '', removeKey: false });
  const [saving, setSaving] = useState(false);

  async function saveWebSearch() {
    setSaving(true);
    const saved = await call(bridge().setWebSearch({
      enabled: draft.enabled,
      searchUrl: draft.searchUrl,
      apiKeyHeader: draft.apiKeyHeader,
      ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
      ...(draft.removeKey ? { removeKey: true } : {}),
    } as Parameters<typeof window.codeAgent.setWebSearch>[0]));
    setSaving(false);
    if (saved !== undefined) notifyInfo('联网设置已保存');
  }

  return (
    <>
      <Group title="联网搜索" aside={<Checkbox checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} aria-label="启用联网搜索" label="启用" />}>
        <Field label="搜索接口地址"><Input value={draft.searchUrl} onChange={event => setDraft({ ...draft, searchUrl: event.target.value })} placeholder="https://…/search?q={query} 或 /search?q={query}" disabled={!draft.enabled} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="密钥请求头"><Input value={draft.apiKeyHeader} onChange={event => setDraft({ ...draft, apiKeyHeader: event.target.value })} placeholder="可选，如 Authorization" disabled={!draft.enabled} /></Field>
          <Field label="API Key"><Input type="password" value={draft.apiKey} onChange={event => setDraft({ ...draft, apiKey: event.target.value })} placeholder={webSearch.hasApiKey ? '已保存密钥，输入以替换' : '可选'} disabled={!draft.enabled || draft.removeKey} autoComplete="off" /></Field>
        </div>
        {webSearch.hasApiKey && <Checkbox checked={draft.removeKey} onChange={event => setDraft({ ...draft, removeKey: event.target.checked })} disabled={!draft.enabled} label="移除已保存密钥" />}
        <p className="text-[11px] text-subtle">web_search / web_fetch 只在开启后对 Agent 可用；网页内容按不可信数据处理，查询不包含本地代码。评测运行始终关闭。</p>
        <div><Button variant="secondary" onClick={saveWebSearch} disabled={saving}>{saving ? '保存中…' : '保存联网设置'}</Button></div>
      </Group>
      <Group
        title="MCP 服务"
        aside={<>
          <Button variant="ghost" size="sm" onClick={() => call(bridge().openMcpConfig())}>打开配置文件</Button>
          <Button variant="secondary" size="sm" onClick={() => call(bridge().reloadMcp())}>重新加载</Button>
        </>}
      >
        {!servers.length && <Empty>未配置服务。点击“打开配置文件”添加。</Empty>}
        {servers.map(server => (
          <div key={server.name} className="flex flex-wrap items-center gap-3 border-b border-border pb-3 last:border-b-0 last:pb-0">
            <Checkbox checked={server.state !== 'disabled'} aria-label={`启用 ${server.name}`} onChange={event => call(bridge().setMcpEnabled(server.name, event.target.checked))} label={<strong className="font-medium">{server.name}</strong>} />
            <Badge tone={mcpTone[server.state]}>{mcpStateText[server.state]}</Badge>
            {server.state === 'ready' && <span className="text-xs text-muted">{server.toolCount} 个工具</span>}
            {server.error && <p className="w-full text-xs text-danger">{server.error}</p>}
          </div>
        ))}
      </Group>
    </>
  );
}

function SandboxSection() {
  const status = useView(view => view.sandboxStatus);
  const roots = useView(view => view.roots);
  const userMode = useView(view => view.permission.userMode);
  const grants = useView(view => view.permission.grants);
  const tone: Tone = status === 'available' ? 'success' : status === 'untested' ? 'accent' : 'danger';
  return (
    <>
      <Group title="原生沙箱" aside={<Badge tone={tone}>{sandboxStatusText[status]}</Badge>}>
        <p className="text-[13px]">自动模式下，命令在 Low 完整性级别的沙箱进程中运行：只有已授权的工作目录可写，项目外的文件与用户目录不可写。</p>
        <ul className="list-disc pl-5 text-xs text-muted">
          <li>已知限制：LocalLow 与 AppDataLow 目录对沙箱可写。</li>
          <li>沙箱限制写入，不限制读取与网络访问。</li>
          <li>授权在退出应用或移除目录时撤销；异常退出后下次启动会清理遗留授权。</li>
        </ul>
      </Group>
      <Group title="当前任务">
        <div className="flex items-center gap-2 text-[13px]">权限模式 <Badge tone="accent">{modes.find(mode => mode.value === userMode)?.label}</Badge></div>
        {!roots.length && <p className="text-xs text-subtle">未选择目录</p>}
        {roots.map(root => (
          <div key={root.id} className="flex items-center gap-2 text-xs">
            <span className="font-medium">{root.alias}</span>
            <span className="min-w-0 flex-1 truncate text-subtle" title={root.path}>{root.path}</span>
            <Badge tone={root.sandboxGranted ? 'success' : 'neutral'}>{root.sandboxGranted ? '沙箱已授权' : '未授权'}</Badge>
          </div>
        ))}
        {grants.length > 0 && <p className="text-xs text-muted">本任务内已允许 {grants.length} 项操作</p>}
      </Group>
    </>
  );
}

function MemorySection() {
  const enabled = useView(view => view.memoryEnabled);
  const active = useActive();
  return (
    <Group title="仓库记忆" aside={<MemorySwitch enabled={enabled} disabled={active} />}>
      <p className="text-[13px]">记录每个仓库里的修复、变更与约定，下次在同一仓库工作时按相关度召回；每条记忆会按当前 Git 历史校验是否仍然有效。</p>
      <div><Button variant="secondary" size="sm" onClick={() => { useUi.getState().closeSettings(); useUi.getState().openPanel('memory'); }}>管理记忆</Button></div>
    </Group>
  );
}

function usePreferences(): [Preferences | undefined, (next: Preferences) => void] {
  const [preferences, setPreferences] = useState<Preferences>();
  useEffect(() => { void call(bridge().getPreferences()).then(setPreferences); }, []);
  const save = (next: Preferences) => {
    setPreferences(next);
    void call(bridge().setPreferences(next)).then(value => value && setPreferences(value));
  };
  return [preferences, save];
}

const levels: { key: keyof Preferences['notify']; title: string; hint: string }[] = [
  { key: 'action', title: '需要处理', hint: '等待审批、任务中断、验证未通过' },
  { key: 'done', title: '完成', hint: '运行结束、验证通过' },
  { key: 'error', title: '错误', hint: '运行失败、模型连接失败、运行进程退出' },
];

function NotificationSection() {
  const [preferences, save] = usePreferences();
  if (!preferences) return null;
  return (
    <Group title="窗口不在前台时发送系统通知">
      {levels.map(level => (
        <label key={level.key} className="flex items-center gap-3">
          <span className="flex flex-1 flex-col">
            <span className="text-[13px] font-medium">{level.title}</span>
            <span className="text-xs text-muted">{level.hint}</span>
          </span>
          <Switch aria-label={`${level.title}通知`} checked={preferences.notify[level.key]} onCheckedChange={value => save({ ...preferences, notify: { ...preferences.notify, [level.key]: value } })} />
        </label>
      ))}
    </Group>
  );
}

const themes: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '暗色' },
];

function AppearanceSection() {
  const [preferences, save] = usePreferences();
  if (!preferences) return null;
  return (
    <Group title="主题">
      <div role="radiogroup" aria-label="主题" className="grid grid-cols-3 gap-2">
        {themes.map(theme => (
          <button
            key={theme.value}
            role="radio"
            aria-checked={preferences.theme === theme.value}
            onClick={() => save({ ...preferences, theme: theme.value })}
            className={cn('flex flex-col items-center gap-2 rounded-lg border p-3 text-xs', preferences.theme === theme.value ? 'border-accent bg-accent-soft font-medium' : 'border-border hover:bg-surface-2')}
          >
            <ThemeSwatch theme={theme.value} />
            {theme.label}
          </button>
        ))}
      </div>
    </Group>
  );
}

function ThemeSwatch({ theme }: { theme: ThemePreference }) {
  const half = (dark: boolean) => (
    <span className={cn('flex flex-1 flex-col gap-1 p-1.5', dark ? 'bg-[#1c1d22]' : 'bg-white')}>
      <span className={cn('h-1.5 w-3/4 rounded-sm', dark ? 'bg-[#3c3f48]' : 'bg-[#e3e4e8]')} />
      <span className={cn('h-1.5 w-1/2 rounded-sm', dark ? 'bg-[#7f97ff]' : 'bg-[#3a5ccc]')} />
    </span>
  );
  return (
    <span className="flex h-12 w-full overflow-hidden rounded-md border border-border">
      {theme === 'dark' ? half(true) : half(false)}
      {theme === 'system' && half(true)}
    </span>
  );
}
