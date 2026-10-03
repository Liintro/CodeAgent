import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Acceptance, Delivery, DeliveryActionResult, DeliveryView, RootDelivery, RootDeliveryState, RootView, VerificationResult } from '../../shared/contracts.js';
import type { DeliveryRow, Ledger } from '../runtime/ledger.js';
import * as git from './git.js';

export type DeliveryInput = {
  taskId: string;
  roots: RootView[];
  ledger: Ledger;
  acceptance: Acceptance;
  /** 该 Task 全部 verification.finished 的结果，按发生顺序。 */
  verifications: VerificationResult[];
  /** 非 Git 目录没有树对象，用工具修改计数 mut:<n> 代替。 */
  mutations: Map<string, number>;
  /** 任务文档及 Agent 读取时引用过的页/章节（来自 doc_read 调用），写入交付报告以便追溯需求来源。 */
  documents: { name: string; kind: string; sha256: string; citations: string[] }[];
};

export const treeOfPlainRoot = (count: number) => `mut:${count}`;
const USER_STATES: RootDeliveryState[] = ['accepted', 'restored', 'committed'];

export async function currentTree(root: RootView, input: Pick<DeliveryInput, 'mutations'>): Promise<string> {
  return root.git ? git.snapshot(root.path) : treeOfPlainRoot(input.mutations.get(root.id) ?? 0);
}

export async function buildDelivery(input: DeliveryInput, trees?: Map<string, string>): Promise<DeliveryView> {
  const rows = input.ledger.deliveryRows(input.taskId);
  const roots: RootDelivery[] = [];
  for (const root of input.roots) {
    const row = rows.find(item => item.rootId === root.id);
    const now = trees?.get(root.id) ?? await currentTree(root, input);
    roots.push(await describeRoot(root, row, now, input));
  }
  return { taskId: input.taskId, state: aggregate(roots), roots };
}

async function describeRoot(root: RootView, row: DeliveryRow | undefined, now: string, input: DeliveryInput): Promise<RootDelivery> {
  const base = row?.baseTree ?? (root.git ? undefined : treeOfPlainRoot(0));
  const files = root.git && base ? await git.changes(root.path, base, now) : [];
  const changed = root.git ? files.length > 0 : now !== base;
  const commands = input.acceptance.commands.filter(command => command.rootId === root.id);
  // 只有对当前源码状态（树相同）的验证结果才有效；之后再改文件即视为过期。
  const latest = new Map<string, VerificationResult>();
  for (const result of input.verifications) if (result.rootId === root.id && result.treeAtStart === now) latest.set(result.commandId, result);
  const verification = [...latest.values()];
  const passed = commands.length > 0 && commands.every(command => latest.get(command.id)?.status === 'passed');
  const failed = verification.some(result => result.status === 'failed' || result.status === 'timeout');
  let state: RootDeliveryState = !changed ? 'none' : passed ? 'verified' : failed ? 'verification_failed' : 'unverified';
  if (changed && row && USER_STATES.includes(row.state) && row.finalTree === now) state = row.state;
  if (!changed && row?.state === 'restored' && row.finalTree === now) state = 'restored';

  let sharedPaths: string[] = [];
  let dirtyAtBaseline = false;
  if (root.git && base) {
    const dirty = await git.dirtyPaths(root.path, row?.baseCommit, base).catch((): string[] => []);
    dirtyAtBaseline = dirty.length > 0;
    sharedPaths = files.map(file => file.path).filter(path => dirty.includes(path));
  }
  return {
    rootId: root.id, alias: root.alias, git: Boolean(root.git), state, branch: root.git?.branch, baseCommit: row?.baseCommit, baseTree: base, finalTree: now,
    files, dirtyAtBaseline, noCommands: changed && commands.length === 0, verification, patchFile: row?.patchFile, reportFile: row?.reportFile,
    commitSha: row?.commitSha, sharedPaths,
  };
}

// 任一被修改的目录失败或未验证，整个 Task 都不会显示 verified。
function aggregate(roots: RootDelivery[]): Delivery {
  const states = roots.map(root => root.state).filter(state => state !== 'none');
  if (!states.length) return 'none';
  if (states.includes('verification_failed')) return 'verification_failed';
  if (states.includes('unverified')) return 'unverified';
  if (states.includes('verified')) return 'verified';
  if (states.every(state => state === 'restored')) return 'restored';
  return 'accepted';
}

// 保存每个有变更目录的补丁与报告，并更新数据库中的交付行。
export async function persistDelivery(input: DeliveryInput, view: DeliveryView, evidenceDir: string): Promise<DeliveryView> {
  const directory = join(evidenceDir, input.taskId);
  await mkdir(directory, { recursive: true });
  for (const entry of view.roots) {
    const root = input.roots.find(item => item.id === entry.rootId)!;
    const row = input.ledger.deliveryRows(input.taskId).find(item => item.rootId === entry.rootId);
    const changed = entry.files.length > 0 || (!entry.git && entry.state !== 'none');
    let patchFile: string | undefined;
    if (changed && entry.git && entry.baseTree && entry.finalTree) {
      patchFile = join(directory, `patch-${entry.alias}.patch`);
      await writeFile(patchFile, await git.patch(root.path, entry.baseTree, entry.finalTree), 'utf8');
    } else if (row?.patchFile) {
      await rm(row.patchFile, { force: true });
    }
    const reportFile = join(directory, `delivery-${entry.alias}.json`);
    await writeFile(reportFile, JSON.stringify({ ...entry, path: root.path, patchFile, reportFile, documents: input.documents }, null, 2), 'utf8');
    Object.assign(entry, { patchFile, reportFile });
    input.ledger.saveDelivery({
      taskId: input.taskId, rootId: entry.rootId, state: entry.state, baseTree: entry.baseTree, finalTree: entry.finalTree,
      baseCommit: entry.baseCommit, commitSha: row?.commitSha, patchFile, reportFile,
    });
  }
  return view;
}

// ---- 用户动作 ----

export async function acceptRoot(input: DeliveryInput, rootId: string): Promise<void> {
  const { entry, row } = await locate(input, rootId);
  if (!entry.files.length && entry.git) throw new Error('该目录没有可接受的变更');
  input.ledger.saveDelivery({ ...row, state: 'accepted', finalTree: entry.finalTree });
}

// 还原只针对智能体改动的文件；任何在最终快照之后又被改过的文件都会跳过并列出，绝不覆盖用户的后续修改。
export async function restoreRoot(input: DeliveryInput, rootId: string): Promise<DeliveryActionResult> {
  const { entry, root, row } = await locate(input, rootId);
  if (!root.git || !entry.baseTree) throw new Error('非 Git 目录不支持还原');
  const now = entry.finalTree!;
  const final = row.finalTree ?? now;
  const skipped: string[] = [];
  const restore: string[] = [];
  const remove: string[] = [];
  for (const { path, status } of await git.changedPaths(root.path, entry.baseTree, final)) {
    if (await git.blobAt(root.path, now, path) !== await git.blobAt(root.path, final, path)) {
      skipped.push(path);
    } else if (status === 'A') {
      remove.push(path);
    } else {
      restore.push(path);
    }
  }
  await git.restoreFrom(root.path, entry.baseTree, restore);
  for (const path of remove) await rm(join(root.path, path), { force: true });
  input.ledger.saveDelivery({ ...row, state: 'restored', finalTree: await git.snapshot(root.path) });
  return { rootId, skipped };
}

export async function commitRoot(input: DeliveryInput, rootId: string, message: string, confirmShared: boolean): Promise<DeliveryActionResult> {
  const { entry, root, row } = await locate(input, rootId);
  if (!root.git || !entry.baseTree) throw new Error('非 Git 目录不支持提交');
  if (!message.trim()) throw new Error('请输入提交说明');
  if (entry.sharedPaths.length && !confirmShared) {
    throw new Error(`提交将包含您在这些文件上已有的修改，需要确认：${entry.sharedPaths.join('、')}`);
  }
  const tracked: string[] = [];
  const created: string[] = [];
  for (const { path, status } of await git.changedPaths(root.path, entry.baseTree, entry.finalTree!)) {
    const inHead = await git.blobAt(root.path, 'HEAD', path);
    if (inHead) tracked.push(path);
    else if (status !== 'D') created.push(path);
  }
  if (!tracked.length && !created.length) throw new Error('没有可提交的变更');
  const commitSha = await git.commitPaths(root.path, message.trim(), tracked, created);
  input.ledger.saveDelivery({ ...row, state: 'committed', commitSha, finalTree: await git.snapshot(root.path) });
  return { rootId, skipped: [], commitSha };
}

async function locate(input: DeliveryInput, rootId: string) {
  const root = input.roots.find(item => item.id === rootId);
  if (!root) throw new Error('目录不存在');
  const view = await buildDelivery({ ...input, roots: [root] });
  const entry = view.roots[0];
  const row = input.ledger.deliveryRows(input.taskId).find(item => item.rootId === rootId)
    ?? { taskId: input.taskId, rootId, state: 'none' as RootDeliveryState, baseTree: entry.baseTree, updatedAt: Date.now() };
  return { root, entry, row };
}
