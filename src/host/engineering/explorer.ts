import { Agent, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import { convertToLlm } from '@earendil-works/pi-coding-agent';

// 受预算约束的只读探索子代理（原型，默认关闭）：用同一个模型、只读工具，在独立上下文里定位相关代码，
// 只把结论和 path:起-止 证据交回主代理。是否保留取决于成对消融结果（见 Batch 5 报告）。
export const EXPLORER_BUDGET = { toolCalls: 10, maxOutputTokens: 1500 };

export type ExplorerContext = {
  model: Model<any>;
  streamFn: StreamFn;
  tools: () => AgentTool<any>[];
  onStarted: (toolCallId: string) => void;
  onUsage: (usage: unknown) => void;
  signal: () => AbortSignal | undefined;
};

export function createExplorerTool(ctx: ExplorerContext): AgentTool<any> {
  return {
    name: 'explore',
    label: 'explore',
    description: `把一个代码定位问题交给只读的探索子代理（独立上下文，最多 ${EXPLORER_BUDGET.toolCalls} 次只读工具调用）。返回相关文件与 path:起-止 证据。适合“这个功能在哪里实现、改哪里”这类需要多步搜索的问题；简单的 grep 能回答时不要用。`,
    parameters: { type: 'object', required: ['question'], properties: { question: { type: 'string', description: '要定位的问题' } } },
    execute: async (toolCallId, params: any) => {
      ctx.onStarted(toolCallId);
      let calls = 0;
      const agent = new Agent({
        initialState: {
          model: ctx.model,
          systemPrompt: '你是只读的代码探索助手。只用提供的只读工具定位与问题相关的代码，不要修改任何东西。最后用中文给出：相关文件列表，每个结论附 path:起-止 行号证据；不确定的地方明确说明。',
          tools: ctx.tools(),
        },
        convertToLlm,
        streamFn: (model, context, options) => ctx.streamFn(model, context, { ...options, maxTokens: EXPLORER_BUDGET.maxOutputTokens }),
        toolExecution: 'sequential',
        beforeToolCall: async () => (++calls > EXPLORER_BUDGET.toolCalls ? { block: true, reason: `探索预算（${EXPLORER_BUDGET.toolCalls} 次工具调用）已用完，请立即给出结论` } : undefined),
      });
      const abort = () => agent.abort();
      ctx.signal()?.addEventListener('abort', abort, { once: true });
      const unsubscribe = agent.subscribe(event => {
        if (event.type === 'message_end' && event.message.role === 'assistant' && event.message.usage?.totalTokens > 0) ctx.onUsage({ ...event.message.usage, purpose: 'explore' });
      });
      try {
        await agent.prompt(String(params.question));
        await agent.waitForIdle();
      } finally {
        unsubscribe();
        ctx.signal()?.removeEventListener('abort', abort);
      }
      const last = [...agent.state.messages].reverse().find(message => message.role === 'assistant');
      const answer = last?.role === 'assistant' ? last.content.filter(block => block.type === 'text').map(block => block.text).join('') : '';
      return { content: [{ type: 'text' as const, text: `${answer || '（探索子代理没有给出结论）'}\n（探索用了 ${Math.min(calls, EXPLORER_BUDGET.toolCalls)} 次只读工具调用）` }], details: undefined };
    },
  };
}
