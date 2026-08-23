export type InvocationPhase =
  | 'running' | 'awaiting_approval' | 'cancelling'
  | 'finished' | 'failed' | 'cancelled' | 'interrupted';

export type AppError = { code: string; message: string; detail?: string };
export type WorkspaceRoot = { id: string; name: string; path: string };

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

export type TimelineItem =
  | { kind: 'message'; id: string; role: 'user' | 'assistant'; text: string }
  | {
      kind: 'tool';
      toolCallId: string;
      name: string;
      cwd?: string;
      args: unknown;
      state: 'requested' | 'awaiting_approval' | 'running' | 'succeeded' | 'failed' | 'denied' | 'cancelled';
      output: string;
      exitCode?: number;
      error?: AppError;
    };

export type InvocationView = { id: string; phase: InvocationPhase; toolErrors: boolean };
export type ApprovalRequest = { id: string; invocationId: string; toolCallId: string; command: string; cwd: string };
export type ConversationSummary = { id: string; title: string; updatedAt: number };

export type WorkbenchSnapshot = {
  host: 'starting' | 'ready' | 'failed' | 'stopping' | 'stopped';
  model?: ModelProfile;
  models: ModelProfile[];
  root?: WorkspaceRoot;
  invocation?: InvocationView;
  timeline: TimelineItem[];
  approval?: ApprovalRequest;
  error?: AppError;
  conversations: ConversationSummary[];
  conversationId?: string;
};

export type Reply<T> = { ok: true; value: T } | { ok: false; error: AppError };
export type SnapshotEnvelope = { hostInstanceId: string; seq: number; value: WorkbenchSnapshot };

export type WorkbenchEvent = {
  hostInstanceId: string;
  seq: number;
  at: number;
  invocationId?: string;
  payload:
    | { type: 'snapshot'; value: WorkbenchSnapshot }
    | { type: 'message.started'; id: string; role: 'user' | 'assistant' }
    | { type: 'message.delta'; id: string; text: string }
    | { type: 'message.ended'; id: string; text: string }
    | { type: 'tool.updated'; value: Extract<TimelineItem, { kind: 'tool' }> }
    | { type: 'approval.requested'; value: ApprovalRequest }
    | { type: 'invocation.changed'; value: InvocationView }
    | { type: 'error'; value: AppError };
};

export interface DesktopBridge {
  getSnapshot(): Promise<Reply<SnapshotEnvelope>>;
  chooseProject(): Promise<Reply<WorkspaceRoot | null>>;
  saveModel(profile: ModelInput, keyChange: KeyChange): Promise<Reply<ModelProfile>>;
  selectModel(modelId: string): Promise<Reply<ModelProfile>>;
  testModel(): Promise<Reply<{ text: string }>>;
  startMessage(text: string): Promise<Reply<{ invocationId: string }>>;
  cancelInvocation(invocationId: string): Promise<Reply<void>>;
  decideApproval(approvalId: string, decision: 'allow' | 'deny'): Promise<Reply<void>>;
  newConversation(): Promise<Reply<void>>;
  selectConversation(conversationId: string): Promise<Reply<void>>;
  restartHost(): Promise<Reply<void>>;
  onEvent(listener: (event: WorkbenchEvent) => void): () => void;
}

export type HostCommand =
  | { type: 'initialize'; hostInstanceId: string; rulesPath: string }
  | { type: 'setModel'; profile: ModelInput; apiKey?: string; models: ModelProfile[] }
  | { type: 'setWorkspace'; path: string }
  | { type: 'clearWorkspace' }
  | { type: 'testModel' }
  | { type: 'startMessage'; text: string }
  | { type: 'cancelInvocation'; invocationId: string }
  | { type: 'decideApproval'; approvalId: string; decision: 'allow' | 'deny' }
  | { type: 'newConversation' }
  | { type: 'selectConversation'; conversationId: string }
  | { type: 'getSnapshot' }
  | { type: 'shutdown' };

export type HostRequest = { requestId: string; command: HostCommand };
export type HostResponse =
  | { requestId: string; reply: Reply<unknown> }
  | { event: WorkbenchEvent };
