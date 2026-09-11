import type { RootView } from '../../shared/contracts.js';
import * as git from '../workspace/git.js';

export type RepoRef = {
  id: string;
  label: string;
  /** 非 Git 目录没有 Git 顶层目录，其记忆无法用 Git 校验。 */
  gitRoot?: string;
  /** 该目录相对 Git 顶层目录的前缀（带结尾斜杠），用于把相对目录的路径换成相对顶层的路径。 */
  prefix: string;
};

// 根提交不会变，所以只缓存真正的仓库标识；按路径区分的标识（空仓库）在首次提交后会变，不缓存。
const cache = new Map<string, RepoRef>();

export async function repoOf(root: RootView): Promise<RepoRef> {
  if (!root.git) return { id: git.pathRepoId(root.path), label: root.alias, prefix: '' };
  const cached = cache.get(root.path);
  if (cached) return { ...cached, label: root.alias };
  const ref: RepoRef = { id: await git.repoId(root.git.gitRoot), label: root.alias, gitRoot: root.git.gitRoot, prefix: await git.prefixOf(root.path) };
  if (!ref.id.startsWith('path:')) cache.set(root.path, ref);
  return ref;
}
