import type { Extracted, Unit } from './types.js';

// Markdown 与纯文本：按标题切成章节；代码块原样保留，代码块里的 # 不当作标题。
export function extractMarkdown(source: string): Extracted {
  const units: Unit[] = [];
  const path: string[] = [];
  let current: Unit = { ref: '§开头', title: '（文档开头）', level: 0, text: '' };
  let fence: string | undefined;
  for (const line of source.replace(/\r\n?/g, '\n').split('\n')) {
    const fenceMark = /^\s*(```|~~~)/.exec(line)?.[1];
    if (fenceMark && (!fence || fence === fenceMark)) fence = fence ? undefined : fenceMark;
    const heading = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      if (current.text.trim() || current.level) units.push(current);
      const level = heading[1].length;
      path.length = level - 1;
      path[level - 1] = heading[2];
      current = { ref: `§${path.filter(Boolean).join(' > ')}`, title: heading[2], level, text: `${line}\n` };
      continue;
    }
    current.text += `${line}\n`;
  }
  if (current.text.trim() || current.level) units.push(current);
  return { kind: 'markdown', units };
}

// 纯文本没有标题：每 80 行一段，引用写成行号范围。
export function extractPlainText(source: string): Extracted {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const units: Unit[] = [];
  for (let start = 0; start < lines.length; start += 80) {
    const chunk = lines.slice(start, start + 80);
    units.push({ ref: `行 ${start + 1}-${start + chunk.length}`, title: chunk.find(line => line.trim())?.trim().slice(0, 80) ?? '', level: 0, text: `${chunk.join('\n')}\n` });
  }
  return { kind: 'text', units };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', deg: '°', micro: 'µ', plusmn: '±', times: '×', le: '≤', ge: '≥', ohm: 'Ω', Omega: 'Ω' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name: string) => {
    if (name[0] === '#') return String.fromCodePoint(name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1)));
    return ENTITIES[name] ?? whole;
  });
}

// 实用 HTML：去掉 script/style，标题转成 Markdown 标题，表格转成 | 分隔的行，pre 转成代码块，再按 Markdown 切章节。
export function extractHtml(source: string): Extracted {
  let html = source.replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  html = html.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_whole, body: string) => `\n\`\`\`\n${decodeEntities(body.replace(/<[^>]+>/g, ''))}\n\`\`\`\n`);
  html = html.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_whole, level: string, body: string) => `\n${'#'.repeat(Number(level))} ${inline(body)}\n`);
  html = html.replace(/<caption\b[^>]*>([\s\S]*?)<\/caption>/gi, (_whole, body: string) => `\n${inline(body)}\n`);
  html = html.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (_whole, row: string) => {
    const cells = [...row.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(cell => inline(cell[1]));
    return `\n| ${cells.join(' | ')} |`;
  });
  html = html.replace(/<li\b[^>]*>/gi, '\n- ').replace(/<(br|\/p|\/div|\/table|\/ul|\/ol|\/li)\b[^>]*>/gi, '\n');
  const text = decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return { ...extractMarkdown(text), kind: 'html' };
}

function inline(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}
