import { join } from 'node:path';
import { diagnostic, findExecutable, listFiles, matches, missing, psQuote, readText, type Adapter } from './toolchain.js';

// Keil MDK 工程（*.uvprojx）：用 Keil 自己的无界面构建 UV4 -b，与在 IDE 里点“Build”一致。
// UV4 的退出码：0 无错误，1 只有警告，2 及以上有错误；构建日志写到 TEMP，避免混入工作区补丁。
export const keil: Adapter = {
  id: 'keil',
  async detect(root) {
    const project = listFiles(root).find(name => name.toLowerCase().endsWith('.uvprojx'));
    if (!project) return [];
    const uv4 = findExecutable('UV4');
    const device = /<Device>([^<]+)<\/Device>/.exec(readText(join(root, project)))?.[1];
    const log = `(Join-Path $env:TEMP 'codeagent-keil-build.log')`;
    const command = `$log = ${log}; Remove-Item $log -ErrorAction SilentlyContinue; & ${psQuote(uv4 ?? 'UV4.exe')} -j0 -b ${psQuote(project)} -o $log | Out-Null; $code = $LASTEXITCODE; if (Test-Path $log) { Get-Content $log } else { "UV4 没有生成构建日志（退出码 $code）" }; if ($code -le 1) { exit 0 } else { exit $code }`;
    return [{ label: 'Keil 构建', command, timeoutSeconds: 900, toolchain: `Keil MDK UV4${device ? `；器件 ${device}` : ''}`, problem: uv4 ? undefined : `${missing('UV4')}（把 Keil 安装目录下的 UV4 加入 PATH）` }];
  },
  // UV4 是 GUI 程序，在受限令牌下以退出码 3 结束且不写日志（实测）。
  sandboxBlocked: { pattern: /UV4 没有生成构建日志/, reason: 'Keil UV4 无法在 Auto 沙箱的受限令牌下运行（实测退出码 3，未生成构建日志）；请在“接受编辑”或“手动”模式下由 Harness 直接构建' },
  parse(output) {
    const diagnostics = [
      // ARMCC：.\Start\stm32f10x.h(96): error:  #35: #error directive: "..."
      ...matches(output, /^([^\s(][^(\r\n]*?)\((\d+)\): (error|warning):\s+#(\w+): (.+)$/m).map(match => diagnostic(match[1], match[2], undefined, match[5], match[3] as 'error', `#${match[4]}`)),
      // ARMCC 命令行："board_check.c", line 4: Error:  #94: the size of an array must be greater than zero
      ...matches(output, /^"([^"]+)", line (\d+): (Error|Warning):\s+#(\w+)-?D?: (.+)$/m).map(match => diagnostic(match[1], match[2], undefined, match[5], match[3] === 'Error' ? 'error' : 'warning', `#${match[4]}`)),
      // ARMLINK：.\Objects\project.axf: Error: L6218E: Undefined symbol main (referred from __rtentry2.o).
      ...matches(output, /^(.+?\.axf): (Error|Warning): (L\d+[EW]): (.+)$/m).map(match => diagnostic(match[1], 0, undefined, match[4], match[2] === 'Error' ? 'error' : 'warning', match[3])),
    ];
    return { tests: [], diagnostics };
  },
};
