import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, utilityProcess, type UtilityProcess } from 'electron';
import type {
  AppError,
  HostCommand,
  HostRequest,
  HostResponse,
  KeyChange,
  ModelProfile,
  Reply,
  SnapshotEnvelope,
  WorkbenchEvent,
  WorkbenchSnapshot,
  WorkspaceRoot,
} from '../../shared/contracts.js';
import { SettingsStore } from './settings.js';

let mainWindow: BrowserWindow | undefined;
let host: UtilityProcess | undefined;
let hostReady = false;
let closing = false;
let hostInstanceId = '';
let localSeq = 0;
let store: SettingsStore;
let currentModel: ModelProfile | undefined;
let currentModels: ModelProfile[] = [];
let currentRoot: WorkspaceRoot | undefined;
let desktopError: AppError | undefined;
let lastSnapshot: WorkbenchSnapshot = { host: 'starting', models: [], timeline: [], conversations: [] };
const pending = new Map<string, { resolve: (reply: Reply<unknown>) => void; timer: NodeJS.Timeout }>();
const expectedExits = new WeakSet<UtilityProcess>();

if (process.env.CODEAGENT_USER_DATA) app.setPath('userData', process.env.CODEAGENT_USER_DATA);
if (process.env.CODEAGENT_TEST === '1') app.disableHardwareAcceleration();

function log(message: string): void {
  const file = join(app.getPath('userData'), 'logs', 'desktop.log');
  void mkdir(dirname(file), { recursive: true }).then(() => appendFile(file, `${new Date().toISOString()} ${message}\n`, 'utf8')).catch(() => undefined);
}

function broadcast(event: WorkbenchEvent): void {
  localSeq = Math.max(localSeq, event.seq);
  if (event.payload.type === 'snapshot') lastSnapshot = event.payload.value;
  else if (event.payload.type === 'invocation.changed') lastSnapshot = { ...lastSnapshot, invocation: event.payload.value };
  else if (event.payload.type === 'approval.requested') lastSnapshot = { ...lastSnapshot, approval: event.payload.value };
  else if (event.payload.type === 'error') lastSnapshot = { ...lastSnapshot, error: event.payload.value };
  mainWindow?.webContents.send('desktop:event', event);
}

function localSnapshot(value: WorkbenchSnapshot): void {
  lastSnapshot = value;
  broadcast({ hostInstanceId, seq: ++localSeq, at: Date.now(), payload: { type: 'snapshot', value } });
}

function hostRequest<T>(command: HostCommand, timeoutMs = 15000): Promise<Reply<T>> {
  if (!host) return Promise.resolve({ ok: false, error: { code: 'HOST_NOT_RUNNING', message: '运行进程未启动' } });
  const requestId = randomUUID();
  const request: HostRequest = { requestId, command };
  return new Promise<Reply<T>>(resolve => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({ ok: false, error: { code: 'HOST_TIMEOUT', message: '未收到运行进程确认' } });
    }, timeoutMs);
    pending.set(requestId, { resolve: resolve as (reply: Reply<unknown>) => void, timer });
    host!.postMessage(request);
  });
}

async function startHost(): Promise<Reply<void>> {
  if (host) await stopHost();
  hostReady = false;
  hostInstanceId = randomUUID();
  localSeq = 0;
  localSnapshot({ host: 'starting', model: currentModel, models: currentModels, root: currentRoot, timeline: [], conversations: [] });
  const entry = fileURLToPath(new URL('../../host/index.js', import.meta.url));
  if (!existsSync(entry)) return { ok: false, error: { code: 'HOST_ENTRY_MISSING', message: '运行进程入口不存在', detail: entry } };
  log(`host_start entry=${entry} electron=${process.versions.electron} arch=${process.arch}`);
  const child = utilityProcess.fork(entry, [], { stdio: 'pipe', serviceName: 'CodeAgent Agent Host' });
  host = child;
  child.stdout?.on('data', () => undefined);
  child.stderr?.on('data', chunk => process.stderr.write(chunk));
  child.on('message', (message: HostResponse) => {
    if ('event' in message) {
      broadcast(message.event);
      return;
    }
    const request = pending.get(message.requestId);
    if (request) {
      clearTimeout(request.timer);
      pending.delete(message.requestId);
      request.resolve(message.reply);
    }
  });
  child.on('exit', (code: number) => {
    if (host !== child) return;
    host = undefined;
    hostReady = false;
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.resolve({ ok: false, error: { code: 'HOST_EXITED', message: '运行进程已退出' } });
      pending.delete(id);
    }
    log(`host_exit code=${code}`);
    if (!closing && !expectedExits.has(child)) {
      const invocation = lastSnapshot.invocation && ['running', 'awaiting_approval', 'cancelling'].includes(lastSnapshot.invocation.phase)
        ? { ...lastSnapshot.invocation, phase: 'interrupted' as const }
        : lastSnapshot.invocation;
      localSnapshot({
        host: 'failed',
        model: currentModel,
        models: currentModels,
        root: currentRoot,
        invocation,
        timeline: [],
        conversations: [],
        error: { code: 'HOST_EXITED', message: '运行进程已退出' },
      });
    }
  });
  const initialized = await hostRequest<{ node: string; execPath: string }>({
    type: 'initialize',
    hostInstanceId,
    rulesPath: fileURLToPath(new URL('../../../../resources/generated/AGENTS.md', import.meta.url)),
  });
  if (!initialized.ok) {
    localSnapshot({ host: 'failed', model: currentModel, models: currentModels, root: currentRoot, timeline: [], conversations: [], error: initialized.error });
    return initialized;
  }
  hostReady = true;
  log(`host_ready node=${initialized.value.node} execPath=${initialized.value.execPath}`);
  if (store.model) {
    try {
      const apiKey = await store.decryptApiKey();
      const configured = await hostRequest<ModelProfile>({ type: 'setModel', profile: store.model, apiKey, models: store.models });
      if (!configured.ok) return configured;
      currentModel = configured.value;
      currentModels = store.models;
    } catch (error) {
      desktopError = { code: 'KEY_DECRYPT_FAILED', message: error instanceof Error ? error.message : String(error) };
    }
  }
  if (store.lastRootPath) {
    const selected = await hostRequest<WorkspaceRoot>({ type: 'setWorkspace', path: store.lastRootPath });
    if (selected.ok) currentRoot = selected.value;
    else {
      currentRoot = undefined;
      await store.saveLastRoot(undefined);
      desktopError = { code: 'WORKSPACE_INVALID', message: '最近项目目录不可用，请重新选择', detail: selected.error.message };
    }
  }
  return { ok: true, value: undefined };
}

async function stopHost(): Promise<void> {
  if (!host) return;
  const child = host;
  expectedExits.add(child);
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  await hostRequest({ type: 'shutdown' });
  await exited;
  if (host === child) host = undefined;
}

function handle<T>(channel: string, action: (...args: any[]) => Promise<Reply<T>>): void {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
      return { ok: false, error: { code: 'INVALID_SENDER', message: '无效窗口请求' } };
    }
    try {
      return await action(...args);
    } catch (error) {
      return { ok: false, error: { code: 'DESKTOP_ERROR', message: error instanceof Error ? error.message : String(error) } };
    }
  });
}

async function assertIdle(): Promise<void> {
  if (!hostReady) return;
  const snapshot = await hostRequest<SnapshotEnvelope>({ type: 'getSnapshot' });
  if (snapshot.ok && snapshot.value.value.invocation && ['running', 'awaiting_approval', 'cancelling'].includes(snapshot.value.value.invocation.phase)) {
    throw new Error('当前执行尚未结束');
  }
}

handle<SnapshotEnvelope>('desktop:getSnapshot', async () => {
  if (!hostReady) return { ok: true, value: { hostInstanceId, seq: localSeq, value: { ...lastSnapshot, error: desktopError ?? lastSnapshot.error } } };
  const reply = await hostRequest<SnapshotEnvelope>({ type: 'getSnapshot' });
  if (reply.ok && desktopError) reply.value.value = { ...reply.value.value, error: desktopError };
  return reply;
});

handle<WorkspaceRoot | null>('desktop:chooseProject', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return { ok: true, value: null };
  const selected = await hostRequest<WorkspaceRoot>({ type: 'setWorkspace', path: result.filePaths[0] });
  if (!selected.ok) return selected;
  currentRoot = selected.value;
  desktopError = undefined;
  await store.saveLastRoot(selected.value.path);
  return selected;
});

handle<ModelProfile>('desktop:saveModel', async (profile: unknown, keyChange: KeyChange) => {
  if (!keyChange || !['keep', 'replace', 'remove'].includes(keyChange.action)) throw new Error('密钥操作无效');
  await assertIdle();
  const model = await store.saveModel(profile, keyChange);
  const configured = await hostRequest<ModelProfile>({ type: 'setModel', profile: model, apiKey: await store.decryptApiKey(), models: store.models });
  if (!configured.ok) return configured;
  currentModel = configured.value;
  currentModels = store.models;
  desktopError = undefined;
  return configured;
});

handle<ModelProfile>('desktop:selectModel', async (modelId: unknown) => {
  if (typeof modelId !== 'string') throw new Error('模型标识无效');
  await assertIdle();
  const model = await store.selectModel(modelId);
  const configured = await hostRequest<ModelProfile>({ type: 'setModel', profile: model, apiKey: await store.decryptApiKey(), models: store.models });
  if (!configured.ok) return configured;
  currentModel = configured.value;
  currentModels = store.models;
  desktopError = undefined;
  return configured;
});

handle<{ text: string }>('desktop:testModel', async () => hostRequest<{ text: string }>({ type: 'testModel' }, 45000));
handle<{ invocationId: string }>('desktop:startMessage', async (text: unknown) => {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: { code: 'INVALID_MESSAGE', message: '请输入内容' } };
  return hostRequest<{ invocationId: string }>({ type: 'startMessage', text: text.trim() });
});
handle<void>('desktop:cancelInvocation', async (invocationId: unknown) => {
  if (typeof invocationId !== 'string') throw new Error('执行标识无效');
  return hostRequest<void>({ type: 'cancelInvocation', invocationId });
});
handle<void>('desktop:decideApproval', async (approvalId: unknown, decision: unknown) => {
  if (typeof approvalId !== 'string' || !['allow', 'deny'].includes(decision as string)) throw new Error('审批请求无效');
  return hostRequest<void>({ type: 'decideApproval', approvalId, decision: decision as 'allow' | 'deny' });
});
handle<void>('desktop:newConversation', async () => hostRequest<void>({ type: 'newConversation' }));
handle<void>('desktop:selectConversation', async (conversationId: unknown) => {
  if (typeof conversationId !== 'string') throw new Error('对话标识无效');
  return hostRequest<void>({ type: 'selectConversation', conversationId });
});
handle<void>('desktop:restartHost', async () => {
  await assertIdle();
  return startHost();
});

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 860,
    minHeight: 600,
    show: false,
    title: 'CodeAgent',
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: fileURLToPath(new URL('../preload.cjs', import.meta.url)),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', event => {
    if (closing) return;
    event.preventDefault();
    void finishClose();
  });
  mainWindow.on('closed', () => { mainWindow = undefined; });
  if (process.env.VITE_DEV_SERVER_URL) await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  else await mainWindow.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)));
}

async function finishClose(): Promise<void> {
  closing = true;
  if (hostReady) {
    const snapshot = await hostRequest<SnapshotEnvelope>({ type: 'getSnapshot' });
    const active = snapshot.ok && snapshot.value.value.invocation && ['running', 'awaiting_approval', 'cancelling'].includes(snapshot.value.value.invocation.phase);
    if (active) {
      const result = await dialog.showMessageBox(mainWindow!, {
        type: 'question',
        buttons: ['结束当前执行并退出', '返回'],
        defaultId: 1,
        cancelId: 1,
        message: '当前执行尚未结束',
        detail: '退出将取消当前执行。',
      });
      if (result.response === 1) {
        closing = false;
        return;
      }
    }
  }
  localSnapshot({ ...lastSnapshot, host: 'stopping' });
  await stopHost();
  mainWindow?.destroy();
  app.quit();
}

app.on('before-quit', event => {
  if (!closing && mainWindow) {
    event.preventDefault();
    mainWindow.close();
  }
});

app.whenReady().then(async () => {
  store = new SettingsStore(app.getPath('userData'));
  currentModel = undefined;
  currentModels = [];
  try {
    await store.load();
    currentModel = store.model;
    currentModels = store.models;
  } catch (error) {
    desktopError = { code: 'SETTINGS_INVALID', message: error instanceof Error ? error.message : String(error) };
  }
  await startHost();
  await createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
