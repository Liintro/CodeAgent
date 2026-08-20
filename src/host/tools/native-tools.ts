import { realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { createPowerShellTool, createReadTool } from '@earendil-works/pi-coding-agent';

const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

export function createNativeTools(root: string, onRunning: (toolCallId: string) => void): AgentTool<any>[] {
  const read = createReadTool(root);
  const scopedRead: AgentTool<any> = {
    ...read,
    execute: async (toolCallId, params: any, signal, onUpdate) => {
      onRunning(toolCallId);
      const candidate = resolve(root, params.path);
      let path = candidate;
      try {
        path = await realpath(candidate);
        const relation = relative(root, path);
        if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
          throw new Error('路径超出当前项目目录');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (imageExtensions.has(extname(path).toLowerCase())) throw new Error('本版本不支持读取图片文件');
      return read.execute(toolCallId, { ...params, path }, signal, onUpdate);
    },
  };

  const powershell = createPowerShellTool(root, { exposeSessionEnvironment: false });
  const controlledPowerShell: AgentTool<any> = {
    ...powershell,
    execute: (toolCallId, params: any, signal, onUpdate) => {
      onRunning(toolCallId);
      return powershell.execute(toolCallId, params, signal, onUpdate);
    },
  };
  return [scopedRead, controlledPowerShell];
}
