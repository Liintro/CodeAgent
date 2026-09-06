import { useState } from 'react';
import type { KeyChange, ModelInput, ModelProfile, Reply } from '../../shared/contracts';

type Props = {
  model?: ModelProfile;
  models: ModelProfile[];
  active: boolean;
  onClose: () => void;
  onSave: (profile: ModelInput, keyChange: KeyChange) => Promise<Reply<ModelProfile>>;
  onDelete: (modelId: string) => Promise<Reply<void>>;
  onTest: () => Promise<Reply<{ text: string }>>;
  onCancel: () => void;
};

const blank = { name: '', provider: '', baseUrl: '', modelId: '', contextWindow: 32000, maxOutputTokens: 2048 };
const draftOf = (profile?: ModelProfile) => profile
  ? { name: profile.name, provider: profile.provider, baseUrl: profile.baseUrl, modelId: profile.modelId, contextWindow: profile.contextWindow, maxOutputTokens: profile.maxOutputTokens }
  : blank;

export function ModelSettings({ model, models, active, onClose, onSave, onDelete, onTest, onCancel }: Props) {
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

  function loadProfile(id: string) {
    setEditingId(id);
    setDraft(draftOf(models.find(item => item.id === id)));
    setApiKey('');
    setKeySource(undefined);
    setRemoveKey(false);
    setConfirmDelete(false);
    setMessage(undefined);
    setTestResult('');
  }

  async function save() {
    setBusy('save');
    setMessage(undefined);
    const keyChange: KeyChange = removeKey ? { action: 'remove' }
      : reuseId ? { action: 'copy', fromId: reuseId }
        : apiKey ? { action: 'replace', value: apiKey } : { action: 'keep' };
    const reply = await onSave({ id: editingId === 'new' ? crypto.randomUUID() : editingId, api: 'openai-completions', reasoning: false, ...draft }, keyChange);
    if (reply.ok) {
      setEditingId(reply.value.id);
      setDraft(draftOf(reply.value));
      setApiKey('');
      setKeySource(undefined);
      setRemoveKey(false);
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
    const reply = await onDelete(editingId);
    if (reply.ok) loadProfile(models.find(item => item.id !== editingId)?.id ?? 'new');
    else setMessage({ text: reply.error.message, ok: false });
    setBusy(undefined);
  }

  async function test() {
    setBusy('test');
    setMessage(undefined);
    setTestResult('');
    const reply = await onTest();
    if (reply.ok) setTestResult(reply.value.text);
    else setMessage({ text: reply.error.message, ok: false });
    setBusy(undefined);
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget && !active) onClose();
    }}>
      <section className="modal model-modal" role="dialog" aria-modal="true" aria-label="模型设置">
        <header className="modal-header">
          <h2>模型设置</h2>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>×</button>
        </header>
        <div className="model-layout">
          <nav className="model-list" aria-label="已保存的模型">
            {models.map(item => (
              <button key={item.id} className={`model-item ${item.id === editingId ? 'selected' : ''}`} aria-pressed={item.id === editingId} disabled={active} onClick={() => loadProfile(item.id)}>
                <span className="model-item-name">{item.name}{item.id === model?.id && <em>当前</em>}</span>
                <small>{item.provider ? `${item.provider} · ` : ''}{item.modelId}</small>
                <small className={item.hasApiKey ? 'key-ok' : 'key-missing'}>{item.hasApiKey ? '密钥已配置' : '未配置密钥'}</small>
              </button>
            ))}
            <button className={`model-item new-model ${editingId === 'new' ? 'selected' : ''}`} disabled={active} onClick={() => loadProfile('new')}>＋ 新建模型</button>
          </nav>
          <div className="form-body">
            <div className="field-pair">
              <label>名称<input value={draft.name} onChange={event => change({ name: event.target.value })} placeholder="默认同 Model ID" disabled={active} /></label>
              <label>服务商<input value={draft.provider} onChange={event => change({ provider: event.target.value })} placeholder="如 DeepSeek" disabled={active} /></label>
            </div>
            <label>Base URL<input value={draft.baseUrl} onChange={event => change({ baseUrl: event.target.value })} placeholder="https://api.example.com/v1" disabled={active} /></label>
            <label>Model ID<input value={draft.modelId} onChange={event => change({ modelId: event.target.value })} placeholder="模型标识" disabled={active} /></label>
            <label>API Key<input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={editing?.hasApiKey ? '已保存密钥，输入以替换' : '输入 API Key'} disabled={active || removeKey || Boolean(reuseId)} autoComplete="off" /></label>
            {!editing?.hasApiKey && donors.length > 0 && (
              <label>密钥来源
                <select value={reuseId} onChange={event => setKeySource(event.target.value)} disabled={active}>
                  <option value="">输入新密钥</option>
                  {donors.map(item => <option key={item.id} value={item.id}>沿用「{item.name}」的密钥</option>)}
                </select>
              </label>
            )}
            {editing?.hasApiKey && <label className="checkbox-label"><input type="checkbox" checked={removeKey} onChange={event => setRemoveKey(event.target.checked)} disabled={active} />移除已保存密钥</label>}
            <details className="advanced-settings">
              <summary>更多</summary>
              <div className="budget-fields">
                <label>上下文预算<input type="number" min="1" value={draft.contextWindow} onChange={event => change({ contextWindow: Number(event.target.value) })} disabled={active} /></label>
                <label>输出预算<input type="number" min="1" value={draft.maxOutputTokens} onChange={event => change({ maxOutputTokens: Number(event.target.value) })} disabled={active} /></label>
              </div>
            </details>
            {message && <p className={`settings-message ${message.ok ? 'ok' : ''}`} role={message.ok ? 'status' : 'alert'}>{message.text}</p>}
            {testResult && <pre className="test-result">{testResult}</pre>}
          </div>
        </div>
        <footer className="modal-footer">
          {active ? <button className="danger-button" onClick={onCancel}>取消执行</button> : (
            <div>
              <button className="secondary" onClick={test} disabled={editingId !== model?.id || Boolean(busy)}>测试连接</button>
              {editing && <button className="danger-button" onClick={remove} disabled={Boolean(busy)}>{confirmDelete ? '确认删除' : '删除'}</button>}
            </div>
          )}
          <div>
            <button className="secondary" onClick={onClose}>关闭</button>
            <button className="primary" onClick={save} disabled={active || Boolean(busy)}>{busy === 'save' ? '保存中…' : '保存'}</button>
          </div>
        </footer>
      </section>
    </div>
  );
}
