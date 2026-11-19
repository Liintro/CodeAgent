import { createDocumentTools } from '../documents/index.js';
import { createNavigationTools } from '../engineering/navigation.js';
import { createMemoryTool, type MemorySearchParams } from '../tools/memory-tool.js';
import { createRootTools } from '../tools/native-tools.js';
import { classify, registered } from '../tools/permission.js';
import { createPlanTool } from '../tools/plan-tool.js';
import { createWebTools } from '../tools/web.js';
import type { AgentEvents } from './agent-events.js';
import type { TaskState, Workbench } from './workbench.js';

/** 按权限模式和任务内容组装本次 Run 可用的工具；memorySearch 只在记忆开启时给出。 */
export function buildTools(wb: Workbench, task: TaskState, events: AgentEvents, trustedMcp: ReadonlySet<string>, memorySearch?: (params: MemorySearchParams) => Promise<string>) {
  const mode = task.permission.userMode;
  const documentTools = task.documents.length ? createDocumentTools({
    documents: () => task.documents,
    library: wb.library,
    onStarted: toolCallId => events.markToolRunning(task, toolCallId),
    vision: wb.profile?.vision === true,
    readChars: wb.policy.settings.output.documentChars,
    onChanged: record => {
      task.documents = task.documents.map(doc => doc.id === record.id ? record : doc);
      wb.ledger.saveDocuments(task.id, task.documents);
    },
  }) : [];
  // web 工具不依赖工作目录，没有目录时也保持可用。
  const webTools = wb.webSearch ? createWebTools(wb.webSearch, { onStarted: toolCallId => events.markToolRunning(task, toolCallId) }) : [];
  const planTool = createPlanTool(items => {
    task.plan = items;
    wb.emitSnapshot();
  });
  if (!task.roots.length) return [planTool, ...documentTools, ...webTools];
  const mcpTools = wb.mcp.tools().filter(tool => registered(mode, classify(tool.name, trustedMcp)));
  return [
    planTool,
    ...createRootTools({
      roots: task.roots,
      fullAccess: mode === 'bypass',
      sandbox: wb.sandbox,
      includeEdit: mode !== 'plan',
      includeShell: mode !== 'plan',
      vision: wb.profile?.vision === true,
      shellMaxTimeoutSec: wb.policy.settings.shellMaxTimeoutSec,
      onStarted: (toolCallId, root) => events.markToolRunning(task, toolCallId, root),
      runnerOf: toolCallId => wb.runners.get(toolCallId) ?? 'direct',
    }),
    ...documentTools,
    ...webTools,
    ...(memorySearch ? [createMemoryTool(memorySearch, toolCallId => events.markToolRunning(task, toolCallId))] : []),
    ...(wb.navigationEnabled ? createNavigationTools({
      roots: task.roots,
      outputChars: wb.policy.settings.output.navigationChars,
      fileLimit: wb.policy.settings.output.navigationFiles,
      onStarted: (toolCallId, root) => events.markToolRunning(task, toolCallId, root),
    }) : []),
    ...mcpTools.map(tool => ({
      ...tool,
      execute: (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any) => {
        events.markToolRunning(task, toolCallId);
        return tool.execute(toolCallId, params, signal, onUpdate);
      },
    })),
  ];
}
