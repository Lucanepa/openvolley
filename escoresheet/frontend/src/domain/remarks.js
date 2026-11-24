/**
 * Pure helpers for the scoresheet remarks text (match.remarks) — no React,
 * no Dexie. Automatic remarks (injury / exceptional substitution, libero
 * unable / re-designation) are appended as one line each; the event that wrote
 * a line records it in its payload (autoRemark) so that undoing the event can
 * take exactly that line out again.
 */
import { zonedParts } from '../ui/format'

/**
 * Where an event's remark line (payload.autoRemark) goes (owner 22.11.2026):
 * on the scoresheet (match.remarks; the default, and every older event) or,
 * with payload.remarkTo 'technical', into the match's technical remarks
 * (domain/technicalRemarks.js: never on the PDF, never in match.remarks).
 * Undo, removals, renumbering and going back take a line out of (or put it
 * back into) match.remarks only when it is a sheet line.
 */
export const TECHNICAL = 'technical'
export function isSheetRemark(payload) {
  return payload?.remarkTo !== TECHNICAL
}

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

/**
 * The remarks text after a correction plan's removals and additions
 * (services/corrections/applyCorrectionPlan writes it; the correction board
 * draws its draft with it).
 */
export function remarksAfter(remarks, plan) {
  // remarksSet: the whole text, when one line was edited in place
  let out = plan?.remarksSet !== undefined ? String(plan.remarksSet) : (remarks || '')
  // a line rewritten where it stands (a renumbered player's remark)
  for (const { from, to } of plan?.remarkReplace || []) {
    if (!from || from === to) continue
    out = out.split('\n').map(l => (l === from ? to : l)).join('\n')
  }
  for (const line of plan?.remarkRemove || []) out = removeRemarkLine(out, line)
  for (const line of plan?.remarkAdd || []) out = appendRemark(out, line)
  return out
}

/**
 * The Zürich wall-clock time "HH:MM" of a remark (24 h), as the sheet prints
 * times: the gym's clock on a device in any zone (stress test 2026-10-25).
 */
export function remarkClock(at = new Date()) {
  const d = at instanceof Date ? at : new Date(at)
  const p = zonedParts(d)
  if (!p.valid) return ''
  return `${pad2(p.hour)}:${pad2(p.minute)}`
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
 * The text of the automatic remarks the match writes for a player who cannot
 * go on, in the rules' words and nothing more (no diagnosis): remarks are
 * part of the record, printed on the scoresheet and mailed with it, and an
 * injury is health data (privacy policy section 7). The event payload keeps
 * the reason (isInjury, reason 'injury') for the rules; older matches carry
 * the earlier wording "... due to injury", which domain/rosterLive and
 * domain/interruptionRequests still recognise.
 *   forced substitution of an injured / ill player  (FIVB 15.5, 15.7)
 *   libero unable to play                           (FIVB 19.3.2.8)
 */
export function injurySubstitutionText(playerOut) {
  return `#${playerOut} substituted, cannot continue playing`
}

/**
 * An exceptional substitution (FIVB 15.7, 15.8). An expulsion or a
 * disqualification is named: it is a sanction, already on the sheet. An
 * injury is not (no diagnosis, see above).
 */
export function exceptionalSubstitutionText(playerOut, playerIn, reason) {
  const why = reason === 'expulsion' || reason === 'disqualification' ? ` (${reason})` : ''
  return `#${playerOut} exceptionally substituted by #${playerIn}${why}`
}

/** `reason` 'injury' (becomes unable) or 'declared' (the coach or the game captain declared it). */
export function liberoUnableText(liberoNumber, reason) {
  return reason === 'injury'
    ? `Libero #${liberoNumber} becomes unable to play`
    : `Libero #${liberoNumber} declared unable to play`
}

/**
 * An injured libero back in play, as long as no re-designation replaced him
 * (owner 22.11.2026; the libero_recovered event). No diagnosis, as above.
 */
export function liberoRecoveredText(liberoNumber) {
  return `Libero #${liberoNumber} able to play again`
}

/**
 * Set 1's actual start, when the scorer confirmed a time other than the
 * scheduled one (owner 2026-10-08): "Actual game start: 12:45". Always in
 * English, like the other automatic remarks the match writes, so the line is
 * found again (replaced / removed) whatever the app language.
 */
export const ACTUAL_START_LABEL = 'Actual game start'
// the earlier wording "Actual start time" and the line without a reason are
// still recognised (replaced / removed)
const ACTUAL_START_RE = /^Actual (?:game start|start time): \d{1,2}:\d{2}(?: \((.*)\))?$/

/** The scorer's reason as one line (no line breaks: one remark is one line). */
export function cleanStartReason(reason) {
  return String(reason ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * The remark line for a set 1 that started at `at` (Zürich HH:MM), with the
 * scorer's reason (owner 2026-11-17): "Actual game start: 16:21 (Team bus
 * late)". The label stays English; the reason is what the scorer typed.
 */
export function actualStartLine(at, reason = null) {
  const clock = remarkClock(at)
  if (!clock) return ''
  const why = cleanStartReason(reason)
  return why ? `${ACTUAL_START_LABEL}: ${clock} (${why})` : `${ACTUAL_START_LABEL}: ${clock}`
}

/** The reason of an actual-start line ("" without one). */
export function actualStartReason(line) {
  const m = ACTUAL_START_RE.exec(String(line || '').trim())
  return m && m[1] ? m[1].trim() : ''
}

/** The "Actual game start: HH:MM" lines of the remarks text (old wording and reason included). */
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
