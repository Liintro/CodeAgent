import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { McpServerDefinition } from '../../shared/contracts.js';

const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

// 用户手写的 config/mcp.json；除 enabled 外 Main 从不改写它。
export class McpConfig {
  readonly file: string;

  constructor(userData: string) {
    this.file = join(userData, 'config', 'mcp.json');
  }

  async load(env: NodeJS.ProcessEnv = process.env): Promise<McpServerDefinition[]> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error('mcp.json 无法解析，请检查 JSON 格式', { cause: error });
    }
    const servers = (raw as { mcpServers?: Record<string, unknown> })?.mcpServers;
    if (!servers || typeof servers !== 'object') return [];
    return Object.entries(servers).map(([name, value]) => parseServer(name, value, env));
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const raw = JSON.parse(await readFile(this.file, 'utf8')) as { mcpServers?: Record<string, Record<string, unknown>> };
    if (!raw.mcpServers?.[name]) throw new Error('MCP 服务不存在');
    raw.mcpServers[name].enabled = enabled;
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = join(dirname(this.file), `mcp.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(raw, null, 2), { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, this.file);
  }
}

function parseServer(name: string, value: unknown, env: NodeJS.ProcessEnv): McpServerDefinition {
  const base: McpServerDefinition = { name, enabled: false, trustedReadOnly: [], timeoutSeconds: 60 };
  try {
    if (!NAME_PATTERN.test(name)) throw new Error('服务名只能包含字母、数字、下划线和连字符（最多 32 位）');
    if (!value || typeof value !== 'object') throw new Error('配置必须是对象');
    const input = value as Record<string, unknown>;
    if (Boolean(input.command) === Boolean(input.url)) throw new Error('command 与 url 必须二选一');
    const definition: McpServerDefinition = { ...base, enabled: input.enabled !== false };
    if (input.command !== undefined) {
      if (typeof input.command !== 'string') throw new Error('command 必须是字符串');
      definition.command = input.command;
      if (input.args !== undefined) definition.args = stringArray(input.args, 'args');
      if (input.cwd !== undefined) definition.cwd = string(input.cwd, 'cwd');
      if (input.env !== undefined) definition.env = stringMap(input.env, 'env', env);
    } else {
      definition.url = string(input.url, 'url');
      if (!['http:', 'https:'].includes(new URL(definition.url).protocol)) throw new Error('url 仅支持 HTTP 或 HTTPS');
      if (input.headers !== undefined) definition.headers = stringMap(input.headers, 'headers', env);
    }
    if (input.trustedReadOnly !== undefined) definition.trustedReadOnly = stringArray(input.trustedReadOnly, 'trustedReadOnly');
    if (input.timeoutSeconds !== undefined) {
      if (!Number.isInteger(input.timeoutSeconds) || (input.timeoutSeconds as number) <= 0) throw new Error('timeoutSeconds 必须是正整数');
      definition.timeoutSeconds = input.timeoutSeconds as number;
    }
    return definition;
  } catch (error) {
    return { ...base, invalid: error instanceof Error ? error.message : String(error) };
  }
}

const string = (value: unknown, field: string): string => {
  if (typeof value !== 'string') throw new Error(`${field} 必须是字符串`);
  return value;
};
const stringArray = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`${field} 必须是字符串数组`);
  return value as string[];
};

// 值恰好为 ${env:NAME} 时从桌面进程环境取值；缺失则该服务显示失败，不打印解析后的值。
function stringMap(value: unknown, field: string, env: NodeJS.ProcessEnv): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} 必须是对象`);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    const text = string(item, `${field}.${key}`);
    const reference = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(text);
    if (reference) {
      const resolved = env[reference[1]];
      if (resolved === undefined) throw new Error(`环境变量 ${reference[1]} 未设置`);
      result[key] = resolved;
    } else {
      result[key] = text;
    }
  }
  return result;
}
