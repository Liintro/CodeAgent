import { Agent, type AgentEvent, type AgentMessage, type AgentOptions } from '@earendil-works/pi-agent-core';
import { NativeAgent, type ToolScheduling } from './loop.js';

export type KernelName = 'native' | 'pi';

/** 运行时用到的 Agent 接口：Pi Agent 与自研循环都满足。 */
export interface KernelAgent {
  readonly state: { messages: AgentMessage[]; readonly errorMessage?: string };
  prompt(messages: AgentMessage[] | string): Promise<void>;
  continue(): Promise<void>;
  abort(): void;
  waitForIdle(): Promise<void>;
  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => unknown): () => void;
}

export type KernelOptions = AgentOptions & { scheduling: ToolScheduling };

/** CODEAGENT_KERNEL=pi 切回 Pi 的循环（保留到运行中交互完成为止）；会话与账本两种内核相同。 */
export function kernelFromEnv(): KernelName {
  const value = process.env.CODEAGENT_KERNEL ?? 'native';
  if (value !== 'native' && value !== 'pi') throw new Error(`CODEAGENT_KERNEL 只能是 native 或 pi：${value}`);
  return value;
}

export function createAgent(kernel: KernelName, { scheduling, ...options }: KernelOptions): KernelAgent {
  if (kernel === 'native') return new NativeAgent({ ...options, scheduling });
  // 回退时与原来完全相同：工具逐个执行。
  return new Agent({ ...options, toolExecution: 'sequential' });
}
