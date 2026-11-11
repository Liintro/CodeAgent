import { create } from 'zustand';

// 未读：窗口不在前台时完成或需要处理的任务。回到窗口并看到该任务后清除。
type NotificationState = {
  unread: ReadonlySet<string>;
  markUnread: (taskId: string) => void;
  markRead: (taskId: string) => void;
};

export const useNotifications = create<NotificationState>(set => ({
  unread: new Set(),
  markUnread: taskId => set(state => (state.unread.has(taskId) ? state : { unread: new Set([...state.unread, taskId]) })),
  markRead: taskId => set(state => {
    if (!state.unread.has(taskId)) return state;
    const unread = new Set(state.unread);
    unread.delete(taskId);
    return { unread };
  }),
}));
