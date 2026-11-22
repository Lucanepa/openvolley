// REMARKS too long for the sheet's box: the PDF prints the whole text after the
// sheet (field-spec 8: continue on an overflow page if needed, never truncate).
// jsPDF does not paginate a text call: everything past the page bottom was lost
// (about 58 lines at 11 pt on A3). Every page takes the lines that fit, and
// the next one starts with "REMARKS (continued)".

import { A3_LANDSCAPE_MM } from './pdfOutput';

/** The part of jsPDF the remark pages use (the real jsPDF, or a test double). */
export interface RemarksPdf {
  addPage: (format?: string, orientation?: 'l' | 'landscape' | 'p' | 'portrait') => unknown;
  setFontSize: (size: number) => unknown;
  text: (text: string | string[], x: number, y: number) => unknown;
  splitTextToSize: (text: string, maxWidth: number) => string[];
  getLineHeightFactor?: () => number;
}

/** Page layout in mm (A3 landscape) and the text size in pt. */
export const REMARKS_PAGE = {
  margin: 15,
  /** first line of text on the first page (under the heading and the title) */
  firstTop: 38,
  /** first line of text on a continuation page (under its heading) */
  nextTop: 30,
  fontPt: 11
} as const;

const PT_MM = 25.4 / 72;

/** The text's lines, page by page, as `writeRemarksPages` prints them. */
export function remarksPageLines(lines: string[], lineHeightMm: number): string[][] {
  const bottom = A3_LANDSCAPE_MM.height - REMARKS_PAGE.margin;
  const pages: string[][] = [];
  let i = 0;
  while (i < lines.length || pages.length === 0) {
    const top = pages.length === 0 ? REMARKS_PAGE.firstTop : REMARKS_PAGE.nextTop;
    // a text line's baseline sits at top + n * lineHeight; it must stay above the bottom margin
    const fit = Math.max(1, Math.floor((bottom - top) / lineHeightMm) + 1);
    pages.push(lines.slice(i, i + fit));
    i += fit;
  }
  return pages;
}

/**
 * Add the REMARKS pages after the sheet; the caller has set the font
 * (pdfFont.applyTextFont). Returns the number of pages added.
 */
export function writeRemarksPages(pdf: RemarksPdf, title: string, text: string): number {
  const width = A3_LANDSCAPE_MM.width - 2 * REMARKS_PAGE.margin;
  pdf.setFontSize(REMARKS_PAGE.fontPt);
  const lines = pdf.splitTextToSize(text, width);
  const factor = (typeof pdf.getLineHeightFactor === 'function' && pdf.getLineHeightFactor()) || 1.15;
  const pages = remarksPageLines(lines, REMARKS_PAGE.fontPt * factor * PT_MM);
  pages.forEach((chunk, n) => {
    pdf.addPage('a3', 'landscape');
    const x = REMARKS_PAGE.margin;
    if (n === 0) {
      pdf.setFontSize(14);
      pdf.text('REMARKS (continued from the scoresheet)', x, 20);
      pdf.setFontSize(10);
      pdf.text(title, x, 27);
    } else {
      pdf.setFontSize(10);
      pdf.text(`REMARKS (continued, page ${n + 1} of ${pages.length}) - ${title}`, x, 20);
    }
    pdf.setFontSize(REMARKS_PAGE.fontPt);
    pdf.text(chunk, x, n === 0 ? REMARKS_PAGE.firstTop : REMARKS_PAGE.nextTop);
  });
  return pages.length;
}
