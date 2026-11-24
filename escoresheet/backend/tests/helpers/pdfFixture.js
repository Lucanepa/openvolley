/**
 * A small but complete PDF file (header, objects, xref, trailer, startxref,
 * %%EOF), as lib/globalMatches.js isPdfFile wants one (audit 2026-11-23
 * PERM-15): the shape jsPDF writes. `pad` bytes of comment make it as large
 * as a test needs.
 */
export function minimalPdf({ pad = 1200, version = '1.7' } = {}) {
  const body = `%PDF-${version}\n%âãÏÓ\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n%${'x'.repeat(pad)}\n`
  const xref = Buffer.byteLength(body, 'latin1')
  return Buffer.from(`${body}xref\n0 3\n0000000000 65535 f \ntrailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1')
}
