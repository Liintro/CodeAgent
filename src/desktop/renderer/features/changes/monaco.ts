// 只加载编辑器核心与常用语言的着色规则（Monarch），不加载语言服务；整个模块在第一次打开 diff 时才导入。
import * as monaco from 'monaco-editor/editor/editor.api';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
// diff 边栏的 +/- 与折叠图标来自 codicon 字体；编辑器核心不会自动引入它。
import 'monaco-editor/features/codicon/register';
import 'monaco-editor/languages/definitions/java/register';
import 'monaco-editor/languages/definitions/kotlin/register';
import 'monaco-editor/languages/definitions/typescript/register';
import 'monaco-editor/languages/definitions/javascript/register';
import 'monaco-editor/languages/definitions/python/register';
import 'monaco-editor/languages/definitions/go/register';
import 'monaco-editor/languages/definitions/rust/register';
import 'monaco-editor/languages/definitions/cpp/register';
import 'monaco-editor/languages/definitions/csharp/register';
import 'monaco-editor/languages/definitions/powershell/register';
import 'monaco-editor/languages/definitions/shell/register';
import 'monaco-editor/languages/definitions/bat/register';
import 'monaco-editor/languages/definitions/html/register';
import 'monaco-editor/languages/definitions/css/register';
import 'monaco-editor/languages/definitions/scss/register';
import 'monaco-editor/languages/definitions/xml/register';
import 'monaco-editor/languages/definitions/yaml/register';
import 'monaco-editor/languages/definitions/ini/register';
import 'monaco-editor/languages/definitions/markdown/register';
import 'monaco-editor/languages/definitions/sql/register';
import 'monaco-editor/languages/definitions/dockerfile/register';
import 'monaco-editor/languages/definitions/ruby/register';
import 'monaco-editor/languages/definitions/php/register';
import 'monaco-editor/languages/definitions/swift/register';
import 'monaco-editor/languages/definitions/scala/register';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

export { monaco };

export function languageFor(path: string): string {
  const lower = path.toLowerCase();
  const name = lower.split('/').at(-1) ?? lower;
  for (const language of monaco.languages.getLanguages()) {
    if (language.filenames?.some(item => item.toLowerCase() === name)) return language.id;
    if (language.extensions?.some(extension => lower.endsWith(extension))) return language.id;
  }
  return 'plaintext';
}
