import { useEffect, useRef, useState } from 'react';
import type { AppError, KeyChange, ModelInput, SnapshotEnvelope, WorkbenchEvent } from '../../shared/contracts';
import { Conversation } from './Conversation';
import { ModelSettings } from './ModelSettings';

const initial: SnapshotEnvelope = {
  hostInstanceId: '',
  seq: 0,
  value: { host: 'starting', models: [], timeline: [], conversations: [] },
};
const activePhases = ['running', 'awaiting_approval', 'cancelling'];

export default function App() {
  const [snapshot, setSnapshot] = useState(initial);
  const [input, setInput] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [actionError, setActionError] = useState<AppError>();
  const timelineEnd = useRef<HTMLDivElement>(null);
  const view = snapshot.value;
  const active = Boolean(view.invocation && activePhases.includes(view.invocation.phase));

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

  async function chooseProject() {
    const reply = await window.codeAgent.chooseProject();
    if (!reply.ok) setActionError(reply.error);
    else setActionError(undefined);
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

  async function newConversation() {
    const reply = await window.codeAgent.newConversation();
    if (!reply.ok) setActionError(reply.error);
    else {
      setActionError(undefined);
      setInput('');
    }
  }

  async function cancel() {
    if (!view.invocation) return;
    const reply = await window.codeAgent.cancelInvocation(view.invocation.id);
    if (!reply.ok) setActionError(reply.error);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">CodeAgent</div>
        <button className="new-chat-button" onClick={newConversation} disabled={active || view.host !== 'ready'}>
          <span>＋</span> 新对话
        </button>
        <nav className="conversation-list" aria-label="对话历史">
          {view.conversations.map(conversation => (
            <button
              key={conversation.id}
              className={`conversation-link ${conversation.id === view.conversationId ? 'current' : ''}`}
              title={conversation.title}
              disabled={active}
              onClick={async () => {
                const reply = await window.codeAgent.selectConversation(conversation.id);
                if (!reply.ok) setActionError(reply.error);
              }}
            >{conversation.title}</button>
          ))}
        </nav>
        <div className="sidebar-footer">{view.model?.modelId ?? '未配置模型'}</div>
      </aside>

      <main className="workbench">
        <header className="topbar">
          <button className="secondary" onClick={chooseProject} disabled={active || view.host !== 'ready'}>打开项目</button>
          <div className="workspace" title={view.root?.path}>
            <span>{view.root?.name ?? '未选择项目'}</span>
            {view.root && <small>{view.root.path}</small>}
          </div>
          {view.models.length > 0 && (
            <select
              className="model-select"
              aria-label="切换模型"
              value={view.model?.id}
              disabled={active}
              onChange={async event => {
                const reply = await window.codeAgent.selectModel(event.target.value);
                if (!reply.ok) setActionError(reply.error);
              }}
            >
              {view.models.map(model => <option key={model.id} value={model.id}>{model.modelId}</option>)}
            </select>
          )}
          <button className="secondary settings-button" onClick={() => setSettingsOpen(true)}>模型设置</button>
        </header>

        {view.host === 'failed' && (
          <div className="host-error">
            <span>运行进程已退出</span>
            <button className="secondary" onClick={async () => {
              const reply = await window.codeAgent.restartHost();
              if (!reply.ok) setActionError(reply.error);
            }}>重启运行进程</button>
          </div>
        )}

        <Conversation
          timeline={view.timeline}
          approval={view.approval}
          active={active}
          onDecide={async (id, decision) => {
            const reply = await window.codeAgent.decideApproval(id, decision);
            if (!reply.ok) setActionError(reply.error);
          }}
        />
        <div ref={timelineEnd} />

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
              disabled={view.host !== 'ready'}
            />
            <div className="composer-actions">
              {active && <button className="danger-button" onClick={cancel}>取消</button>}
              <button className="primary" onClick={send} disabled={!input.trim() || active || view.host !== 'ready'}>发送</button>
            </div>
          </div>
        </footer>
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
    case 'invocation.changed':
      value.invocation = event.payload.value;
      if (['finished', 'failed', 'cancelled', 'interrupted'].includes(event.payload.value.phase)) value.approval = undefined;
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
