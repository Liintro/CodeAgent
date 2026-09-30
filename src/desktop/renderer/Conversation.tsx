import { memo, useEffect, useRef } from 'react';
import type { ApprovalDecision, ApprovalRequest, TimelineItem, ToolItem, VerificationItem } from '../../shared/contracts';
import { kindText, validityText } from './MemoryPanel';

type Props = {
  timeline: TimelineItem[];
  approval?: ApprovalRequest;
  active: boolean;
  onDecide: (id: string, decision: ApprovalDecision) => void;
};

const stateText: Record<string, string> = {
  requested: '等待执行', awaiting_approval: '等待批准', running: '执行中', succeeded: '已完成', failed: '失败', denied: '已拒绝', cancelled: '已取消', unknown: '结果未知',
};
const verificationText: Record<VerificationItem['state'], string> = {
  running: '验证中', passed: '通过', failed: '未通过', timeout: '超时', cancelled: '已取消', unavailable: '未能执行',
};
const toolTitles: Record<string, string> = {
  read: '读取文件', grep: '搜索内容', find: '查找文件', ls: '列出目录', edit: '编辑文件', write: '写入文件', powershell: 'PowerShell', git: 'Git 查询',
  doc_outline: '文档结构', doc_read: '读取文档', doc_view: '查看文档图像', code_outline: '代码结构', find_symbol: '查找定义', related_files: '相关文件',
};
const toolIcons: Record<string, string> = { read: '↧', grep: '⌕', find: '⌕', ls: '☰', edit: '✎', write: '✎', git: '⑂', powershell: '›_', doc_outline: '▤', doc_read: '▤', doc_view: '◧', code_outline: '≡', find_symbol: '⌕', related_files: '⇄' };

export function Conversation({ timeline, approval, active, onDecide }: Props) {
  const scroller = useRef<HTMLElement>(null);
  const stick = useRef(true);

  // 只有用户本来就停在底部时才跟随输出；向上翻阅历史时不抢滚动位置。
  useEffect(() => {
    const element = scroller.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [timeline, approval]);

  const lastIndex = timeline.length - 1;
  return (
    <section
      className="conversation"
      aria-live="polite"
      ref={scroller}
      onScroll={event => {
        const element = event.currentTarget;
        stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      }}
    >
      <div className="conversation-inner">
        {timeline.map((item, index) => <Row key={item.kind === 'tool' ? item.toolCallId : item.id} item={item} pending={active && index === lastIndex} />)}
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
      </div>
    </section>
  );
}

const Row = memo(function Row({ item, pending }: { item: TimelineItem; pending: boolean }) {
  if (item.kind === 'tool') return <ToolCard item={item} />;
  if (item.kind === 'verification') return <VerificationCard item={item} />;
  if (item.kind === 'notice') return <div className="notice"><span>{item.text}</span></div>;
  if (item.kind === 'memory') {
    return (
      <details className="harness-note memory-note">
        <summary>已引用 {item.items.length} 条记忆</summary>
        {item.items.map(entry => (
          <p key={entry.id}><span className="tag">{kindText[entry.kind]}</span> <span className={`delivery-chip validity-${entry.validity}`}>{validityText[entry.validity]}</span> {entry.text}</p>
        ))}
      </details>
    );
  }
  if (item.harness) {
    const recovery = item.text.startsWith('[任务恢复说明]');
    return (
      <details className="harness-note">
        <summary>{recovery ? '任务恢复说明（系统生成）' : '自动验证反馈（系统生成）'}</summary>
        <pre>{item.text}</pre>
      </details>
    );
  }
  return (
    <article className={`message ${item.role}`}>
      {item.role === 'assistant' && <span className="avatar" aria-hidden="true">A</span>}
      <div className="message-content">
        {item.text ? <pre>{item.text}</pre> : item.role === 'assistant' && pending ? <span className="pending-text">正在响应…</span> : null}
      </div>
    </article>
  );
});

const ToolCard = memo(function ToolCard({ item }: { item: ToolItem }) {
  const title = item.source ? `MCP · ${item.source.mcpServer}.${item.source.tool}` : toolTitles[item.name] ?? item.name;
  const target = item.name === 'powershell' ? item.cwd : argPath(item.args);
  const hasDetail = Boolean(item.output || item.exitCode !== undefined || item.error);
  return (
    <article className={`tool-card ${item.state}`}>
      <div className="tool-heading">
        <span className="tool-icon">{toolIcons[item.name] ?? 'MCP'}</span>
        <strong>{title}</strong>
        {item.rootAlias && <span className="tag">{item.rootAlias}</span>}
        <span className="tool-target" title={target}>{target}</span>
        {item.runner && <span className="tag">{item.runner === 'sandbox' ? '沙箱' : '直接'}</span>}
        {item.durationMs !== undefined && <span className="tool-meta">{formatDuration(item.durationMs)}</span>}
        <span className={`state-chip ${item.state}`}>{stateText[item.state]}</span>
      </div>
      {hasDetail && (
        <details className="tool-output" open={item.state === 'failed'}>
          <summary>执行结果{item.exitCode !== undefined ? ` · 退出码 ${item.exitCode}` : ''}</summary>
          {item.output && <pre>{item.output}</pre>}
          {item.error && <p className="tool-error">{item.error.message}</p>}
        </details>
      )}
    </article>
  );
});

const VerificationCard = memo(function VerificationCard({ item }: { item: VerificationItem }) {
  return (
    <article className={`verification-card ${item.state}`}>
      <div className="tool-heading">
        <span className="tool-icon">✓</span>
        <strong>验证 · {item.commandLabel}</strong>
        <span className="tag">{item.rootAlias}</span>
        <span className="tool-target" title={item.command}>{item.command}</span>
        {item.attempt > 0 && <span className="tag">修复 {item.attempt}</span>}
        {item.durationMs !== undefined && <span className="tool-meta">{formatDuration(item.durationMs)}</span>}
        <span className={`state-chip ${item.state === 'passed' ? 'succeeded' : item.state === 'running' ? 'running' : 'failed'}`}>{verificationText[item.state]}</span>
      </div>
      {item.failure && (
        <ul className="failure-list" aria-label="解析出的失败">
          {item.failure.tests.map(name => <li key={`t:${name}`}>测试 <code>{name}</code></li>)}
          {item.failure.diagnostics.map((entry, index) => <li key={`d:${index}`}><code>{entry.file}:{entry.line}</code> {entry.message}</li>)}
        </ul>
      )}
      {item.state !== 'running' && item.outputTail && (
        <details className="tool-output" open={item.state !== 'passed' && !item.failure}>
          <summary>{item.exitCode !== undefined ? `退出码 ${item.exitCode} · ` : ''}输出末尾{item.logFile ? '（完整日志已保存）' : ''}</summary>
          <pre>{item.outputTail}</pre>
        </details>
      )}
    </article>
  );
});

function argPath(args: unknown): string {
  if (args && typeof args === 'object' && 'path' in args && typeof args.path === 'string') return args.path;
  return '';
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
