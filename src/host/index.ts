import { randomUUID } from 'node:crypto';
import type { HostRequest, Reply, SnapshotEnvelope, WorkbenchEvent, WorkbenchSnapshot } from '../shared/contracts.js';

let hostInstanceId: string = randomUUID();
let seq = 0;
let snapshot: WorkbenchSnapshot = { host: 'starting', timeline: [] };

function send(message: unknown): void {
  process.parentPort?.postMessage(message);
}

function emitSnapshot(): void {
  const event: WorkbenchEvent = {
    hostInstanceId,
    seq: ++seq,
    at: Date.now(),
    payload: { type: 'snapshot', value: snapshot },
  };
  send({ event });
}

function ok<T>(value: T): Reply<T> {
  return { ok: true, value };
}

process.parentPort?.on('message', async ({ data }: { data: HostRequest }) => {
  const { requestId, command } = data;
  let reply: Reply<unknown>;
  try {
    switch (command.type) {
      case 'initialize':
        hostInstanceId = command.hostInstanceId;
        snapshot = { host: 'ready', timeline: [] };
        emitSnapshot();
        reply = ok({ electron: process.versions.electron, node: process.versions.node, arch: process.arch });
        break;
      case 'getSnapshot': {
        const value: SnapshotEnvelope = { hostInstanceId, seq, value: snapshot };
        reply = ok(value);
        break;
      }
      case 'shutdown':
        snapshot = { ...snapshot, host: 'stopping' };
        emitSnapshot();
        reply = ok(undefined);
        setImmediate(() => process.exit(0));
        break;
      default:
        reply = { ok: false, error: { code: 'NOT_IMPLEMENTED', message: '该操作尚未实现' } };
    }
  } catch (error) {
    reply = { ok: false, error: { code: 'HOST_ERROR', message: error instanceof Error ? error.message : String(error) } };
  }
  send({ requestId, reply });
});
