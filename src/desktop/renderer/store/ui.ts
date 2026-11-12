import { create } from 'zustand';
import type { SettingsSection } from '../i18n/zh';

export type PanelTab = 'changes' | 'acceptance' | 'memory' | 'run';
export type DiffTarget = { rootId: string; path: string };

type UiState = {
  view: 'workbench' | 'settings';
  settingsSection: SettingsSection;
  panel?: PanelTab;
  panelWidth: number;
  paletteOpen: boolean;
  diff?: DiffTarget;
  /** 当前设置分区有未保存的修改时注册；返回 false 表示这次离开被拦下。 */
  leaveGuard?: () => boolean;
  openSettings: (section?: SettingsSection) => void;
  setSettingsSection: (section: SettingsSection) => void;
  closeSettings: () => void;
  togglePanel: (tab: PanelTab) => void;
  openPanel: (tab: PanelTab) => void;
  closePanel: () => void;
  setPanelWidth: (width: number) => void;
  setPalette: (open: boolean) => void;
  openDiff: (target: DiffTarget) => void;
  setLeaveGuard: (guard?: () => boolean) => void;
};

const WIDTH_KEY = 'codeagent.panelWidth';

function storedWidth(): number {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY));
    return value >= 320 && value <= 960 ? value : 420;
  } catch {
    return 420;
  }
}

const allowed = (state: UiState) => !state.leaveGuard || state.leaveGuard();

export const useUi = create<UiState>((set, get) => ({
  view: 'workbench',
  settingsSection: '模型',
  panelWidth: storedWidth(),
  paletteOpen: false,
  openSettings: section => {
    if (get().view === 'settings' && section && section !== get().settingsSection && !allowed(get())) return;
    set(state => ({ view: 'settings', settingsSection: section ?? state.settingsSection }));
  },
  setSettingsSection: section => {
    if (section !== get().settingsSection && allowed(get())) set({ settingsSection: section, leaveGuard: undefined });
  },
  closeSettings: () => {
    if (allowed(get())) set({ view: 'workbench', leaveGuard: undefined });
  },
  togglePanel: tab => set(state => ({ panel: state.panel === tab ? undefined : tab })),
  openPanel: tab => set({ panel: tab }),
  closePanel: () => set({ panel: undefined }),
  setPanelWidth: width => {
    const value = Math.round(Math.min(960, Math.max(320, width)));
    try { localStorage.setItem(WIDTH_KEY, String(value)); } catch { /* 只是界面偏好 */ }
    set({ panelWidth: value });
  },
  setPalette: open => set({ paletteOpen: open }),
  openDiff: target => set({ diff: target, panel: 'changes' }),
  setLeaveGuard: guard => set({ leaveGuard: guard }),
}));
