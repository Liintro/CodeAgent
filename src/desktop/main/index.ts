import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, utilityProcess, type UtilityProcess } from 'electron';
import type { HostCommand, HostRequest, HostResponse, Reply, SnapshotEnvelope, WorkbenchEvent, WorkbenchSnapshot } from '../../shared/contracts.js';

let mainWindow: BrowserWindow | undefined;
let host: UtilityProcess | undefined;
let hostReady = false;
let closing = false;
let hostInstanceId = '';
let localSeq = 0;
let lastSnapshot: WorkbenchSnapshot = { host: 'starting', timeline: [] };
const pending = new Map<string, { resolve: (reply: Reply<unknown>) => void; timer: NodeJS.Timeout }>();

if (process.env.CODEAGENT_USER_DATA) app.setPath('userData', process.env.CODEAGENT_USER_DATA);
if (process.env.CODEAGENT_TEST === '1') app.disableHardwareAcceleration();

function broadcast(event: WorkbenchEvent): void {
  if (event.payload.type === 'snapshot') lastSnapshot = event.payload.value;
  mainWindow?.webContents.send('desktop:event', event);
}

function localSnapshot(value: WorkbenchSnapshot): void {
  lastSnapshot = value;
  broadcast({
    hostInstanceId,
    seq: ++localSeq,
    at: Date.now(),
    payload: { type: 'snapshot', value },
  });
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
  localSnapshot({ host: 'starting', timeline: [] });
  const entry = fileURLToPath(new URL('../../host/index.js', import.meta.url));
  if (!existsSync(entry)) return { ok: false, error: { code: 'HOST_ENTRY_MISSING', message: '运行进程入口不存在', detail: entry } };
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
  child.on('exit', () => {
    if (host !== child) return;
    host = undefined;
    hostReady = false;
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.resolve({ ok: false, error: { code: 'HOST_EXITED', message: '运行进程已退出' } });
      pending.delete(id);
    }
    if (!closing) {
      const invocation = lastSnapshot.invocation && ['running', 'awaiting_approval', 'cancelling'].includes(lastSnapshot.invocation.phase)
        ? { ...lastSnapshot.invocation, phase: 'interrupted' as const }
        : lastSnapshot.invocation;
      localSnapshot({
        host: 'failed',
        invocation,
        timeline: [],
        error: { code: 'HOST_EXITED', message: '运行进程已退出' },
      });
    }
  });
  const initialized = await hostRequest<{ node: string }>({ type: 'initialize', hostInstanceId, rulesPath: join(app.getAppPath(), 'resources/generated/AGENTS.md') });
  if (!initialized.ok) return initialized;
  hostReady = true;
  return { ok: true, value: undefined };
}

async function stopHost(): Promise<void> {
  if (!host) return;
  closing = true;
  const child = host;
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

handle<SnapshotEnvelope>('desktop:getSnapshot', async () => {
  if (!hostReady) return { ok: true, value: { hostInstanceId, seq: localSeq, value: lastSnapshot } };
  return hostRequest<SnapshotEnvelope>({ type: 'getSnapshot' });
});
handle<void>('desktop:restartHost', async () => startHost());

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
    closing = true;
    void stopHost().finally(() => {
      mainWindow?.destroy();
      app.quit();
    });
  });
  mainWindow.on('closed', () => { mainWindow = undefined; });
  if (process.env.VITE_DEV_SERVER_URL) await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  else await mainWindow.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)));
}

app.on('before-quit', event => {
  if (!closing && mainWindow) {
    event.preventDefault();
    mainWindow.close();
  }
});

app.whenReady().then(async () => {
  await startHost();
  await createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
