import { useCallback, useEffect, useState } from 'react';
import type { AppError, ApprovalDecision, KeyChange, ModelInput, SnapshotEnvelope, UserMode, WorkbenchEvent } from '../../shared/contracts';
import { Composer } from './Composer';
import { Conversation } from './Conversation';
import { McpPanel } from './McpPanel';
import { ModelSettings } from './ModelSettings';
import { SidePanel, type PanelTab } from './SidePanel';
import { Sidebar } from './Sidebar';

const initial: SnapshotEnvelope = {
  hostInstanceId: '',
  seq: 0,
  value: {
    host: 'starting', models: [], tasks: [], roots: [], timeline: [], mcp: [], sandboxStatus: 'untested', acceptance: { commands: [], maxRepairs: 3 },
    permission: { userMode: 'manual', phase: 'act', approval: 'ask_writes_and_commands', scope: 'selected_roots', grants: [] },
  },
};
export const activePhases = ['running', 'awaiting_approval', 'verifying', 'cancelling'];
const terminalPhases = ['finished', 'failed', 'cancelled', 'interrupted'];

export default function App() {
  const [snapshot, setSnapshot] = useState(initial);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [panel, setPanel] = useState<PanelTab>();
  const [actionError, setActionError] = useState<AppError>();
  const view = snapshot.value;
  const active = Boolean(view.run && activePhases.includes(view.run.phase));
  const ready = view.host === 'ready';

  useEffect(() => {
    // 流式输出事件很密：同一帧内到达的事件合并成一次状态更新，界面在长任务里保持流畅。
    const buffered: WorkbenchEvent[] = [];
    let subscribed = false;
    let frame = 0;
    const flush = () => {
      frame = 0;
      const batch = buffered.splice(0);
      if (batch.length) setSnapshot(current => batch.reduce(applyEvent, current));
    };
    const unsubscribe = window.codeAgent.onEvent(event => {
      buffered.push(event);
      if (subscribed && !frame) frame = requestAnimationFrame(flush);
    });
    void window.codeAgent.getSnapshot().then(reply => {
      if (!reply.ok) {
        setActionError(reply.error);
        return;
      }
      subscribed = true;
      setSnapshot(buffered.splice(0).reduce(applyEvent, reply.value));
    });
    return () => {
      unsubscribe();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  const call = useCallback(async <T,>(action: Promise<{ ok: true; value: T } | { ok: false; error: AppError }>): Promise<T | undefined> => {
    const reply = await action;
    if (!reply.ok) {
      setActionError(reply.error);
      return undefined;
    }
    setActionError(undefined);
    return reply.value;
  }, []);

  async function send(text: string): Promise<boolean> {
    setActionError(undefined);
    const reply = await window.codeAgent.startMessage(text);
    if (reply.ok) return true;
    setActionError(reply.error);
    if (!view.model) setSettingsOpen(true);
    return false;
  }

  async function saveModel(profile: ModelInput, keyChange: KeyChange) {
    const reply = await window.codeAgent.saveModel(profile, keyChange);
    setActionError(reply.ok ? undefined : reply.error);
    return reply;
  }

  const deleteModel = (modelId: string) => window.codeAgent.deleteModel(modelId);

  const cancel = async () => {
    if (view.run) await call(window.codeAgent.cancelRun(view.run.id));
  };
  const changeCount = view.changes?.roots.reduce((sum, root) => sum + (root.git ? root.files.length : 0), 0) ?? 0;
  const togglePanel = (tab: PanelTab) => setPanel(current => current === tab ? undefined : tab);
  const error = actionError ?? view.error;

  return (
    <div className="app-shell">
      <Sidebar
        view={view}
        active={active}
        ready={ready}
        onNewTask={() => call(window.codeAgent.newTask())}
        onSelect={id => call(window.codeAgent.selectTask(id))}
        onSettings={() => setSettingsOpen(true)}
        onMcp={() => setMcpOpen(true)}
      />

      <main className="workbench">
        <header className="topbar">
          <div className="root-chips" aria-label="工作目录">
            {view.roots.map(root => (
              <span key={root.id} className={`root-chip ${root.primary ? 'primary-root' : ''} ${root.missing ? 'missing-root' : ''}`} title={root.path}>
                <button className="chip-name" disabled={active || root.primary} onClick={() => call(window.codeAgent.setPrimaryRoot(root.id))} aria-label={`设为主目录 ${root.alias}`}>
                  {root.alias}
                </button>
                <small>{root.missing ? '目录不存在' : root.git ? (root.git.branch ?? '无分支') : '非 Git'}</small>
                <button className="chip-remove" disabled={active} onClick={() => call(window.codeAgent.removeRoot(root.id))} aria-label={`移除目录 ${root.alias}`}>×</button>
              </span>
            ))}
            {!view.roots.length && <span className="no-root">未选择目录</span>}
            <button className="ghost-button" onClick={() => call(window.codeAgent.addRoot())} disabled={active || !ready}>＋ 添加目录</button>
          </div>
          {view.models.length > 1 && (
            <select className="model-select" aria-label="切换模型" value={view.model?.id} disabled={active} onChange={event => call(window.codeAgent.selectModel(event.target.value))}>
              {view.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
            </select>
          )}
          <button className="ghost-button" aria-label="验收面板" aria-pressed={panel === 'acceptance'} onClick={() => togglePanel('acceptance')}>验收</button>
          <button className="ghost-button" aria-label="变更面板" aria-pressed={panel === 'changes'} onClick={() => togglePanel('changes')}>变更{changeCount ? ` ${changeCount}` : ''}</button>
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
            {(actionError ?? view.error) && <ErrorView error={(actionError ?? view.error)!} />}
            <Composer
              view={view}
              active={active}
              ready={ready}
              onSend={send}
              onCancel={cancel}
              onMode={mode => call(window.codeAgent.setPermission(mode as UserMode))}
              onImplement={() => call(window.codeAgent.implementPlan())}
              onContinue={() => call(window.codeAgent.continueTask())}
              onVerify={() => call(window.codeAgent.verifyNow())}
              onOpenPanel={setPanel}
            />
          </div>
          {panel && <SidePanel tab={panel} onTab={setPanel} view={view} active={active} call={call} onClose={() => setPanel(undefined)} />}
        </div>
      </main>

      {settingsOpen && (
        <ModelSettings
          model={view.model}
          models={view.models}
          active={active}
          onClose={() => setSettingsOpen(false)}
          onSave={saveModel}
          onDelete={deleteModel}
          onTest={() => window.codeAgent.testModel()}
          onCancel={cancel}
        />
      )}
      {mcpOpen && <McpPanel servers={view.mcp} onClose={() => setMcpOpen(false)} onError={setActionError} />}
    </div>
  );
}

function ErrorView({ error }: { error: AppError }) {
  return (
    <div className="error-banner" role="alert">
      <span>{error.message}</span>
      {error.detail && <details><summary>诊断详情</summary><pre>{error.detail}</pre></details>}
    </div>
  );
}

// 只复制发生变化的部分：未变化的时间线条目保持原对象，React 不会重绘它们。
function applyEvent(current: SnapshotEnvelope, event: WorkbenchEvent): SnapshotEnvelope {
  if (event.hostInstanceId === current.hostInstanceId && event.seq <= current.seq) return current;
  if (event.payload.type === 'snapshot') return { hostInstanceId: event.hostInstanceId, seq: event.seq, value: event.payload.value };
  if (event.hostInstanceId !== current.hostInstanceId) return current;
  const next = { ...current.value };
  const payload = event.payload;
  switch (payload.type) {
    case 'message.started':
      if (!next.timeline.some(item => item.kind === 'message' && item.id === payload.id)) {
        next.timeline = [...next.timeline, { kind: 'message', id: payload.id, role: payload.role, text: '' }];
      }
      break;
    case 'message.delta':
      next.timeline = next.timeline.map(item => item.kind === 'message' && item.id === payload.id ? { ...item, text: item.text + payload.text } : item);
      break;
    case 'message.ended':
      next.timeline = next.timeline.map(item => item.kind === 'message' && item.id === payload.id ? { ...item, text: payload.text } : item);
      break;
    case 'tool.updated': {
      const tool = payload.value;
      const index = next.timeline.findIndex(item => item.kind === 'tool' && item.toolCallId === tool.toolCallId);
      next.timeline = index < 0 ? [...next.timeline, tool] : next.timeline.map((item, position) => position === index ? tool : item);
      break;
    }
    case 'verification.updated': {
      const entry = payload.value;
      const index = next.timeline.findIndex(item => item.kind === 'verification' && item.id === entry.id);
      next.timeline = index < 0 ? [...next.timeline, entry] : next.timeline.map((item, position) => position === index ? entry : item);
      break;
    }
    case 'approval.requested':
      next.approval = payload.value;
      break;
    case 'run.changed':
      next.run = payload.value;
      if (terminalPhases.includes(payload.value.phase)) next.approval = undefined;
      break;
    case 'sandbox.updated':
      next.sandboxStatus = payload.value;
      break;
    case 'changes.updated':
      next.changes = payload.value;
      break;
    case 'delivery.updated':
      next.delivery = payload.value;
      break;
    case 'mcp.updated':
      next.mcp = payload.value;
      break;
    case 'error':
      next.error = payload.value;
      break;
  }
  return { hostInstanceId: event.hostInstanceId, seq: event.seq, value: next };
}

declare global {
  interface Window {
    codeAgent: import('../../shared/contracts').DesktopBridge;
  }
}
