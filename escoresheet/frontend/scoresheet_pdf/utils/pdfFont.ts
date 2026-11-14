// Text that jsPDF writes itself (the remarks page 2, the invisible search line).
// Its built-in Helvetica knows WinAnsi only: a remark with Č, Ł, Ğ or an iPad's
// smart punctuation (’ –) was printed with letters dropped or changed. Such
// text is written with an embedded Unicode font, Liberation Sans (SIL OFL,
// shipped with pdf.js and bundled with the app, so it works offline). Text in
// Latin-1 keeps Helvetica: no font is added, the PDF stays as small as before.

import type { jsPDF } from 'jspdf';

export const UNICODE_FONT = 'LiberationSans';
const FONT_FILE = 'LiberationSans-Regular.ttf';

/** True when Helvetica (WinAnsi) cannot write the text. */
export const needsUnicodeFont = (text: string): boolean => /[^\u0000-ÿ]/.test(text || '');

let bundledFont: Promise<string> | null = null;

/** The bundled TTF as base64, fetched once per page. */
function loadBundledFont(): Promise<string> {
  if (!bundledFont) {
    bundledFont = (async () => {
      const { default: url } = await import('pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf?url');
      const res = await fetch(url);
      if (!res.ok) throw new Error(`font ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return btoa(binary);
    })();
    bundledFont.catch(() => { bundledFont = null; });
  }
  return bundledFont;
}

/**
 * Sets the font the text needs: the embedded Unicode font (added to this PDF
 * once) or Helvetica. If the font cannot be loaded, Helvetica as before.
 * @returns true when the Unicode font is set
 */
export async function applyTextFont(pdf: jsPDF, text: string, load: () => Promise<string> = loadBundledFont): Promise<boolean> {
  if (!needsUnicodeFont(text)) {
    pdf.setFont('helvetica', 'normal');
    return false;
  }
  try {
    if (!pdf.getFontList()[UNICODE_FONT]) {
      pdf.addFileToVFS(FONT_FILE, await load());
      pdf.addFont(FONT_FILE, UNICODE_FONT, 'normal');
    }
    pdf.setFont(UNICODE_FONT, 'normal');
    return true;
  } catch (err) {
    console.warn('[Scoresheet] Unicode font unavailable, using Helvetica:', err);
    pdf.setFont('helvetica', 'normal');
    return false;
  }
}
