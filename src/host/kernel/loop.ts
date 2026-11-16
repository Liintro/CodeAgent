import type {
  AgentEvent,
  AgentMessage,
  AgentOptions,
  AgentTool,
  AgentToolCall,
  AgentToolResult,
  BeforeToolCallContext,
  BeforeToolCallResult,
  PrepareRequest,
  StreamFn,
} from '@earendil-works/pi-agent-core';
import { validateToolArguments, type AssistantMessage, type Message, type Model, type ToolCall, type ToolResultMessage } from '@earendil-works/pi-ai';
import { initialTranscript, requestContext, requestOptions, type RequestHooks } from './context.js';

/** 一组工具调用怎样执行：isReadOnly 为真的连续调用并发（不超过 maxParallel），其余逐个执行。 */
export type ToolScheduling = { parallel: boolean; maxParallel: number; isReadOnly: (name: string) => boolean };
export type NativeAgentOptions = Pick<AgentOptions, 'initialState' | 'transformContext' | 'beforeToolCall' | 'prepareRequest'>
  & { streamFn: StreamFn; convertToLlm?: RequestHooks['convertToLlm']; scheduling: ToolScheduling };

type Listener = (event: AgentEvent, signal: AbortSignal) => unknown;
type Finalized = { toolCall: AgentToolCall; result: AgentToolResult<any>; isError: boolean; durationMs?: number };
type Prepared = { toolCall: AgentToolCall; tool: AgentTool<any>; args: unknown };

// 与 Pi Agent 未指定 convertToLlm 时的默认做法相同。
const defaultConvertToLlm = (messages: AgentMessage[]) => messages.filter(message => ['system', 'user', 'assistant', 'toolResult'].includes(message.role)) as Message[];

const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/**
 * 自研循环：请求模型 → 执行工具 → 交回结果 → 再请求，直到模型不再调用工具。
 * 对外接口与运行时用到的 Pi Agent 部分相同（prompt、continue、abort、waitForIdle、subscribe、state），
 * 事件顺序也相同，所以会话写入、时间线、重试与恢复逻辑两种内核共用。
 */
export class NativeAgent {
  readonly state: { model: Model<any>; tools: AgentTool<any>[]; messages: AgentMessage[]; errorMessage?: string };
  private readonly listeners = new Set<Listener>();
  private active?: { controller: AbortController; done: Promise<void> };

  constructor(private readonly options: NativeAgentOptions) {
    const initial = options.initialState;
    const tools = initial?.tools?.slice() ?? [];
    this.state = { model: initial!.model!, tools, messages: initialTranscript(initial?.systemPrompt, tools, initial?.messages) };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  abort(): void {
    this.active?.controller.abort();
  }

  waitForIdle(): Promise<void> {
    return this.active?.done ?? Promise.resolve();
  }

  prompt(input: AgentMessage[] | string): Promise<void> {
    const messages = typeof input === 'string' ? [{ role: 'user' as const, content: [{ type: 'text' as const, text: input }], timestamp: Date.now() }] : input;
    return this.run(async signal => {
      await this.emit({ type: 'agent_start' }, signal);
      await this.emit({ type: 'turn_start' }, signal);
      for (const message of messages) {
        await this.emit({ type: 'message_start', message }, signal);
        await this.emit({ type: 'message_end', message }, signal);
      }
      return [...this.state.messages];
    });
  }

  /** 从现有记录继续；最后一条必须是 user 或 toolResult（重试时失败的 assistant 已被移除）。 */
  continue(): Promise<void> {
    const last = this.state.messages.at(-1);
    if (!last || this.state.messages.every(message => message.role === 'system')) throw new Error('No messages to continue from');
    if (last.role === 'assistant') throw new Error('Cannot continue from message role: assistant');
    return this.run(async signal => {
      await this.emit({ type: 'agent_start' }, signal);
      await this.emit({ type: 'turn_start' }, signal);
      return [...this.state.messages];
    });
  }

  private async run(start: (signal: AbortSignal) => Promise<AgentMessage[]>): Promise<void> {
    if (this.active) throw new Error('Agent is already processing.');
    const controller = new AbortController();
    let finish = () => {};
    this.active = { controller, done: new Promise<void>(resolve => { finish = resolve; }) };
    this.state.errorMessage = undefined;
    try {
      // 本次运行的上下文是状态的快照：压缩替换的是快照，状态里保留完整记录（与 Pi 相同）。
      const context = await start(controller.signal);
      await this.loop(context, controller.signal);
    } catch (error) {
      await this.fail(error, controller.signal);
    } finally {
      this.active = undefined;
      finish();
    }
  }

  private async loop(initial: AgentMessage[], signal: AbortSignal): Promise<void> {
    let messages = initial;
    let model = this.state.model;
    for (let first = true; ; first = false) {
      if (!first) await this.emit({ type: 'turn_start' }, signal);
      const update = await (this.options.prepareRequest as PrepareRequest | undefined)?.({ context: { messages, tools: this.state.tools }, model, thinkingLevel: 'off' }, signal);
      if (update) {
        messages = update.context?.messages ?? messages;
        model = update.model ?? model;
      }
      const message = await this.streamResponse(messages, model, signal);
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        await this.emit({ type: 'turn_end', message, toolResults: [] }, signal);
        break;
      }
      const calls = message.content.filter((block): block is AgentToolCall => block.type === 'toolCall');
      if (!calls.length) {
        await this.emit({ type: 'turn_end', message, toolResults: [] }, signal);
        break;
      }
      // length 停止时参数可能被截断，全部按失败返回让模型重新发出（与 Pi 相同）。
      const results = message.stopReason === 'length' ? await this.failTruncated(calls, signal) : await this.executeTools(messages, message, calls, signal);
      messages.push(...results);
      await this.emit({ type: 'turn_end', message, toolResults: results }, signal);
    }
    await this.emit({ type: 'agent_end', messages: [] }, signal);
  }

  private async streamResponse(messages: AgentMessage[], model: Model<any>, signal: AbortSignal): Promise<AssistantMessage> {
    const context = await requestContext(messages, { convertToLlm: this.options.convertToLlm ?? defaultConvertToLlm, transformContext: this.options.transformContext }, signal);
    const response = await this.options.streamFn(model, context, requestOptions(model, signal));
    const result = async () => Object.assign(await response.result(), { thinkingLevel: 'off' });
    let added = false;
    for await (const event of response) {
      if (event.type === 'start') {
        messages.push(event.partial);
        added = true;
        await this.emit({ type: 'message_start', message: { ...event.partial } }, signal);
      } else if (event.type === 'done' || event.type === 'error') {
        break;
      } else if (added && 'partial' in event) {
        messages[messages.length - 1] = event.partial;
        await this.emit({ type: 'message_update', assistantMessageEvent: event, message: { ...event.partial } }, signal);
      }
    }
    const final = await result();
    if (added) messages[messages.length - 1] = final;
    else {
      messages.push(final);
      await this.emit({ type: 'message_start', message: { ...final } }, signal);
    }
    await this.emit({ type: 'message_end', message: final }, signal);
    return final;
  }

  // ---- 工具 ----

  private async executeTools(context: AgentMessage[], assistant: AssistantMessage, calls: AgentToolCall[], signal: AbortSignal): Promise<ToolResultMessage[]> {
    const { parallel, maxParallel, isReadOnly } = this.options.scheduling;
    if (!parallel) return this.executeSequential(context, assistant, calls, signal);
    const finalized: Promise<Finalized>[] = [];
    const running = new Set<Promise<unknown>>();
    for (const toolCall of calls) {
      const readOnly = isReadOnly(toolCall.name);
      // 写入、命令与非可信 MCP 不与任何调用重叠：先等前面的只读调用结束。
      if (!readOnly) await Promise.all(running);
      await this.emit({ type: 'tool_execution_start', toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments }, signal);
      const preparation = await this.prepare(context, assistant, toolCall, signal);
      if ('result' in preparation) {
        await this.emitEnd(preparation, signal);
        finalized.push(Promise.resolve(preparation));
        continue;
      }
      if (!readOnly) {
        const done = await this.execute(preparation, signal);
        await this.emitEnd(done, signal);
        finalized.push(Promise.resolve(done));
        continue;
      }
      while (running.size >= maxParallel) await Promise.race(running);
      const task = (async () => {
        const done = signal.aborted ? this.errorResult(toolCall, 'Operation aborted') : await this.execute(preparation, signal);
        await this.emitEnd(done, signal);
        return done;
      })();
      const tracked = task.finally(() => running.delete(tracked));
      running.add(tracked);
      finalized.push(task);
      if (signal.aborted) break;
    }
    // 结果消息按 assistant 中的原始顺序追加，请求内容不受完成顺序影响。
    const messages: ToolResultMessage[] = [];
    for (const done of await Promise.all(finalized)) messages.push(await this.emitResult(done, signal));
    return messages;
  }

  private async executeSequential(context: AgentMessage[], assistant: AssistantMessage, calls: AgentToolCall[], signal: AbortSignal): Promise<ToolResultMessage[]> {
    const messages: ToolResultMessage[] = [];
    for (const toolCall of calls) {
      await this.emit({ type: 'tool_execution_start', toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments }, signal);
      const preparation = await this.prepare(context, assistant, toolCall, signal);
      const done = 'result' in preparation ? preparation : await this.execute(preparation, signal);
      await this.emitEnd(done, signal);
      messages.push(await this.emitResult(done, signal));
      if (signal.aborted) break;
    }
    return messages;
  }

  private async failTruncated(calls: AgentToolCall[], signal: AbortSignal): Promise<ToolResultMessage[]> {
    const messages: ToolResultMessage[] = [];
    for (const toolCall of calls) {
      await this.emit({ type: 'tool_execution_start', toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments }, signal);
      const done = this.errorResult(toolCall, `Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`);
      await this.emitEnd(done, signal);
      messages.push(await this.emitResult(done, signal));
    }
    return messages;
  }

  /** 找到工具、校验参数、经过权限闸门；不能执行时直接给出错误结果。 */
  private async prepare(context: AgentMessage[], assistantMessage: AssistantMessage, toolCall: AgentToolCall, signal: AbortSignal): Promise<Prepared | Finalized> {
    const tool = this.state.tools.find(item => item.name === toolCall.name);
    if (!tool) return this.errorResult(toolCall, `Tool ${toolCall.name} not found`);
    try {
      const prepared = tool.prepareArguments ? { ...toolCall, arguments: tool.prepareArguments(toolCall.arguments) } as ToolCall : toolCall;
      const args = validateToolArguments(tool, prepared);
      const gate: BeforeToolCallResult | undefined = await this.options.beforeToolCall?.({ assistantMessage, toolCall, args, context: { messages: context, tools: this.state.tools } } as BeforeToolCallContext, signal);
      if (signal.aborted) return this.errorResult(toolCall, 'Operation aborted');
      if (gate?.block) return this.errorResult(toolCall, gate.reason || 'Tool execution was blocked');
      return { toolCall, tool, args };
    } catch (error) {
      return this.errorResult(toolCall, error instanceof Error ? error.message : String(error));
    }
  }

  private async execute({ toolCall, tool, args }: Prepared, signal: AbortSignal): Promise<Finalized> {
    const updates: Promise<unknown>[] = [];
    let accepting = true;
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    try {
      const result = await tool.execute(toolCall.id, args, signal, partialResult => {
        if (accepting) updates.push(Promise.resolve(this.emit({ type: 'tool_execution_update', toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments, partialResult }, signal)));
      });
      const durationMs = elapsed();
      accepting = false;
      await Promise.all(updates);
      return { toolCall, result, isError: result.isError === true, durationMs };
    } catch (error) {
      const durationMs = elapsed();
      accepting = false;
      await Promise.all(updates);
      return { ...this.errorResult(toolCall, error instanceof Error ? error.message : String(error)), durationMs };
    }
  }

  private errorResult(toolCall: AgentToolCall, text: string): Finalized {
    return { toolCall, result: { content: [{ type: 'text', text }], details: {} }, isError: true };
  }

  private emitEnd(done: Finalized, signal: AbortSignal) {
    return this.emit({
      type: 'tool_execution_end', toolCallId: done.toolCall.id, toolName: done.toolCall.name, result: done.result, isError: done.isError,
      ...(done.durationMs === undefined ? {} : { durationMs: done.durationMs }),
    }, signal);
  }

  private async emitResult(done: Finalized, signal: AbortSignal): Promise<ToolResultMessage> {
    const message = {
      role: 'toolResult', toolCallId: done.toolCall.id, toolName: done.toolCall.name, content: done.result.content ?? [], details: done.result.details,
      usage: done.result.usage, isError: done.isError, ...(done.durationMs === undefined ? {} : { durationMs: done.durationMs }), timestamp: Date.now(),
    } as ToolResultMessage;
    await this.emit({ type: 'message_start', message }, signal);
    await this.emit({ type: 'message_end', message }, signal);
    return message;
  }

  // ---- 事件 ----

  // 运行抛出的异常（例如压缩以外的意外错误）按 Pi 的方式变成一条失败的 assistant 消息。
  private async fail(error: unknown, signal: AbortSignal): Promise<void> {
    const message = {
      role: 'assistant', content: [{ type: 'text', text: '' }], api: this.state.model.api, provider: this.state.model.provider, model: this.state.model.id,
      usage: EMPTY_USAGE, stopReason: signal.aborted ? 'aborted' : 'error', errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now(),
    } as AssistantMessage;
    await this.emit({ type: 'message_start', message }, signal);
    await this.emit({ type: 'message_end', message }, signal);
    await this.emit({ type: 'turn_end', message, toolResults: [] }, signal);
    await this.emit({ type: 'agent_end', messages: [message] }, signal);
  }

  private async emit(event: AgentEvent, signal: AbortSignal): Promise<void> {
    if (event.type === 'message_end') this.state.messages.push(event.message);
    if (event.type === 'turn_end' && event.message.role === 'assistant' && event.message.errorMessage) this.state.errorMessage = event.message.errorMessage;
    for (const listener of this.listeners) await listener(event, signal);
  }
}
