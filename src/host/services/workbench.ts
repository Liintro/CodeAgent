import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent, AgentMessage } from '@earendil-works/pi-agent-core';
import type { SessionManager } from '@earendil-works/pi-coding-agent';
import type {
  Acceptance,
  AppError,
  ChangesView,
  Delivery,
  DeliveryView,
  DocumentView,
  ModelInput,
  ModelProfile,
  PermissionSetting,
  RootView,
  RunnerKind,
  RunPhase,
  RunView,
  SandboxStatus,
  SnapshotEnvelope,
  TaskSummary,
  TimelineItem,
  ToolItem,
  VerificationItem,
  WorkbenchEvent,
  WorkbenchSnapshot,
} from '../../shared/contracts/index.js';
import { DEFAULT_MAX_REPAIRS } from '../../shared/constants.js';
import { DocumentLibrary, type DocumentRecord } from '../documents/index.js';
import { MemoryStore } from '../memory/store.js';
import { Ledger } from '../runtime/ledger.js';
import { initialPolicy, type HarnessPolicy } from '../runtime/policy.js';
import { McpManager } from '../tools/mcp.js';
import { ApprovalBroker, permissionFor } from '../tools/permission.js';
import { SandboxRunner } from '../tools/sandbox.js';
import type { WebSearchRuntimeConfig } from '../tools/web.js';

export type TaskState = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  roots: RootView[];
  /** 只读的任务文档（可在工作目录之外）。 */
  documents: DocumentRecord[];
  permission: PermissionSetting;
  acceptance: Acceptance;
  delivery: Delivery;
  deliveryView?: DeliveryView;
  /** 非 Git 目录没有树对象，用工具修改次数代替。 */
  mutations: Map<string, number>;
  interrupted: boolean;
  loaded: boolean;
  session: SessionManager;
  timeline: TimelineItem[];
  run?: RunView;
  error?: AppError;
  changes?: ChangesView;
  /** 本次 Run 开始时计算的仓库概况（不持久化）。 */
  profile?: string;
};
export type ActiveRun = {
  id: string;
  kind: 'prompt' | 'test';
  taskId?: string;
  agent?: Agent;
  verifyAbort: AbortController;
  cancelRequested: boolean;
  /** 下一次模型请求前无条件压缩一次（length 停止后的恢复）。 */
  forceCompaction?: boolean;
  done?: Promise<unknown>;
};
export type RunEnd = { phase: 'finished' | 'failed' | 'cancelled'; stopReason: string; error?: AppError };
export type SandboxOptions = { exe: string; tempDir: string };

/** 各个 service 共享的状态：任务列表、当前执行、模型配置，以及向主进程发送事件与快照。 */
export class Workbench {
  profile?: ModelInput;
  models: ModelProfile[] = [];
  apiKey?: string;
  tasks: TaskState[] = [];
  taskId?: string;
  active?: ActiveRun;
  testRun?: RunView;
  error?: AppError;
  memoryEnabled = true;
  /** 仓库概况与代码导航工具；评测消融时关闭。 */
  navigationEnabled = true;
  /** 联网搜索配置；未配置时 web 工具不存在，评测环境从不配置。 */
  webSearch?: WebSearchRuntimeConfig;
  /** Harness 策略包（经验手册 + 白名单参数）；默认策略不改变任何行为。 */
  policy: HarnessPolicy = initialPolicy();
  readonly ledger: Ledger;
  readonly memory: MemoryStore;
  readonly broker = new ApprovalBroker();
  readonly mcp: McpManager;
  readonly sandbox?: SandboxRunner;
  readonly runners = new Map<string, RunnerKind>();
  readonly startedAt = new Map<string, number>();
  readonly library: DocumentLibrary;
  private seq = 0;

  // 未提供 dataDir 时（运行时测试）账本与会话都只在内存中。
  constructor(
    private readonly hostInstanceId: string,
    private readonly send: (event: WorkbenchEvent) => void,
    sandbox?: SandboxOptions,
    readonly dataDir?: string,
  ) {
    this.ledger = new Ledger(dataDir ? join(dataDir, 'data', 'tasks.sqlite') : ':memory:');
    this.memory = new MemoryStore(this.ledger.database);
    this.library = new DocumentLibrary(dataDir ? join(dataDir, 'docs') : undefined);
    this.mcp = new McpManager(() => this.emit({ type: 'mcp.updated', value: this.mcp.statuses() }));
    if (sandbox) {
      this.sandbox = new SandboxRunner(sandbox.exe, sandbox.tempDir);
      void this.sandbox.verify().then(status => this.emit({ type: 'sandbox.updated', value: status }));
    }
  }

  getSnapshot(): SnapshotEnvelope {
    return { hostInstanceId: this.hostInstanceId, seq: this.seq, value: this.snapshot() };
  }

  requireTask(): TaskState {
    const task = this.tasks.find(item => item.id === this.taskId);
    if (!task) throw new Error('当前没有任务');
    return task;
  }

  taskOf(active: ActiveRun): TaskState | undefined {
    return this.tasks.find(item => item.id === active.taskId);
  }

  assertConfigured(): void {
    if (!this.profile || !this.apiKey) throw new Error('请先保存完整的模型配置和 API Key');
  }

  assertIdle(): void {
    if (this.active) throw new Error('当前执行尚未结束');
  }

  // ---- 时间线 ----

  updateTool(task: TaskState, toolCallId: string, update: Partial<ToolItem>): void {
    const index = task.timeline.findIndex(item => item.kind === 'tool' && item.toolCallId === toolCallId);
    if (index < 0) return;
    const value = { ...task.timeline[index], ...update } as ToolItem;
    task.timeline[index] = value;
    this.emit({ type: 'tool.updated', value });
  }

  upsertVerification(task: TaskState, item: VerificationItem): void {
    const index = task.timeline.findIndex(value => value.kind === 'verification' && value.id === item.id);
    if (index < 0) task.timeline.push(item);
    else task.timeline[index] = item;
    this.emit({ type: 'verification.updated', value: item });
  }

  // 用户消息、自动验证反馈、恢复说明都是进入会话的 user 消息；harness 标记它们在界面上折叠显示。
  pushMessage(task: TaskState, message: { text: string; harness?: boolean; beforeLast?: boolean }): void {
    const item: TimelineItem = { kind: 'message', id: randomUUID(), role: 'user', text: message.text, harness: message.harness || undefined };
    if (message.beforeLast) {
      task.timeline.splice(task.timeline.length - 1, 0, item);
      this.emitSnapshot();
      return;
    }
    task.timeline.push(item);
    this.emit({ type: 'message.started', id: item.id, role: 'user' });
    this.emit({ type: 'message.ended', id: item.id, text: message.text });
  }

  setPhase(task: TaskState, phase: RunPhase, attempt?: number): void {
    if (!task.run || task.run.phase === 'cancelling') return;
    task.run = { ...task.run, phase, attempt };
    this.emitRun(task);
  }

  // ---- 目录与沙箱 ----

  rootFor(task: TaskState, args: Record<string, unknown>): RootView | undefined {
    if (!task.roots.length) return undefined;
    return typeof args.root === 'string' ? task.roots.find(root => root.alias === args.root) : task.roots.find(root => root.primary);
  }

  commandsOf(task: TaskState, rootId: string) {
    return task.acceptance.commands.filter(command => command.rootId === rootId);
  }

  sandboxStatus(): SandboxStatus {
    return this.sandbox?.status ?? 'unavailable';
  }

  sandboxReady(task: TaskState): boolean {
    return this.sandbox?.status === 'available' && task.roots.length > 0 && task.roots.every(root => root.sandboxGranted);
  }

  evidenceRoot(): string {
    return join(this.dataDir ?? join(tmpdir(), 'codeagent-evidence'), 'evidence');
  }

  // ---- 事件与快照 ----

  emitRun(task?: TaskState): void {
    const run = task?.run ?? this.testRun;
    if (run) this.emit({ type: 'run.changed', value: run });
  }

  emitSnapshot(): void {
    this.emit({ type: 'snapshot', value: this.snapshot() });
  }

  emit(payload: WorkbenchEvent['payload']): void {
    this.send({
      hostInstanceId: this.hostInstanceId,
      seq: ++this.seq,
      at: Date.now(),
      runId: this.active?.id,
      payload: structuredClone(payload),
    });
  }

  private snapshot(): WorkbenchSnapshot {
    const task = this.tasks.find(item => item.id === this.taskId);
    const summaries: TaskSummary[] = [...this.tasks].sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ id, title, updatedAt, delivery: state, interrupted, roots }) => ({ id, title, updatedAt, delivery: state, interrupted, project: roots.find(root => root.primary)?.alias }));
    return structuredClone({
      host: 'ready',
      model: this.profile ? { ...this.profile, hasApiKey: Boolean(this.apiKey) } : undefined,
      models: this.models,
      tasks: summaries,
      taskId: task?.id,
      roots: task?.roots ?? [],
      permission: task?.permission ?? permissionFor('manual'),
      sandboxStatus: this.sandboxStatus(),
      run: this.testRun ?? task?.run,
      timeline: task?.timeline ?? [],
      approval: this.broker.current,
      error: task?.error ?? this.error,
      mcp: this.mcp.statuses(),
      changes: task?.changes,
      acceptance: task?.acceptance ?? { commands: [], maxRepairs: DEFAULT_MAX_REPAIRS },
      delivery: task?.deliveryView,
      memoryEnabled: this.memoryEnabled,
      webSearch: this.webSearch ? {
        enabled: true,
        searchUrl: this.webSearch.searchUrl,
        ...(this.webSearch.apiKeyHeader ? { apiKeyHeader: this.webSearch.apiKeyHeader } : {}),
        hasApiKey: Boolean(this.webSearch.apiKey),
      } : { enabled: false, hasApiKey: false },
      documents: task?.documents.map(documentView) ?? [],
    });
  }
}

export function documentView({ mtimeMs: _mtime, size: _size, ...view }: DocumentRecord): DocumentView {
  return view;
}

export function userMessage(text: string): Extract<AgentMessage, { role: 'user' }> {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() };
}

export function createError(code: string, message: string, detail: unknown, apiKey?: string): AppError {
  let text = detail instanceof Error ? detail.message : typeof detail === 'string' ? detail : detail ? String(detail) : '';
  if (apiKey) text = text.replaceAll(apiKey, '[已隐藏]');
  if (/\b(401|403)\b/.test(text)) message = '模型认证或访问失败';
  return { code, message, detail: text || undefined };
}
