/**
 * The Android build's xlsxCodec (vite.config.js aliases lib/xlsxCodec to
 * this file when CAPACITOR=true): the tournament import is manager-beach's,
 * a web page, so the APK carries no XLSX reader or writer. The import dialog
 * then offers CSV only.
 */
export const XLSX_AVAILABLE = false

export function columnName(i) {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

export function readWorkbook() {
  throw new Error('xlsx: not available in this build')
}

export function writeWorkbook() {
  throw new Error('xlsx: not available in this build')
}
