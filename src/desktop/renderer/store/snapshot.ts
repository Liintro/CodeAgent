import { create } from 'zustand';
import type { AppError, WorkbenchEvent, WorkbenchSnapshot } from '../../../shared/contracts';
import { activePhases, applyEvent, initialEnvelope } from './reduce';

type SnapshotState = {
  envelope: typeof initialEnvelope;
  apply: (events: WorkbenchEvent[]) => void;
  replace: (envelope: typeof initialEnvelope, pending: WorkbenchEvent[]) => void;
};

export const useSnapshotStore = create<SnapshotState>(set => ({
  envelope: initialEnvelope,
  apply: events => set(state => ({ envelope: events.reduce(applyEvent, state.envelope) })),
  replace: (envelope, pending) => set({ envelope: pending.reduce(applyEvent, envelope) }),
}));

export function useView<T>(selector: (view: WorkbenchSnapshot) => T): T {
  return useSnapshotStore(state => selector(state.envelope.value));
}

export const getView = () => useSnapshotStore.getState().envelope.value;

export const useActive = () => useView(view => Boolean(view.run && activePhases.includes(view.run.phase)));
export const useReady = () => useView(view => view.host === 'ready');

type Listener = (previous: WorkbenchSnapshot, event: WorkbenchEvent) => void;

// 订阅 Host 事件。流式输出事件很密：同一帧内到达的事件合并成一次状态更新，界面在长任务里保持流畅。
// onEvent 在应用每个事件前收到旧快照，提醒规则据此判断状态转变。
export function connectHost(onEvent: Listener, onError: (error: AppError) => void, onSnapshot: (view: WorkbenchSnapshot) => void): () => void {
  const buffered: WorkbenchEvent[] = [];
  let subscribed = false;
  let frame = 0;
  const flush = () => {
    frame = 0;
    const batch = buffered.splice(0);
    if (!batch.length) return;
    let envelope = useSnapshotStore.getState().envelope;
    for (const event of batch) {
      onEvent(envelope.value, event);
      envelope = applyEvent(envelope, event);
    }
    useSnapshotStore.setState({ envelope });
  };
  const unsubscribe = window.codeAgent.onEvent(event => {
    buffered.push(event);
    if (subscribed && !frame) frame = requestAnimationFrame(flush);
  });
  void window.codeAgent.getSnapshot().then(reply => {
    if (!reply.ok) {
      onError(reply.error);
      return;
    }
    subscribed = true;
    useSnapshotStore.getState().replace(reply.value, buffered.splice(0));
    onSnapshot(reply.value.value);
  });
  return () => {
    unsubscribe();
    if (frame) cancelAnimationFrame(frame);
  };
}
