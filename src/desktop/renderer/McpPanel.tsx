import type { AppError, McpServerStatus } from '../../shared/contracts';

const stateText: Record<McpServerStatus['state'], string> = { disabled: '已停用', connecting: '连接中', ready: '就绪', failed: '失败' };

type Props = { servers: McpServerStatus[]; onClose: () => void; onError: (error: AppError | undefined) => void };

export function McpPanel({ servers, onClose, onError }: Props) {
  async function run(action: Promise<{ ok: true; value: unknown } | { ok: false; error: AppError }>) {
    const reply = await action;
    onError(reply.ok ? undefined : reply.error);
  }

  return (
    <div className="modal-backdrop">
      <section className="modal" role="dialog" aria-modal="true" aria-label="MCP 服务">
        <div className="modal-header">
          <h2>MCP 服务</h2>
          <button className="icon-button" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="form-body">
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
