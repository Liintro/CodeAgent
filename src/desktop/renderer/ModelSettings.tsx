import { useState } from 'react';
import type { KeyChange, ModelInput, ModelProfile, Reply } from '../../shared/contracts';

type Props = {
  model?: ModelProfile;
  active: boolean;
  onClose: () => void;
  onSave: (profile: ModelInput, keyChange: KeyChange) => Promise<Reply<ModelProfile>>;
  onTest: () => Promise<Reply<{ text: string }>>;
  onCancel: () => void;
};

export function ModelSettings({ model, active, onClose, onSave, onTest, onCancel }: Props) {
  const [baseUrl, setBaseUrl] = useState(model?.baseUrl ?? '');
  const [modelId, setModelId] = useState(model?.modelId ?? '');
  const [contextWindow, setContextWindow] = useState(model?.contextWindow ?? 32000);
  const [maxOutputTokens, setMaxOutputTokens] = useState(model?.maxOutputTokens ?? 2048);
  const [apiKey, setApiKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState('');
  const [testResult, setTestResult] = useState('');

  async function save() {
    setSaving(true);
    setMessage('');
    const keyChange: KeyChange = removeKey ? { action: 'remove' } : apiKey ? { action: 'replace', value: apiKey } : { action: 'keep' };
    const reply = await onSave({
      id: model?.id ?? 'default',
      api: 'openai-completions',
      baseUrl,
      modelId,
      contextWindow,
      maxOutputTokens,
      reasoning: false,
    }, keyChange);
    if (reply.ok) {
      setApiKey('');
      setRemoveKey(false);
      setMessage('设置已保存');
      setTestResult('');
    } else setMessage(reply.error.message);
    setSaving(false);
  }

  async function test() {
    setTesting(true);
    setMessage('');
    setTestResult('');
    const reply = await onTest();
    if (reply.ok) setTestResult(reply.value.text);
    else setMessage(reply.error.message);
    setTesting(false);
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget && !active) onClose();
    }}>
      <section className="modal" role="dialog" aria-modal="true" aria-label="模型设置">
        <header className="modal-header">
          <h2>模型设置</h2>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>×</button>
        </header>
        <div className="form-body">
          <label>Base URL<input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" disabled={active} /></label>
          <label>Model ID<input value={modelId} onChange={event => setModelId(event.target.value)} placeholder="模型标识" disabled={active} /></label>
          <label>API Key<input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={model?.hasApiKey ? '已保存密钥，输入以替换' : '输入 API Key'} disabled={active || removeKey} autoComplete="off" /></label>
          {model?.hasApiKey && <label className="checkbox-label"><input type="checkbox" checked={removeKey} onChange={event => setRemoveKey(event.target.checked)} disabled={active} />移除已保存密钥</label>}
          <details className="advanced-settings">
            <summary>更多</summary>
            <div className="budget-fields">
              <label>上下文预算<input type="number" min="1" value={contextWindow} onChange={event => setContextWindow(Number(event.target.value))} disabled={active} /></label>
              <label>输出预算<input type="number" min="1" value={maxOutputTokens} onChange={event => setMaxOutputTokens(Number(event.target.value))} disabled={active} /></label>
            </div>
          </details>
          {message && <p className="settings-message" role="alert">{message}</p>}
          {testResult && <pre className="test-result">{testResult}</pre>}
        </div>
        <footer className="modal-footer">
          {active ? <button className="danger-button" onClick={onCancel}>取消执行</button> : <button className="secondary" onClick={test} disabled={!model || testing}>测试连接</button>}
          <div>
            <button className="secondary" onClick={onClose}>关闭</button>
            <button className="primary" onClick={save} disabled={active || saving}>保存</button>
          </div>
        </footer>
      </section>
    </div>
  );
}
