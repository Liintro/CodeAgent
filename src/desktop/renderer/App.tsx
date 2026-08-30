import { useEffect, useRef, useState } from 'react';
import type { AppError, ApprovalDecision, KeyChange, ModelInput, SnapshotEnvelope, UserMode, WorkbenchEvent, WorkbenchSnapshot } from '../../shared/contracts';
import { ChangesPanel } from './ChangesPanel';
import { Conversation } from './Conversation';
import { McpPanel } from './McpPanel';
import { ModelSettings } from './ModelSettings';

const initial: SnapshotEnvelope = {
  hostInstanceId: '',
  seq: 0,
  value: {
    host: 'starting', models: [], tasks: [], roots: [], timeline: [], mcp: [], sandboxStatus: 'untested',
    permission: { userMode: 'manual', phase: 'act', approval: 'ask_writes_and_commands', scope: 'selected_roots', grants: [] },
  },
};
const activePhases = ['running', 'awaiting_approval', 'cancelling'];
const terminalPhases = ['finished', 'failed', 'cancelled', 'interrupted'];
const modes: { value: UserMode; label: string }[] = [
  { value: 'plan', label: '计划' },
  { value: 'manual', label: '手动' },
  { value: 'accept_edits', label: '接受编辑' },
  { value: 'auto', label: '自动' },
  { value: 'bypass', label: '绕过权限' },
];

export default function App() {
  const [snapshot, setSnapshot] = useState(initial);
  const [input, setInput] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [actionError, setActionError] = useState<AppError>();
  const timelineEnd = useRef<HTMLDivElement>(null);
  const view = snapshot.value;
  const active = Boolean(view.run && activePhases.includes(view.run.phase));
  const ready = view.host === 'ready';

  useEffect(() => {
    const buffered: WorkbenchEvent[] = [];
    let subscribed = false;
    const unsubscribe = window.codeAgent.onEvent(event => {
      if (!subscribed) buffered.push(event);
      else setSnapshot(current => applyEvent(current, event));
    });
    void window.codeAgent.getSnapshot().then(reply => {
      if (!reply.ok) {
        setActionError(reply.error);
        return;
      }
      subscribed = true;
      setSnapshot(buffered.reduce(applyEvent, reply.value));
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    timelineEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [view.timeline, view.approval]);

  async function call<T>(action: Promise<{ ok: true; value: T } | { ok: false; error: AppError }>): Promise<T | undefined> {
    const reply = await action;
    if (!reply.ok) {
      setActionError(reply.error);
      return undefined;
    }
    setActionError(undefined);
    return reply.value;
  }

  async function send() {
    const text = input.trim();
    if (!text || active) return;
    setActionError(undefined);
    const reply = await window.codeAgent.startMessage(text);
    if (reply.ok) setInput('');
    else {
      setActionError(reply.error);
      if (!view.model) setSettingsOpen(true);
    }
  }

  async function saveModel(profile: ModelInput, keyChange: KeyChange) {
    const reply = await window.codeAgent.saveModel(profile, keyChange);
    if (!reply.ok) setActionError(reply.error);
    else setActionError(undefined);
    return reply;
  }

  async function cancel() {
    if (view.run) await call(window.codeAgent.cancelRun(view.run.id));
  }

  const lastItem = view.timeline.at(-1);
  const canImplement = view.permission.userMode === 'plan' && !active && lastItem?.kind === 'message' && lastItem.role === 'assistant' && Boolean(lastItem.text);
  const changeCount = view.changes?.roots.reduce((sum, root) => sum + (root.git ? root.files.length : 0), 0) ?? 0;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">CodeAgent</div>
        <button className="new-chat-button" onClick={async () => { await call(window.codeAgent.newTask()); setInput(''); }} disabled={active || !ready}>
          <span>＋</span> 新任务
        </button>
        <nav className="conversation-list" aria-label="任务列表">
          {view.tasks.map(task => (
            <button
              key={task.id}
              className={`conversation-link ${task.id === view.taskId ? 'current' : ''}`}
              title={task.title}
              disabled={active}
              onClick={() => call(window.codeAgent.selectTask(task.id))}
            >{task.title}</button>
          ))}
        </nav>
        <div className="sidebar-footer">{view.model?.modelId ?? '未配置模型'}</div>
      </aside>

      <main className="workbench">
        <header className="topbar">
          <div className="root-chips" aria-label="工作目录">
            {view.roots.map(root => (
              <span key={root.id} className={`root-chip ${root.primary ? 'primary-root' : ''}`} title={root.path}>
                <button className="chip-name" disabled={active || root.primary} onClick={() => call(window.codeAgent.setPrimaryRoot(root.id))} aria-label={`设为主目录 ${root.alias}`}>
                  {root.alias}
                </button>
                <small>{root.git ? (root.git.branch ?? '无分支') : '非 Git'}</small>
                <button className="chip-remove" disabled={active} onClick={() => call(window.codeAgent.removeRoot(root.id))} aria-label={`移除目录 ${root.alias}`}>×</button>
              </span>
            ))}
            {!view.roots.length && <span className="no-root">未选择目录</span>}
          </div>
          <button className="secondary" onClick={() => call(window.codeAgent.addRoot())} disabled={active || !ready}>添加目录</button>
          <select
            className="mode-select"
            aria-label="权限模式"
            value={view.permission.userMode}
            disabled={active || !ready}
            onChange={event => call(window.codeAgent.setPermission(event.target.value as UserMode))}
          >
            {modes.map(mode => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
          </select>
          {view.permission.userMode !== 'plan' && <span className="runner-state" aria-label="命令运行方式">{runnerText(view)}</span>}
          {view.models.length > 0 && (
            <select
              className="model-select"
              aria-label="切换模型"
              value={view.model?.id}
              disabled={active}
              onChange={event => call(window.codeAgent.selectModel(event.target.value))}
            >
              {view.models.map(model => <option key={model.id} value={model.id}>{model.modelId}</option>)}
            </select>
          )}
          <button className="secondary" onClick={() => setMcpOpen(true)}>MCP{view.mcp.length ? ` ${view.mcp.filter(item => item.state === 'ready').length}/${view.mcp.length}` : ''}</button>
          <button className="secondary settings-button" onClick={() => setSettingsOpen(true)}>模型设置</button>
          <button className="secondary" aria-label="变更面板" aria-pressed={changesOpen} onClick={() => setChangesOpen(open => !open)}>变更{changeCount ? ` ${changeCount}` : ''}</button>
        </header>

        {view.host === 'failed' && (
          <div className="host-error">
            <span>运行进程已退出</span>
            <button className="secondary" onClick={() => call(window.codeAgent.restartHost())}>重启运行进程</button>
          </div>
        )}

        <div className="workbench-body">
          <div className="workbench-main">
            <Conversation
              timeline={view.timeline}
              approval={view.approval}
              active={active}
              onDecide={(id, decision: ApprovalDecision) => call(window.codeAgent.decideApproval(id, decision))}
            />
            <div ref={timelineEnd} />
            {canImplement && (
              <div className="plan-actions">
                <button className="primary" onClick={() => call(window.codeAgent.implementPlan())}>实施此计划</button>
              </div>
            )}
            {(actionError ?? view.error) && <ErrorView error={(actionError ?? view.error)!} />}
            <footer className="composer-area">
              <div className="composer">
                <textarea
                  aria-label="任务输入"
                  value={input}
                  onChange={event => setInput(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  placeholder="输入任务或问题……"
                  disabled={!ready}
                />
                <div className="composer-actions">
                  {active && <button className="danger-button" onClick={cancel}>取消</button>}
                  <button className="primary" onClick={send} disabled={!input.trim() || active || !ready}>发送</button>
                </div>
              </div>
            </footer>
          </div>
          {changesOpen && <ChangesPanel view={view} active={active} />}
        </div>
      </main>

      {settingsOpen && (
        <ModelSettings
          model={view.model}
          models={view.models}
          active={active}
          onClose={() => setSettingsOpen(false)}
          onSave={saveModel}
          onTest={() => window.codeAgent.testModel()}
          onCancel={cancel}
        />
      )}
      {mcpOpen && <McpPanel servers={view.mcp} onClose={() => setMcpOpen(false)} onError={setActionError} />}
    </div>
  );
}

function runnerText(view: WorkbenchSnapshot): string {
  const mode = view.permission.userMode;
  const sandboxed = view.sandboxStatus === 'available' && view.roots.length > 0 && view.roots.every(root => root.sandboxGranted);
  if (mode === 'bypass') return '命令直接运行';
  if (sandboxed) return '命令在沙箱内运行';
  if (mode === 'auto') return '沙箱不可用';
  return '命令直接运行（无沙箱）';
}

function ErrorView({ error }: { error: AppError }) {
  return (
    <div className="error-banner" role="alert">
      <span>{error.message}</span>
      {error.detail && <details><summary>诊断详情</summary><pre>{error.detail}</pre></details>}
    </div>
  );
}

function applyEvent(current: SnapshotEnvelope, event: WorkbenchEvent): SnapshotEnvelope {
  if (event.hostInstanceId === current.hostInstanceId && event.seq <= current.seq) return current;
  if (event.payload.type === 'snapshot') return { hostInstanceId: event.hostInstanceId, seq: event.seq, value: event.payload.value };
  if (event.hostInstanceId !== current.hostInstanceId) return current;
  const value = structuredClone(current.value);
  switch (event.payload.type) {
    case 'message.started': {
      const { id, role } = event.payload;
      if (!value.timeline.some(item => item.kind === 'message' && item.id === id)) {
        value.timeline.push({ kind: 'message', id, role, text: '' });
      }
      break;
    }
    case 'message.delta': {
      const { id, text } = event.payload;
      const item = value.timeline.find(item => item.kind === 'message' && item.id === id);
      if (item?.kind === 'message') item.text += text;
      break;
    }
    case 'message.ended': {
      const { id, text } = event.payload;
      const item = value.timeline.find(item => item.kind === 'message' && item.id === id);
      if (item?.kind === 'message') item.text = text;
      break;
    }
    case 'tool.updated': {
      const tool = event.payload.value;
      const index = value.timeline.findIndex(item => item.kind === 'tool' && item.toolCallId === tool.toolCallId);
      if (index < 0) value.timeline.push(tool);
      else value.timeline[index] = tool;
      break;
    }
    case 'approval.requested':
      value.approval = event.payload.value;
      break;
    case 'run.changed':
      value.run = event.payload.value;
      if (terminalPhases.includes(event.payload.value.phase)) value.approval = undefined;
      break;
    case 'sandbox.updated':
      value.sandboxStatus = event.payload.value;
      break;
    case 'changes.updated':
      value.changes = event.payload.value;
      break;
    case 'mcp.updated':
      value.mcp = event.payload.value;
      break;
    case 'error':
      value.error = event.payload.value;
      break;
  }
  return { hostInstanceId: event.hostInstanceId, seq: event.seq, value };
}

declare global {
  interface Window {
    codeAgent: import('../../shared/contracts').DesktopBridge;
  }
}
