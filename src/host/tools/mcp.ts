import { createHash } from 'node:crypto';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { DEFAULT_MAX_BYTES, truncateHead } from '@earendil-works/pi-coding-agent';
import { McpClient, McpConnectionClosedError, StdioTransport, StreamableHttpTransport, toLlmContent, type McpTransport } from '@earendil-works/pi-mcp';
import type { McpServerDefinition, McpServerStatus } from '../../shared/contracts.js';

export type McpBinding = { server: string; tool: string; trustedReadOnly: boolean };
const STRUCTURED_LIMIT = 256 * 1024;

type Connection = { definition: McpServerDefinition; client?: McpClient; status: McpServerStatus; tools: AgentTool<any>[] };

export class McpManager {
  private connections = new Map<string, Connection>();
  /** 工具名 → 来源，供权限分类与证据使用。 */
  readonly bindings = new Map<string, McpBinding>();

  constructor(private readonly onChange: (statuses: McpServerStatus[]) => void) {}

  statuses(): McpServerStatus[] {
    return [...this.connections.values()].map(connection => structuredClone(connection.status));
  }

  tools(): AgentTool<any>[] {
    return [...this.connections.values()].flatMap(connection => connection.tools);
  }

  // 后台连接：不阻塞 Host 就绪；失败只体现在对应服务的状态上。
  async setServers(definitions: McpServerDefinition[]): Promise<void> {
    await this.closeAll();
    this.bindings.clear();
    for (const definition of definitions) {
      const status: McpServerStatus = definition.invalid
        ? { name: definition.name, state: 'failed', toolCount: 0, tools: [], error: definition.invalid }
        : { name: definition.name, state: definition.enabled ? 'connecting' : 'disabled', toolCount: 0, tools: [] };
      this.connections.set(definition.name, { definition, status, tools: [] });
    }
    this.onChange(this.statuses());
    for (const connection of this.connections.values()) if (connection.definition.enabled && !connection.definition.invalid) void this.connect(connection);
  }

  async closeAll(): Promise<void> {
    const connections = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(connections.map(connection => connection.client?.close().catch(() => undefined)));
  }

  private async connect(connection: Connection): Promise<void> {
    const { definition } = connection;
    const client = new McpClient({ name: 'codeagent', version: '0.1.0', requestTimeoutMs: definition.timeoutSeconds * 1000 });
    client.onError(() => undefined);
    connection.client = client;
    const transport = createTransport(definition);
    try {
      await client.connect(transport);
      const remoteTools = await client.listTools();
      if (this.connections.get(definition.name) !== connection) return;
      const used = new Set(this.bindings.keys());
      connection.tools = remoteTools.map(remote => {
        const name = toolName(definition.name, remote.name, used);
        used.add(name);
        const trusted = definition.trustedReadOnly.includes(remote.name);
        this.bindings.set(name, { server: definition.name, tool: remote.name, trustedReadOnly: trusted });
        return bridge(name, definition, remote, client);
      });
      connection.status = {
        name: definition.name, state: 'ready', toolCount: remoteTools.length,
        tools: remoteTools.map(remote => ({ name: remote.name, trustedReadOnly: definition.trustedReadOnly.includes(remote.name) })),
      };
    } catch (error) {
      await client.close().catch(() => undefined);
      connection.status = { name: definition.name, state: 'failed', toolCount: 0, tools: [], error: describeFailure(error, transport, definition) };
    }
    this.onChange(this.statuses());
  }
}

function createTransport(definition: McpServerDefinition): McpTransport {
  if (definition.command) {
    return new StdioTransport({ command: definition.command, args: definition.args, cwd: definition.cwd, env: definition.env, inheritEnv: true });
  }
  return new StreamableHttpTransport({ url: definition.url!, headers: definition.headers });
}

// 命令不存在时 pi-mcp 只报“连接已关闭”，原因丢失；改用服务的 stderr 或命令名说明。
function describeFailure(error: unknown, transport: McpTransport, definition: McpServerDefinition): string {
  if (error instanceof McpConnectionClosedError && transport instanceof StdioTransport) {
    return transport.stderr.trim().slice(-500) || `命令无法启动或立即退出：${definition.command}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function toolName(server: string, tool: string, used: Set<string>): string {
  const clean = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '_');
  const full = `mcp__${clean(server)}__${clean(tool)}`;
  if (full.length <= 64 && !used.has(full)) return full;
  const hash = createHash('sha1').update(`${server}\0${tool}`).digest('hex').slice(0, 6);
  return `${full.slice(0, 57)}_${hash}`;
}

function bridge(name: string, definition: McpServerDefinition, remote: any, client: McpClient): AgentTool<any> {
  return {
    name,
    label: `${definition.name}.${remote.name}`,
    description: remote.description ?? `${definition.name} 的 ${remote.name}`,
    parameters: remote.inputSchema ?? { type: 'object', properties: {} },
    execute: async (_toolCallId, args, signal) => {
      const result = await client.callTool(remote.name, args as Record<string, unknown>, { signal, timeoutMs: definition.timeoutSeconds * 1000 });
      const text = toLlmContent(result).map(block => block.type === 'text' ? block.text : '[图片内容未显示]').join('\n');
      const structured = result.structuredContent !== undefined && JSON.stringify(result.structuredContent).length <= STRUCTURED_LIMIT
        ? result.structuredContent : undefined;
      return {
        content: [{ type: 'text', text: truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES }).content }],
        structuredContent: structured as any,
        details: { mcp: { server: definition.name, tool: remote.name, isError: result.isError === true, structuredTruncated: result.structuredContent !== undefined && structured === undefined } },
        isError: result.isError === true,
      } as any;
    },
  };
}
