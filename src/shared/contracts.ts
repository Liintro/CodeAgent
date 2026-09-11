export type RunPhase =
  | 'running' | 'awaiting_approval' | 'verifying' | 'cancelling'
  | 'finished' | 'failed' | 'cancelled' | 'interrupted';

export type UserMode = 'plan' | 'manual' | 'accept_edits' | 'auto' | 'bypass';
export type WorkPhase = 'plan' | 'act';
export type ApprovalPolicy = 'ask_writes_and_commands' | 'ask_commands' | 'auto_sandbox' | 'never';
export type ExecutionScope = 'selected_roots' | 'host_full_access';
export type SandboxStatus = 'untested' | 'available' | 'unavailable' | 'failed';
export type RunnerKind = 'sandbox' | 'direct';

// grants 只保存精确动作：shell:<rootId>:<命令> 或 mcp:<server>.<tool>，不存在“全部命令”授权。
export type PermissionSetting = {
  userMode: UserMode;
  phase: WorkPhase;
  approval: ApprovalPolicy;
  scope: ExecutionScope;
  grants: string[];
};

export type AppError = { code: string; message: string; detail?: string };

export type ModelProfile = {
  id: string;
  name: string;
  provider: string;
  api: 'openai-completions';
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  maxOutputTokens: number;
  reasoning: false;
  hasApiKey: boolean;
};

export type ModelInput = Omit<ModelProfile, 'hasApiKey'>;
export type KeyChange = { action: 'keep' } | { action: 'replace'; value: string } | { action: 'copy'; fromId: string } | { action: 'remove' };

export type RootView = {
  id: string;
  alias: string;
  path: string;
  primary: boolean;
  git?: { gitRoot: string; branch?: string; head?: string };
  sandboxGranted: boolean;
  /** 重启后发现目录已不存在。 */
  missing?: boolean;
};

// Task 级交付状态；verified 仅在每个被修改的目录都有当前有效的通过证据时出现。
export type Delivery = 'none' | 'unverified' | 'verifying' | 'verified' | 'verification_failed' | 'accepted' | 'restored';
export type RootDeliveryState = 'none' | 'unverified' | 'verified' | 'verification_failed' | 'accepted' | 'restored' | 'committed';

export type VerifyCommand = { id: string; rootId: string; label: string; command: string; timeoutSeconds: number };
export type DetectedCommand = VerifyCommand & { missing?: string };
export type Acceptance = { commands: VerifyCommand[]; maxRepairs: number };

export type TaskSummary = { id: string; title: string; updatedAt: number; delivery: Delivery; interrupted: boolean };
export type RunView = { id: string; taskId: string; phase: RunPhase; toolErrors: boolean; attempt?: number };

export type ToolState = 'requested' | 'awaiting_approval' | 'running' | 'succeeded' | 'failed' | 'denied' | 'cancelled' | 'unknown';
export type ToolItem = {
  kind: 'tool';
  toolCallId: string;
  name: string;
  rootId?: string;
  rootAlias?: string;
  cwd?: string;
  args: unknown;
  state: ToolState;
  output: string;
  exitCode?: number;
  durationMs?: number;
  runner?: RunnerKind;
  error?: AppError;
  source?: { mcpServer: string; tool: string };
};
export type VerificationState = 'running' | 'passed' | 'failed' | 'timeout' | 'cancelled' | 'unavailable';
export type VerificationItem = {
  kind: 'verification';
  id: string;
  attempt: number;
  rootAlias: string;
  commandLabel: string;
  command: string;
  state: VerificationState;
  exitCode?: number;
  durationMs?: number;
  outputTail: string;
  logFile?: string;
};
export type MemoryShown = { id: string; kind: MemoryKind; validity: MemoryValidity; repoLabel: string; text: string };
export type TimelineItem =
  | { kind: 'message'; id: string; role: 'user' | 'assistant'; text: string; harness?: boolean }
  | { kind: 'notice'; id: string; text: string }
  | { kind: 'memory'; id: string; items: MemoryShown[] }
  | VerificationItem
  | ToolItem;

export type ApprovalRequest = {
  id: string;
  runId: string;
  toolCallId: string;
  tool: string;
  summary: string;
  rootId?: string;
  rootAlias?: string;
  cwd?: string;
  argsText: string;
  grantKey?: string;
  runner?: RunnerKind;
};
export type ApprovalDecision = 'allow' | 'allow_task' | 'deny';

export type McpServerStatus = {
  name: string;
  state: 'disabled' | 'connecting' | 'ready' | 'failed';
  toolCount: number;
  error?: string;
  tools: { name: string; trustedReadOnly: boolean }[];
};

export type McpServerDefinition = {
  name: string;
  enabled: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  trustedReadOnly: string[];
  timeoutSeconds: number;
  /** 配置校验失败的原因；该服务不会连接。 */
  invalid?: string;
};

export type FileChange = { path: string; status: 'A' | 'M' | 'D' | 'R'; additions: number; deletions: number };
export type RootChanges =
  | { rootId: string; git: { branch?: string; baseCommit?: string; baseTree: string; nowTree: string }; files: FileChange[] }
  | { rootId: string; git: null; reason: string };
export type ChangesView = { taskId: string; computedAt: number; roots: RootChanges[] };
export type DiffView = { rootId: string; path: string; patch: string; truncated: boolean };

export type VerificationResult = {
  commandId: string;
  rootId: string;
  label: string;
  command: string;
  attempt: number;
  status: Exclude<VerificationState, 'running'>;
  exitCode?: number;
  durationMs: number;
  logFile?: string;
  outputTail: string;
  treeAtStart?: string;
};

export type RootDelivery = {
  rootId: string;
  alias: string;
  git: boolean;
  state: RootDeliveryState;
  branch?: string;
  baseCommit?: string;
  baseTree?: string;
  finalTree?: string;
  files: FileChange[];
  /** 基线时该目录已有用户未提交的修改。 */
  dirtyAtBaseline: boolean;
  /** 已有修改但没有任何验收命令。 */
  noCommands: boolean;
  verification: VerificationResult[];
  patchFile?: string;
  reportFile?: string;
  commitSha?: string;
  /** 提交会带入用户在这些文件上已有的修改，需要二次确认。 */
  sharedPaths: string[];
};
export type DeliveryView = { taskId: string; state: Delivery; roots: RootDelivery[] };
export type DeliveryActionResult = { rootId: string; skipped: string[]; commitSha?: string };

export type MemoryKind = 'change' | 'fix' | 'convention' | 'note';
export type MemoryValidity = 'current' | 'drifted' | 'reverted' | 'not_in_history' | 'unverifiable';

export type MemoryItemView = {
  id: string;
  kind: MemoryKind;
  text: string;
  status: 'active' | 'rejected';
  origin: 'harness' | 'user';
  confirmed: boolean;
  repoLabel: string;
  taskId?: string;
  taskTitle?: string;
  paths: string[];
  validity: MemoryValidity;
  updatedAt: number;
};
export type MemoryChange = { id: string; action: 'reject' | 'restore' | 'delete' } | { id: string; action: 'edit'; text: string };

export type RunEventType =
  | 'run.started' | 'git.snapshot' | 'tool.requested' | 'permission.decided' | 'tool.started'
  | 'tool.finished' | 'model.usage' | 'run.ended'
  | 'verification.started' | 'verification.finished' | 'repair.requested' | 'compaction.done' | 'delivery.changed'
  | 'memory.recalled' | 'memory.captured' | 'memory.capture_failed' | 'memory.changed';
export type RunEvent = { runId: string; seq: number; at: number; type: RunEventType; data: Record<string, unknown> };

export type WorkbenchSnapshot = {
  host: 'starting' | 'ready' | 'failed' | 'stopping' | 'stopped';
  model?: ModelProfile;
  models: ModelProfile[];
  tasks: TaskSummary[];
  taskId?: string;
  roots: RootView[];
  permission: PermissionSetting;
  sandboxStatus: SandboxStatus;
  run?: RunView;
  timeline: TimelineItem[];
  approval?: ApprovalRequest;
  error?: AppError;
  mcp: McpServerStatus[];
  changes?: ChangesView;
  acceptance: Acceptance;
  delivery?: DeliveryView;
  memoryEnabled: boolean;
};

export type Reply<T> = { ok: true; value: T } | { ok: false; error: AppError };
export type SnapshotEnvelope = { hostInstanceId: string; seq: number; value: WorkbenchSnapshot };

export type WorkbenchEvent = {
  hostInstanceId: string;
  seq: number;
  at: number;
  runId?: string;
  payload:
    | { type: 'snapshot'; value: WorkbenchSnapshot }
    | { type: 'message.started'; id: string; role: 'user' | 'assistant' }
    | { type: 'message.delta'; id: string; text: string }
    | { type: 'message.ended'; id: string; text: string }
    | { type: 'tool.updated'; value: ToolItem }
    | { type: 'approval.requested'; value: ApprovalRequest }
    | { type: 'run.changed'; value: RunView }
    | { type: 'sandbox.updated'; value: SandboxStatus }
    | { type: 'changes.updated'; value: ChangesView }
    | { type: 'mcp.updated'; value: McpServerStatus[] }
    | { type: 'verification.updated'; value: VerificationItem }
    | { type: 'delivery.updated'; value: DeliveryView }
    | { type: 'error'; value: AppError };
};

export interface DesktopBridge {
  getSnapshot(): Promise<Reply<SnapshotEnvelope>>;
  addRoot(): Promise<Reply<RootView | null>>;
  removeRoot(rootId: string): Promise<Reply<void>>;
  setPrimaryRoot(rootId: string): Promise<Reply<void>>;
  setPermission(userMode: UserMode): Promise<Reply<PermissionSetting | null>>;
  saveModel(profile: ModelInput, keyChange: KeyChange): Promise<Reply<ModelProfile>>;
  selectModel(modelId: string): Promise<Reply<ModelProfile>>;
  deleteModel(modelId: string): Promise<Reply<void>>;
  testModel(): Promise<Reply<{ text: string }>>;
  startMessage(text: string): Promise<Reply<{ runId: string }>>;
  implementPlan(): Promise<Reply<{ runId: string }>>;
  cancelRun(runId: string): Promise<Reply<void>>;
  decideApproval(approvalId: string, decision: ApprovalDecision): Promise<Reply<void>>;
  newTask(): Promise<Reply<void>>;
  selectTask(taskId: string): Promise<Reply<void>>;
  getChanges(): Promise<Reply<ChangesView>>;
  getDiff(rootId: string, path: string): Promise<Reply<DiffView>>;
  detectAcceptance(): Promise<Reply<DetectedCommand[]>>;
  setAcceptance(acceptance: Acceptance): Promise<Reply<void>>;
  verifyNow(): Promise<Reply<{ runId: string }>>;
  continueTask(): Promise<Reply<{ runId: string }>>;
  getDelivery(): Promise<Reply<DeliveryView>>;
  acceptRoot(rootId: string): Promise<Reply<void>>;
  restoreRoot(rootId: string): Promise<Reply<DeliveryActionResult | null>>;
  commitRoot(rootId: string, message: string, confirmShared: boolean): Promise<Reply<DeliveryActionResult>>;
  listMemory(): Promise<Reply<MemoryItemView[]>>;
  changeMemory(change: MemoryChange): Promise<Reply<void>>;
  addMemoryNote(text: string): Promise<Reply<void>>;
  setMemoryEnabled(enabled: boolean): Promise<Reply<void>>;
  reloadMcp(): Promise<Reply<void>>;
  setMcpEnabled(name: string, enabled: boolean): Promise<Reply<void>>;
  openMcpConfig(): Promise<Reply<void>>;
  restartHost(): Promise<Reply<void>>;
  onEvent(listener: (event: WorkbenchEvent) => void): () => void;
}

export type HostCommand =
  | { type: 'initialize'; hostInstanceId: string; dataDir: string; rulesPath: string; sandboxExe: string; sandboxTempDir: string; staleGrants: string[] }
  | { type: 'setModel'; profile?: ModelInput; apiKey?: string; models: ModelProfile[] }
  | { type: 'newTask'; rootPaths: string[] }
  | { type: 'selectTask'; taskId: string }
  | { type: 'addRoot'; path: string; grantSandbox: boolean }
  | { type: 'removeRoot'; rootId: string }
  | { type: 'setPrimaryRoot'; rootId: string }
  | { type: 'setPermission'; userMode: UserMode }
  | { type: 'testModel' }
  | { type: 'startMessage'; text: string }
  | { type: 'implementPlan' }
  | { type: 'cancelRun'; runId: string }
  | { type: 'decideApproval'; approvalId: string; decision: ApprovalDecision }
  | { type: 'getChanges' }
  | { type: 'getDiff'; rootId: string; path: string }
  | { type: 'detectAcceptance' }
  | { type: 'setAcceptance'; acceptance: Acceptance }
  | { type: 'verifyNow' }
  | { type: 'continueTask' }
  | { type: 'getDelivery' }
  | { type: 'acceptRoot'; rootId: string }
  | { type: 'restoreRoot'; rootId: string }
  | { type: 'commitRoot'; rootId: string; message: string; confirmShared: boolean }
  | { type: 'listMemory' }
  | { type: 'changeMemory'; change: MemoryChange }
  | { type: 'addMemoryNote'; text: string }
  | { type: 'setMemoryEnabled'; enabled: boolean }
  | { type: 'setMcpServers'; servers: McpServerDefinition[] }
  | { type: 'getRunEvents'; runId: string }
  | { type: 'getSnapshot' }
  | { type: 'shutdown' };

export type HostRequest = { requestId: string; command: HostCommand };
export type HostResponse =
  | { requestId: string; reply: Reply<unknown> }
  | { event: WorkbenchEvent };
