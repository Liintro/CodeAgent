import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, shell, utilityProcess, type UtilityProcess } from 'electron';
import type {
  Acceptance,
  AppError,
  ApprovalDecision,
  ChangesView,
  DeliveryActionResult,
  DeliveryView,
  DetectedCommand,
  DiffView,
  HostCommand,
  HostRequest,
  HostResponse,
  KeyChange,
  ModelProfile,
  PermissionSetting,
  Reply,
  RootView,
  SnapshotEnvelope,
  UserMode,
  WorkbenchEvent,
  WorkbenchSnapshot,
} from '../../shared/contracts.js';
import { McpConfig } from './mcp-config.js';
import { SettingsStore } from './settings.js';

const USER_MODES: UserMode[] = ['plan', 'manual', 'accept_edits', 'auto', 'bypass'];
const DECISIONS: ApprovalDecision[] = ['allow', 'allow_task', 'deny'];
const BUSY_PHASES = ['running', 'awaiting_approval', 'verifying', 'cancelling'];

let mainWindow: BrowserWindow | undefined;
let host: UtilityProcess | undefined;
let hostReady = false;
let closing = false;
let hostInstanceId = '';
let localSeq = 0;
let store: SettingsStore;
let mcpConfig: McpConfig;
let currentModel: ModelProfile | undefined;
let currentModels: ModelProfile[] = [];
let desktopError: AppError | undefined;
let lastSnapshot: WorkbenchSnapshot = emptySnapshot('starting');
const pending = new Map<string, { resolve: (reply: Reply<unknown>) => void; timer: NodeJS.Timeout }>();
const expectedExits = new WeakSet<UtilityProcess>();

if (process.env.CODEAGENT_USER_DATA) app.setPath('userData', process.env.CODEAGENT_USER_DATA);
if (process.env.CODEAGENT_TEST === '1') app.disableHardwareAcceleration();

function emptySnapshot(hostState: WorkbenchSnapshot['host']): WorkbenchSnapshot {
  return {
    host: hostState, models: currentModels, model: currentModel, tasks: [], roots: [], sandboxStatus: 'untested', timeline: [], mcp: [], acceptance: { commands: [], maxRepairs: 3 },
    permission: { userMode: 'manual', phase: 'act', approval: 'ask_writes_and_commands', scope: 'selected_roots', grants: [] },
  };
}

function log(message: string): void {
  const file = join(app.getPath('userData'), 'logs', 'desktop.log');
  void mkdir(dirname(file), { recursive: true }).then(() => appendFile(file, `${new Date().toISOString()} ${message}\n`, 'utf8')).catch(() => undefined);
}

function broadcast(event: WorkbenchEvent): void {
  localSeq = Math.max(localSeq, event.seq);
  const payload = event.payload;
  if (payload.type === 'snapshot') lastSnapshot = payload.value;
  else if (payload.type === 'run.changed') lastSnapshot = { ...lastSnapshot, run: payload.value };
  else if (payload.type === 'approval.requested') lastSnapshot = { ...lastSnapshot, approval: payload.value };
  else if (payload.type === 'sandbox.updated') lastSnapshot = { ...lastSnapshot, sandboxStatus: payload.value };
  else if (payload.type === 'mcp.updated') lastSnapshot = { ...lastSnapshot, mcp: payload.value };
  else if (payload.type === 'delivery.updated') lastSnapshot = { ...lastSnapshot, delivery: payload.value };
  else if (payload.type === 'changes.updated') lastSnapshot = { ...lastSnapshot, changes: payload.value };
  else if (payload.type === 'error') lastSnapshot = { ...lastSnapshot, error: payload.value };
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
  localSnapshot(emptySnapshot('starting'));
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
      const run = lastSnapshot.run && BUSY_PHASES.includes(lastSnapshot.run.phase)
        ? { ...lastSnapshot.run, phase: 'interrupted' as const }
        : lastSnapshot.run;
      localSnapshot({ ...emptySnapshot('failed'), run, error: { code: 'HOST_EXITED', message: '运行进程已退出' } });
    }
  });
  const generated = (name: string) => fileURLToPath(new URL(`../../../../resources/generated/${name}`, import.meta.url));
  const initialized = await hostRequest<{ node: string; execPath: string }>({
    type: 'initialize',
    hostInstanceId,
    dataDir: app.getPath('userData'),
    rulesPath: generated('AGENTS.md'),
    sandboxExe: generated('codeagent-sandbox.exe'),
    sandboxTempDir: join(app.getPath('userData'), 'sandbox-temp'),
    staleGrants: store.sandboxGrants,
  }, 120000);
  if (!initialized.ok) {
    localSnapshot({ ...emptySnapshot('failed'), error: initialized.error });
    return initialized;
  }
  hostReady = true;
  if (store.sandboxGrants.length) await store.saveRoots(store.recentRoots, []);
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
  // 任务列表由 Host 从数据库恢复；只有全新安装（没有任何任务）才创建第一个任务。
  if (!(await hostSnapshot())?.tasks.length) await hostRequest<void>({ type: 'newTask', rootPaths: store.recentRoots });
  await persistRoots();
  await loadMcp();
  return { ok: true, value: undefined };
}

async function loadMcp(): Promise<Reply<void>> {
  try {
    return await hostRequest<void>({ type: 'setMcpServers', servers: await mcpConfig.load() });
  } catch (error) {
    desktopError = { code: 'MCP_CONFIG_INVALID', message: error instanceof Error ? error.message : String(error) };
    return { ok: false, error: desktopError };
  }
}

async function stopHost(): Promise<void> {
  if (!host) return;
  const child = host;
  expectedExits.add(child);
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  const shutdown = await hostRequest({ type: 'shutdown' }, 60000);
  await exited;
  if (shutdown.ok && store.sandboxGrants.length) await store.saveRoots(store.recentRoots, []);
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

async function hostSnapshot(): Promise<WorkbenchSnapshot | undefined> {
  if (!hostReady) return undefined;
  const reply = await hostRequest<SnapshotEnvelope>({ type: 'getSnapshot' });
  return reply.ok ? reply.value.value : undefined;
}

async function assertIdle(): Promise<WorkbenchSnapshot | undefined> {
  const snapshot = await hostSnapshot();
  if (snapshot?.run && BUSY_PHASES.includes(snapshot.run.phase)) throw new Error('当前执行尚未结束');
  return snapshot;
}

async function confirm(message: string, detail: string, action: string): Promise<boolean> {
  const result = await dialog.showMessageBox(mainWindow!, { type: 'warning', buttons: [action, '取消'], defaultId: 1, cancelId: 1, message, detail });
  return result.response === 0;
}

const confirmBypass = () => confirm('启用绕过权限？', '该模式不再逐项询问：命令以当前 Windows 用户的全部权限直接运行，文件工具也不再限制在所选目录内。', '启用绕过权限');
const confirmSandboxGrant = (paths: string[]) => confirm(
  '为沙箱授予目录写入权限？',
  `Auto 模式需要在以下目录的访问控制列表中添加一条仅供 CodeAgent 沙箱使用的写入权限（退出应用或移除目录时撤销）：\n${paths.join('\n')}`,
  '授予并启用',
);

// 渲染进程传来的验收配置只在这里校验一次；Host 收到的是已校验的类型化值。
function validateAcceptance(value: unknown): Acceptance {
  const input = value as Partial<Acceptance> | undefined;
  if (!input || !Array.isArray(input.commands) || !Number.isInteger(input.maxRepairs) || input.maxRepairs! < 0 || input.maxRepairs! > 10) throw new Error('验收配置无效');
  const commands = input.commands.map(item => {
    const command = item as Record<string, unknown>;
    const text = (name: string) => typeof command[name] === 'string' && (command[name] as string).trim() ? (command[name] as string).trim() : undefined;
    const timeout = command.timeoutSeconds;
    if (!text('id') || !text('rootId') || !text('label') || !text('command') || !Number.isInteger(timeout) || (timeout as number) < 1 || (timeout as number) > 3600) throw new Error('验收命令无效');
    return { id: text('id')!, rootId: text('rootId')!, label: text('label')!, command: text('command')!, timeoutSeconds: timeout as number };
  });
  return { commands, maxRepairs: input.maxRepairs! };
}

async function persistRoots(): Promise<void> {
  const snapshot = await hostSnapshot();
  if (!snapshot?.taskId) return;
  // 授权路径只增不减，直到 Host 正常退出并撤销；异常退出后下次启动据此清理。
  const granted = snapshot.roots.filter(root => root.sandboxGranted).map(root => root.path);
  await store.saveRoots(snapshot.roots.filter(root => !root.missing).map(root => root.path), [...new Set([...store.sandboxGrants, ...granted])]);
}

handle<SnapshotEnvelope>('desktop:getSnapshot', async () => {
  if (!hostReady) return { ok: true, value: { hostInstanceId, seq: localSeq, value: { ...lastSnapshot, error: desktopError ?? lastSnapshot.error } } };
  const reply = await hostRequest<SnapshotEnvelope>({ type: 'getSnapshot' });
  if (reply.ok && desktopError) reply.value.value = { ...reply.value.value, error: desktopError };
  return reply;
});

handle<RootView | null>('desktop:addRoot', async () => {
  const snapshot = await assertIdle();
  const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return { ok: true, value: null };
  const grantSandbox = snapshot?.permission.userMode === 'auto';
  if (grantSandbox && !await confirmSandboxGrant([result.filePaths[0]])) return { ok: true, value: null };
  const added = await hostRequest<RootView>({ type: 'addRoot', path: result.filePaths[0], grantSandbox }, 120000);
  if (added.ok) {
    desktopError = undefined;
    await persistRoots();
  }
  return added;
});

handle<void>('desktop:removeRoot', async (rootId: unknown) => {
  if (typeof rootId !== 'string') throw new Error('目录标识无效');
  await assertIdle();
  const reply = await hostRequest<void>({ type: 'removeRoot', rootId }, 120000);
  if (reply.ok) await persistRoots();
  return reply;
});

handle<void>('desktop:setPrimaryRoot', async (rootId: unknown) => {
  if (typeof rootId !== 'string') throw new Error('目录标识无效');
  await assertIdle();
  const reply = await hostRequest<void>({ type: 'setPrimaryRoot', rootId });
  if (reply.ok) await persistRoots();
  return reply;
});

handle<PermissionSetting | null>('desktop:setPermission', async (userMode: unknown) => {
  if (!USER_MODES.includes(userMode as UserMode)) throw new Error('权限模式无效');
  const snapshot = await assertIdle();
  if (userMode === 'bypass' && !await confirmBypass()) return { ok: true, value: null };
  const ungranted = snapshot?.roots.filter(root => !root.sandboxGranted).map(root => root.path) ?? [];
  if (userMode === 'auto' && ungranted.length && !await confirmSandboxGrant(ungranted)) return { ok: true, value: null };
  const reply = await hostRequest<PermissionSetting | null>({ type: 'setPermission', userMode: userMode as UserMode }, 120000);
  await persistRoots();
  return reply;
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
handle<{ runId: string }>('desktop:startMessage', async (text: unknown) => {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: { code: 'INVALID_MESSAGE', message: '请输入内容' } };
  return hostRequest<{ runId: string }>({ type: 'startMessage', text: text.trim() });
});
handle<{ runId: string }>('desktop:implementPlan', async () => hostRequest<{ runId: string }>({ type: 'implementPlan' }));
handle<void>('desktop:cancelRun', async (runId: unknown) => {
  if (typeof runId !== 'string') throw new Error('执行标识无效');
  return hostRequest<void>({ type: 'cancelRun', runId });
});
handle<void>('desktop:decideApproval', async (approvalId: unknown, decision: unknown) => {
  if (typeof approvalId !== 'string' || !DECISIONS.includes(decision as ApprovalDecision)) throw new Error('审批请求无效');
  return hostRequest<void>({ type: 'decideApproval', approvalId, decision: decision as ApprovalDecision });
});
handle<void>('desktop:newTask', async () => {
  await assertIdle();
  return hostRequest<void>({ type: 'newTask', rootPaths: store.recentRoots });
});
handle<void>('desktop:selectTask', async (taskId: unknown) => {
  if (typeof taskId !== 'string') throw new Error('任务标识无效');
  return hostRequest<void>({ type: 'selectTask', taskId });
});
handle<ChangesView>('desktop:getChanges', async () => hostRequest<ChangesView>({ type: 'getChanges' }, 60000));
handle<DiffView>('desktop:getDiff', async (rootId: unknown, path: unknown) => {
  if (typeof rootId !== 'string' || typeof path !== 'string') throw new Error('差异请求无效');
  return hostRequest<DiffView>({ type: 'getDiff', rootId, path });
});
handle<DetectedCommand[]>('desktop:detectAcceptance', async () => hostRequest<DetectedCommand[]>({ type: 'detectAcceptance' }));
handle<void>('desktop:setAcceptance', async (value: unknown) => hostRequest<void>({ type: 'setAcceptance', acceptance: validateAcceptance(value) }));
handle<{ runId: string }>('desktop:verifyNow', async () => hostRequest<{ runId: string }>({ type: 'verifyNow' }));
handle<{ runId: string }>('desktop:continueTask', async () => hostRequest<{ runId: string }>({ type: 'continueTask' }));
handle<DeliveryView>('desktop:getDelivery', async () => hostRequest<DeliveryView>({ type: 'getDelivery' }, 60000));
handle<void>('desktop:acceptRoot', async (rootId: unknown) => {
  if (typeof rootId !== 'string') throw new Error('目录标识无效');
  return hostRequest<void>({ type: 'acceptRoot', rootId }, 60000);
});
handle<DeliveryActionResult | null>('desktop:restoreRoot', async (rootId: unknown) => {
  if (typeof rootId !== 'string') throw new Error('目录标识无效');
  if (!await confirm('还原智能体的改动？', '智能体修改过的文件将恢复到任务开始时的内容；新建的文件会被删除。任务之后又被您修改过的文件会被跳过。', '还原')) return { ok: true, value: null };
  return hostRequest<DeliveryActionResult>({ type: 'restoreRoot', rootId }, 120000);
});
handle<DeliveryActionResult>('desktop:commitRoot', async (rootId: unknown, message: unknown, confirmShared: unknown) => {
  if (typeof rootId !== 'string' || typeof message !== 'string' || typeof confirmShared !== 'boolean') throw new Error('提交请求无效');
  return hostRequest<DeliveryActionResult>({ type: 'commitRoot', rootId, message, confirmShared }, 120000);
});
handle<void>('desktop:reloadMcp', async () => {
  desktopError = undefined;
  return loadMcp();
});
handle<void>('desktop:setMcpEnabled', async (name: unknown, enabled: unknown) => {
  if (typeof name !== 'string' || typeof enabled !== 'boolean') throw new Error('MCP 设置无效');
  await mcpConfig.setEnabled(name, enabled);
  return loadMcp();
});
handle<void>('desktop:openMcpConfig', async () => {
  await mkdir(dirname(mcpConfig.file), { recursive: true });
  if (!existsSync(mcpConfig.file)) await writeFile(mcpConfig.file, JSON.stringify({ '_说明': 'env 与 headers 中的值以明文保存在此文件；值写成 "${env:变量名}" 时改为从桌面进程环境变量读取。', mcpServers: {} }, null, 2), 'utf8');
  const failure = await shell.openPath(mcpConfig.file);
  return failure ? { ok: false, error: { code: 'OPEN_FAILED', message: failure } } : { ok: true, value: undefined };
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
  const snapshot = await hostSnapshot();
  if (snapshot?.run && BUSY_PHASES.includes(snapshot.run.phase)) {
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
  mcpConfig = new McpConfig(app.getPath('userData'));
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
