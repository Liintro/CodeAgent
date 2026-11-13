import { useEffect, useRef, useState } from 'react';
import type { DiffView } from '../../../../shared/contracts';
import { Spinner } from '@/components/ui/spinner';
import { isDark, onThemeChange } from '@/app/theme';

type Monaco = typeof import('./monaco');

let loading: Promise<Monaco> | undefined;
const loadMonaco = () => (loading ??= import('./monaco'));

/** 并排或行内 diff。Host 给不出两侧完整文本（二进制或过大）时退回显示 patch。 */
export function DiffViewer({ diff, inline }: { diff: DiffView; inline: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const full = diff.original !== undefined && diff.modified !== undefined;

  useEffect(() => {
    if (!full || !host.current) return;
    let disposed = false;
    let cleanup = () => undefined as void;
    void loadMonaco().then(({ monaco, languageFor }) => {
      if (disposed || !host.current) return;
      const language = languageFor(diff.path);
      const original = monaco.editor.createModel(diff.original!, language);
      const modified = monaco.editor.createModel(diff.modified!, language);
      const editor = monaco.editor.createDiffEditor(host.current, {
        readOnly: true,
        originalEditable: false,
        automaticLayout: true,
        renderSideBySide: !inline,
        useInlineViewWhenSpaceIsLimited: true,
        renderSideBySideInlineBreakpoint: 600,
        renderOverviewRuler: false,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontFamily: 'Cascadia Mono, Consolas, monospace',
        fontSize: 12,
        lineNumbersMinChars: 3,
        hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 5 },
        theme: isDark() ? 'vs-dark' : 'vs',
      });
      editor.setModel({ original, modified });
      const stopTheme = onThemeChange(() => monaco.editor.setTheme(isDark() ? 'vs-dark' : 'vs'));
      setReady(true);
      cleanup = () => {
        stopTheme();
        editor.dispose();
        original.dispose();
        modified.dispose();
      };
    });
    return () => {
      disposed = true;
      cleanup();
      setReady(false);
    };
  }, [diff, inline, full]);

  if (!full) {
    return (
      <pre aria-label="差异内容" className="min-h-0 flex-1 overflow-auto whitespace-pre bg-surface-2 p-3 font-mono text-[11.5px] leading-snug">
        {diff.patch || '（无文本差异）'}
        {diff.truncated && '\n…差异过长，已截断'}
      </pre>
    );
  }
  return (
    <div className="relative min-h-0 flex-1">
      {!ready && <div className="absolute inset-0 grid place-items-center text-muted-foreground"><Spinner /></div>}
      <div ref={host} aria-label="差异内容" className="absolute inset-0" />
    </div>
  );
}
