import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { diagnostic, findExecutable, has, listFiles, matches, missing, probe, psQuote, type Adapter } from './toolchain.js';

export const python: Adapter = {
  id: 'python',
  async detect(root) {
    if (!has(root, 'pyproject.toml') && !has(root, 'pytest.ini') && !listFiles(join(root, 'tests')).some(name => name.endsWith('.py'))) return [];
    if (has(root, 'uv.lock')) {
      const uv = findExecutable('uv');
      return [{ label: 'pytest 测试', command: 'uv run pytest', timeoutSeconds: 600, toolchain: uv && await probe(uv, ['--version']), problem: uv ? undefined : missing('uv') }];
    }
    const resolved = await resolvePython(root);
    if (!resolved) return [{ label: 'pytest 测试', command: 'python -m pytest', timeoutSeconds: 600, problem: '未找到装有 pytest 的 Python 解释器' }];
    return [{ label: 'pytest 测试', command: `${resolved.command} -m pytest`, timeoutSeconds: 600, toolchain: resolved.version }];
  },
  parse(output) {
    const tests = matches(output, /^(?:FAILED|ERROR) (\S+?::\S+|\S+\.py)(?: - .*)?$/m).map(match => match[1]);
    const diagnostics = [
      // 断言与异常位置：tests\test_prices.py:9: AssertionError
      ...matches(output, /^([^\s:][^:\r\n]*?\.py):(\d+): (\w+(?:Error|Exception)|Failed)\b(.*)$/m).map(match => diagnostic(match[1], match[2], undefined, `${match[3]}${match[4]}`)),
      // 收集阶段的语法错误：  File "calc\prices.py", line 3
      ...matches(output, /^\s*File "([^"]+\.py)", line (\d+)\r?\n(?:.*\r?\n){0,3}?(SyntaxError|IndentationError|ImportError|ModuleNotFoundError): (.+)$/m)
        .map(match => diagnostic(match[1], match[2], undefined, `${match[3]}: ${match[4]}`)),
    ];
    return { tests, diagnostics };
  },
};

// 优先项目虚拟环境，其次 PATH 上的 python，再其次 py 启动器登记的解释器；只选真正能 import pytest 的那个。
async function resolvePython(root: string): Promise<{ command: string; version: string } | undefined> {
  for (const venv of ['.venv', 'venv']) {
    const local = join(root, venv, 'Scripts', 'python.exe');
    const version = has(root, join(venv, 'Scripts', 'python.exe')) ? await probe(local, ['-m', 'pytest', '--version']) : undefined;
    if (version) return { command: `.\\${venv}\\Scripts\\python.exe`, version };
  }
  const onPath = findExecutable('python');
  const pathVersion = onPath && await probe(onPath, ['-m', 'pytest', '--version']);
  if (pathVersion) return { command: 'python', version: pathVersion };
  const launcher = findExecutable('py');
  const listed = launcher ? await probeList(launcher) : [];
  for (const interpreter of listed) {
    const version = await probe(interpreter, ['-m', 'pytest', '--version']);
    if (version) return { command: `& ${psQuote(interpreter)}`, version: `${version}（${interpreter}；PATH 上的 python 没有 pytest）` };
  }
  return undefined;
}

// `py -0p` 每行：" -V:3.12 *        C:\...\python.exe"
async function probeList(launcher: string): Promise<string[]> {
  return new Promise(resolve => execFile(launcher, ['-0p'], { windowsHide: true, timeout: 15000 }, (error, stdout) => {
    resolve(error ? [] : [...stdout.matchAll(/([A-Za-z]:\\[^\r\n]*?python\.exe)\s*$/gim)].map(match => match[1].trim()));
  }));
}
