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

/**
 * Set 1's actual start, when the scorer confirmed a time other than the
 * scheduled one (owner 2026-10-08): "Actual start time: 12:45". Always in
 * English, like the other automatic remarks the match writes, so the line is
 * found again (replaced / removed) whatever the app language.
 */
export const ACTUAL_START_LABEL = 'Actual start time'
const ACTUAL_START_RE = /^Actual start time: \d{1,2}:\d{2}$/

/** The remark line for a set 1 that started at `at` (local HH:MM). */
export function actualStartLine(at) {
  const clock = remarkClock(at)
  return clock ? `${ACTUAL_START_LABEL}: ${clock}` : ''
}

/** The "Actual start time: HH:MM" lines of the remarks text. */
export function actualStartLines(remarks) {
  if (!remarks) return []
  return remarks.split('\n').filter(l => ACTUAL_START_RE.test(l.trim()))
}

/**
 * The remarks text with exactly one actual-start line: `line`, or none when
 * `line` is empty (set 1 started at the scheduled time). The other lines stay
 * as they are; an existing identical single line stays where it is.
 */
export function setActualStartRemark(remarks, line) {
  const text = remarks || ''
  const existing = actualStartLines(text)
  if (line && existing.length === 1 && existing[0] === line) return text
  const kept = text ? text.split('\n').filter(l => !ACTUAL_START_RE.test(l.trim())).join('\n') : ''
  return appendRemark(kept, line || '')
}
