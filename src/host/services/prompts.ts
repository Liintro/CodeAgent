import { stat } from 'node:fs/promises';
import type { VerificationResult } from '../../shared/contracts/index.js';
import type { HarnessPolicy } from '../runtime/policy.js';
import { recoveryBrief, unknownCalls, type RootRecovery } from '../runtime/recovery.js';
import * as git from '../workspace/git.js';
import type { DeliveryService } from './delivery.js';
import type { TaskState, Workbench } from './workbench.js';

/** 系统提示中的角色、工作目录、权限模式与工程守则；策略包的经验手册追加在末尾。 */
export function modeStatement(task: TaskState, policy: HarnessPolicy): string {
  const roots = task.roots.map(root => `- ${root.alias}${root.primary ? '（主目录）' : ''}：${root.path}${root.git ? `，Git 分支 ${root.git.branch ?? '未知'}` : '，非 Git'}`).join('\n');
  const mode = { plan: '计划：只读，仅可读取与搜索，不要修改任何文件，给出分步实施计划', manual: '手动：编辑与命令均需用户批准', accept_edits: '接受编辑：范围内文件编辑自动通过，命令需批准', auto: '自动：编辑自动通过，命令仅在沙箱内自动执行', bypass: '绕过权限：不再逐项询问' }[task.permission.userMode];
  return `你是 CodeAgent 中文工作台中的编程助手。只使用显式提供的工具，所有文件路径必须位于下列目录内；工具可用 root 参数选择目录，默认主目录。根据真实工具结果回答，不要声称未执行的验证已经通过。
工作目录：
${roots || '（未选择目录）'}
当前权限模式：${mode}

## 工程守则（必须遵守）
1. 范围纪律：只在上述工作目录内探索与取证。不要读取、扫描或修改目录之外的文件系统、缓存目录或其他会话/运行留下的数据；需要工具链信息时用 Get-Command 或 where.exe 查询，不要全盘递归搜索。
2. 测试契约：测试是行为契约，测试失败首先当作源码问题对待。不要为了让测试通过而修改或删除已有测试、放宽断言或改写期望值；除非任务明确要求，交付的改动不包含对任何测试文件的改动（也不要新增测试文件）。
3. 沿用惯例：新增或修改报错与日志文本、命令行参数、配置项、函数或接口名时，先在仓库里搜索同类写法（相同或相近的消息、相邻的参数定义、同模块的命名），措辞、大小写和格式与已有写法保持一致；已有现成的消息或工具函数时直接复用，不要另起一套。
4. 验证闭环：修改完成后，先从仓库的构建配置（package.json、Makefile、Cargo.toml、go.mod、pom.xml、CMakeLists.txt 等）识别真实的构建/测试入口，运行与本次改动最相关的最小子集。因环境原因（依赖缺失、权限拒绝、工具链不可用）无法运行时，同一目标最多尝试 2 次即降级为替代验证：复核改动上下文、用 git diff 自查、或在系统临时目录自建最小验证脚本（验证后删除，不留在工作区）。
5. 成本纪律：命令设置合理超时（常用 30–300 秒），不要让长命令阻塞整个任务；同一命令失败后不要原样重跑；探索阶段用复合命令一次获取多项信息，避免对同一文件反复读取。
6. 交付自查：结束前用 git status/diff 核对改动范围，确认没有混入临时文件、调试脚本或无关产物。最终回复如实说明：做了什么、哪些验证已通过、哪些验证无法执行及原因；验证不完整的部分不得声称完成。${policy.playbook ? `

## 经验手册（从历史任务轨迹总结）
${policy.playbook}` : ''}`;
}

// 每个 Run 的系统提示末尾的状态块：压缩无法丢弃这些事实。
export function stateBlock(task: TaskState, vision: boolean | undefined): string {
  const lines = ['## 任务状态（由系统生成）'];
  if (task.profile) lines.push(task.profile);
  const commands = task.acceptance.commands.map(command => `- ${task.roots.find(root => root.id === command.rootId)?.alias ?? command.rootId}：${command.command}`);
  lines.push(commands.length ? `验收命令（用户已确认，不得修改）：\n${commands.join('\n')}` : '验收命令：未设置');
  if (task.documents.length) {
    lines.push(`任务文档（只读；用 doc_outline 查看结构、doc_read 读取页或章节；实现与回答时按 【文档 p.N】 或 【文档 §章节】 引用依据${vision ? '；文本不足以确定的图、表、扫描页才用 doc_view 查看图像' : '；当前模型不支持图像输入，图片与扫描页的内容无法解读，遇到时如实说明'}）：`);
    for (const doc of task.documents) lines.push(`- ${doc.name}（${doc.kind}，${doc.kind === 'pdf' ? `${doc.pages} 页` : `${doc.sections} 个章节`}${doc.noTextLayerPages.length ? `，第 ${doc.noTextLayerPages.join('、')} 页没有文本层` : ''}）`);
  }
  for (const entry of task.deliveryView?.roots ?? []) {
    const last = entry.verification.map(result => `${result.label}${result.status === 'passed' ? '通过' : `未通过（退出码 ${result.exitCode ?? '无'}）`}`).join('、');
    lines.push(`目录 ${entry.alias}：交付状态 ${entry.state}${last ? `；当前代码上的验证：${last}` : ''}`);
    if (entry.files.length) lines.push(`  自任务起点以来变更的文件：${entry.files.slice(0, 50).map(file => `${file.status} ${file.path}`).join('；')}${entry.files.length > 50 ? ` 等共 ${entry.files.length} 个` : ''}`);
  }
  return lines.join('\n');
}

// 以真实的 Git/工作区状态为准，列出变更与结果未知的调用；不重放任何东西。
export async function buildRecoveryBrief(wb: Workbench, deliveries: DeliveryService, task: TaskState, interruptedRunId: string): Promise<string> {
  const events = wb.ledger.events(interruptedRunId);
  const roots: RootRecovery[] = [];
  for (const root of task.roots) {
    const exists = await stat(root.path).then(value => value.isDirectory(), () => false);
    if (!exists || !root.git) {
      roots.push({ alias: root.alias, sinceRun: [], sinceBaseline: [], missing: !exists });
      continue;
    }
    const now = await git.snapshot(root.path);
    const start = events.find(event => event.type === 'git.snapshot' && event.data.kind === 'run_start' && event.data.rootId === root.id)?.data.tree as string | undefined;
    const base = deliveries.baselineOf(task, root.id)?.tree;
    roots.push({
      alias: root.alias,
      sinceRun: start ? await git.changes(root.path, start, now) : [],
      sinceBaseline: base ? await git.changes(root.path, base, now) : [],
    });
  }
  const calls = unknownCalls(events, rootId => task.roots.find(root => root.id === rootId)?.alias);
  const last = wb.ledger.taskEvents(task.id, 'verification.finished').at(-1)?.data as unknown as VerificationResult | undefined;
  const lastText = last ? `${task.roots.find(root => root.id === last.rootId)?.alias ?? last.rootId} ${last.label}：${last.status === 'passed' ? '通过' : `未通过（退出码 ${last.exitCode ?? '无'}）`}` : undefined;
  return recoveryBrief(roots, calls, lastText);
}
