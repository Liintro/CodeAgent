import type { AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import type { VerificationResult } from '../../shared/contracts/index.js';
import type { PermissionGate } from '../policy/permission-gate.js';
import type { TaskState, Workbench } from '../services/workbench.js';
import { runSubagent } from './subagent.js';

export const EXPLORE_TOOL = 'explore';

export type SubagentDeps = { wb: Workbench; task: TaskState; runId: string; model: Model<any>; streamFn: StreamFn };

const EXPLORER_PROMPT = `你是只读的代码探索助手，在独立的上下文里替主 Agent 回答一个定位问题。只用提供的只读工具，不要修改任何东西。
最后用中文给出简短结论：相关文件与位置，每条结论都附 path:起-止 行号引用（路径相对工作目录）；不确定的地方明确说明。不要复述工具输出。`;

const VERIFIER_PROMPT = `你是验证助手。验收命令刚刚失败，请在不修改源码的前提下：
1. 复现失败（可以运行命令，只运行与这次失败相关的最小范围）；
2. 缩小到最小复现：最短的命令或单个用例；
3. 指出最可疑的位置，附 path:起-止 行号引用（路径相对工作目录）。
最后用中文给出：最小复现命令、失败的关键输出、可疑位置与理由。不要修复，不要改任何文件。`;

/** explore：主 Agent 把多步搜索的定位问题委派给探索者，只拿回结论和 path:line 引用。 */
export function createExploreTool(deps: SubagentDeps, readTools: () => AgentTool<any>[]): AgentTool<any> {
  const { wb, task } = deps;
  const settings = () => wb.policy.settings.subagents;
  return {
    name: EXPLORE_TOOL,
    label: EXPLORE_TOOL,
    description: `把一个需要多步搜索的代码定位问题（某个功能在哪里实现、要改哪些地方）交给只读的探索子智能体。它在独立上下文里最多调用 ${settings().explorerToolCalls} 次只读工具，只返回结论和 path:起-止 引用，不占用你的上下文。一两次 grep 就能回答的问题直接自己查。`,
    parameters: { type: 'object', properties: { question: { type: 'string', description: '要定位的问题，写清楚要找什么' } }, required: ['question'] },
    execute: async (toolCallId: string, params: any, signal?: AbortSignal) => {
      wb.updateTool(task, toolCallId, { state: 'running' });
      const result = await runSubagent(wb, task, deps.runId, {
        kind: 'explorer', key: toolCallId, title: String((params as { question: string }).question), systemPrompt: EXPLORER_PROMPT, prompt: String((params as { question: string }).question),
        tools: readTools(), maxToolCalls: settings().explorerToolCalls, maxOutputTokens: settings().explorerOutputTokens,
        model: deps.model, streamFn: deps.streamFn, signal,
        onSteps: steps => wb.updateTool(task, toolCallId, { steps }),
      });
      return { content: [{ type: 'text', text: `${result.answer}\n（探索者用了 ${result.toolCalls} 次只读工具调用）` }], details: { sessionId: result.sessionId } };
    },
  };
}

/** 验收失败后、交给主 Agent 修复之前：验证者复现失败、缩小到最小复现并指出可疑位置。时间线上是一条折叠的工具行。 */
export async function runVerifier(deps: SubagentDeps, gate: PermissionGate, tools: AgentTool<any>[], failed: VerificationResult, alias: string, signal?: AbortSignal): Promise<string> {
  const { wb, task, runId } = deps;
  const key = `verifier-${failed.attempt}`;
  const id = `subagent:${runId}:${key}`;
  task.timeline.push({ kind: 'tool', toolCallId: id, name: 'verifier', args: { command: failed.label }, state: 'running', output: '', steps: [] });
  wb.emitSnapshot();
  const prompt = `目录 ${alias} 的验收命令「${failed.label}」失败（${failed.status === 'timeout' ? '超时' : `退出码 ${failed.exitCode ?? '无'}`}）。
命令：${failed.command}
输出尾部：
${failed.outputTail.split('\n').slice(-60).join('\n')}`;
  const result = await runSubagent(wb, task, runId, {
    kind: 'verifier', key, title: failed.label, systemPrompt: VERIFIER_PROMPT, prompt, tools,
    maxToolCalls: wb.policy.settings.subagents.verifierToolCalls, maxOutputTokens: wb.policy.settings.subagents.verifierOutputTokens,
    model: deps.model, streamFn: deps.streamFn, signal,
    beforeToolCall: (context, toolSignal) => gate.beforeToolCall(task, runId, context, toolSignal),
    onSteps: steps => wb.updateTool(task, id, { steps }),
  });
  wb.updateTool(task, id, { state: signal?.aborted ? 'cancelled' : 'succeeded', output: result.answer });
  return result.answer;
}
