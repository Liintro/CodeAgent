import type { AgentTool } from '@earendil-works/pi-agent-core';

export type MemorySearchParams = { path?: string; identifier?: string; failure?: string };

/** memory_search：只读，计划模式也可用；结果带有效性状态，由模型自行判断是否采用。 */
export function createMemoryTool(search: (params: MemorySearchParams) => Promise<string>, onStarted: (toolCallId: string) => void): AgentTool<any> {
  return {
    name: 'memory_search',
    label: 'memory_search',
    description: '查询这个仓库的历史记忆（过去任务里验证过的修复、可用的验证命令、用户备注与教训）。按文件路径、标识符或失败信息查找；每条结果都标明它在当前代码上是否仍然有效。记忆只供参考，一切以当前代码为准。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相关文件路径，例如 src/calc.ts' },
        identifier: { type: 'string', description: '函数、类或配置项等标识符' },
        failure: { type: 'string', description: '失败信息或报错片段' },
      },
    },
    execute: async (toolCallId: string, params: any) => {
      onStarted(toolCallId);
      const { path, identifier, failure } = params as Record<string, unknown>;
      const request = { path: text(path), identifier: text(identifier), failure: text(failure) };
      if (!request.path && !request.identifier && !request.failure) throw new Error('至少提供 path、identifier、failure 之一');
      return { content: [{ type: 'text', text: await search(request) }], details: {} };
    },
  };
}

const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 500) : undefined;
