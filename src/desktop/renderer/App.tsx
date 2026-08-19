import { useEffect, useState } from 'react';
import type { SnapshotEnvelope, WorkbenchEvent } from '../../shared/contracts';

const initial: SnapshotEnvelope = {
  hostInstanceId: '',
  seq: 0,
  value: { host: 'starting', timeline: [] },
};

export default function App() {
  const [snapshot, setSnapshot] = useState(initial);

  useEffect(() => {
    const buffered: WorkbenchEvent[] = [];
    let ready = false;
    const unsubscribe = window.codeAgent.onEvent(event => {
      if (!ready) buffered.push(event);
      else setSnapshot(current => applyEvent(current, event));
    });
    void window.codeAgent.getSnapshot().then(reply => {
      if (!reply.ok) return;
      ready = true;
      setSnapshot(buffered.filter(event => event.seq > reply.value.seq).reduce(applyEvent, reply.value));
    });
    return unsubscribe;
  }, []);

  return (
    <main className="workbench">
      <header className="topbar">
        <strong>CodeAgent</strong>
        <span className="workspace">未选择项目</span>
      </header>
      <section className="empty-state">
        <h1>中文桌面工作台</h1>
        <p>{snapshot.value.host === 'ready' ? '运行进程已就绪' : '正在启动运行进程…'}</p>
      </section>
      <footer className="composer">
        <textarea aria-label="任务输入" placeholder="输入任务或问题……" disabled />
        <button disabled>发送</button>
      </footer>
    </main>
  );
}

function applyEvent(current: SnapshotEnvelope, event: WorkbenchEvent): SnapshotEnvelope {
  if (event.hostInstanceId !== current.hostInstanceId || event.seq <= current.seq) return current;
  if (event.payload.type === 'snapshot') return { hostInstanceId: event.hostInstanceId, seq: event.seq, value: event.payload.value };
  return { ...current, seq: event.seq };
}

declare global {
  interface Window {
    codeAgent: import('../../shared/contracts').DesktopBridge;
  }
}
