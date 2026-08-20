import type { HostRequest, Reply, WorkbenchEvent } from '../shared/contracts.js';
import { AgentRuntime } from './runtime/agent-runtime.js';
import { openWorkspace } from './workspace/workspace.js';

let runtime: AgentRuntime | undefined;

function send(message: unknown): void {
  process.parentPort?.postMessage(message);
}

function ok<T>(value: T): Reply<T> {
  return { ok: true, value };
}

process.parentPort?.on('message', async ({ data }: { data: HostRequest }) => {
  const { requestId, command } = data;
  let reply: Reply<unknown>;
  try {
    if (command.type === 'initialize') {
      runtime = new AgentRuntime(command.hostInstanceId, command.rulesPath, (event: WorkbenchEvent) => send({ event }));
      reply = ok({
        electron: process.versions.electron,
        node: process.versions.node,
        arch: process.arch,
        execPath: process.execPath,
        agentCore: true,
      });
    } else {
      if (!runtime) throw new Error('运行进程尚未初始化');
      switch (command.type) {
        case 'setModel':
          reply = ok(runtime.setModel(command.profile, command.apiKey));
          break;
        case 'setWorkspace':
          reply = ok(runtime.setWorkspace(await openWorkspace(command.path)));
          break;
        case 'clearWorkspace':
          reply = ok(runtime.clearWorkspace());
          break;
        case 'testModel':
          reply = ok(await runtime.testModel());
          break;
        case 'startMessage':
          reply = ok(runtime.startMessage(command.text));
          break;
        case 'cancelInvocation':
          reply = ok(runtime.cancelInvocation(command.invocationId));
          break;
        case 'decideApproval':
          reply = ok(runtime.decideApproval(command.approvalId, command.decision));
          break;
        case 'newConversation':
          reply = ok(runtime.newConversation());
          break;
        case 'getSnapshot':
          reply = ok(runtime.getSnapshot());
          break;
        case 'shutdown':
          await runtime.shutdown();
          reply = ok(undefined);
          setImmediate(() => process.exit(0));
          break;
        default:
          reply = { ok: false, error: { code: 'INVALID_COMMAND', message: '无效运行命令' } };
      }
    }
  } catch (error) {
    reply = {
      ok: false,
      error: {
        code: 'HOST_COMMAND_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
  send({ requestId, reply });
});
