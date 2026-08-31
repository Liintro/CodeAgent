import type { Delivery, WorkbenchSnapshot } from '../../shared/contracts';

export const deliveryText: Record<Delivery, string> = {
  none: '', unverified: '未验证', verifying: '验证中', verified: '已验证', verification_failed: '验证未通过', accepted: '已接受', restored: '已还原',
};

type Props = {
  view: WorkbenchSnapshot;
  active: boolean;
  ready: boolean;
  onNewTask: () => void;
  onSelect: (id: string) => void;
  onSettings: () => void;
  onMcp: () => void;
};

export function Sidebar({ view, active, ready, onNewTask, onSelect, onSettings, onMcp }: Props) {
  const readyServers = view.mcp.filter(item => item.state === 'ready').length;
  return (
    <aside className="sidebar">
      <div className="sidebar-brand"><span className="brand-mark">⌘</span>CodeAgent</div>
      <button className="new-chat-button" onClick={onNewTask} disabled={active || !ready}><span>＋</span> 新任务</button>
      <nav className="conversation-list" aria-label="任务列表">
        {view.tasks.map(task => {
          const status = task.interrupted ? 'interrupted' : task.delivery;
          const text = task.interrupted ? '已中断' : deliveryText[task.delivery];
          return (
            <button
              key={task.id}
              className={`conversation-link ${task.id === view.taskId ? 'current' : ''}`}
              title={task.title}
              disabled={active}
              onClick={() => onSelect(task.id)}
            >
              <span className="task-title">{task.title}</span>
              {text && <span className={`task-status ${status}`}>{text}</span>}
            </button>
          );
        })}
      </nav>
      <div className="sidebar-footer">
        <button className="sidebar-action" onClick={onSettings}>模型设置</button>
        <button className="sidebar-action" onClick={onMcp}>MCP{view.mcp.length ? ` ${readyServers}/${view.mcp.length}` : ''}</button>
        <span className="model-name" title={view.model?.modelId}>{view.model?.modelId ?? '未配置模型'}</span>
      </div>
    </aside>
  );
}
