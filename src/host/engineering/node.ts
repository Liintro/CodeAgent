import { join } from 'node:path';
import { diagnostic, findExecutable, has, listFiles, matches, missing, probe, readJson, type Adapter, type Proposal } from './toolchain.js';

const NO_TEST = /no test specified/;

export const node: Adapter = {
  id: 'node',
  async detect(root, sandboxed) {
    const manifest = readJson(join(root, 'package.json'));
    if (!manifest) return [];
    const manager = has(root, 'pnpm-lock.yaml') ? 'pnpm' : has(root, 'yarn.lock') ? 'yarn' : 'npm';
    const nodeExe = findExecutable('node');
    const toolchain = nodeExe && await probe(nodeExe, ['--version']).then(version => version && `Node ${version}`);
    const deps = { ...manifest.dependencies, ...manifest.devDependencies };
    const problem = !nodeExe ? missing('node') : !findExecutable(manager) ? missing(manager)
      : Object.keys(deps).length && !has(root, 'node_modules') ? `依赖尚未安装（没有 node_modules），请先运行 ${manager} install` : undefined;
    const run = (script: string) => manager === 'npm' ? (script === 'test' ? 'npm test' : `npm run ${script}`) : `${manager} ${script}`;
    const scripts = manifest.scripts ?? {};
    const found: Proposal[] = [];
    for (const script of ['typecheck', 'build', 'lint']) {
      if (scripts[script]) found.push({ label: `${manager} ${script}`, command: run(script), timeoutSeconds: 600, toolchain, problem });
    }
    if (scripts.test && !NO_TEST.test(scripts.test)) {
      found.push({ label: `${manager} test`, command: run('test'), timeoutSeconds: 900, toolchain, problem });
      return found;
    }
    // 没有 test 脚本时按已安装的工具推断；node --test 不带目录参数（Node 24 把目录当作模块路径解析而失败），
    // 沙箱里不能为每个测试文件创建带管道的子进程，改为在同一进程内运行。
    if (!scripts.typecheck && !scripts.build && deps.typescript && has(root, 'tsconfig.json')) found.push({ label: 'TypeScript 类型检查', command: 'npx tsc --noEmit', timeoutSeconds: 600, toolchain, problem });
    if (deps.vitest) found.push({ label: 'Vitest 测试', command: 'npx vitest run', timeoutSeconds: 900, toolchain, problem });
    else if (deps.jest) found.push({ label: 'Jest 测试', command: 'npx jest', timeoutSeconds: 900, toolchain, problem });
    else if (hasNodeTests(root)) found.push({ label: 'node:test 测试', command: sandboxed ? 'node --test --test-isolation=none' : 'node --test', timeoutSeconds: 600, toolchain, problem: nodeExe ? undefined : missing('node') });
    return found;
  },
  // node:test 默认每个文件一个子进程，受限令牌下创建子进程管道被拒绝（实测 EPERM spawn）。
  sandboxBlocked: { pattern: /code: 'EPERM',\s*syscall: 'spawn'/, reason: 'node:test 在 Auto 沙箱里无法为测试文件创建子进程（EPERM spawn）；可把验收命令改为 node --test --test-isolation=none，或在“接受编辑”模式下运行' },
  parse(output) {
    const tests = [
      // node:test TAP：not ok 2 - formats durations（子测试有缩进）
      ...matches(output, /^\s*not ok \d+ - (.+?)(?: # .*)?$/m).map(match => match[1].trim()),
      // node:test spec：✖ formats durations (1.2ms)
      ...matches(output, /^\s*✖ (.+?)(?: \([\d.]+m?s\))?$/m).map(match => match[1].trim()).filter(name => !/^(failing tests:|fail)/i.test(name)),
      // Vitest：FAIL  src/a.test.ts > suite > name
      ...matches(output, /^\s*FAIL\s+(\S+\.(?:[cm]?[jt]sx?)) > (.+)$/m).map(match => `${match[1]} > ${match[2].trim()}`),
      // Jest：● suite › name
      ...matches(output, /^\s*● (.+ › .+)$/m).map(match => match[1].trim()),
    ];
    const diagnostics = [
      // tsc：src/a.ts(12,5): error TS2322: ...
      ...matches(output, /^([^\s(][^(\r\n]*?\.(?:[cm]?[jt]sx?))\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$/m)
        .map(match => diagnostic(match[1], match[2], match[3], match[6], match[4] as 'error', match[5])),
      // tsc --pretty：src/a.ts:12:5 - error TS2322: ...
      ...matches(output, /^([^\s:][^:\r\n]*?\.(?:[cm]?[jt]sx?)):(\d+):(\d+) - (error|warning) (TS\d+): (.+)$/m)
        .map(match => diagnostic(match[1], match[2], match[3], match[6], match[4] as 'error', match[5])),
      // node:test TAP 的失败位置：location: 'E:\x\test\a.test.js:10:3'
      ...matches(output, /^\s*location: '(.+?\.[cm]?[jt]sx?):(\d+):(\d+)'$/m).map(match => diagnostic(match[1].replaceAll('\\\\', '\\'), match[2], match[3], '测试失败位置')),
    ];
    return { tests: [...new Set(tests)], diagnostics };
  },
};

function hasNodeTests(root: string): boolean {
  const isTest = (name: string) => /\.test\.[cm]?js$|^test\.[cm]?js$/.test(name);
  return listFiles(join(root, 'test')).some(name => /\.[cm]?js$/.test(name)) || listFiles(root).some(isTest);
}
