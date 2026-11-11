import { memo, useEffect, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { highlight } from './highlight';

const components: Components = {
  // 代码块统一交给 CodeBlock；行内代码保持默认样式。
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const text = String(children ?? '');
    const lang = /language-([\w+#-]+)/.exec(className ?? '')?.[1];
    if (!lang && !text.includes('\n')) return <code>{children}</code>;
    return <CodeBlock code={text.replace(/\n$/, '')} lang={lang} />;
  },
  a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-chat">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>
    </div>
  );
});

export function CodeBlock({ code, lang, label }: { code: string; lang?: string; label?: ReactNode }) {
  const [html, setHtml] = useState<string>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    // 流式输出期间代码块还在变化，稍等片刻再高亮，避免每个增量都重新着色。
    const timer = setTimeout(() => {
      void highlight(code, lang).then(value => { if (live) setHtml(value); }, () => undefined);
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [code, lang]);

  const copy = () => void navigator.clipboard.writeText(code).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  });

  return (
    <div className="group/code my-1 overflow-hidden rounded-lg border border-border bg-surface-2">
      <div className="flex h-7 items-center justify-between border-b border-border px-3 text-[11px] text-subtle">
        <span>{label ?? lang ?? '文本'}</span>
        <button type="button" onClick={copy} className="inline-flex items-center gap-1 rounded px-1 hover:text-foreground" aria-label="复制代码">
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}{copied ? '已复制' : '复制'}
        </button>
      </div>
      {html
        ? <div className="overflow-x-auto px-3 py-2 text-[12px] leading-[1.55] [&_pre]:m-0" dangerouslySetInnerHTML={{ __html: html }} />
        : <pre className="overflow-x-auto px-3 py-2 text-[12px] leading-[1.55]">{code}</pre>}
    </div>
  );
}
