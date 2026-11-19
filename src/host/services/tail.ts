import { isAbsolute, relative, resolve } from 'node:path';
import type { VerificationResult } from '../../shared/contracts/index.js';
import type { ToolCallInfo } from '../kernel/compaction.js';
import type { FileStamp } from '../kernel/session.js';
import { currentBlobs } from '../memory/validity.js';
import type { TaskState, Workbench } from './workbench.js';

// 摘要只为能确定具体文件的调用记下内容标识。
const FILE_TOOLS = new Set(['read', 'edit', 'write']);
const VERIFICATION_TAIL_LINES = 20;
const PLAN_MARK = { pending: ' ', in_progress: '>', completed: 'x' } as const;

export type Backfill = { files: FileStamp[] };

/**
 * 每次请求附在对话末尾的任务状态：随请求重新生成、不写入会话，所以修复轮次里也不会过期，
 * 系统提示因此可以跨 Run 保持不变。backfill 只在上下文里有摘要且开启分层压缩时给出。
 */
export async function tailState(wb: Workbench, task: TaskState, backfill?: Backfill): Promise<string> {
  const lines = ['## 当前任务状态（由系统生成，每次请求更新）'];
  if (task.profile) lines.push(task.profile);
  const commands = task.acceptance.commands.map(command => `- ${task.roots.find(root => root.id === command.rootId)?.alias ?? command.rootId}：${command.command}`);
  lines.push(commands.length ? `验收命令（用户已确认，不得修改）：\n${commands.join('\n')}` : '验收命令：未设置');
  if (task.documents.length) {
    const vision = wb.profile?.vision;
    lines.push(`任务文档（只读；用 doc_outline 查看结构、doc_read 读取页或章节；实现与回答时按 【文档 p.N】 或 【文档 §章节】 引用依据${vision ? '；文本不足以确定的图、表、扫描页才用 doc_view 查看图像' : '；当前模型不支持图像输入，图片与扫描页的内容无法解读，遇到时如实说明'}）：`);
    for (const doc of task.documents) lines.push(`- ${doc.name}（${doc.kind}，${doc.kind === 'pdf' ? `${doc.pages} 页` : `${doc.sections} 个章节`}${doc.noTextLayerPages.length ? `，第 ${doc.noTextLayerPages.join('、')} 页没有文本层` : ''}）`);
  }
  for (const entry of task.deliveryView?.roots ?? []) {
    const last = entry.verification.map(result => `${result.label}${result.status === 'passed' ? '通过' : `未通过（退出码 ${result.exitCode ?? '无'}）`}`).join('、');
    lines.push(`目录 ${entry.alias}：交付状态 ${entry.state}${last ? `；当前代码上的验证：${last}` : ''}`);
    if (entry.files.length) lines.push(`  自任务起点以来变更的文件：${entry.files.slice(0, 50).map(file => `${file.status} ${file.path}`).join('；')}${entry.files.length > 50 ? ` 等共 ${entry.files.length} 个` : ''}`);
  }
  if (backfill) lines.push(...await backfillLines(wb, task, backfill));
  return lines.join('\n');
}

// 摘要会丢细节：补上当前计划、最近一次验证的输出尾部，并指出摘要形成后内容已变化的文件。
async function backfillLines(wb: Workbench, task: TaskState, backfill: Backfill): Promise<string[]> {
  const lines = ['较早的对话已压缩为摘要，以下状态以系统记录为准：'];
  if (task.plan.length) lines.push(`当前计划：\n${task.plan.map(item => `- [${PLAN_MARK[item.status]}] ${item.content}`).join('\n')}`);
  const last = wb.ledger.taskEvents(task.id, 'verification.finished').at(-1)?.data as unknown as VerificationResult | undefined;
  if (last) {
    const alias = task.roots.find(root => root.id === last.rootId)?.alias ?? last.rootId;
    const tail = last.status === 'passed' ? '' : `\n${(last.outputTail ?? '').split('\n').slice(-VERIFICATION_TAIL_LINES).join('\n')}`;
    lines.push(`最近一次验证：${alias} ${last.label}${last.status === 'passed' ? '通过' : `未通过（退出码 ${last.exitCode ?? '无'}）`}${tail}`);
  }
  const stale = await staleFiles(task, backfill.files);
  if (stale.length) lines.push(`摘要中关于以下文件的描述可能已过期（摘要形成后内容有变化），以当前文件为准：${stale.join('、')}`);
  return lines;
}

/** 摘要涉及的文件（相对 Git 顶层）及其当前内容标识；不在 Git 仓库里的目录无从校验，不记录。 */
export async function stampFiles(wb: Workbench, task: TaskState, calls: ToolCallInfo[]): Promise<FileStamp[]> {
  const byRoot = new Map<string, Set<string>>();
  for (const call of calls) {
    if (!FILE_TOOLS.has(call.name) || typeof call.args.path !== 'string') continue;
    const root = wb.rootFor(task, call.args);
    const gitRoot = root?.git?.gitRoot;
    if (!root || !gitRoot) continue;
    const path = relative(gitRoot, resolve(root.path, call.args.path)).replaceAll('\\', '/');
    if (path.startsWith('..') || isAbsolute(path)) continue;
    byRoot.set(root.id, (byRoot.get(root.id) ?? new Set()).add(path));
  }
  const stamps: FileStamp[] = [];
  for (const [rootId, paths] of byRoot) {
    const blobs = await currentBlobs(task.roots.find(root => root.id === rootId)!.git!.gitRoot, [...paths]);
    for (const path of paths) stamps.push({ rootId, path, blob: blobs.get(path) });
  }
  return stamps;
}

async function staleFiles(task: TaskState, stamps: FileStamp[]): Promise<string[]> {
  const stale: string[] = [];
  for (const root of task.roots) {
    const mine = stamps.filter(stamp => stamp.rootId === root.id);
    if (!mine.length || !root.git?.gitRoot) continue;
    const blobs = await currentBlobs(root.git.gitRoot, mine.map(stamp => stamp.path));
    for (const stamp of mine) if (blobs.get(stamp.path) !== stamp.blob) stale.push(task.roots.length > 1 ? `${root.alias}/${stamp.path}` : stamp.path);
  }
  return stale;
}
