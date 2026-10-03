import { readFile } from 'node:fs/promises';
import { createCanvas, DOMMatrix, ImageData, Path2D, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import type { Extracted, Unit } from './types.js';

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
type TextItem = { str: string; transform: number[]; width: number; height: number };
const isText = (item: object): item is TextItem => 'str' in item;

let loaded: Promise<PdfJs> | undefined;

// pdfjs 的 legacy 构建在 Node/Electron utilityProcess 里运行；必须显式给出 workerSrc，否则 getDocument 会抛错（S0 实测）。
export function pdfjs(): Promise<PdfJs> {
  // pdfjs 只在它判定为 Node 时才从 @napi-rs/canvas 补齐这三个全局对象；utilityProcess 里由这里补上（与 pdfjs 自己的做法相同）。
  const globals = globalThis as Record<string, unknown>;
  globals.DOMMatrix ??= DOMMatrix;
  globals.ImageData ??= ImageData;
  globals.Path2D ??= Path2D;
  loaded ??= import('pdfjs-dist/legacy/build/pdf.mjs').then(module => {
    module.GlobalWorkerOptions.workerSrc = import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
    return module;
  });
  return loaded;
}

// pdfjs 只在 process.type 为空或 'browser' 时按 Node 处理；Electron utilityProcess 的 process.type 是 'utility'，
// 它会改用 DOM 的 canvas、FontFace 与 fetch（实测 doc_view 报 document.createElement 未定义）。
// 因此显式提供画布与标准字体工厂并关闭浏览器特性，Node 与 Host 走同一条路径。
export async function openPdf(data: Uint8Array) {
  const lib = await pdfjs();
  return lib.getDocument({
    data, isEvalSupported: false, useSystemFonts: false, verbosity: 0,
    standardFontDataUrl: standardFonts(), StandardFontDataFactory: FileFontFactory, CanvasFactory: NapiCanvasFactory,
    disableFontFace: true, useWorkerFetch: false, isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
  }).promise;
}

// 本地目录路径（结尾带分隔符），不是 URL：字体从文件系统读取。
export function standardFonts(): string {
  return `${new URL('.', import.meta.resolve('pdfjs-dist/package.json')).pathname.replace(/^\/([A-Za-z]:)/, '$1')}standard_fonts/`;
}

class FileFontFactory {
  private readonly baseUrl: string;
  constructor({ baseUrl }: { baseUrl: string }) { this.baseUrl = baseUrl; }
  async fetch({ filename }: { filename: string }): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.baseUrl + filename));
  }
}

type CanvasPair = { canvas: Canvas | null; context: SKRSContext2D | null };

class NapiCanvasFactory {
  create(width: number, height: number): CanvasPair {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(pair: CanvasPair, width: number, height: number): void {
    pair.canvas!.width = width;
    pair.canvas!.height = height;
  }
  destroy(pair: CanvasPair): void {
    pair.canvas!.width = 0;
    pair.canvas!.height = 0;
    pair.canvas = null;
    pair.context = null;
  }
}

// 每页一个引用单位。同一基线（y 相近）的文本合并成一行，行内按 x 排序；间距明显时保留两个空格，表格列因此不会粘连。
export async function extractPdf(data: Uint8Array): Promise<Extracted> {
  const document = await openPdf(data);
  try {
    const units: Unit[] = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const text = lines((content.items as object[]).filter(isText).filter(item => Boolean(item.str.trim()))).join('\n');
      units.push({ ref: `p.${number}`, title: text.split('\n')[0]?.slice(0, 80) ?? '', level: 0, text, page: number, ...(text.trim() ? {} : { noTextLayer: true }) });
      page.cleanup();
    }
    return { kind: 'pdf', units, pages: document.numPages };
  } finally {
    await document.destroy();
  }
}

function lines(items: TextItem[]): string[] {
  const rows: { y: number; parts: TextItem[] }[] = [];
  for (const item of items) {
    const y = item.transform[5];
    const row = rows.find(candidate => Math.abs(candidate.y - y) <= Math.max(2, (item.height || 10) * 0.3));
    if (row) row.parts.push(item);
    else rows.push({ y, parts: [item] });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map(row => {
    const parts = row.parts.sort((a, b) => a.transform[4] - b.transform[4]);
    let text = '';
    let end: number | undefined;
    for (const part of parts) {
      const x = part.transform[4];
      const size = part.height || Math.abs(part.transform[0]) || 10;
      if (end !== undefined) text += x - end > size * 1.2 ? '  ' : x - end > size * 0.15 ? ' ' : '';
      text += part.str;
      end = x + part.width;
    }
    return text.trim();
  });
}

// 把一页渲染成 PNG（供视觉模型解读扫描页、示意图、时序图）。最长边限制在 maxSide 像素以内，控制请求大小。
export async function renderPdfPage(data: Uint8Array, pageNumber: number, maxSide = 1600): Promise<{ png: Buffer; width: number; height: number }> {
  const document = await openPdf(data);
  try {
    if (pageNumber < 1 || pageNumber > document.numPages) throw new Error(`页码超出范围：1-${document.numPages}`);
    const page = await document.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2.5, maxSide / Math.max(base.width, base.height)) });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
    page.cleanup();
    return { png: canvas.toBuffer('image/png'), width: canvas.width, height: canvas.height };
  } finally {
    await document.destroy();
  }
}
