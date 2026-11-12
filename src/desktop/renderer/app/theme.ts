import { useSyncExternalStore } from 'react';
import type { ThemePreference } from '../../../shared/contracts';

// 主题由渲染层自己决定并写在 <html data-theme> 上：主进程的 nativeTheme.themeSource 不会可靠地改变已加载页面的
// prefers-color-scheme，所以“跟随系统”时监听媒体查询，“浅色 / 暗色”时直接固定。
const media = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();
let preference: ThemePreference = 'system';

function update(): void {
  const dark = preference === 'dark' || (preference === 'system' && media.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  listeners.forEach(listener => listener());
}

media.addEventListener('change', update);
update();

export function applyTheme(next: ThemePreference): void {
  preference = next;
  update();
}

export const isDark = (): boolean => document.documentElement.dataset.theme === 'dark';

export function useResolvedTheme(): 'light' | 'dark' {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (isDark() ? 'dark' : 'light'),
  );
}

export function onThemeChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
