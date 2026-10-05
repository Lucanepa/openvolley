/**
 * Pure helpers for the scoresheet remarks text (match.remarks) — no React,
 * no Dexie. Automatic remarks (injury / exceptional substitution, libero
 * unable / re-designation) are appended as one line each; the event that wrote
 * a line records it in its payload (autoRemark) so that undoing the event can
 * take exactly that line out again.
 */

/** Append one line to the remarks text. */
export function appendRemark(remarks, line) {
  if (!line) return remarks || ''
  return remarks ? `${remarks}\n${line}` : line
}

/**
 * Remove the LAST occurrence of an exact line from the remarks text (the most
 * recent automatic remark with that text). Other lines, including manual edits
 * the scorer typed, are left as they are. Returns the text unchanged when the
 * line is not found (e.g. the scorer already edited it).
 */
export function removeRemarkLine(remarks, line) {
  if (!remarks || !line) return remarks || ''
  const lines = remarks.split('\n')
  const idx = lines.lastIndexOf(line)
  if (idx === -1) return remarks
  lines.splice(idx, 1)
  return lines.join('\n')
}
