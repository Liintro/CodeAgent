import { realpath } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  createEditTool, createFindTool, createGrepTool, createLsTool, createPowerShellTool, createReadTool, createWriteTool,
  DEFAULT_MAX_BYTES, truncateHead,
} from '@earendil-works/pi-coding-agent';
import type { RootView, RunnerKind } from '../../shared/contracts.js';
import { readOnly, type GitReadOp } from '../workspace/git.js';
import type { SandboxRunner } from './sandbox.js';

const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

export type ToolContext = {
  roots: RootView[];
  fullAccess: boolean;
  sandbox?: SandboxRunner;
  /** 工具即将真正执行；shell 另带 runner。 */
  onStarted: (toolCallId: string, root: RootView | undefined) => void;
  runnerOf: (toolCallId: string) => RunnerKind;
  includeShell: boolean;
  includeEdit: boolean;
};

export function createRootTools(ctx: ToolContext): AgentTool<any>[] {
  const tools: AgentTool<any>[] = [
    scoped('read', createReadTool, ctx),
    scoped('grep', createGrepTool, ctx),
    scoped('find', createFindTool, ctx),
    scoped('ls', createLsTool, ctx),
    gitTool(ctx),
  ];
  if (ctx.includeEdit) tools.push(scoped('edit', createEditTool, ctx), scoped('write', createWriteTool, ctx));
  if (ctx.includeShell) tools.push(shellTool(ctx));
  return tools;
}

function pickRoot(ctx: ToolContext, alias: unknown): RootView {
  const root = alias === undefined ? ctx.roots.find(item => item.primary) : ctx.roots.find(item => item.alias === alias);
  if (!root) throw new Error(`未知的 root：${String(alias)}`);
  return root;
}

function withRootParameter(schema: any, ctx: ToolContext): any {
  return {
    ...schema,
    properties: {
      root: { type: 'string', enum: ctx.roots.map(root => root.alias), description: '工作目录别名，默认主目录' },
      ...schema.properties,
    },
  };
}

function scoped(name: string, factory: (cwd: string) => AgentTool<any>, ctx: ToolContext): AgentTool<any> {
  const base = factory(ctx.roots[0].path);
  const instances = new Map<string, AgentTool<any>>();
  return {
    ...base,
    parameters: withRootParameter(base.parameters, ctx),
    execute: async (toolCallId, params: any, signal, onUpdate) => {
      const { root: alias, ...rest } = params;
      const root = pickRoot(ctx, alias);
      if (typeof rest.path === 'string') {
        rest.path = await resolveInScope(ctx.roots, root.path, rest.path, ctx.fullAccess);
        if (name === 'read' && imageExtensions.has(extname(rest.path).toLowerCase())) throw new Error('本版本不支持读取图片文件');
      }
      ctx.onStarted(toolCallId, root);
      let instance = instances.get(root.id);
      if (!instance) instances.set(root.id, instance = factory(root.path));
      return instance.execute(toolCallId, rest, signal, onUpdate);
    },
  };
}

function shellTool(ctx: ToolContext): AgentTool<any> {
  const base = createPowerShellTool(ctx.roots[0].path, { exposeSessionEnvironment: false });
  const instances = new Map<string, AgentTool<any>>();
  return {
    ...base,
    parameters: withRootParameter(base.parameters, ctx),
    execute: (toolCallId, params: any, signal, onUpdate) => {
      const { root: alias, ...rest } = params;
      const root = pickRoot(ctx, alias);
      const runner = ctx.runnerOf(toolCallId);
      ctx.onStarted(toolCallId, root);
      const key = `${root.id}:${runner}`;
      let instance = instances.get(key);
      if (!instance) {
        const operations = runner === 'sandbox' ? ctx.sandbox!.operations() : ctx.sandbox?.directOperations();
        instances.set(key, instance = createPowerShellTool(root.path, { exposeSessionEnvironment: false, operations }));
      }
      return instance.execute(toolCallId, rest, signal, onUpdate);
    },
  };
}

function gitTool(ctx: ToolContext): AgentTool<any> {
  return {
    name: 'git',
    label: 'git',
    description: '只读 Git 查询：status、diff、log、show。不能修改仓库。',
    parameters: withRootParameter({
      type: 'object',
      required: ['op'],
      properties: {
        op: { type: 'string', enum: ['status', 'diff', 'log', 'show'] },
        rev: { type: 'string', description: '提交或分支，如 HEAD~1' },
        path: { type: 'string', description: '限定的相对路径' },
      },
    }, ctx),
    execute: async (toolCallId, params: any) => {
      const root = pickRoot(ctx, params.root);
      ctx.onStarted(toolCallId, root);
      const output = await readOnly(root.path, params.op as GitReadOp, params.rev, params.path);
      const truncated = truncateHead(output, { maxBytes: DEFAULT_MAX_BYTES });
      return { content: [{ type: 'text', text: truncated.content || '（无输出）' }], details: undefined };
    },
  };
}

// 对尚不存在的目标（write）也要检查：取最近的已存在祖先做 realpath，符号链接与 junction 因此无法绕过。
export async function resolveInScope(roots: RootView[], base: string, requested: string, fullAccess: boolean): Promise<string> {
  const target = resolve(base, requested);
  if (fullAccess) return target;
  let ancestor = target;
  for (;;) {
    try {
      const real = join(await realpath(ancestor), relative(ancestor, target));
      if (!roots.some(root => contains(root.path, real))) throw new Error(`路径超出当前项目目录：${requested}`);
      return target;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

function contains(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}
