import type { HostRequest, Reply, WorkbenchEvent } from '../shared/contracts.js';
import { AgentRuntime } from './runtime/agent-runtime.js';

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
      runtime = new AgentRuntime(command.hostInstanceId, command.rulesPath, (event: WorkbenchEvent) => send({ event }), {
        exe: command.sandboxExe,
        tempDir: command.sandboxTempDir,
      });
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
          reply = ok(runtime.setModel(command.profile, command.apiKey, command.models));
          break;
        case 'newTask':
          reply = ok(await runtime.newTask(command.rootPaths));
          break;
        case 'selectTask':
          reply = ok(runtime.selectTask(command.taskId));
          break;
        case 'addRoot':
          reply = ok(await runtime.addRoot(command.path, command.grantSandbox));
          break;
        case 'removeRoot':
          reply = ok(await runtime.removeRoot(command.rootId));
          break;
        case 'setPrimaryRoot':
          reply = ok(runtime.setPrimaryRoot(command.rootId));
          break;
        case 'setPermission':
          reply = ok(await runtime.setPermission(command.userMode));
          break;
        case 'testModel':
          reply = ok(await runtime.testModel());
          break;
        case 'startMessage':
          reply = ok(runtime.startMessage(command.text));
          break;
        case 'implementPlan':
          reply = ok(await runtime.implementPlan());
          break;
        case 'cancelRun':
          reply = ok(runtime.cancelRun(command.runId));
          break;
        case 'decideApproval':
          reply = ok(runtime.decideApproval(command.approvalId, command.decision));
          break;
        case 'getChanges':
          reply = ok(await runtime.getChanges());
          break;
        case 'getDiff':
          reply = ok(await runtime.getDiff(command.rootId, command.path));
          break;
        case 'setMcpServers':
          reply = ok(await runtime.setMcpServers(command.servers));
          break;
        case 'getRunEvents':
          reply = ok(runtime.getRunEvents(command.runId));
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
