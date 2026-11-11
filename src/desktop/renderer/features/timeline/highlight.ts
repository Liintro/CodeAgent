import type { HighlighterCore } from 'shiki/core';

// 只打包常用语言；高亮器第一次用到时才加载，主界面启动不受影响。
const LANGS = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  bat: () => import('shiki/langs/bat.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
} as const;

const ALIASES: Record<string, keyof typeof LANGS> = {
  ts: 'typescript', js: 'javascript', mjs: 'javascript', cjs: 'javascript', py: 'python', rs: 'rust', 'c++': 'cpp', cs: 'csharp',
  ps1: 'powershell', pwsh: 'powershell', ps: 'powershell', sh: 'shellscript', bash: 'shellscript', shell: 'shellscript', zsh: 'shellscript',
  cmd: 'bat', batch: 'bat', yml: 'yaml', md: 'markdown', kt: 'kotlin', htm: 'html', patch: 'diff', h: 'c', hpp: 'cpp',
};

let highlighter: Promise<HighlighterCore> | undefined;
const loaded = new Set<string>();

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] = await Promise.all([
      import('shiki/core'), import('shiki/engine/javascript'), import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs'),
    ]);
    // JavaScript 正则引擎不需要 WASM，符合页面的 CSP（script-src 'self'）。
    return createHighlighterCore({ themes: [light.default, dark.default], langs: [], engine: createJavaScriptRegexEngine() });
  })();
  return highlighter;
}

export function resolveLang(lang: string | undefined): keyof typeof LANGS | undefined {
  if (!lang) return undefined;
  const key = lang.toLowerCase();
  return key in LANGS ? key as keyof typeof LANGS : ALIASES[key];
}

/** 返回 Shiki 生成的 HTML；语言不在子集内时返回 undefined，调用方显示纯文本。 */
export async function highlight(code: string, lang: string | undefined): Promise<string | undefined> {
  const resolved = resolveLang(lang);
  if (!resolved) return undefined;
  const core = await getHighlighter();
  if (!loaded.has(resolved)) {
    await core.loadLanguage((await LANGS[resolved]()).default);
    loaded.add(resolved);
  }
  return core.codeToHtml(code, { lang: resolved, themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: 'light' });
}
