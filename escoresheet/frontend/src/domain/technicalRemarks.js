/**
 * Technical remarks (owner 22.11.2026) — pure, no React, no Dexie.
 *
 * The scoresheet's REMARKS hold what the rules want on paper: the scorer's
 * own remarks, a delayed start of the game or a set, an exceptional
 * substitution, a libero unable / re-designated, going back in the game,
 * protests, a forfeit. What the app notes about how the record was kept
 * (a roster change after the coin toss, a reopened set, cleared or replaced
 * signatures, an injury substitution with a legal substitute, a bench
 * injury, every correction) is a TECHNICAL remark: never printed on the
 * PDF, listed at the match end and in Corrections, kept with the match on
 * the server (manual_changes) and sent in the final scoresheet mail, never
 * to the referee tablet.
 *
 * Where they are stored (no migration):
 *  - match-wide lines: match.manualChanges entries (the correction log;
 *    `category: 'technical'` for a line written as a technical remark);
 *  - an event's line: its payload.autoRemark with payload.remarkTo
 *    'technical' (domain/remarks isSheetRemark), never in match.remarks.
 *
 * Only a match created with this model (match.remarksModel = REMARKS_MODEL,
 * set when the match row is created, db/db.js; match_info.remarks_model on
 * the server, domain/sheetInputs) writes and draws them so: an older match
 * (no marker) keeps every line on its sheet, as before.
 */
import { describeLegacyChange, remarkPrefix, remarkText, teamLetter, displaySetNumber, tr } from './describe'
import { TECHNICAL } from './remarks'

/** The remarks model of a match created by this version. */
export const REMARKS_MODEL = 2

/** True when the match keeps technical remarks off its scoresheet. */
export function technicalRemarksOn(match) {
  return Number(match?.remarksModel) >= REMARKS_MODEL
}

/**
 * The remarks model a stored match brings along (a backup file, the
 * server's match_info): its own, else null (an older match). A restored
 * match never gets the marker of a new one (db/db.js creating hook).
 */
export function remarksModelOf(value) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * Where an automatic line of a technical kind goes in this match: 'technical'
 * in a match of this model, 'sheet' (match.remarks, as before) in an older one.
 */
export function technicalRemarkTo(match) {
  return technicalRemarksOn(match) ? TECHNICAL : 'sheet'
}

/** One line of text (no line breaks: one remark is one line), at most `max` characters. */
export function oneLine(text, max = 500) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

/**
 * A technical remark as a match.manualChanges entry (the correction log's
 * shape, services/corrections/applyCorrectionPlan logEntryFor).
 * action: 'technicalRemark' (typed by the scorer), 'signaturesCleared',
 * 'resigned', ...
 */
export function technicalChange({ action = 'technicalRemark', text, setIndex = null, team = null, by = 'scorer', now = new Date() } = {}) {
  const line = oneLine(text)
  return {
    ts: (now instanceof Date ? now : new Date(now)).toISOString(),
    category: TECHNICAL,
    action,
    setIndex,
    team,
    before: null,
    after: null,
    text: line,
    description: line,
    by
  }
}

const msOf = (ts) => {
  const ms = Date.parse(ts)
  return Number.isFinite(ms) ? ms : null
}

/**
 * The technical remarks of a match, oldest first: every correction-log entry
 * (match.manualChanges, as its sentence) and every event line written as a
 * technical remark. [{ ts, text, source: 'log' | 'event' }]
 * An entry without a time keeps its place after the timed ones.
 */
export function technicalRemarks({ match, events, t } = {}) {
  const out = []
  let order = 0
  for (const c of Array.isArray(match?.manualChanges) ? match.manualChanges : []) {
    if (!c || typeof c !== 'object') continue
    const text = oneLine(describeLegacyChange(c, t))
    if (text) out.push({ ts: c.ts ?? null, text, source: 'log', order: order++ })
  }
  for (const e of Array.isArray(events) ? events : []) {
    if (!e?.payload || e.payload.remarkTo !== TECHNICAL || typeof e.payload.autoRemark !== 'string') continue
    const text = oneLine(e.payload.autoRemark)
    if (text) out.push({ ts: e.ts ?? null, text, source: 'event', order: order++ })
  }
  return out
    .sort((a, b) => {
      const x = msOf(a.ts)
      const y = msOf(b.ts)
      if (x !== null && y !== null && x !== y) return x - y
      if ((x === null) !== (y === null)) return x === null ? 1 : -1
      return a.order - b.order
    })
    .map(({ order: _order, ...r }) => r)
}

// ───────────────────────────── the ask flow ─────────────────────────────

// The remark templates the rules want on the scoresheet (Corrections, Add remark)
const SHEET_TEMPLATES = new Set(['exceptionalSub', 'liberoUnable', 'liberoRedesignated', 'delay', 'protest', 'missingSignature'])
// Changes of the sheet's own remark lines: nothing to ask
const REMARK_EDITS = new Set(['editRemark', 'removeRemark', 'editRemarks'])

/**
 * Where a correction is noted (owner 22.11.2026: ask the scorer):
 * { default: 'sheet' | 'technical', locked } or null (nothing to ask: an
 * edit of the sheet's remark lines, an older match).
 *  - locked to the sheet: a line the rules require (an exceptional
 *    substitution, a set 1 start or a delay, going back in the game, a
 *    libero / protest / missing-signature remark): the plan's own remark;
 *  - asked, the sheet by default: the scorer's own remark ("Other");
 *  - asked, technical by default: every other correction (points, scores,
 *    sanctions, time-outs, regular substitutions, line-ups, rotations, the
 *    coin toss, game captains, numbers, entries edited or moved).
 * @param {object} plan a planner's plan (never one with `error`)
 * @param {{ match?: object }} [ctx]
 */
export function remarkDestination(plan, ctx = {}) {
  if (!plan || plan.error || !plan.log) return null
  if (!technicalRemarksOn(ctx.match)) return null
  // already decided (withRemarkDestination): not asked again
  if (plan.log.remarkTo) return null
  const action = plan.log.action
  if (REMARK_EDITS.has(action) || plan.remarksSet !== undefined) return null
  if (action === 'addRemark') {
    return { default: 'sheet', locked: SHEET_TEMPLATES.has(plan.remarkKind) }
  }
  if (plan.remarkAdd?.length) return { default: 'sheet', locked: true }
  return { default: 'technical', locked: false }
}

/**
 * The scoresheet line of a correction the scorer wants on the sheet too
 * (an editable proposal): "Team B, Set 2: Point removed: … (manual correction)."
 */
export function sheetLineOf(plan, ctx = {}) {
  const log = plan?.log || {}
  const what = oneLine(log.text).replace(/[.\s]+$/, '')
  if (!what) return ''
  const team = log.team === 'home' || log.team === 'away' ? teamLetter(log.team, ctx.match) : null
  const set = Number.isInteger(log.setIndex) ? displaySetNumber(log.setIndex, ctx.match) : null
  if (team && set && log.score) return remarkText('manualCorrection', { team, set, score: log.score, what }, ctx.t)
  return `${remarkPrefix({ team, set }, ctx.t)}${tr(ctx.t, 'corrections.remark.manualCorrectionWhat', '{{what}} (manual correction).', { what })}`
}

/**
 * The plan with the scorer's choice of where it is noted:
 *  - 'sheet' for a correction that is technical by default: `line` (the
 *    scorer's text, else sheetLineOf) is added to the remarks, and the log
 *    entry says so (remarkTo 'sheet', sheetLine);
 *  - 'technical' for the scorer's own remark: no line on the sheet, the text
 *    becomes a technical remark (log action 'technicalRemark', category
 *    'technical');
 *  - a technical correction kept technical: the log says it was decided
 *    (remarkTo 'technical'), so the board's review does not ask again;
 *  - a locked one, or the scorer's remark kept on the sheet: the plan as it is.
 */
export function withRemarkDestination(plan, choice, { line = null, ctx = {} } = {}) {
  const dest = remarkDestination(plan, ctx)
  if (!dest || dest.locked) return plan
  choice = choice || dest.default
  if (choice === 'sheet' && dest.default === TECHNICAL) {
    const text = oneLine(line ?? sheetLineOf(plan, ctx))
    if (!text) return plan
    return { ...plan, remarkAdd: [...(plan.remarkAdd || []), text], log: { ...plan.log, remarkTo: 'sheet', sheetLine: text } }
  }
  if (choice === TECHNICAL && plan.log.action === 'addRemark') {
    const text = oneLine(plan.log.after ?? plan.remarkAdd?.[0])
    if (!text) return plan
    return {
      ...plan,
      remarkAdd: [],
      log: {
        ...plan.log,
        action: 'technicalRemark',
        category: TECHNICAL,
        remarkTo: TECHNICAL,
        before: null,
        after: null,
        text: tr(ctx.t, 'corrections.log.technicalRemarkAdded', 'Technical remark: "{{text}}"', { text })
      }
    }
  }
  if (choice === TECHNICAL) return { ...plan, log: { ...plan.log, remarkTo: TECHNICAL } }
  return plan
}
