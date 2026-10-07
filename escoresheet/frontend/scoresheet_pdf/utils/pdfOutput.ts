/**
 * Checks and layout of the scoresheet PDF (field-spec 13.5): the capture must
 * be a real picture of the sheet, and the file a valid PDF, before anything is
 * saved or handed to the match-end approval. A capture of a hidden or empty
 * sheet (the libero control sheet view, a 0-size element) used to produce a
 * 3 KB PDF with a broken image that was "saved" as a success.
 */

/** The sheet's size on paper (mm) and its place on the A3 landscape page, to scale. */
export const SHEET_MM = { width: 410, height: 287 } as const
export const A3_LANDSCAPE_MM = { width: 420, height: 297 } as const
export const SHEET_OFFSET_MM = {
  x: (A3_LANDSCAPE_MM.width - SHEET_MM.width) / 2,
  y: (A3_LANDSCAPE_MM.height - SHEET_MM.height) / 2
} as const

/** Smallest capture accepted: the 410 x 287 mm sheet at 96 dpi is about 1550 x 1085 px. */
export const MIN_CAPTURE_PX = { width: 1000, height: 700 } as const

export class PdfCheckError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'PdfCheckError'
  }
}

/** The element is laid out (not display:none, not 0-size). */
export function assertVisibleSheet(el: { offsetWidth?: number; offsetHeight?: number } | null | undefined): void {
  if (!el || !(el.offsetWidth! > 0) || !(el.offsetHeight! > 0)) {
    throw new PdfCheckError('The scoresheet is not visible: nothing to capture.')
  }
}

/** The capture is big enough and in the sheet's proportions. */
export function assertCanvas(canvas: { width: number; height: number } | null | undefined): void {
  if (!canvas || !(canvas.width >= MIN_CAPTURE_PX.width) || !(canvas.height >= MIN_CAPTURE_PX.height)) {
    throw new PdfCheckError(`The capture is empty or too small (${canvas?.width ?? 0} x ${canvas?.height ?? 0} px).`)
  }
  const ratio = canvas.width / canvas.height
  const expected = SHEET_MM.width / SHEET_MM.height
  if (Math.abs(ratio - expected) / expected > 0.05) {
    throw new PdfCheckError(`The capture is not the sheet (${canvas.width} x ${canvas.height} px).`)
  }
}

/** A JPEG data URL with real content (an empty canvas gives "data:," or a tiny image). */
export function assertJpegDataUrl(dataUrl: unknown): void {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/jpeg') || dataUrl.length < 10_000) {
    throw new PdfCheckError('The capture could not be encoded as an image.')
  }
}

const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes)

/**
 * A complete PDF: starts with "%PDF-", ends with "%%EOF" (and an end-of-line),
 * and is not just a skeleton (a page with an image is far above 20 KB).
 */
export function isValidPdfBytes(buffer: ArrayBuffer | Uint8Array, minBytes = 20_000): boolean {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  if (bytes.length < minBytes) return false
  if (ascii(bytes.subarray(0, 5)) !== '%PDF-') return false
  const tail = ascii(bytes.subarray(Math.max(0, bytes.length - 32))).trimEnd()
  return tail.endsWith('%%EOF')
}

export function assertValidPdf(buffer: ArrayBuffer | Uint8Array, minBytes?: number): void {
  if (!isValidPdfBytes(buffer, minBytes)) {
    throw new PdfCheckError('The PDF file is not complete.')
  }
}

/** Where the user's PDF went, as the sheet tells it (one shape for every platform). */
export type SaveOutcome =
  | { kind: 'web'; fileName: string }
  | { kind: 'desktop'; fileName: string; path: string; id?: number | null }
  | { kind: 'desktop-pending'; fileName: string }
  | { kind: 'app'; fileName: string }
  | { kind: 'failed'; message: string }

/** Downloads a blob under `fileName` (an anchor with the download attribute). */
export function downloadBlob(blob: Blob, fileName: string, doc: Document = document): void {
  const url = URL.createObjectURL(blob)
  const a = doc.createElement('a')
  a.href = url
  a.download = fileName
  a.rel = 'noopener'
  a.style.display = 'none'
  doc.body.appendChild(a)
  a.click()
  a.remove()
  // the download has started by then; the URL is not needed any more
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
