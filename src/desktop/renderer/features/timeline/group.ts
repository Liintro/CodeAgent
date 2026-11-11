import type { TimelineItem, ToolItem } from '../../../../shared/contracts';

// 这个文件只依赖类型，单元测试可以直接用 Node 加载它。

export type TimelineEntry =
  | { type: 'item'; key: string; item: TimelineItem }
  | { type: 'explore'; key: string; tools: ToolItem[] };

/** 只读的探索类工具：连续出现时合并成一行摘要，点开才显示明细。 */
const EXPLORE = new Set(['read', 'grep', 'find', 'ls', 'git', 'code_outline', 'find_symbol', 'related_files', 'doc_outline', 'doc_read', 'doc_view', 'web_search', 'web_fetch']);

export const isExplore = (item: TimelineItem): boolean => item.kind === 'tool' && !item.source && EXPLORE.has(item.name);

export function groupTimeline(items: TimelineItem[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const item of items) {
    const last = entries.at(-1);
    if (item.kind === 'tool' && isExplore(item)) {
      if (last?.type === 'explore') last.tools.push(item);
      else entries.push({ type: 'explore', key: item.toolCallId, tools: [item] });
      continue;
    }
    entries.push({ type: 'item', key: item.kind === 'tool' ? item.toolCallId : item.id, item });
  }
  return entries;
}

const COUNTED: Record<string, (n: number) => string> = {
  read: n => `读取 ${n} 个文件`,
  doc_read: n => `读取文档 ${n} 次`,
  grep: n => `搜索 ${n} 次`,
  find: n => `查找文件 ${n} 次`,
  find_symbol: n => `查找定义 ${n} 次`,
  ls: n => `列出 ${n} 个目录`,
  git: n => `Git 查询 ${n} 次`,
  code_outline: n => `代码结构 ${n} 次`,
  related_files: n => `相关文件 ${n} 次`,
  doc_outline: n => `文档结构 ${n} 次`,
  doc_view: n => `查看文档图像 ${n} 次`,
  web_search: n => `联网搜索 ${n} 次`,
  web_fetch: n => `读取网页 ${n} 次`,
};

/** 例如“读取 4 个文件 · 搜索 2 次”；顺序按第一次出现。 */
export function exploreSummary(tools: ToolItem[]): string {
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  return [...counts].map(([name, n]) => COUNTED[name]?.(n) ?? `${name} ${n} 次`).join(' · ');
}

/** 自最后一条用户消息以来的工具调用数，用于运行状态条。 */
export function toolCallsSinceLastUser(items: TimelineItem[]): number {
  let count = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === 'message' && item.role === 'user' && !item.harness) break;
    if (item.kind === 'tool') count += 1;
  }
  return count;
}
