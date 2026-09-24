import type { DocumentKind } from '../../shared/contracts.js';

/** 可引用的最小单位：PDF 的一页，或 Markdown/DOCX/HTML 的一个章节。 */
export type Unit = { ref: string; title: string; level: number; text: string; page?: number; noTextLayer?: boolean };
export type Extracted = { kind: DocumentKind; units: Unit[]; pages?: number };
