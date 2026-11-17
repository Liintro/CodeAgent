import type {
  Acceptance,
  ApprovalDecision,
  ChangesView,
  DeliveryActionResult,
  DeliveryView,
  DetectedCommand,
  DiffView,
  DocumentView,
  McpServerDefinition,
  MemoryChange,
  MemoryItemView,
  ModelInput,
  ModelProfile,
  PermissionSetting,
  RootView,
  RunEvent,
  SnapshotEnvelope,
  UserMode,
  WorkbenchEvent,
} from '../../shared/contracts/index.js';
import { PermissionGate } from '../policy/permission-gate.js';
import { AgentEvents } from '../services/agent-events.js';
import { DeliveryService } from '../services/delivery.js';
import { MemoryService } from '../services/memory.js';
import { ModelService } from '../services/model.js';
import { RunController } from '../services/run-controller.js';
import { TaskService } from '../services/task-service.js';
import { Workbench, type SandboxOptions } from '../services/workbench.js';
import type { SandboxRunner } from '../tools/sandbox.js';
import type { HarnessPolicy } from './policy.js';

export { MODEL_RETRY } from '../services/model.js';

/** Host 对外的运行时接口：组装各个 service，并把每个命令转给负责的 service。 */
export class AgentRuntime {
  private readonly wb: Workbench;
  private readonly sandbox?: SandboxRunner;
  private readonly tasks: TaskService;
  private readonly memory: MemoryService;
  private readonly deliveries: DeliveryService;
  private readonly gate: PermissionGate;
  private readonly model: ModelService;
  private readonly runs: RunController;

  // 未提供 dataDir 时（运行时测试）账本与会话都只在内存中。
  constructor(
    hostInstanceId: string,
    rulesPath: string,
    send: (event: WorkbenchEvent) => void,
    sandbox?: SandboxOptions,
    dataDir?: string,
  ) {
    this.wb = new Workbench(hostInstanceId, send, sandbox, dataDir);
    this.sandbox = this.wb.sandbox;
    this.tasks = new TaskService(this.wb, task => this.deliveries.restoreViews(task));
    this.memory = new MemoryService(this.wb);
    this.deliveries = new DeliveryService(this.wb, this.tasks, this.memory);
    this.gate = new PermissionGate(this.wb, this.tasks, this.memory);
    this.model = new ModelService(this.wb);
    this.runs = new RunController(this.wb, rulesPath, {
      tasks: this.tasks, deliveries: this.deliveries, memory: this.memory, gate: this.gate, events: new AgentEvents(this.wb), model: this.model,
    });
    this.tasks.restoreTasks();
  }

  // 上次异常退出时遗留的授权：新的 Host 不再持有它们，直接撤销。
  async revokeStaleGrants(paths: string[]): Promise<void> {
    for (const path of paths) await this.sandbox?.revoke(path).catch(() => undefined);
  }

  revalidateRoots(): Promise<void> {
    return this.tasks.revalidateRoots();
  }

  getSnapshot(): SnapshotEnvelope {
    return this.wb.getSnapshot();
  }

  getRunEvents(runId: string): RunEvent[] {
    return this.wb.ledger.events(runId);
  }

  // ---- 配置 ----

  setModel(profile: ModelInput | undefined, apiKey?: string, models?: ModelProfile[]): ModelProfile | undefined {
    this.wb.assertIdle();
    this.wb.profile = profile;
    this.wb.apiKey = apiKey;
    // 当前模型的密钥解密失败时，列表里也要显示为未配置，提示用户重新输入。
    this.wb.models = (models ?? (profile ? [{ ...profile, hasApiKey: true }] : []))
      .map(item => item.id === profile?.id ? { ...item, hasApiKey: Boolean(apiKey) } : item);
    this.wb.emitSnapshot();
    return profile && { ...profile, hasApiKey: Boolean(apiKey) };
  }

  testModel(): Promise<{ text: string }> {
    return this.model.testModel();
  }

  async setMcpServers(servers: McpServerDefinition[]): Promise<void> {
    await this.wb.mcp.setServers(servers);
  }

  setPolicy(policy: HarnessPolicy): void {
    this.wb.assertIdle();
    this.wb.policy = policy;
  }

  setNavigationEnabled(enabled: boolean): void {
    this.wb.assertIdle();
    this.wb.navigationEnabled = enabled;
  }

  setMemoryEnabled(enabled: boolean): void {
    this.memory.setEnabled(enabled);
  }

  // 开启需要完整配置；关闭或缺少接口地址时一律回到未配置状态（工具不存在）。
  setWebSearch(config: { enabled: boolean; searchUrl?: string; apiKeyHeader?: string; apiKey?: string }): void {
    this.wb.webSearch = config.enabled && config.searchUrl
      ? {
        searchUrl: config.searchUrl,
        ...(config.apiKeyHeader ? { apiKeyHeader: config.apiKeyHeader } : {}),
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      }
      : undefined;
    this.wb.emitSnapshot();
  }

  // ---- 任务 ----

  newTask(rootPaths: string[] = []): Promise<void> {
    return this.tasks.newTask(rootPaths);
  }

  selectTask(taskId: string): void {
    this.tasks.selectTask(taskId);
  }

  renameTask(taskId: string, title: string): void {
    this.tasks.renameTask(taskId, title);
  }

  deleteTask(taskId: string): Promise<void> {
    return this.tasks.deleteTask(taskId);
  }

  addRoot(path: string, grantSandbox = false): Promise<RootView> {
    return this.tasks.addRoot(path, grantSandbox);
  }

  removeRoot(rootId: string): Promise<void> {
    return this.tasks.removeRoot(rootId);
  }

  addDocument(path: string): Promise<DocumentView> {
    return this.tasks.addDocument(path);
  }

  removeDocument(documentId: string): void {
    this.tasks.removeDocument(documentId);
  }

  setPrimaryRoot(rootId: string): void {
    this.tasks.setPrimaryRoot(rootId);
  }

  setPermission(userMode: UserMode): Promise<PermissionSetting> {
    return this.tasks.setPermission(userMode);
  }

  detectAcceptance(): Promise<DetectedCommand[]> {
    return this.tasks.detectAcceptance();
  }

  setAcceptance(acceptance: Acceptance): void {
    this.tasks.setAcceptance(acceptance);
  }

  // ---- Run ----

  startMessage(text: string): { runId: string } {
    return this.runs.startMessage(text);
  }

  implementPlan(): Promise<{ runId: string }> {
    return this.runs.implementPlan();
  }

  continueTask(): { runId: string } {
    return this.runs.continueTask();
  }

  verifyNow(): { runId: string } {
    return this.runs.verifyNow();
  }

  cancelRun(runId: string): void {
    this.runs.cancelRun(runId);
  }

  decideApproval(approvalId: string, decision: ApprovalDecision, reason?: string): void {
    this.gate.decideApproval(approvalId, decision, reason);
  }

  // ---- 记忆 ----

  listMemory(): Promise<MemoryItemView[]> {
    return this.memory.listMemory();
  }

  changeMemory(change: MemoryChange): void {
    this.memory.changeMemory(change);
  }

  addMemoryNote(text: string): Promise<void> {
    return this.memory.addMemoryNote(text);
  }

  // ---- 变更与交付 ----

  getChanges(): Promise<ChangesView> {
    return this.deliveries.getChanges();
  }

  getDiff(rootId: string, path: string): Promise<DiffView> {
    return this.deliveries.getDiff(rootId, path);
  }

  getDelivery(): Promise<DeliveryView> {
    return this.deliveries.getDelivery();
  }

  acceptRoot(rootId: string): Promise<void> {
    return this.deliveries.acceptRoot(rootId);
  }

  restoreRoot(rootId: string): Promise<DeliveryActionResult> {
    return this.deliveries.restoreRoot(rootId);
  }

  commitRoot(rootId: string, message: string, confirmShared: boolean): Promise<DeliveryActionResult> {
    return this.deliveries.commitRoot(rootId, message, confirmShared);
  }

  async shutdown(): Promise<void> {
    const active = this.wb.active;
    if (active) {
      this.runs.cancelRun(active.id);
      await active.done;
    }
    await this.wb.mcp.closeAll();
    const granted = new Set(this.wb.tasks.flatMap(task => task.roots.filter(root => root.sandboxGranted).map(root => root.path)));
    for (const path of granted) await this.sandbox?.revoke(path).catch(() => undefined);
    this.wb.ledger.close();
  }
}
