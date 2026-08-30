import type { ApprovalDecision, ApprovalRequest, TimelineItem, ToolItem } from '../../shared/contracts';

type Props = {
  timeline: TimelineItem[];
  approval?: ApprovalRequest;
  active: boolean;
  onDecide: (id: string, decision: ApprovalDecision) => void;
};

const stateText: Record<string, string> = {
  requested: '等待执行',
  awaiting_approval: '等待批准',
  running: '执行中',
  succeeded: '已完成',
  failed: '失败',
  denied: '已拒绝',
  cancelled: '已取消',
};
const toolTitles: Record<string, string> = {
  read: '读取文件', grep: '搜索内容', find: '查找文件', ls: '列出目录', edit: '编辑文件', write: '写入文件', powershell: 'PowerShell', git: 'Git 查询',
};
const toolIcons: Record<string, string> = { read: '↧', grep: '⌕', find: '⌕', ls: '☰', edit: '✎', write: '✎', git: '⑂' };

export function Conversation({ timeline, approval, active, onDecide }: Props) {
  if (!timeline.length) {
    return (
      <section className="empty-state">
        <div className="empty-mark">⌘</div>
        <h1>开始一个任务</h1>
        <p>添加本地目录，让 Agent 读取、修改并在批准后执行命令。</p>
      </section>
    );
  }
  return (
    <section className="conversation" aria-live="polite">
      {timeline.map(item => item.kind === 'message' ? (
        <article key={item.id} className={`message ${item.role}`}>
          <div className="message-role">{item.role === 'user' ? '你' : 'Agent'}</div>
          <div className="message-content">
            {item.text ? <pre>{item.text}</pre> : item.role === 'assistant' && active ? <span className="pending-text">正在响应…</span> : null}
          </div>
        </article>
      ) : <ToolCard key={item.toolCallId} item={item} />)}
      {approval && (
        <article className="approval-card">
          <strong>批准 {toolTitles[approval.tool] ?? approval.summary}</strong>
          <p className="approval-cwd">{approval.rootAlias ? `目录：${approval.rootAlias} · ` : ''}{approval.cwd}</p>
          <pre>{approval.summary}</pre>
          {approval.tool !== 'powershell' && approval.argsText !== approval.summary && (
            <details><summary>完整参数</summary><pre>{approval.argsText}</pre></details>
          )}
          {approval.runner === 'sandbox' && <p className="approval-note">将在沙箱内运行：仅所选目录可写。</p>}
          {approval.runner === 'direct' && <p className="approval-warning">将以当前 Windows 用户权限运行，可访问项目外资源。</p>}
          <div className="approval-actions">
            <button className="secondary" onClick={() => onDecide(approval.id, 'deny')}>拒绝</button>
            {approval.grantKey && <button className="secondary" onClick={() => onDecide(approval.id, 'allow_task')}>允许本任务</button>}
            <button className="primary" onClick={() => onDecide(approval.id, 'allow')}>允许本次</button>
          </div>
        </article>
      )}
    </section>
  );
}

function ToolCard({ item }: { item: ToolItem }) {
  const title = item.source ? `MCP · ${item.source.mcpServer}.${item.source.tool}` : toolTitles[item.name] ?? item.name;
  const target = item.name === 'powershell' ? item.cwd : argPath(item.args);
  return (
    <article className={`tool-card ${item.state}`}>
      <div className="tool-heading">
        <span className="tool-icon">{item.name === 'powershell' ? '›_' : toolIcons[item.name] ?? 'MCP'}</span>
        <strong>{title}</strong>
        {item.rootAlias && <span className="tool-root">{item.rootAlias}</span>}
        <span className="tool-target">{target}</span>
        {item.runner && <span className="tool-runner">{item.runner === 'sandbox' ? '沙箱' : '直接'}</span>}
        {item.durationMs !== undefined && <span className="tool-state">{formatDuration(item.durationMs)}</span>}
        <span className="tool-state">{stateText[item.state]}</span>
      </div>
      {(item.output || item.exitCode !== undefined || item.error) && (
        <details className="tool-output" open={item.state === 'failed'}>
          <summary>执行结果{item.exitCode !== undefined ? ` · 退出码 ${item.exitCode}` : ''}</summary>
          {item.output && <pre>{item.output}</pre>}
          {item.error && <p className="tool-error">{item.error.message}</p>}
        </details>
      )}
    </article>
  );
}

function argPath(args: unknown): string {
  if (args && typeof args === 'object' && 'path' in args && typeof args.path === 'string') return args.path;
  return '';
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
