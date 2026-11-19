import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { PlanItem } from '../../shared/contracts/index.js';
import type { SessionStore } from '../kernel/session.js';

export const PLAN_TOOL = 'update_plan';
const MAX_ITEMS = 20;
const MAX_TEXT = 200;

/** update_plan：模型维护的任务计划。每次传入完整列表，替换上一份；计划模式也可用。 */
export function createPlanTool(onUpdate: (items: PlanItem[]) => void): AgentTool<any> {
  return {
    name: PLAN_TOOL,
    label: PLAN_TOOL,
    description: '记录或更新当前任务的计划（每次传入完整列表，替换上一份）。多步骤任务开始时写下计划，每完成一步更新状态；同一时刻最多一项 in_progress。计划会固定显示给用户。',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          maxItems: MAX_ITEMS,
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '这一步要做什么，一句话' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['items'],
    },
    // 参数已按 parameters 校验过。
    execute: async (_toolCallId: string, params: any) => {
      const items = (params as { items: PlanItem[] }).items.map(item => ({ content: item.content.trim().slice(0, MAX_TEXT), status: item.status }));
      onUpdate(items);
      return { content: [{ type: 'text', text: `计划已更新（${items.filter(item => item.status === 'completed').length}/${items.length} 完成）` }], details: {} };
    },
  };
}

/** 会话里最后一次成功的 update_plan 调用就是当前计划；没有则为空。会话里存的是模型的原始参数，所以这里要重新检查。 */
export function currentPlan(session: SessionStore): PlanItem[] {
  const failed = new Set<string>();
  const entries = session.entries();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (message.role === 'toolResult' && message.toolName === PLAN_TOOL && message.isError) failed.add(message.toolCallId);
    if (message.role !== 'assistant') continue;
    const calls = message.content.filter(block => block.type === 'toolCall' && block.name === PLAN_TOOL && !failed.has(block.id));
    const items = calls.length ? planItems((calls.at(-1) as { arguments: unknown }).arguments) : undefined;
    if (items) return items;
  }
  return [];
}

function planItems(params: unknown): PlanItem[] | undefined {
  const list = (params as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(list)) return undefined;
  const items = list.slice(0, MAX_ITEMS).map(item => item as { content?: unknown; status?: unknown });
  if (items.some(item => typeof item?.content !== 'string' || !['pending', 'in_progress', 'completed'].includes(item.status as string))) return undefined;
  return items.map(item => ({ content: (item.content as string).trim().slice(0, MAX_TEXT), status: item.status as PlanItem['status'] }));
}
