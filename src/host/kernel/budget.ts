import type { RunEvent } from '../../shared/contracts/index.js';
import type { BudgetSettings } from '../runtime/policy.js';

export type BudgetReport = { tokens: number; toolCalls: number; wallSeconds: number; limits: BudgetSettings; exceeded: (keyof BudgetSettings)[] };

/** 一个 Run 用掉的 token（含压缩摘要）、工具调用次数与墙钟时间，以及超出了哪些上限。 */
export function budgetReport(events: RunEvent[], now: number, limits: BudgetSettings): BudgetReport {
  const tokens = events.filter(event => event.type === 'model.usage').reduce((sum, event) => sum + (Number(event.data.totalTokens) || 0), 0);
  const toolCalls = events.filter(event => event.type === 'tool.finished').length;
  const started = events.find(event => event.type === 'run.started')?.at ?? now;
  const wallSeconds = Math.round((now - started) / 1000);
  const exceeded = ([['maxTokens', tokens], ['maxToolCalls', toolCalls], ['maxWallSeconds', wallSeconds]] as const)
    .filter(([key, value]) => value > limits[key]).map(([key]) => key);
  return { tokens, toolCalls, wallSeconds, limits, exceeded };
}
