import { diagnostic, findExecutable, has, matches, missing, probe, type Adapter } from './toolchain.js';

export const rust: Adapter = {
  id: 'rust',
  async detect(root) {
    if (!has(root, 'Cargo.toml')) return [];
    const exe = findExecutable('cargo');
    const toolchain = exe && await probe(exe, ['--version']);
    const problem = exe ? undefined : missing('cargo');
    return [
      { label: 'Cargo 构建', command: 'cargo build', timeoutSeconds: 1200, toolchain, problem },
      { label: 'Cargo 测试', command: 'cargo test', timeoutSeconds: 1200, toolchain, problem },
    ];
  },
  parse(output) {
    const tests = matches(output, /^test (\S+) \.\.\. FAILED$/m).map(match => match[1]);
    const diagnostics = [
      // error[E0308]: mismatched types
      //   --> src\lib.rs:12:5
      ...matches(output, /^(error|warning)(?:\[(E\d+)\])?: (.+)\r?\n\s*--> ([^:\r\n]+(?::\\[^:\r\n]+)?):(\d+):(\d+)/m)
        .map(match => diagnostic(match[4], match[5], match[6], match[3], match[1] as 'error', match[2])),
      // thread 'tests::adds' panicked at src\lib.rs:20:9:
      ...matches(output, /panicked at ([^:\r\n]+\.rs):(\d+):(\d+):\r?\n(.+)/m).map(match => diagnostic(match[1], match[2], match[3], `panic: ${match[4]}`)),
    ];
    return { tests, diagnostics };
  },
};
