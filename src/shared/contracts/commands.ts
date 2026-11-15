import type { RunEvent, SnapshotEnvelope, WorkbenchEvent } from './events.js';
import type {
  Acceptance, AppError, ApprovalDecision, ChangesView, DeliveryActionResult, DeliveryView, DetectedCommand, DiffView, DocumentView, KeyChange,
  McpServerDefinition, MemoryChange, MemoryItemView, ModelInput, ModelProfile, PermissionSetting, Preferences, RootView, UserMode, WebSearchInput,
} from './views.js';

export type Reply<T> = { ok: true; value: T } | { ok: false; error: AppError };

export interface DesktopBridge {
  getSnapshot(): Promise<Reply<SnapshotEnvelope>>;
  addRoot(): Promise<Reply<RootView | null>>;
  removeRoot(rootId: string): Promise<Reply<void>>;
  addDocument(): Promise<Reply<DocumentView | null>>;
  removeDocument(documentId: string): Promise<Reply<void>>;
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
  renameTask(taskId: string, title: string): Promise<Reply<void>>;
  deleteTask(taskId: string): Promise<Reply<void>>;
  getRunEvents(runId: string): Promise<Reply<RunEvent[]>>;
  getPreferences(): Promise<Reply<Preferences>>;
  setPreferences(preferences: Preferences): Promise<Reply<Preferences>>;
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
  setWebSearch(config: WebSearchInput): Promise<Reply<void>>;
  reloadMcp(): Promise<Reply<void>>;
  setMcpEnabled(name: string, enabled: boolean): Promise<Reply<void>>;
  openMcpConfig(): Promise<Reply<void>>;
  restartHost(): Promise<Reply<void>>;
  onEvent(listener: (event: WorkbenchEvent) => void): () => void;
}

export type HostCommand =
  | { type: 'initialize'; protocolVersion: number; hostInstanceId: string; dataDir: string; rulesPath: string; sandboxExe: string; sandboxTempDir: string; staleGrants: string[] }
  | { type: 'setModel'; profile?: ModelInput; apiKey?: string; models: ModelProfile[] }
  | { type: 'newTask'; rootPaths: string[] }
  | { type: 'selectTask'; taskId: string }
  | { type: 'renameTask'; taskId: string; title: string }
  | { type: 'deleteTask'; taskId: string }
  | { type: 'addRoot'; path: string; grantSandbox: boolean }
  | { type: 'removeRoot'; rootId: string }
  | { type: 'addDocument'; path: string }
  | { type: 'removeDocument'; documentId: string }
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
  | { type: 'setWebSearch'; config: WebSearchInput }
  | { type: 'setMcpServers'; servers: McpServerDefinition[] }
  | { type: 'getRunEvents'; runId: string }
  | { type: 'getSnapshot' }
  | { type: 'shutdown' };

export type HostRequest = { requestId: string; command: HostCommand };
export type HostResponse =
  | { requestId: string; reply: Reply<unknown> }
  | { event: WorkbenchEvent };
