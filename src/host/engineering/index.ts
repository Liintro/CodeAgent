import type { DetectedCommand, Diagnostic, ParsedFailure, RootView } from '../../shared/contracts.js';
import { cpp } from './cpp.js';
import { go } from './go.js';
import { java } from './java.js';
import { keil } from './keil.js';
import { node } from './node.js';
import { python } from './python.js';
import { rust } from './rust.js';
import { relativize } from './toolchain.js';

const ADAPTERS = [java, python, node, cpp, go, rust, keil];
const MAX_TESTS = 30;
const MAX_DIAGNOSTICS = 30;

// 只检测目录本身（不递归子项目）；建议命令由用户在验收面板确认后才会执行。
export async function detectCommands(root: RootView, sandboxed = false): Promise<DetectedCommand[]> {
  const found: DetectedCommand[] = [];
  for (const adapter of ADAPTERS) {
    for (const proposal of await adapter.detect(root.path, sandboxed)) {
      const problem = proposal.problem ?? (sandboxed && adapter.sandboxBlocked ? adapter.sandboxBlocked.reason : undefined);
      found.push({ id: `${root.id}-${found.length + 1}`, rootId: root.id, adapter: adapter.id, ...proposal, ...(problem ? { problem } : {}) });
    }
  }
  return found;
}

// 已知的沙箱限制：返回原因，未命中返回 undefined。
export function sandboxBlocked(output: string): string | undefined {
  return ADAPTERS.find(adapter => adapter.sandboxBlocked?.pattern.test(output))?.sandboxBlocked?.reason;
}

// 命令是用户确认的任意字符串，因此不按命令选解析器：各生态的输出格式互不重叠，全部解析后合并去重。
export function parseFailure(raw: string, rootPath: string): ParsedFailure {
  // Maven/npm 在部分终端设置下带 ANSI 颜色码。
  const output = raw.replace(/\x1b\[[0-9;]*m/g, '');
  const tests = new Set<string>();
  const diagnostics = new Map<string, Diagnostic>();
  for (const adapter of ADAPTERS) {
    const parsed = adapter.parse(output);
    for (const name of parsed.tests) tests.add(name);
    for (const item of parsed.diagnostics) {
      const value = { ...item, file: relativize(item.file, rootPath) };
      const key = `${value.file}:${value.line}:${value.col ?? ''}:${value.message}`;
      if (!diagnostics.has(key)) diagnostics.set(key, value);
    }
  }
  // 错误排在警告之前，各自保持输出顺序。
  const ordered = [...diagnostics.values()].sort((a, b) => Number(a.severity === 'warning') - Number(b.severity === 'warning'));
  return { tests: [...tests].slice(0, MAX_TESTS), diagnostics: ordered.slice(0, MAX_DIAGNOSTICS) };
}
