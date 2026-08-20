import type { ApprovalRequest, TimelineItem } from '../../shared/contracts';

type Props = {
  timeline: TimelineItem[];
  approval?: ApprovalRequest;
  active: boolean;
  onDecide: (id: string, decision: 'allow' | 'deny') => void;
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

export function Conversation({ timeline, approval, active, onDecide }: Props) {
  if (!timeline.length) {
    return (
      <section className="empty-state">
        <div className="empty-mark">⌘</div>
        <h1>开始一个对话</h1>
        <p>可选择本地项目，让 Agent 读取文件并执行经批准的命令。</p>
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
      ) : (
        <article key={item.toolCallId} className={`tool-card ${item.state}`}>
          <div className="tool-heading">
            <span className="tool-icon">{item.name === 'read' ? '↧' : '›_'}</span>
            <strong>{item.name === 'read' ? '读取文件' : 'PowerShell'}</strong>
            <span className="tool-target">{item.name === 'read' ? readPath(item.args) : item.cwd}</span>
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
      ))}
      {approval && (
        <article className="approval-card">
          <strong>批准本次 PowerShell 执行</strong>
          <p className="approval-cwd">工作目录：{approval.cwd}</p>
          <pre>{approval.command}</pre>
          <p className="approval-warning">将以当前 Windows 用户权限运行，可访问项目外资源。</p>
          <div className="approval-actions">
            <button className="secondary" onClick={() => onDecide(approval.id, 'deny')}>拒绝</button>
            <button className="primary" onClick={() => onDecide(approval.id, 'allow')}>允许本次</button>
          </div>
        </article>
      )}
    </section>
  );
}

function readPath(args: unknown): string {
  if (args && typeof args === 'object' && 'path' in args && typeof args.path === 'string') return args.path;
  return '';
}
