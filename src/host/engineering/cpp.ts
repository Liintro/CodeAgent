import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { diagnostic, findExecutable, has, matches, missing, probe, readText, sequence, type Adapter, type Proposal } from './toolchain.js';

// GCC 4.9 之前的 TDM-GCC 不支持 C++17，S0 中还在受限令牌下崩溃（STATUS_BREAKPOINT）。
const MIN_GCC = 7;

export const cpp: Adapter = {
  id: 'cpp',
  async detect(root) {
    const cmake = has(root, 'CMakeLists.txt');
    const makefile = has(root, 'Makefile') || has(root, 'makefile');
    if (!cmake && !makefile) return [];
    const compiler = await findCompiler();
    if (cmake) {
      const cmakeExe = findExecutable('cmake');
      // Ninja 在受限令牌下会挂起（实测），MinGW Makefiles 在沙箱内外都能工作，所以优先使用。
      const generator = findExecutable('mingw32-make') ? 'MinGW Makefiles' : findExecutable('ninja') ? 'Ninja' : undefined;
      const problem = !cmakeExe ? missing('cmake') : !generator ? '未找到 mingw32-make 或 Ninja（CMake 生成器）' : compiler.problem;
      // 构建目录放在 TEMP 下（沙箱里是已授权的临时目录），构建产物不会混入工作区补丁。
      const build = `(Join-Path $env:TEMP 'codeagent-cmake-${createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 12)}')`;
      const steps = [`cmake -S . -B ${build} -G '${generator ?? 'MinGW Makefiles'}'`, `cmake --build ${build}`];
      if (/\badd_test\s*\(|\benable_testing\s*\(/i.test(readText(join(root, 'CMakeLists.txt')))) steps.push(`ctest --test-dir ${build} --output-on-failure`);
      const toolchain = [cmakeExe && await probe(cmakeExe, ['--version']), compiler.version].filter(Boolean).join('；') || undefined;
      return [{ label: steps.length > 2 ? 'CMake 构建与测试' : 'CMake 构建', command: sequence(...steps), timeoutSeconds: 1200, toolchain, problem }];
    }
    const make = findExecutable('make') ? 'make' : findExecutable('mingw32-make') ? 'mingw32-make' : undefined;
    const hasTest = /^test\s*:/m.test(readText(join(root, has(root, 'Makefile') ? 'Makefile' : 'makefile')));
    const found: Proposal = { label: hasTest ? 'Make 测试' : 'Make 构建', command: `${make ?? 'make'}${hasTest ? ' test' : ''}`, timeoutSeconds: 1200, toolchain: compiler.version, problem: make ? compiler.problem : missing('make 或 mingw32-make') };
    return [found];
  },
  parse(output) {
    const tests = [
      // ctest：  1 - calc_tests (Failed)
      ...matches(output, /^\s*\d+ - (\S+) \((?:Failed|SEGFAULT|Exception|Timeout|Not Run|Subprocess aborted)\)/m).map(match => match[1]),
    ];
    const diagnostics = [
      // GCC/Clang：src/calc.c:12:5: error: ...
      ...matches(output, /^((?:[A-Za-z]:)?[^\s:][^:\r\n]*?\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|inl)):(\d+):(?:(\d+):)? (?:fatal )?(error|warning): (.+)$/m)
        .map(match => diagnostic(match[1], match[2], match[3], match[5], match[4] as 'error')),
      // MSVC：src\calc.cpp(12): error C2065: ...
      ...matches(output, /^\s*([^\s(][^(\r\n]*?\.(?:c|cc|cpp|cxx|h|hpp))\((\d+)(?:,(\d+))?\): (error|warning) ([A-Z]+\d+): (.+)$/m)
        .map(match => diagnostic(match[1], match[2], match[3], match[6], match[4] as 'error', match[5])),
      // 链接器：calc.c:(.text+0x1a): undefined reference to `scale'
      ...matches(output, /^(?:.*?[\\/])?([^\\/\s:]+\.(?:c|cpp|o|obj)):\(.*?\): (undefined reference to .+)$/m).map(match => diagnostic(match[1], 0, undefined, match[2])),
      // CMake 配置错误：CMake Error at CMakeLists.txt:7 (add_executable):
      ...matches(output, /^CMake Error at ([^:\r\n]+):(\d+) \((\w+)\):\s*\r?\n\s*(.+)$/m).map(match => diagnostic(match[1], match[2], undefined, `${match[3]}: ${match[4]}`)),
    ];
    return { tests, diagnostics };
  },
};

async function findCompiler(): Promise<{ version?: string; problem?: string }> {
  for (const name of ['gcc', 'clang', 'cl']) {
    const exe = findExecutable(name);
    if (!exe) continue;
    if (name === 'gcc') {
      const version = await probe(exe, ['-dumpfullversion']);
      if (!version) return { problem: `GCC（${exe}）无法运行` };
      const major = Number(version.split('.')[0]);
      return { version: `GCC ${version}`, problem: major < MIN_GCC ? `GCC ${version} 过旧（需要 ${MIN_GCC} 或更高版本）` : undefined };
    }
    return { version: name === 'cl' ? 'MSVC cl' : await probe(exe, ['--version']) };
  }
  return { problem: missing('C/C++ 编译器（gcc、clang 或 cl）') };
}
