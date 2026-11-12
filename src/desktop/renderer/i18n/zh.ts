import type {
  Delivery, MemoryKind, MemoryValidity, McpServerStatus, RootDeliveryState, RunPhase, ToolState, UserMode, VerificationState,
} from '../../../shared/contracts';

// 所有界面文案集中在这里，组件只引用键值。

export const deliveryText: Record<Delivery, string> = {
  none: '', unverified: '未验证', verifying: '验证中', verified: '已验证', verification_failed: '验证未通过', accepted: '已接受', restored: '已还原',
};
export const rootStateText: Record<RootDeliveryState, string> = { ...deliveryText, committed: '已提交', none: '无变更' };
export const resultText = { passed: '通过', failed: '未通过', timeout: '超时', cancelled: '已取消', unavailable: '未能执行' } as const;

export const toolStateText: Record<ToolState, string> = {
  requested: '等待执行', awaiting_approval: '等待批准', running: '执行中', succeeded: '已完成', failed: '失败', denied: '已拒绝', cancelled: '已取消', unknown: '结果未知',
};
export const verificationText: Record<VerificationState, string> = {
  running: '验证中', passed: '通过', failed: '未通过', timeout: '超时', cancelled: '已取消', unavailable: '未能执行',
};
export const toolTitles: Record<string, string> = {
  read: '读取文件', grep: '搜索内容', find: '查找文件', ls: '列出目录', edit: '编辑文件', write: '写入文件', powershell: 'PowerShell', git: 'Git 查询',
  doc_outline: '文档结构', doc_read: '读取文档', doc_view: '查看文档图像', code_outline: '代码结构', find_symbol: '查找定义', related_files: '相关文件',
  web_search: '联网搜索', web_fetch: '读取网页',
};

export const runPhaseText: Record<RunPhase, string> = {
  running: '运行中', awaiting_approval: '等待批准', verifying: '验证中', cancelling: '正在停止', finished: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断',
};

export const modes: { value: UserMode; label: string; hint: string }[] = [
  { value: 'plan', label: '计划', hint: '只读调查，给出实施计划' },
  { value: 'manual', label: '手动', hint: '编辑与命令都需要批准' },
  { value: 'accept_edits', label: '接受编辑', hint: '编辑自动通过，命令需批准' },
  { value: 'auto', label: '自动', hint: '编辑与沙箱内命令自动执行' },
  { value: 'bypass', label: '绕过权限', hint: '不再询问，以当前用户权限运行' },
];

export const kindText: Record<MemoryKind, string> = { fix: '修复', change: '变更', convention: '约定', note: '备注' };
export const validityText: Record<MemoryValidity, string> = { current: '当前', drifted: '已漂移', reverted: '已回退', not_in_history: '不在当前历史', unverifiable: '无法校验' };
export const mcpStateText: Record<McpServerStatus['state'], string> = { disabled: '已停用', connecting: '连接中', ready: '就绪', failed: '失败' };

export const sandboxStatusText = { untested: '检测中', available: '可用', unavailable: '不可用', failed: '自检失败' } as const;

export const panelTitles = { changes: '变更', acceptance: '验收', memory: '记忆', run: '运行' } as const;
export const settingsSections = ['模型', 'MCP 与联网', '沙箱与权限', '记忆', '通知', '外观'] as const;
export type SettingsSection = typeof settingsSections[number];
/** Tabs 的值用 ASCII：Radix 用它拼元素 id，含空格会让 aria-labelledby 失效。 */
export const settingsKeys: Record<SettingsSection, string> = { 模型: 'model', 'MCP 与联网': 'mcp', 沙箱与权限: 'sandbox', 记忆: 'memory', 通知: 'notify', 外观: 'appearance' };
