import type { NotifyLevel, WorkbenchEvent, WorkbenchSnapshot } from './contracts.js';

/** 一条需要告诉用户的事情。主进程据此发系统通知，渲染层据此弹应用内提醒；两边用同一套规则。 */
export type Attention = {
  level: NotifyLevel;
  kind: 'approval' | 'interrupted' | 'verification_failed' | 'finished' | 'failed' | 'error' | 'host_exited';
  title: string;
  body: string;
  taskId?: string;
  approvalId?: string;
};

const BUSY = ['running', 'awaiting_approval', 'verifying', 'cancelling'];

// previous 是应用事件之前的快照；只有状态真正发生转变时才产生提醒，重复事件不会重复提醒。
export function attentionFor(previous: WorkbenchSnapshot, event: WorkbenchEvent): Attention | undefined {
  const payload = event.payload;
  const taskId = previous.run?.taskId ?? previous.taskId;
  const taskTitle = previous.tasks.find(task => task.id === taskId)?.title ?? '当前任务';
  switch (payload.type) {
    case 'approval.requested':
      if (previous.approval?.id === payload.value.id) return undefined;
      return { level: 'action', kind: 'approval', title: '需要批准', body: `${taskTitle}：${payload.value.summary}`, taskId, approvalId: payload.value.id };
    case 'run.changed': {
      const before = previous.run?.id === payload.value.id ? previous.run.phase : undefined;
      if (!before || !BUSY.includes(before)) return undefined;
      const id = payload.value.taskId;
      const title = previous.tasks.find(task => task.id === id)?.title ?? taskTitle;
      if (payload.value.phase === 'interrupted') return { level: 'action', kind: 'interrupted', title: '任务已中断', body: `${title}：可以继续执行`, taskId: id };
      if (payload.value.phase === 'failed') return { level: 'error', kind: 'failed', title: '运行失败', body: previous.error?.message ?? title, taskId: id };
      if (payload.value.phase !== 'finished') return undefined;
      if (previous.delivery?.state === 'verification_failed') return { level: 'action', kind: 'verification_failed', title: '验证未通过', body: `${title}：需要决定下一步`, taskId: id };
      return { level: 'done', kind: 'finished', title: '任务已完成', body: title, taskId: id };
    }
    case 'error':
      if (previous.error?.code === payload.value.code && previous.error.message === payload.value.message) return undefined;
      return { level: 'error', kind: 'error', title: payload.value.message, body: payload.value.detail ?? '', taskId };
    case 'snapshot':
      if (previous.host === 'failed' || payload.value.host !== 'failed') return undefined;
      return { level: 'error', kind: 'host_exited', title: '运行进程已退出', body: '重启运行进程后可以继续', taskId };
    default:
      return undefined;
  }
}
