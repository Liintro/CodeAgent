import { diagnostic, findExecutable, has, matches, missing, probe, type Adapter } from './toolchain.js';

export const go: Adapter = {
  id: 'go',
  async detect(root) {
    if (!has(root, 'go.mod')) return [];
    const exe = findExecutable('go');
    const toolchain = exe && await probe(exe, ['version']);
    const problem = exe ? undefined : missing('go');
    return [
      { label: 'Go 构建', command: 'go build ./...', timeoutSeconds: 900, toolchain, problem },
      { label: 'Go 测试', command: 'go test ./...', timeoutSeconds: 900, toolchain, problem },
    ];
  },
  parse(output) {
    const tests = matches(output, /^\s*--- FAIL: (\S+)/m).map(match => match[1]);
    const diagnostics = [
      // 编译：.\calc.go:12:5: undefined: scale
      ...matches(output, /^(?:\.[\\/])?([^\s:][^:\r\n]*?\.go):(\d+):(\d+): (.+)$/m).map(match => diagnostic(match[1], match[2], match[3], match[4])),
      // 测试日志：    calc_test.go:14: Add(2, 3) = 6, want 5
      ...matches(output, /^\s+([\w./\\-]+_test\.go):(\d+): (.+)$/m).map(match => diagnostic(match[1], match[2], undefined, match[3])),
    ];
    return { tests, diagnostics };
  },
};
