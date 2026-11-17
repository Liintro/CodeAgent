import { createHash } from 'node:crypto';
import type { ApprovalRequest, VerificationResult } from '../../shared/contracts/index.js';
import { failureHash } from '../services/verification.js';
import * as git from '../workspace/git.js';
import { failureLines, scrub } from './capture.js';
import type { RepoRef } from './repo.js';
import type { Anchor, NewMemory } from './store.js';

// 教训都是待确认的：由系统推断或摘自用户的一句话，用户在记忆面板里确认或拒绝。
const MAX_PATHS = 20;
const SHOWN_PATHS = 4;
const CORRECTION_LIMIT = 300;

// 用户对上一个回答的纠正：以否定或改正的说法开头，或明确要求不要怎样做。只在任务的后续消息里判断。
const CORRECTION = /^(不对|不是|错了|你错了|搞错|别|不要|不用|停|应该|改成|换成|改用)|不要再|不应该|而不是|别再|^(no|wrong|don'?t|stop|instead)\b|\binstead of\b/i;

type Base = Pick<NewMemory, 'repoId' | 'repoLabel' | 'taskId' | 'runId'>;
type Verified = { runId: string; result: VerificationResult };

/**
 * 换路线：同一条验收命令以同一个失败连续出现两次（中间改过代码却没解决），之后失败变了或通过了，
 * 中间那次改动就是被放弃的方案。锚点取最后那棵树上的文件，这些文件再变时教训降为 drifted。
 */
export async function routeLessons(repo: RepoRef, base: Base, rootId: string, results: Verified[]): Promise<NewMemory[]> {
  const byCommand = new Map<string, VerificationResult[]>();
  for (const { runId, result } of results) {
    if (runId !== base.runId || result.rootId !== rootId || !result.treeAtStart) continue;
    byCommand.set(result.commandId, [...byCommand.get(result.commandId) ?? [], result]);
  }
  const lessons: NewMemory[] = [];
  for (const list of byCommand.values()) {
    for (let index = 0; index + 2 < list.length; index++) {
      const [first, again, later] = [list[index], list[index + 1], list[index + 2]];
      const failed = (result: VerificationResult) => result.status === 'failed' || result.status === 'timeout';
      if (!failed(first) || !failed(again) || failureHash(first) !== failureHash(again) || first.treeAtStart === again.treeAtStart) continue;
      if (failed(later) && failureHash(later) === failureHash(again)) continue;
      lessons.push(await routeLesson(repo, base, first, again, later));
    }
  }
  return lessons;
}

async function routeLesson(repo: RepoRef, base: Base, first: VerificationResult, again: VerificationResult, later: VerificationResult): Promise<NewMemory> {
  const abandoned = (await git.treeChanges(repo.gitRoot!, first.treeAtStart!, again.treeAtStart!)).slice(0, MAX_PATHS);
  const next = (await git.treeChanges(repo.gitRoot!, again.treeAtStart!, later.treeAtStart!)).slice(0, MAX_PATHS);
  const blobs = await git.blobsAt(repo.gitRoot!, later.treeAtStart!, abandoned);
  const anchors: Anchor[] = abandoned.flatMap((path, index) => blobs[index] ? [{ path, preBlob: blobs[index], postBlob: blobs[index] }] : []);
  const lines = failureLines(first.outputTail);
  const then = later.status === 'passed' ? `改为修改 ${shown(next)} 后通过` : `之后失败变为：${failureLines(later.outputTail).join('；') || '无输出'}`;
  const hash = failureHash(first);
  return {
    ...base, kind: 'lesson', origin: 'harness', confirmed: false, anchors,
    signature: signature('route', base.repoId, `${hash}|${[...abandoned].sort().join(',')}`),
    text: `${repo.label}：\`${scrub(first.command)}\` 失败（${lines.join('；') || '无输出'}）时，修改 ${shown(abandoned)} 没有解决，同一失败再次出现，于是放弃了这条路线；${then}。`,
    evidence: { source: 'route', command: scrub(first.command), failureHash: hash, failureLines: lines, abandoned, next, trees: [first.treeAtStart, again.treeAtStart, later.treeAtStart] },
  };
}

/** 拒绝审批时用户写下的原因。编辑类操作锚定目标文件的当前内容。 */
export async function rejectionLesson(repo: RepoRef, base: Base, request: ApprovalRequest, path: string | undefined, reason: string): Promise<NewMemory> {
  const blob = path && repo.gitRoot ? (await git.hashFiles(repo.gitRoot, [path]).catch(() => []))[0] : undefined;
  return {
    ...base, kind: 'lesson', origin: 'user', confirmed: false, anchors: path && blob ? [{ path, preBlob: blob, postBlob: blob }] : [],
    signature: signature('rejection', base.repoId, `${request.tool}|${request.summary}|${reason}`),
    text: `用户拒绝了 ${request.tool}（${scrub(request.summary).slice(0, 120)}），原因：${scrub(reason)}`,
    evidence: { source: 'rejection', tool: request.tool, summary: scrub(request.summary), reason: scrub(reason) },
  };
}

/** 任务里的后续消息像是在纠正上一个回答时，原话记成一条教训；不像就返回 undefined。 */
export function correctionLesson(base: Base, text: string): NewMemory | undefined {
  const value = text.trim();
  if (!value || value.length > CORRECTION_LIMIT || !CORRECTION.test(value)) return undefined;
  return {
    ...base, kind: 'lesson', origin: 'user', confirmed: false, anchors: [],
    signature: signature('correction', base.repoId, value), text: `用户纠正：${scrub(value)}`, evidence: { source: 'correction' },
  };
}

const shown = (paths: string[]) => paths.length ? `${paths.slice(0, SHOWN_PATHS).join('、')}${paths.length > SHOWN_PATHS ? ' 等' : ''}` : '（无文件变化）';

function signature(kind: string, repoId: string, key: string): string {
  return createHash('sha1').update(`lesson|${kind}|${repoId}|${key}`).digest('hex');
}
