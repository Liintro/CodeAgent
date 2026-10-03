import type { Delivery, TaskSummary, WorkbenchSnapshot } from '../../shared/contracts';

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

const NO_PROJECT = '未选择目录';

// 按主目录分组，组的顺序跟随组内最近更新的任务。
function groupByProject(tasks: TaskSummary[]): [string, TaskSummary[]][] {
  const groups = new Map<string, TaskSummary[]>();
  for (const task of tasks) {
    const key = task.project ?? NO_PROJECT;
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  return [...groups];
}

export function Sidebar({ view, active, ready, onNewTask, onSelect, onSettings, onMcp }: Props) {
  const readyServers = view.mcp.filter(item => item.state === 'ready').length;
  return (
    <aside className="sidebar">
      <div className="sidebar-brand"><span className="brand-mark">⌘</span>CodeAgent</div>
      <nav className="sidebar-nav" aria-label="操作">
        <button className="nav-item new-chat-button" onClick={onNewTask} disabled={active || !ready}><span className="nav-icon" aria-hidden="true">＋</span>新任务</button>
        <button className="nav-item" onClick={onSettings}><span className="nav-icon" aria-hidden="true">⚙</span>模型设置</button>
        <button className="nav-item" onClick={onMcp}><span className="nav-icon" aria-hidden="true">⧉</span>MCP{view.mcp.length ? ` ${readyServers}/${view.mcp.length}` : ''}</button>
      </nav>
      <nav className="conversation-list" aria-label="任务列表">
        {groupByProject(view.tasks).map(([project, tasks]) => (
          <section key={project} className="task-group">
            <h2 className="task-group-title" title={project}>{project}</h2>
            {tasks.map(task => {
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
          </section>
        ))}
      </nav>
      <div className="sidebar-footer">
        <span className="model-name" title={view.model?.modelId}>{view.model?.name ?? '未配置模型'}</span>
      </div>
    </aside>
  );
}
