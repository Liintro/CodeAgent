import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import type { KeyChange, ModelInput, ModelProfile } from '../../../../shared/contracts';
import { Button } from '@/components/ui/button';
import { CheckboxField, Field, Select } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/misc';
import { bridge } from '@/lib/bridge';
import { cn } from '@/lib/utils';
import { useActive, useView } from '@/store/snapshot';
import { useUi } from '@/store/ui';

const blank = { name: '', provider: '', baseUrl: '', modelId: '', contextWindow: 32000, maxOutputTokens: 2048, reasoning: false as ModelInput['reasoning'], vision: false };
const draftOf = (profile?: ModelProfile) => profile
  ? { name: profile.name, provider: profile.provider, baseUrl: profile.baseUrl, modelId: profile.modelId, contextWindow: profile.contextWindow, maxOutputTokens: profile.maxOutputTokens, reasoning: profile.reasoning, vision: profile.vision }
  : blank;
const REASONING_OPTIONS: { value: ModelInput['reasoning']; label: string }[] = [
  { value: false, label: '关闭' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
];

export function ModelSection() {
  const model = useView(view => view.model);
  const models = useView(view => view.models);
  const run = useView(view => view.run);
  const active = useActive();
  const [editingId, setEditingId] = useState(model?.id ?? 'new');
  const [draft, setDraft] = useState(draftOf(model));
  const [apiKey, setApiKey] = useState('');
  const [keySource, setKeySource] = useState<string>();
  const [removeKey, setRemoveKey] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState<'save' | 'delete' | 'test'>();
  const [message, setMessage] = useState<{ text: string; ok: boolean }>();
  const [testResult, setTestResult] = useState('');
  const editing = models.find(item => item.id === editingId);
  const change = (patch: Partial<typeof blank>) => setDraft({ ...draft, ...patch });
  // 新配置可以沿用已保存的密钥；Base URL 与某个已保存配置相同时默认沿用它。
  const donors = models.filter(item => item.hasApiKey && item.id !== editingId);
  const reuseId = editing?.hasApiKey ? '' : keySource ?? donors.find(item => item.baseUrl === draft.baseUrl)?.id ?? '';
  const dirty = Boolean(apiKey) || removeKey || keySource !== undefined || JSON.stringify(draft) !== JSON.stringify(draftOf(editing));

  // 有未保存的修改时，第一次离开只提示，再次离开才放弃。
  const leave = useRef({ dirty, warned: false });
  leave.current.dirty = dirty;
  useEffect(() => {
    useUi.getState().setLeaveGuard(() => {
      if (!leave.current.dirty || leave.current.warned) return true;
      leave.current.warned = true;
      setMessage({ text: '有未保存的修改，再次关闭将放弃', ok: false });
      return false;
    });
    return () => useUi.getState().setLeaveGuard(undefined);
  }, []);

  function loadProfile(id: string) {
    setEditingId(id);
    setDraft(draftOf(models.find(item => item.id === id)));
    setApiKey('');
    setKeySource(undefined);
    setRemoveKey(false);
    setConfirmDelete(false);
    leave.current.warned = false;
    setMessage(undefined);
    setTestResult('');
  }

  async function save() {
    setBusy('save');
    setMessage(undefined);
    const keyChange: KeyChange = removeKey ? { action: 'remove' }
      : reuseId ? { action: 'copy', fromId: reuseId }
        : apiKey ? { action: 'replace', value: apiKey } : { action: 'keep' };
    const reply = await bridge().saveModel({ id: editingId === 'new' ? crypto.randomUUID() : editingId, api: 'openai-completions', ...draft }, keyChange);
    if (reply.ok) {
      setEditingId(reply.value.id);
      setDraft(draftOf(reply.value));
      setApiKey('');
      setKeySource(undefined);
      setRemoveKey(false);
      leave.current.warned = false;
      setTestResult('');
      setMessage({ text: `设置已保存，当前使用「${reply.value.name}」`, ok: true });
    } else setMessage({ text: reply.error.message, ok: false });
    setBusy(undefined);
  }

  async function remove() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy('delete');
    const reply = await bridge().deleteModel(editingId);
    if (reply.ok) loadProfile(models.find(item => item.id !== editingId)?.id ?? 'new');
    else setMessage({ text: reply.error.message, ok: false });
    setBusy(undefined);
  }

  async function test() {
    setBusy('test');
    setMessage(undefined);
    setTestResult('');
    const reply = await bridge().testModel();
    if (reply.ok) setTestResult(reply.value.text);
    else setMessage({ text: reply.error.message, ok: false });
    setBusy(undefined);
  }

  return (
    <div className="flex min-h-0 flex-1 gap-6">
      <nav className="flex w-52 shrink-0 flex-col gap-1" aria-label="已保存的模型">
        {models.map(item => (
          <button
            key={item.id}
            aria-pressed={item.id === editingId}
            disabled={active}
            onClick={() => loadProfile(item.id)}
            className={cn('flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left disabled:opacity-50', item.id === editingId ? 'border-primary bg-primary-soft' : 'border-border hover:bg-surface-2')}
          >
            <span className="flex w-full items-center gap-1.5 text-[13px] font-medium">
              <span className="truncate">{item.name}</span>{item.id === model?.id && <Badge tone="accent" className="ml-auto">当前</Badge>}
            </span>
            <small className="w-full truncate text-[11px] text-muted-foreground">{item.provider ? `${item.provider} · ` : ''}{item.modelId}</small>
            <small className={cn('text-[11px]', item.hasApiKey ? 'text-success' : 'text-warning')}>{item.hasApiKey ? '密钥已配置' : '未配置密钥'}</small>
          </button>
        ))}
        <Button variant="ghost" className={cn('justify-start', editingId === 'new' && 'bg-surface-2 text-foreground')} disabled={active} onClick={() => loadProfile('new')}><Plus />新建模型</Button>
      </nav>
      <div className="flex min-w-0 max-w-xl flex-1 flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="名称"><Input value={draft.name} onChange={event => change({ name: event.target.value })} placeholder="默认同 Model ID" disabled={active} /></Field>
          <Field label="服务商"><Input value={draft.provider} onChange={event => change({ provider: event.target.value })} placeholder="如 DeepSeek" disabled={active} /></Field>
        </div>
        <Field label="Base URL"><Input value={draft.baseUrl} onChange={event => change({ baseUrl: event.target.value })} placeholder="https://api.example.com/v1" disabled={active} /></Field>
        <Field label="Model ID"><Input value={draft.modelId} onChange={event => change({ modelId: event.target.value })} placeholder="模型标识" disabled={active} /></Field>
        <Field label="API Key">
          <Input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={editing?.hasApiKey ? '已保存密钥，输入以替换' : '输入 API Key'} disabled={active || removeKey || Boolean(reuseId)} autoComplete="off" />
        </Field>
        {!editing?.hasApiKey && donors.length > 0 && (
          <Field label="密钥来源">
            <Select value={reuseId} onChange={event => setKeySource(event.target.value)} disabled={active}>
              <option value="">输入新密钥</option>
              {donors.map(item => <option key={item.id} value={item.id}>沿用「{item.name}」的密钥</option>)}
            </Select>
          </Field>
        )}
        {editing?.hasApiKey && <CheckboxField checked={removeKey} onCheckedChange={checked => setRemoveKey(checked === true)} disabled={active} label="移除已保存密钥" />}
        <details className="group rounded-lg border border-border">
          <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">更多</summary>
          <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="上下文预算"><Input type="number" min="1" value={draft.contextWindow} onChange={event => change({ contextWindow: Number(event.target.value) })} disabled={active} /></Field>
              <Field label="输出预算"><Input type="number" min="1" value={draft.maxOutputTokens} onChange={event => change({ maxOutputTokens: Number(event.target.value) })} disabled={active} /></Field>
            </div>
            <Field label="思考强度">
              <Select value={String(draft.reasoning)} onChange={event => change({ reasoning: event.target.value === 'false' ? false : event.target.value as ModelInput['reasoning'] })} disabled={active}>
                {REASONING_OPTIONS.map(option => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}
              </Select>
            </Field>
            <small className="text-[11px] text-subtle">将随请求发送给端点（DeepSeek 官方端点发送 thinking 与 reasoning_effort，其他 OpenAI 兼容端点发送 reasoning_effort）；端点不支持时会报错，不会伪装生效。</small>
            <CheckboxField checked={draft.vision} onCheckedChange={checked => change({ vision: checked === true })} disabled={active} label="支持图像输入" />
          </div>
        </details>
        {message && <p className={cn('text-xs', message.ok ? 'text-success' : 'text-danger')} role={message.ok ? 'status' : 'alert'}>{message.text}</p>}
        {testResult && <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-surface-2 p-2.5 text-xs">{testResult}</pre>}
        <div className="flex items-center gap-2 border-t border-border pt-3">
          {active ? (
            <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => run && bridge().cancelRun(run.id)}>取消执行</Button>
          ) : (
            <>
              <Button variant="outline" onClick={test} disabled={editingId !== model?.id || Boolean(busy)}>测试连接</Button>
              {editing && <Button variant="outline" className="text-destructive hover:text-destructive" onClick={remove} disabled={Boolean(busy)}>{confirmDelete ? '确认删除' : '删除'}</Button>}
            </>
          )}
          <Button className="ml-auto" onClick={save} disabled={active || Boolean(busy)}>{busy === 'save' ? '保存中…' : '保存'}</Button>
        </div>
      </div>
    </div>
  );
}
