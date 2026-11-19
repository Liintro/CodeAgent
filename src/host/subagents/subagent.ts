import type { AgentTool, BeforeToolCallContext, BeforeToolCallResult, StreamFn } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import type { SubagentKind, SubagentStep } from '../../shared/contracts/index.js';
import { verifyCitations } from '../engineering/navigation.js';
import { toLlm } from '../kernel/context.js';
import { NativeAgent } from '../kernel/loop.js';
import { SessionStore } from '../kernel/session.js';
import { classify } from '../tools/permission.js';
import type { TaskState, Workbench } from '../services/workbench.js';

const ARGS_TEXT_LIMIT = 1024;

export type SubagentOptions = {
  kind: SubagentKind;
  /** 父 Run 内唯一：探索者用触发它的工具调用 id，验证者用验证次数。 */
  key: string;
  /** 时间线行上显示的内容：探索者是问题，验证者是验收命令名。 */
  title: string;
  systemPrompt: string;
  prompt: string;
  tools: AgentTool<any>[];
  maxToolCalls: number;
  maxOutputTokens: number;
  model: Model<any>;
  streamFn: StreamFn;
  signal?: AbortSignal;
  /** 预算之外的放行判断（验证者的命令要经过权限闸门）。 */
  beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
  onSteps: (steps: SubagentStep[]) => void;
};

export type SubagentResult = { sessionId: string; answer: string; toolCalls: number; cited: number; invalid: string[] };

/**
 * 在独立上下文里跑一个子智能体：会话存入 session_entry（会话 id 记下父 Run），过程写入父 Run 的 run_event，
 * 工具调用次数受预算约束；结论里指向不存在的行的 path:line 引用被剔除，只保留路径。
 */
export async function runSubagent(wb: Workbench, task: TaskState, runId: string, options: SubagentOptions): Promise<SubagentResult> {
  const sessionId = `subagent:${runId}:${options.key}`;
  const session = new SessionStore(wb.ledger.database, sessionId);
  const steps: SubagentStep[] = [];
  let calls = 0;
  wb.ledger.appendEvent(runId, 'subagent.started', { sessionId, kind: options.kind, key: options.key, title: options.title });
  const agent = new NativeAgent({
    initialState: { model: options.model, systemPrompt: options.systemPrompt, tools: options.tools },
    convertToLlm: toLlm,
    streamFn: (model, context, streamOptions) => options.streamFn(model, context, { ...streamOptions, maxTokens: options.maxOutputTokens }),
    scheduling: { parallel: true, maxParallel: wb.policy.settings.kernel.maxParallelTools, isReadOnly: name => classify(name, new Set()) === 'read' },
    beforeToolCall: async (context, signal) => {
      if (++calls > options.maxToolCalls) return { block: true, reason: `工具调用预算（${options.maxToolCalls} 次）已用完，请立即给出结论。` };
      if (wb.active?.id !== runId || wb.active.summarizing) return { block: true, reason: '主任务已停止，请立即给出结论。' };
      return options.beforeToolCall?.(context, signal);
    },
  });
  const abort = () => agent.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const unsubscribe = agent.subscribe(event => {
    if (event.type === 'message_end') {
      session.appendMessage(event.message);
      if (event.message.role === 'assistant' && event.message.usage?.totalTokens > 0) {
        wb.ledger.appendEvent(runId, 'model.usage', { ...event.message.usage, purpose: options.kind, sessionId });
      }
    } else if (event.type === 'tool_execution_start') {
      steps.push({ toolCallId: event.toolCallId, name: event.toolName, target: targetOf(event.args), state: 'running' });
      options.onSteps([...steps]);
    } else if (event.type === 'tool_execution_end') {
      const step = steps.find(item => item.toolCallId === event.toolCallId);
      if (!step) return;
      step.state = event.isError ? 'failed' : 'succeeded';
      wb.ledger.appendEvent(runId, 'subagent.tool', { sessionId, kind: options.kind, key: options.key, toolCallId: step.toolCallId, name: step.name, target: step.target, state: step.state });
      options.onSteps([...steps]);
    }
  });
  try {
    await agent.prompt(options.prompt);
    await agent.waitForIdle();
  } finally {
    unsubscribe();
    options.signal?.removeEventListener('abort', abort);
  }
  const last = agent.state.messages.findLast(message => message.role === 'assistant');
  const raw = last?.role === 'assistant' ? last.content.filter(block => block.type === 'text').map(block => block.text).join('').trim() : '';
  const { cited, invalid } = await verifyCitations(raw, task.roots);
  const answer = stripInvalid(raw || (agent.state.errorMessage ? `（子智能体出错：${agent.state.errorMessage}）` : '（子智能体没有给出结论）'), invalid);
  const toolCalls = Math.min(calls, options.maxToolCalls);
  wb.ledger.appendEvent(runId, 'subagent.finished', { sessionId, kind: options.kind, key: options.key, toolCalls, cited, invalid, answer, error: agent.state.errorMessage });
  return { sessionId, answer, toolCalls, cited, invalid };
}

// 无效引用只去掉行号：路径本身仍是有用的线索，行号会误导。
function stripInvalid(answer: string, invalid: string[]): string {
  if (!invalid.length) return answer;
  let text = answer;
  for (const citation of new Set(invalid)) text = text.replaceAll(citation, citation.slice(0, citation.lastIndexOf(':')));
  return `${text}\n（已剔除 ${invalid.length} 处指向不存在行号的引用：${[...new Set(invalid)].join('、')}）`;
}

function targetOf(args: unknown): string {
  const value = (args ?? {}) as Record<string, unknown>;
  const target = value.command ?? value.path ?? value.pattern ?? value.query ?? value.name ?? '';
  return String(target).slice(0, ARGS_TEXT_LIMIT);
}
