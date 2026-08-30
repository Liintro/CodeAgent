export type RunPhase =
  | 'running' | 'awaiting_approval' | 'cancelling'
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
  api: 'openai-completions';
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  maxOutputTokens: number;
  reasoning: false;
  hasApiKey: boolean;
};

export type ModelInput = Omit<ModelProfile, 'hasApiKey'>;
export type KeyChange = { action: 'keep' } | { action: 'replace'; value: string } | { action: 'remove' };

export type RootView = {
  id: string;
  alias: string;
  path: string;
  primary: boolean;
  git?: { gitRoot: string; branch?: string; head?: string };
  sandboxGranted: boolean;
};

export type TaskSummary = { id: string; title: string; updatedAt: number };
export type RunView = { id: string; taskId: string; phase: RunPhase; toolErrors: boolean };

export type ToolState = 'requested' | 'awaiting_approval' | 'running' | 'succeeded' | 'failed' | 'denied' | 'cancelled';
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
export type TimelineItem =
  | { kind: 'message'; id: string; role: 'user' | 'assistant'; text: string }
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

export type RunEventType =
  | 'run.started' | 'git.snapshot' | 'tool.requested' | 'permission.decided' | 'tool.started'
  | 'tool.finished' | 'model.usage' | 'run.ended';
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
  testModel(): Promise<Reply<{ text: string }>>;
  startMessage(text: string): Promise<Reply<{ runId: string }>>;
  implementPlan(): Promise<Reply<{ runId: string }>>;
  cancelRun(runId: string): Promise<Reply<void>>;
  decideApproval(approvalId: string, decision: ApprovalDecision): Promise<Reply<void>>;
  newTask(): Promise<Reply<void>>;
  selectTask(taskId: string): Promise<Reply<void>>;
  getChanges(): Promise<Reply<ChangesView>>;
  getDiff(rootId: string, path: string): Promise<Reply<DiffView>>;
  reloadMcp(): Promise<Reply<void>>;
  setMcpEnabled(name: string, enabled: boolean): Promise<Reply<void>>;
  openMcpConfig(): Promise<Reply<void>>;
  restartHost(): Promise<Reply<void>>;
  onEvent(listener: (event: WorkbenchEvent) => void): () => void;
}

export type HostCommand =
  | { type: 'initialize'; hostInstanceId: string; rulesPath: string; sandboxExe: string; sandboxTempDir: string; staleGrants: string[] }
  | { type: 'setModel'; profile: ModelInput; apiKey?: string; models: ModelProfile[] }
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
  | { type: 'setMcpServers'; servers: McpServerDefinition[] }
  | { type: 'getRunEvents'; runId: string }
  | { type: 'getSnapshot' }
  | { type: 'shutdown' };

export type HostRequest = { requestId: string; command: HostCommand };
export type HostResponse =
  | { requestId: string; reply: Reply<unknown> }
  | { event: WorkbenchEvent };
