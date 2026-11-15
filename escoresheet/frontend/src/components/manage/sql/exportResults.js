// src/components/manage/sql/exportResults.js
//
// The SQL tab's result exports: CSV (download) and a table on the clipboard
// (HTML for a spreadsheet or mail, TSV as plain text). Pure except the two
// browser helpers at the end.

import { parseSqlTemporal, formatSqlTemporal } from './sqlCellDates'

/** Text form of a cell. Temporal strings come out Swiss (`dd.mm.yyyy`,
 *  `dd.mm.yyyy HH:MM:SS`, instants in Europe/Zurich), as the grid shows them. */
export function serializeCell(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'object') return JSON.stringify(value)
  const temporal = parseSqlTemporal(value)
  if (temporal) return formatSqlTemporal(temporal, { seconds: true })
  return String(value)
}

/** Tab-separated values with a header row (clipboard → spreadsheet). */
export function toTSV(columns, rows) {
  const clean = (s) => s.replace(/[\t\n\r]+/g, ' ')
  const header = columns.map(clean).join('\t')
  const body = rows.map((row) => row.map((c) => clean(serializeCell(c))).join('\t')).join('\n')
  return `${header}\n${body}`
}

/** RFC 4180 CSV: quotes fields with commas, quotes or line breaks. */
export function toCSV(columns, rows) {
  const escape = (raw) => {
    let s = raw
    // Spreadsheet formula injection (a leading = + - @ tab CR), but not a signed number
    if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d/.test(s)) s = `'${s}`
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const header = columns.map(escape).join(',')
  const body = rows.map((row) => row.map((cell) => escape(serializeCell(cell))).join(',')).join('\n')
  return `${header}\n${body}`
}

/** An HTML <table>, escaped, for the clipboard. */
export function toHtmlTable(columns, rows) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const thead = `<thead><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>`
  const tbody = `<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${esc(serializeCell(cell))}</td>`).join('')}</tr>`).join('')}</tbody>`
  return `<table border="1" cellspacing="0" cellpadding="4">${thead}${tbody}</table>`
}

/** A text file download (UTF-8 BOM for CSV, so Excel reads umlauts). */
export function downloadText(content, filename, mime) {
  const blob = new Blob([mime.startsWith('text/csv') ? '﻿' : '', content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** HTML and TSV on the clipboard: the target picks the richer one. */
export async function copyAsTable(columns, rows) {
  const html = toHtmlTable(columns, rows)
  const tsv = toTSV(columns, rows)
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([tsv], { type: 'text/plain' })
    })])
    return
  }
  await navigator.clipboard.writeText(tsv)
}
