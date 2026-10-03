import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { RootView } from '../../shared/contracts.js';

// 确定性的代码导航：符号轮廓、定义查找、相关文件（测试/源码配对、引用方、Git 共同修改）。
// 只读，输出一律带 path:起-止 行号，便于核对引用是否与当前文件一致。

const LIST_LIMIT = 4000;
const OUTPUT_LIMIT = 16 * 1024;

type Symbol = { name: string; kind: string; line: number; end: number };

// 每种语言的定义行（行首匹配，避免把调用当作定义）。结束行按缩进/花括号近似。
const DEFINITIONS: { exts: string[]; pattern: RegExp; kind: (match: RegExpExecArray) => string }[] = [
  { exts: ['.ts', '.tsx', '.js', '.mjs', '.cjs'], pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:(function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/, kind: match => match[1] ?? 'function' },
  { exts: ['.ts', '.tsx', '.js', '.mjs'], pattern: /^\s+(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/, kind: () => 'method' },
  { exts: ['.py'], pattern: /^\s*(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/, kind: match => match[1] },
  { exts: ['.java', '.kt', '.cs'], pattern: /^\s*(?:(?:public|private|protected|static|final|abstract|sealed|override|internal)\s+)*(class|interface|enum|record)\s+([A-Za-z_]\w*)/, kind: match => match[1] },
  { exts: ['.java', '.kt', '.cs'], pattern: /^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|override)\s+)+[\w<>[\],\s?]+\s+([A-Za-z_]\w*)\s*\([^;]*$/, kind: () => 'method' },
  { exts: ['.go'], pattern: /^(?:func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)|type\s+([A-Za-z_]\w*))/, kind: match => match[1] ? 'func' : 'type' },
  { exts: ['.rs'], pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?(fn|struct|enum|trait|impl|mod)\s+([A-Za-z_]\w*)/, kind: match => match[1] },
  { exts: ['.c', '.h', '.cpp', '.hpp', '.cc', '.cxx'], pattern: /^(?!\s*(?:if|for|while|switch|return|else)\b)[A-Za-z_][\w\s\*&:<>,]*?\b([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const\s*)?\{?\s*$|^\s*(?:typedef\s+)?(struct|class|enum|union)\s+([A-Za-z_]\w*)/, kind: match => match[2] ?? 'function' },
];

export function outline(path: string, text: string): Symbol[] {
  const rules = DEFINITIONS.filter(rule => rule.exts.includes(extname(path).toLowerCase()));
  const lines = text.split(/\r?\n/);
  const symbols: Symbol[] = [];
  lines.forEach((line, index) => {
    for (const rule of rules) {
      const match = rule.pattern.exec(line);
      if (!match) continue;
      const name = match.slice(1).filter(Boolean).reverse().find(value => /^[A-Za-z_$][\w$]*$/.test(value) && !['function', 'class', 'interface', 'type', 'enum', 'def', 'record', 'struct', 'union', 'fn', 'trait', 'impl', 'mod'].includes(value));
      if (!name || ['if', 'for', 'while', 'switch', 'catch', 'return'].includes(name)) continue;
      symbols.push({ name, kind: rule.kind(match), line: index + 1, end: blockEnd(lines, index, extname(path).toLowerCase() === '.py') });
      break;
    }
  });
  return symbols;
}

// Python 按缩进；其他语言按花括号配平（忽略字符串里的括号，足够用于定位）。
function blockEnd(lines: string[], start: number, indentation: boolean): number {
  if (indentation) {
    const indent = /^\s*/.exec(lines[start])![0].length;
    for (let index = start + 1; index < lines.length; index++) {
      if (lines[index].trim() && /^\s*/.exec(lines[index])![0].length <= indent) return index;
    }
    return lines.length;
  }
  let depth = 0;
  let opened = false;
  for (let index = start; index < Math.min(lines.length, start + 2000); index++) {
    for (const char of lines[index]) {
      if (char === '{') { depth++; opened = true; } else if (char === '}') depth--;
    }
    if (opened && depth <= 0) return index + 1;
    if (!opened && index > start + 2) return start + 1;
  }
  return start + 1;
}

function run(file: string, args: string[], cwd: string): Promise<string> {
  return new Promise(resolve => execFile(file, args, { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 30000 }, (_error, stdout) => resolve(stdout ?? '')));
}

const trackedFiles = async (root: RootView) => (await run('git', ['ls-files', '-z'], root.path)).split('\0').filter(Boolean).slice(0, 200000);

// 任务开始时的仓库概况（约 400 token 以内），写进系统提示的状态块。
export async function repositoryProfile(root: RootView): Promise<string> {
  const files = root.git ? await trackedFiles(root) : [];
  if (!files.length) return `目录 ${root.alias}：${root.git ? 'Git 仓库中没有已跟踪的文件' : '非 Git 目录'}`;
  const byExt = new Map<string, number>();
  for (const file of files) {
    const ext = extname(file).toLowerCase() || basename(file);
    byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
  }
  const languages = [...byExt].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([ext, count]) => `${ext} ${count}`).join('，');
  const top = [...new Set(files.map(file => file.split('/')[0]))].filter(name => files.some(file => file.startsWith(`${name}/`))).slice(0, 12);
  const manifests = files.filter(file => /(^|\/)(package\.json|pom\.xml|build\.gradle(\.kts)?|pyproject\.toml|go\.mod|Cargo\.toml|CMakeLists\.txt|Makefile|[^/]+\.uvprojx)$/.test(file) && file.split('/').length <= 2).slice(0, 10);
  const tests = [...new Set(files.filter(file => /(^|\/)(tests?|__tests__|spec)\//.test(file) || /(_test|\.test|\.spec|Test)\.\w+$/.test(file)).map(file => dirname(file)))].slice(0, 8);
  const docs = files.filter(file => /^(AGENTS|README|CONTRIBUTING)(\.md)?$/i.test(basename(file)) && !file.includes('/')).join('、');
  return [
    `目录 ${root.alias} 概况（${files.length} 个已跟踪文件）：语言/扩展名 ${languages}`,
    `  顶层目录：${top.join('、') || '无'}`,
    manifests.length ? `  构建清单：${manifests.join('、')}` : '',
    tests.length ? `  测试目录：${tests.join('、')}` : '',
    docs ? `  说明文件：${docs}` : '',
  ].filter(Boolean).join('\n');
}

export type NavigationContext = { roots: RootView[]; onStarted: (toolCallId: string, root: RootView) => void };

export function createNavigationTools(ctx: NavigationContext): AgentTool<any>[] {
  const rootParam = { type: 'string', enum: ctx.roots.map(root => root.alias), description: '工作目录别名，默认主目录' };
  const pick = (alias: unknown) => {
    const root = alias === undefined ? ctx.roots.find(item => item.primary) : ctx.roots.find(item => item.alias === alias);
    if (!root) throw new Error(`未知的 root：${String(alias)}`);
    return root;
  };
  const relativePath = (root: RootView, path: string) => {
    const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
    if (normalized.startsWith('..') || /^[A-Za-z]:/.test(normalized) || normalized.startsWith('/')) throw new Error('只接受相对工作目录的路径');
    return normalized;
  };
  return [
    {
      name: 'code_outline',
      label: 'code_outline',
      description: '列出一个源文件中的类、函数、方法等定义及其行号范围（path:起-止）。只读。',
      parameters: { type: 'object', required: ['path'], properties: { root: rootParam, path: { type: 'string', description: '相对工作目录的文件路径' } } },
      execute: async (toolCallId, params: any) => {
        const root = pick(params.root);
        const path = relativePath(root, String(params.path));
        ctx.onStarted(toolCallId, root);
        const symbols = outline(path, await readFile(join(root.path, path), 'utf8'));
        return text(symbols.length ? symbols.map(item => `${path}:${item.line}-${item.end} ${item.kind} ${item.name}`).join('\n') : `${path}：没有识别到定义`);
      },
    },
    {
      name: 'find_symbol',
      label: 'find_symbol',
      description: '在已跟踪的源文件中查找名称包含 query 的定义（类、函数、方法、类型），返回 path:起-止。比 grep 更少噪声：不返回调用处。只读。',
      parameters: { type: 'object', required: ['query'], properties: { root: rootParam, query: { type: 'string' } } },
      execute: async (toolCallId, params: any) => {
        const root = pick(params.root);
        ctx.onStarted(toolCallId, root);
        const query = String(params.query).toLowerCase();
        const exts = new Set(DEFINITIONS.flatMap(rule => rule.exts));
        const hits: string[] = [];
        for (const file of (await trackedFiles(root)).filter(file => exts.has(extname(file).toLowerCase())).slice(0, LIST_LIMIT)) {
          const content = await readFile(join(root.path, file), 'utf8').catch(() => '');
          if (!content.toLowerCase().includes(query)) continue;
          for (const item of outline(file, content)) if (item.name.toLowerCase().includes(query)) hits.push(`${file}:${item.line}-${item.end} ${item.kind} ${item.name}`);
          if (hits.length >= 60) break;
        }
        return text(hits.length ? hits.join('\n') : `没有找到名称包含“${params.query}”的定义`);
      },
    },
    {
      name: 'related_files',
      label: 'related_files',
      description: '与一个文件相关的文件：对应的测试或被测源码、引用它的文件，以及 Git 历史中经常与它一起修改的文件（附共同提交次数）。只读。',
      parameters: { type: 'object', required: ['path'], properties: { root: rootParam, path: { type: 'string' } } },
      execute: async (toolCallId, params: any) => {
        const root = pick(params.root);
        const path = relativePath(root, String(params.path));
        ctx.onStarted(toolCallId, root);
        const files = await trackedFiles(root);
        const stem = basename(path, extname(path)).replace(/(\.test|\.spec|_test|Test|Tests)$/, '');
        const tests = files.filter(file => file !== path && basename(file, extname(file)).replace(/^test_/, '').replace(/(\.test|\.spec|_test|Test|Tests)$/, '') === stem);
        const importers = (await run('git', ['grep', '-l', '-F', '-e', `/${stem}`, '-e', `"${stem}"`, '-e', `'${stem}'`, '-e', `import ${stem}`, '-e', `${stem}.h"`], root.path))
          .split('\n').map(line => line.trim()).filter(file => file && file !== path).slice(0, 20);
        const together = await coChange(root, path);
        return text([
          `对应的测试/源码：${tests.join('、') || '无'}`,
          `引用它的文件：${importers.join('、') || '无'}`,
          `经常一起修改：${together.map(([file, count]) => `${file}（${count}）`).join('、') || '无历史'}`,
        ].join('\n'));
      },
    },
  ];
}

// 最近 300 个触及该文件的提交里（--full-diff 列出这些提交的全部文件），与它一起修改次数最多的文件。
async function coChange(root: RootView, path: string): Promise<[string, number][]> {
  if (!root.git) return [];
  const log = await run('git', ['log', '-n', '300', '--format=format:@@', '--name-only', '--full-diff', '--', path], root.path);
  const counts = new Map<string, number>();
  for (const block of log.split('@@')) {
    for (const file of block.split('\n').map(line => line.trim()).filter(Boolean)) if (file !== path) counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 10);
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value.length > OUTPUT_LIMIT ? `${value.slice(0, OUTPUT_LIMIT)}\n（输出已截断）` : value }], details: undefined });

// 引用核对：回答中的 path:起-止 是否指向当前文件中真实存在的行（只核对出处，不判断逻辑是否正确）。
export async function verifyCitations(answer: string, roots: RootView[]): Promise<{ cited: number; valid: number; invalid: string[] }> {
  const invalid: string[] = [];
  let cited = 0;
  for (const match of answer.matchAll(/([\w./-]+\.[A-Za-z]{1,5}):(\d+)(?:-(\d+))?/g)) {
    cited++;
    const [, file, from, to] = match;
    const lines = await Promise.any(roots.map(root => readFile(join(root.path, file), 'utf8'))).then(content => content.split(/\r?\n/).length, () => 0);
    if (!lines || Number(from) < 1 || Number(to ?? from) > lines || Number(to ?? from) < Number(from)) invalid.push(match[0]);
  }
  return { cited, valid: cited - invalid.length, invalid };
}
