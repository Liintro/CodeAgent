import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { DocumentKind, DocumentView } from '../../shared/contracts.js';
import { extractDocx } from './docx.js';
import { extractPdf, renderPdfPage } from './pdf.js';
import { extractHtml, extractMarkdown, extractPlainText } from './text.js';
import type { Extracted, Unit } from './types.js';

export const DOCUMENT_KINDS: Record<string, DocumentKind> = {
  '.pdf': 'pdf', '.docx': 'docx', '.md': 'markdown', '.markdown': 'markdown', '.txt': 'text', '.html': 'html', '.htm': 'html',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image',
  // CMSIS-SVD 是 XML 文本：按行段引用，用 query 查找外设与寄存器。
  '.svd': 'text',
};
// 一个 Run 内最多交给模型的图像数，以及单张图像的大小上限：视觉请求只在文本不够时有针对性地使用。
export const IMAGE_BUDGET = { perRun: 6, maxBytes: 4 * 1024 * 1024 };
const MAX_BYTES = 64 * 1024 * 1024;
const READ_LIMIT = 24 * 1024;
// 提取格式变化时递增，旧缓存自动失效。
const CACHE_VERSION = 1;

export type DocumentRecord = DocumentView & { mtimeMs: number; size: number };

// 文档是只读输入：按内容哈希缓存提取结果（<dataDir>/docs/<sha256>/extract.json），从不写回原文件。
export class DocumentLibrary {
  private readonly memory = new Map<string, Extracted>();

  constructor(private readonly cacheDir?: string) {}

  // 入口校验：扩展名、大小；返回可持久化的元数据。
  async inspect(path: string): Promise<DocumentRecord> {
    const kind = DOCUMENT_KINDS[extname(path).toLowerCase()];
    if (!kind) throw new Error(`不支持的文档类型：${extname(path) || '无扩展名'}（支持 PDF、DOCX、Markdown、TXT、HTML、PNG、JPEG、SVD）`);
    const info = await stat(path);
    if (!info.isFile()) throw new Error('所选路径不是文件');
    if (info.size > MAX_BYTES) throw new Error('文档超过 64 MB');
    const data = await readFile(path);
    const sha256 = createHash('sha256').update(data).digest('hex');
    const extracted = await this.extract(sha256, kind, data);
    return describe(path, kind, sha256, extracted, info.mtimeMs, info.size);
  }

  // 读取时核对文件是否在添加后被修改；修改过就重新提取，并在结果里说明。
  async open(record: DocumentRecord): Promise<{ record: DocumentRecord; extracted: Extracted; changed: boolean }> {
    const info = await stat(record.path).catch(() => undefined);
    if (!info) throw new Error(`文档已不存在：${record.path}`);
    if (info.size === record.size && info.mtimeMs === record.mtimeMs) {
      const extracted = this.memory.get(record.sha256) ?? await this.extract(record.sha256, record.kind, await readFile(record.path));
      return { record, extracted, changed: false };
    }
    const fresh = await this.inspect(record.path);
    return { record: { ...fresh, id: record.id }, extracted: this.memory.get(fresh.sha256)!, changed: fresh.sha256 !== record.sha256 };
  }

  private async extract(sha256: string, kind: DocumentKind, data: Buffer): Promise<Extracted> {
    const cached = this.memory.get(sha256);
    if (cached) return cached;
    const file = this.cacheDir && join(this.cacheDir, sha256, 'extract.json');
    const fromDisk = file ? await readFile(file, 'utf8').then(text => JSON.parse(text) as Extracted & { version: number }, () => undefined) : undefined;
    let extracted: Extracted;
    if (fromDisk?.version === CACHE_VERSION) extracted = fromDisk;
    else {
      extracted = kind === 'image' ? { kind, units: [{ ref: '图像', title: '（图像，没有文本）', level: 0, text: '', noTextLayer: true }] }
        : kind === 'pdf' ? await extractPdf(new Uint8Array(data)) : kind === 'docx' ? extractDocx(data)
        : kind === 'html' ? extractHtml(data.toString('utf8')) : kind === 'markdown' ? extractMarkdown(data.toString('utf8')) : extractPlainText(data.toString('utf8'));
      if (file) {
        await mkdir(join(this.cacheDir!, sha256), { recursive: true });
        await writeFile(file, JSON.stringify({ version: CACHE_VERSION, ...extracted }), 'utf8');
      }
    }
    this.memory.set(sha256, extracted);
    return extracted;
  }
}

function describe(path: string, kind: DocumentKind, sha256: string, extracted: Extracted, mtimeMs: number, size: number): DocumentRecord {
  return {
    id: sha256.slice(0, 12), name: basename(path), path, kind, sha256, pages: extracted.pages, sections: extracted.units.length,
    noTextLayerPages: extracted.units.filter(unit => unit.noTextLayer).map(unit => unit.page!), mtimeMs, size,
  };
}

export type DocumentToolContext = {
  documents: () => DocumentRecord[];
  library: DocumentLibrary;
  vision: boolean;
  onStarted: (toolCallId: string) => void;
  onChanged: (record: DocumentRecord) => void;
};

export function createDocumentTools(ctx: DocumentToolContext): AgentTool<any>[] {
  const documentParam = { type: 'string', enum: ctx.documents().map(doc => doc.name), description: '文档名称' };
  const imageHint = ctx.vision ? '需要时用 doc_view 查看该页图像' : '当前模型不支持图像输入，无法解读此内容，请如实说明';
  let imagesUsed = 0;
  const view: AgentTool<any> = {
    name: 'doc_view',
    label: 'doc_view',
    description: `把文档的一页（PDF）或图像文档交给你直接看。只在文本提取不够时使用：没有文本层的扫描页、示意图、时序图、复杂表格、图形化的寄存器位定义。每次执行最多 ${IMAGE_BUDGET.perRun} 张。只读。`,
    parameters: { type: 'object', required: ['document'], properties: { document: documentParam, page: { type: 'integer', minimum: 1, description: 'PDF 页码；图像文档省略' } } },
    execute: async (toolCallId, params: any) => {
      const { record } = await openFor(ctx, params.document, toolCallId);
      if (imagesUsed >= IMAGE_BUDGET.perRun) throw new Error(`本次执行的图像预算（${IMAGE_BUDGET.perRun} 张）已用完；请基于已获得的信息继续，或说明还缺少什么`);
      const data = await readFile(record.path);
      let image: { data: Buffer; mimeType: string; note: string };
      if (record.kind === 'pdf') {
        const page = Number(params.page);
        if (!Number.isInteger(page)) throw new Error('PDF 需要指定 page');
        const rendered = await renderPdfPage(new Uint8Array(data), page);
        image = { data: rendered.png, mimeType: 'image/png', note: `【${record.name} p.${page}】页面图像 ${rendered.width}×${rendered.height}` };
      } else if (record.kind === 'image') {
        image = { data, mimeType: /.png$/i.test(record.path) ? 'image/png' : 'image/jpeg', note: `【${record.name} 图像】` };
      } else throw new Error(`${record.kind} 文档没有页面图像，请用 doc_read`);
      if (image.data.length > IMAGE_BUDGET.maxBytes) throw new Error(`图像超过 ${IMAGE_BUDGET.maxBytes / 1024 / 1024} MB，未发送`);
      imagesUsed++;
      return {
        content: [
          { type: 'text' as const, text: `${image.note}（sha256 ${record.sha256.slice(0, 12)}；第 ${imagesUsed}/${IMAGE_BUDGET.perRun} 张）。引用图中信息时请注明此出处，并区分“图中可见”与推断。` },
          { type: 'image' as const, data: image.data.toString('base64'), mimeType: image.mimeType },
        ],
        details: undefined,
      };
    },
  };
  return [
    {
      name: 'doc_outline',
      label: 'doc_outline',
      description: '列出任务文档的结构：PDF 的每页首行与图表编号，Markdown/DOCX/HTML 的章节。只读。',
      parameters: { type: 'object', required: ['document'], properties: { document: documentParam } },
      execute: async (toolCallId, params: any) => {
        const { record, extracted, changed } = await openFor(ctx, params.document, toolCallId);
        const lines = extracted.units.map(unit => outlineLine(record.name, unit, imageHint));
        return text([header(record, changed), ...lines].join('\n'));
      },
    },
    {
      name: 'doc_read',
      label: 'doc_read',
      description: '读取任务文档。refs 选择页或章节（如 "p.3"、"p.2-4"、"§2 Communication" 或章节标题中的文字）；query 返回所有包含该文字的行及其出处。输出中的 【文档 p.N】/【文档 §章节】 就是引用格式。只读。',
      parameters: {
        type: 'object',
        required: ['document'],
        properties: {
          document: documentParam,
          refs: { type: 'array', items: { type: 'string' }, description: '页或章节；省略时从头读取' },
          query: { type: 'string', description: '在全文中查找包含该文字的行（不区分大小写）' },
        },
      },
      execute: async (toolCallId, params: any) => {
        const { record, extracted, changed } = await openFor(ctx, params.document, toolCallId);
        const body = typeof params.query === 'string' && params.query.trim()
          ? search(record.name, extracted.units, params.query.trim())
          : read(record.name, select(extracted.units, Array.isArray(params.refs) ? params.refs.map(String) : []), imageHint);
        return text(`${header(record, changed)}\n${body}`);
      },
    },
    ...(ctx.vision ? [view] : []),
  ];
}

async function openFor(ctx: DocumentToolContext, name: unknown, toolCallId: string) {
  const record = ctx.documents().find(doc => doc.name === name || doc.id === name);
  if (!record) throw new Error(`未知的任务文档：${String(name)}`);
  ctx.onStarted(toolCallId);
  const opened = await ctx.library.open(record);
  if (opened.changed || opened.record.mtimeMs !== record.mtimeMs) ctx.onChanged(opened.record);
  return opened;
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }], details: undefined });

function header(record: DocumentRecord, changed: boolean): string {
  const shape = record.kind === 'pdf' ? `${record.pages} 页` : `${record.sections} 个章节`;
  const scanned = record.noTextLayerPages.length ? `；没有文本层的页：${record.noTextLayerPages.join(', ')}` : '';
  return `文档 ${record.name}（${record.kind}，${shape}，sha256 ${record.sha256.slice(0, 12)}${scanned}）${changed ? '\n注意：文档在添加到任务之后已被修改，以下内容来自当前文件。' : ''}`;
}

const cite = (name: string, unit: Unit) => `【${name} ${unit.ref}】`;
const CAPTION = /^\s*((?:Table|Figure|Fig\.|表|图)\s*\d+(?:[-.]\d+)*)\b.*$/gim;

function outlineLine(name: string, unit: Unit, imageHint: string): string {
  if (unit.noTextLayer) return `${cite(name, unit)} （没有文本层：扫描页或图片，文本提取为空；${imageHint}）`;
  const captions = [...unit.text.matchAll(CAPTION)].map(match => match[0].trim().slice(0, 60));
  const indent = '  '.repeat(Math.max(0, unit.level - 1));
  return `${indent}${cite(name, unit)} ${unit.title}${captions.length ? `；图表：${captions.join('；')}` : ''}`;
}

function select(units: Unit[], refs: string[]): Unit[] {
  if (!refs.length) return units;
  const chosen: Unit[] = [];
  for (const ref of refs) {
    const range = /^p\.?\s*(\d+)(?:\s*-\s*(\d+))?$/i.exec(ref.trim());
    const matches = range
      ? units.filter(unit => unit.page !== undefined && unit.page >= Number(range[1]) && unit.page <= Number(range[2] ?? range[1]))
      : units.filter(unit => unit.ref === ref || unit.ref.toLowerCase().includes(ref.replace(/^§/, '').toLowerCase()) || unit.title.toLowerCase().includes(ref.toLowerCase()));
    for (const unit of matches) if (!chosen.includes(unit)) chosen.push(unit);
  }
  if (!chosen.length) throw new Error(`文档中没有匹配的页或章节：${refs.join('、')}。请先用 doc_outline 查看结构。`);
  return chosen;
}

function read(name: string, units: Unit[], imageHint: string): string {
  let output = '';
  for (const unit of units) {
    const body = unit.noTextLayer ? `（没有文本层：扫描页或图片，文本提取为空；${imageHint}）` : unit.text.trimEnd();
    const block = `\n${cite(name, unit)}\n${body}\n`;
    if (output.length + block.length > READ_LIMIT) return `${output}\n（输出已截断：请用 refs 指定更少的页或章节）`;
    output += block;
  }
  return output;
}

function search(name: string, units: Unit[], query: string): string {
  const needle = query.toLowerCase();
  const hits: string[] = [];
  for (const unit of units) {
    for (const line of unit.text.split('\n')) if (line.toLowerCase().includes(needle)) hits.push(`${cite(name, unit)} ${line.trim()}`);
  }
  return hits.length ? hits.slice(0, 80).join('\n') + (hits.length > 80 ? `\n（共 ${hits.length} 处，只显示前 80 处）` : '') : `没有找到“${query}”。`;
}
