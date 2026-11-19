import { DEFAULT_AGENT_IDENTITY, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core';
import { createInitialSystemMessage, mergeClientIdentity, normalizeContext, toToolDeclaration, type Message, type Model, type TranscriptContext } from '@earendil-works/pi-ai';

// 每一步都与 Pi Agent 的做法相同（createMutableAgentState、streamAssistantResponse、createLoopConfig），
// 两种内核发出的请求因此逐字节一致；改动这里时要同时更新逐字节对比测试。

export type RequestHooks = {
  convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
};

/** 会话里只有这四种消息，原样交给 Provider。 */
export const toLlm = (messages: AgentMessage[]) => messages.filter(message => ['system', 'user', 'assistant', 'toolResult'].includes(message.role)) as Message[];

/** 对话记录开头的 system 消息携带系统提示与工具声明；已有 system 消息时不再插入。 */
export function initialTranscript(systemPrompt: string | undefined, tools: AgentTool<any>[], messages: AgentMessage[] = []): AgentMessage[] {
  const transcript = messages.slice();
  const system = createInitialSystemMessage(systemPrompt, tools.map(toToolDeclaration));
  if (transcript[0]?.role !== 'system' && system) transcript.unshift(system);
  return transcript;
}

/** 发给 Provider 的对话：召回槽位注入 → 转为 LLM 消息 → 规范化。 */
export async function requestContext(messages: AgentMessage[], hooks: RequestHooks, signal?: AbortSignal): Promise<TranscriptContext> {
  const transformed = hooks.transformContext ? await hooks.transformContext(messages, signal) : messages;
  return normalizeContext({ messages: await hooks.convertToLlm(transformed) });
}

/** 请求选项：思考等级在 streamFn 里按模型配置决定，这里与 Pi 一样不带；归属标识沿用 Pi 的默认值。 */
export function requestOptions(model: Model<any>, signal: AbortSignal) {
  return {
    model,
    reasoning: undefined,
    transport: 'auto' as const,
    identity: mergeClientIdentity(DEFAULT_AGENT_IDENTITY, undefined),
    apiKey: undefined,
    signal,
  };
}
