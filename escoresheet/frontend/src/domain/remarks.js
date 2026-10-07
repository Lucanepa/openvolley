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

const pad2 = (n) => String(n).padStart(2, '0')

/** The local wall-clock time "HH:MM" of a remark (24 h), as the sheet prints times. */
export function remarkClock(at = new Date()) {
  const d = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/**
 * An automatic remark in the scoresheet's convention (owner 2026-10-07):
 * "Set 3, 14:28, B 15:5, #4 injured (bench)": the set as printed, the local
 * time, the team and the score with the concerned team first (field-spec 8),
 * then what happened.
 */
export function eventRemark({ set, at = new Date(), team, teamScore = 0, oppScore = 0, text }) {
  return `Set ${set}, ${remarkClock(at)}, ${team} ${teamScore}:${oppScore}, ${text}`
}
