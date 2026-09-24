import { decodeEntities, extractMarkdown } from './text.js';
import type { Extracted } from './types.js';
import { readZipEntries } from './zip.js';

// 轻量 OOXML：只读 word/document.xml 与 styles.xml。标题来自段落样式（Heading N / 标题 N / outlineLvl），
// 表格转成 | 分隔的行，公式（OMML）取其中的文本。DOCX 没有固定分页，引用按章节。
export function extractDocx(data: Buffer): Extracted {
  const parts = readZipEntries(data, name => name === 'word/document.xml' || name === 'word/styles.xml');
  const document = parts.get('word/document.xml')?.toString('utf8');
  if (!document) throw new Error('DOCX 中没有 word/document.xml');
  const levels = headingLevels(parts.get('word/styles.xml')?.toString('utf8') ?? '');
  const body = document.slice(document.indexOf('<w:body'));
  const lines: string[] = [];
  for (const block of body.matchAll(/<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/g)) {
    const xml = block[0];
    if (xml.startsWith('<w:tbl')) {
      lines.push('');
      for (const row of xml.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)) {
        const cells = [...row[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map(cell => [...cell[0].matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map(paragraph => runs(paragraph[0])).join(' ').trim());
        lines.push(`| ${cells.join(' | ')} |`);
      }
      lines.push('');
      continue;
    }
    const text = runs(xml);
    const style = /<w:pStyle w:val="([^"]+)"/.exec(xml)?.[1];
    const outline = /<w:outlineLvl w:val="(\d)"/.exec(xml)?.[1];
    const level = outline !== undefined ? Number(outline) + 1 : style ? levels.get(style) : undefined;
    lines.push(level && text.trim() ? `${'#'.repeat(Math.min(level, 6))} ${text.trim()}` : text);
  }
  return { ...extractMarkdown(lines.join('\n')), kind: 'docx' };
}

function runs(paragraph: string): string {
  let text = '';
  for (const piece of paragraph.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<m:t(?:\s[^>]*)?>([^<]*)<\/m:t>|<w:(tab|br|cr)\b[^>]*\/>/g)) {
    if (piece[3]) text += piece[3] === 'tab' ? '\t' : '\n';
    else text += decodeEntities(piece[1] ?? piece[2] ?? '');
  }
  return text;
}

// styleId → 标题级别：样式名为 heading N（中文 Word 的 styleId 常是 "1"、"2"，名字仍是 heading 1）或样式自带 outlineLvl。
function headingLevels(styles: string): Map<string, number> {
  const levels = new Map<string, number>();
  for (const style of styles.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const name = /<w:name w:val="([^"]+)"/.exec(style[2])?.[1] ?? '';
    const byName = /^(?:heading|标题)\s*(\d)$/i.exec(name)?.[1];
    const outline = /<w:outlineLvl w:val="(\d)"/.exec(style[2])?.[1];
    const level = byName ? Number(byName) : outline !== undefined ? Number(outline) + 1 : undefined;
    if (level) levels.set(style[1], level);
  }
  for (let level = 1; level <= 6; level++) if (!levels.has(`Heading${level}`)) levels.set(`Heading${level}`, level);
  return levels;
}
