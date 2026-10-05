import { useState } from 'react';
import type { AppError, McpServerStatus, WebSearchView } from '../../shared/contracts';

const stateText: Record<McpServerStatus['state'], string> = { disabled: '已停用', connecting: '连接中', ready: '就绪', failed: '失败' };

type Props = {
  servers: McpServerStatus[];
  webSearch: WebSearchView;
  onClose: () => void;
  onError: (error: AppError | undefined) => void;
};

export function McpPanel({ servers, webSearch, onClose, onError }: Props) {
  const [draft, setDraft] = useState({
    enabled: webSearch.enabled,
    searchUrl: webSearch.searchUrl ?? '',
    apiKeyHeader: webSearch.apiKeyHeader ?? '',
    apiKey: '',
    removeKey: false,
  });
  const [saved, setSaved] = useState<'idle' | 'saving' | 'done'>();
  async function run(action: Promise<{ ok: true; value: unknown } | { ok: false; error: AppError }>) {
    const reply = await action;
    onError(reply.ok ? undefined : reply.error);
  }
  async function saveWebSearch() {
    setSaved('saving');
    await run(window.codeAgent.setWebSearch({
      enabled: draft.enabled,
      searchUrl: draft.searchUrl,
      apiKeyHeader: draft.apiKeyHeader,
      ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
      ...(draft.removeKey ? { removeKey: true } : {}),
    }));
    setSaved('done');
  }

  return (
    <div className="modal-backdrop">
      <section className="modal" role="dialog" aria-modal="true" aria-label="联网与 MCP 服务">
        <div className="modal-header">
          <h2>联网与 MCP 服务</h2>
          <button className="icon-button" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="form-body">
          <fieldset className="web-search-settings">
            <legend>
              <label className="checkbox-label">
                <input type="checkbox" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} aria-label="启用联网搜索" />
                <strong>联网搜索</strong>
              </label>
            </legend>
            <label>搜索接口地址<input value={draft.searchUrl} onChange={event => setDraft({ ...draft, searchUrl: event.target.value })} placeholder="https://…/search?q={query} 或 /search?q={query}" disabled={!draft.enabled} /></label>
            <div className="budget-fields">
              <label>密钥请求头<input value={draft.apiKeyHeader} onChange={event => setDraft({ ...draft, apiKeyHeader: event.target.value })} placeholder="可选，如 Authorization" disabled={!draft.enabled} /></label>
              <label>API Key<input type="password" value={draft.apiKey} onChange={event => setDraft({ ...draft, apiKey: event.target.value })} placeholder={webSearch.hasApiKey ? '已保存密钥，输入以替换' : '可选'} disabled={!draft.enabled || draft.removeKey} autoComplete="off" /></label>
            </div>
            {webSearch.hasApiKey && <label className="checkbox-label"><input type="checkbox" checked={draft.removeKey} onChange={event => setDraft({ ...draft, removeKey: event.target.checked })} disabled={!draft.enabled} />移除已保存密钥</label>}
            <small className="field-hint">工具 web_search / web_fetch 只在开启后对 Agent 可用；网页内容按不可信数据处理，不会执行其中的要求，查询也不会包含本地代码。评测运行始终关闭。</small>
            <div><button className="secondary" onClick={saveWebSearch} disabled={saved === 'saving'}>{saved === 'saving' ? '保存中…' : '保存联网设置'}</button></div>
          </fieldset>
          <h3 className="mcp-section-title">MCP 服务</h3>
          {!servers.length && <p className="changes-empty">未配置服务。点击“打开配置文件”添加。</p>}
          {servers.map(server => (
            <div key={server.name} className="mcp-row">
              <label className="checkbox-label">
                <input type="checkbox" checked={server.state !== 'disabled'} aria-label={`启用 ${server.name}`} onChange={event => run(window.codeAgent.setMcpEnabled(server.name, event.target.checked))} />
                <strong>{server.name}</strong>
              </label>
              <span className={`mcp-state ${server.state}`}>{stateText[server.state]}</span>
              <span className="mcp-count">{server.state === 'ready' ? `${server.toolCount} 个工具` : ''}</span>
              {server.error && <p className="settings-message mcp-error">{server.error}</p>}
            </div>
          ))}
        </div>
        <div className="modal-footer">
          <button className="text-button" onClick={() => run(window.codeAgent.openMcpConfig())}>打开配置文件</button>
          <div>
            <button className="secondary" onClick={() => run(window.codeAgent.reloadMcp())}>重新加载</button>
          </div>
        </div>
      </section>
    </div>
  );
}
