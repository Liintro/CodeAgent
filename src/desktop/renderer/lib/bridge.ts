import type { AppError, DesktopBridge } from '../../../shared/contracts';
import { notifyError } from '../features/notifications/notify';

declare global {
  interface Window {
    codeAgent: DesktopBridge;
  }
}

export const bridge = (): DesktopBridge => window.codeAgent;

type ReplyPromise<T> = Promise<{ ok: true; value: T } | { ok: false; error: AppError }>;

/** 调用 bridge：失败统一变成错误提醒，调用方只处理成功值。 */
export async function call<T>(action: ReplyPromise<T>): Promise<T | undefined> {
  const reply = await action;
  if (reply.ok) return reply.value;
  notifyError(reply.error);
  return undefined;
}
