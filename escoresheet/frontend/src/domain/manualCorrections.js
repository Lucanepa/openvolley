/**
 * Planners for the scorer's corrections (during the match and at the match
 * end) — pure, no React, no Dexie.
 *
 * Every correction is planned here and written by one executor
 * (services/corrections/applyCorrectionPlan). A planner returns either a PLAN
 * or `{ error, params }` (error is an i18n key under corrections.error.*):
 *
 *   Plan = {
 *     add:    Event[]            full rows (seq, ts, setIndex, payload, stateSnapshot:null)
 *     update: {id, changes}[]    payload edits and seq renumbering
 *     remove: id[]               whole groups, never orphans
 *     affectedSets: number[]     set indexes whose score is re-derived from the points
 *     setUpdates: {setIndex, changes}[]  set row fields (start/end time)
 *     remarkAdd: string[]  remarkRemove: string[]
 *     log: { action, setIndex, team, before, after, text }
 *     notes: {key, params, text}[]   non-blocking warnings for the preview
 *     followUp: null | { awardPointTo: 'home'|'away' }   live only
 *   }
 *
 * WHERE A NEW EVENT GOES. The scoresheet places a time-out, substitution or
 * sanction at the score of the points logged before it (seq order), never
 * from the stored stateSnapshot. So "at which score" is chosen from the scores
 * the set actually went through (scoreTimeline) and the event gets a seq right
 * after the last event already recorded at that score: an INTEGER seq, with
 * every later event shifted by one (fractional part kept, N.1 -> N+1.1).
 * A fractional seq (40.5) is never used: Undo deletes by base seq and would
 * take the new event with point 40.
 *
 * EVERYTHING THAT FOLLOWS (owner 2026-10-29: manual corrections correct
 * everything). Every exported planner hands its plan to finalizePlan
 * (domain/recompute): the rotations, libero records and set ends after the
 * corrected entry are rebuilt in the same plan, and what has become
 * inconsistent (a substitution of a player no longer on court ...) is listed
 * in plan.newIssues instead of refusing the correction. Only an entry that
 * cannot be written at all is refused (a score the set never had, a player
 * who is not on court at that score). A rule the referee may have decided
 * otherwise (a 7th substitution, a third time-out, the delay ladder) is a
 * warning (plan.notes).
 */
import {
  compareBySeq, tsMs, scoreBeforeEvent, formatScore, plainScore, teamLetter,
  displaySetNumber, describeEvent, remarkText, tr, sanctionLabel, otherTeam,
  isTeamSanctionType, teamLabel
} from './describe'
import { getSetResult, scoreFromPointEvents, getFirstServeForSet, isDecidingSet } from './rules'
import { rotateLineup, pointSubEventsForTeam } from './rotation'
import { swapTeamDesignation as swapTeamDesignationPatch } from './coinToss'
import { actualStartLines, remarkClock } from './remarks'
import { actualStartRemark, scheduledStartOnDay } from '../utils/setStartTime'
import { validateManualTimeout, validateManualSubstitution, classifySubstitutionRequest } from './substitutions'
import { resolveSanction, isDelaySanction, awardsPoint, validateMemberSanction } from './sanctions'
import { applyPlanToEvents, finalizePlan, isRotationLiberoExit } from './recompute'
import { referencedPlayerNumbers, renumberPlayerInEvents, isShirtNumber, renumberRemarkText } from './roster'

export { applyPlanToEvents }

/**
 * The plan with everything that follows from it (domain/recompute). A
 * planner composed of other planners asks them for raw plans (ctx.raw) and
 * finalizes the whole once.
 */
function done(events, plan, ctx) {
  if (!plan || plan.error || ctx?.raw) return plan
  return finalizePlan(events, plan, ctx)
}

const POSITIONS = ['I', 'II', 'III', 'IV', 'V', 'VI']
const FRONT_ROW = ['II', 'III', 'IV']
const baseOf = (e) => Math.floor(e?.seq || 0)
const setOf = (e) => e?.setIndex ?? 1
const hasNumber = (n) => n !== undefined && n !== null && n !== '' && n !== '?'
const sameNumber = (a, b) => hasNumber(a) && hasNumber(b) && String(a) === String(b)

export const ERROR_DEFAULTS = {
  noSuchScore: 'Set {{set}} never had this score.',
  noLineup: 'No line-up is recorded for this team in set {{set}} at that score.',
  timeoutLimit: 'Both time-outs of this team are already recorded in set {{set}}.',
  subLimit: 'Six substitutions of this team are already recorded in set {{set}}.',
  subRule: '{{reason}}',
  samePlayer: 'Choose two different players.',
  choosePlayers: 'Choose the player going out and the player coming in.',
  playerNotOnCourt: 'At {{score}}, #{{n}} was not on court.',
  liberoOnCourt: 'At {{score}}, #{{n}} was replaced by libero #{{libero}}.',
  liberoNotSubstituted: '#{{n}} is a libero: a libero is not substituted. Correct the libero replacement in the Libero card.',
  playerInOnCourt: 'At {{score}}, #{{n}} was already on court.',
  laterConflict: '#{{out}} or #{{in}} takes part in a later substitution or libero replacement in this set. Remove that one first.',
  noLaterOpponentPoint: '{{team}} has no later point in set {{set}} to mark as the penalty point. If the point was never recorded, use "Correct final score".',
  pointNowOnlyLive: 'The point can only be added now at the current score of the set being played.',
  winnerWouldChange: 'This would change who won set {{set}}. Use "Reopen last set" or ask the referee.',
  invalidFinalScore: '{{score}} is not a possible final score of set {{set}}.',
  notLastPoint: 'The last point of set {{set}} was not won by {{team}}.',
  setNotFinished: 'Set {{set}} is not finished.',
  ladder: 'By the rules this is a {{expected}} (the team\'s earlier sanctions).',
  sameSanctionTwice: 'This person already has this sanction.',
  teamAlreadyWarned: 'The team has already been warned: only one warning per team per match.',
  chooseTarget: 'Choose who was sanctioned.',
  readOnlyApproved: 'The match is approved. Reopen it for corrections first.',
  notFound: 'This entry no longer exists.',
  useUndo: 'This entry is corrected with Undo, Reopen set or the line-up tool, not removed here.',
  useReopen: 'A set end is taken back with "Reopen set".',
  automaticEntry: 'This row is written by the app and recalculated from the entries: correct the entry it belongs to.',
  coinTossNotRemovable: 'A match always has a coin toss: correct it instead.',
  lineupIncomplete: 'Choose a player for each of the six positions.',
  lineupDuplicate: '#{{n}} is chosen twice.',
  chooseNumber: 'Choose a number.',
  numberTaken: '#{{n}} is already the number of {{name}} ({{team}}). Choose another number.',
  numberInRecord: '#{{n}} already appears in the match record of {{team}}. Choose another number.',
  invalidNumber: 'A shirt number is a whole number from 1 to 99.',
  sameNumber: 'This is already the player\'s number.',
  noSuchPlayer: 'This player is not on the roster.',
  subEvent: 'This row belongs to another entry; remove that entry instead.',
  liberoOnCourtRotate: 'A libero is on court for this team: rotate after the libero has left the court.',
  removePointNotLast: 'The penalty point can only be removed while it is the last point of the set being played.',
  noScoreChange: 'Nothing to change.',
  endBeforeStart: 'Set {{set}} cannot end before it starts.'
}

export const NOTE_DEFAULTS = {
  ladder: 'By the rules this would have been a {{expected}}; recorded as the referee decided.',
  sameSanctionTwice: 'This person already has this sanction.',
  teamAlreadyWarned: 'The team had already been warned (only one warning per team per match).',
  circledPoint: '{{team}}\'s point at {{score}} becomes the circled penalty point.',
  pointNow: 'The point for {{team}} is added after the sanction.',
  pointStays: 'The point stays as a normal rally point (no longer circled).',
  penaltyNotNext: 'The rally after {{score}} was won by {{team}}, not by the opponent: check that the sanction was given at this score.',
  irBox: 'Team {{letter}}\'s letter is crossed (X) in the improper-request box; no score is written.',
  expulsionReplacement: 'Record the replacement with "+ Add substitution" (exceptional if no legal substitution was possible).',
  laterRotations: 'Later rotations of this set are not recalculated.',
  afterMatch: 'Entered after the match.',
  timeoutLimit: 'Both time-outs of this team were already recorded in set {{set}}: this is a third one.',
  subLimit: 'Six substitutions of this team are already recorded in set {{set}}: this is a seventh one.',
  subRule: '{{reason}}',
  winnerWouldChange: 'This changes who won set {{set}}.',
  invalidFinalScore: '{{score}} is not a possible final score of set {{set}}.',
  liberoInLineup: '#{{n}} is a libero: a libero is not in the starting line-up.',
  recalculated: 'Everything after it is recalculated: rotations, serve, libero replacements and the score.'
}

/** A planner failure. `text` is the English sentence (UI translates `error`). */
export function fail(key, params = {}) {
  return { error: `corrections.error.${key}`, params, text: tr(null, '', ERROR_DEFAULTS[key] || key, params) }
}

/** The translated text of a planner error. */
export function errorText(result, t) {
  if (!result?.error) return ''
  const key = result.error.replace(/^corrections\.error\./, '')
  return tr(t, result.error, ERROR_DEFAULTS[key] || key, result.params)
}

function note(key, params = {}, t) {
  return { key: `corrections.note.${key}`, params, text: tr(t, `corrections.note.${key}`, NOTE_DEFAULTS[key] || key, params) }
}

export function emptyPlan() {
  return { add: [], update: [], remove: [], affectedSets: [], setUpdates: [], remarkAdd: [], remarkRemove: [], remarkReplace: [], log: null, notes: [], followUp: null }
}

/** Merge two plans (b planned on the events after a): b's changes win per field. */
export function mergePlans(a, b) {
  const out = emptyPlan()
  const removed = new Set([...(a.remove || []), ...(b.remove || [])])
  out.remove = [...removed]
  const updates = new Map()
  for (const u of [...(a.update || []), ...(b.update || [])]) {
    if (removed.has(u.id)) continue
    updates.set(u.id, { ...(updates.get(u.id) || {}), ...u.changes })
  }
  // a's added rows may have been renumbered by b (their temp id is the key)
  const add = [...(a.add || []), ...(b.add || [])].filter(r => !removed.has(r.tempKey)).map(r => {
    const ch = updates.get(r.tempKey)
    if (!ch) return r
    updates.delete(r.tempKey)
    return { ...r, ...ch }
  })
  out.add = add
  out.update = [...updates.entries()].map(([id, changes]) => ({ id, changes }))
  out.affectedSets = [...new Set([...(a.affectedSets || []), ...(b.affectedSets || [])])]
  out.setUpdates = [...(a.setUpdates || []), ...(b.setUpdates || [])]
  out.remarkAdd = [...(a.remarkAdd || []), ...(b.remarkAdd || [])]
  out.remarkRemove = [...(a.remarkRemove || []), ...(b.remarkRemove || [])]
  out.remarkReplace = [...(a.remarkReplace || []), ...(b.remarkReplace || [])]
  if (a.matchPatch || b.matchPatch) out.matchPatch = { ...(a.matchPatch || {}), ...(b.matchPatch || {}) }
  if (a.cloudMatch || b.cloudMatch) out.cloudMatch = { ...(a.cloudMatch || {}), ...(b.cloudMatch || {}) }
  if (a.playerUpdates || b.playerUpdates) out.playerUpdates = [...(a.playerUpdates || []), ...(b.playerUpdates || [])]
  out.notes = [...(a.notes || []), ...(b.notes || [])]
  out.log = b.log || a.log
  out.followUp = b.followUp || a.followUp
  return out
}

let tempCounter = 0
function newRow(ctx, fields) {
  tempCounter += 1
  return {
    matchId: ctx?.matchId,
    stateSnapshot: null,
    manual: true,
    tempKey: `new:${tempCounter}`,
    ...fields
  }
}

function setEvents(events, setIndex) {
  return (events || []).filter(e => setOf(e) === setIndex).sort(compareBySeq)
}

/**
 * The scores a set went through, in order, each with where an event "at that
 * score" goes: after the point that made it (and its N.x rows) and after any
 * event already recorded at that score, before the next rally start / point /
 * set end. The 0:0 entry follows the set start and the starting line-ups.
 * @returns {Array<{index:number, home:number, away:number, anchorId:any, anchorSeq:number|null, closerId:any, closerSeq:number|null, kinds:string[]}>}
 */
export function scoreTimeline(events, setIndex) {
  const list = setEvents(events, setIndex)
  const out = []
  let home = 0
  let away = 0
  let win = []
  let open = true
  const close = (closer) => {
    if (!open) return
    const anchor = win.length ? win[win.length - 1] : null
    out.push({
      home, away,
      anchorId: anchor ? anchor.id : null,
      anchorSeq: anchor ? (anchor.seq || 0) : null,
      closerId: closer ? closer.id : null,
      closerSeq: closer ? (closer.seq || 0) : null,
      kinds: win.filter(e => e.type !== 'point').map(e => e.type)
    })
    open = false
  }
  for (const e of list) {
    if (e.type === 'point') {
      close(e)
      if (e.payload?.team === 'home') home++
      else if (e.payload?.team === 'away') away++
      win = [e]
      open = true
    } else if (e.type === 'rally_start' || e.type === 'set_end') {
      close(e)
    } else if (open) {
      win.push(e)
    }
  }
  if (open && list.length > 0) close(null)
  return out.map((x, index) => ({ ...x, index }))
}

/**
 * Where a new event at timeline entry `idx` goes: its seq, its ts and the
 * renumbering of every later event.
 * @returns {null | { seq:number, ts:string, renumber: Array<{id:any, seq:number}>, prevSeq:number }}
 */
export function insertionAt(events, setIndex, idx, timeline = null) {
  const tl = timeline || scoreTimeline(events, setIndex)
  const entry = tl[idx]
  if (!entry) return null
  const all = [...(events || [])].sort(compareBySeq)
  let prev = null
  if (entry.anchorId != null || entry.anchorSeq != null) {
    prev = all.find(e => e.id === entry.anchorId) || all.filter(e => (e.seq || 0) <= entry.anchorSeq).pop() || null
  } else if (entry.closerSeq != null) {
    prev = all.filter(e => (e.seq || 0) < entry.closerSeq).pop() || null
  }
  const seq = (prev ? baseOf(prev) : 0) + 1
  const next = all.find(e => baseOf(e) >= seq) || null
  const renumber = all.some(e => baseOf(e) === seq)
    ? all.filter(e => baseOf(e) >= seq).map(e => ({ id: e.id, seq: Math.round(((e.seq || 0) + 1) * 1000) / 1000 }))
    : []

  const a = prev ? tsMs(prev.ts) : 0
  const b = next ? tsMs(next.ts) : 0
  let ms
  if (a && b && b > a) ms = Math.floor((a + b) / 2)
  else if (a && !next) ms = Math.max(a + 1, Date.now())
  else if (a) ms = a + 1
  else if (b) ms = b - 1
  else ms = Date.now()
  return { seq, ts: new Date(ms).toISOString(), renumber, prevSeq: prev ? prev.seq || 0 : 0 }
}

function renumberUpdates(ins) {
  return (ins?.renumber || []).map(r => ({ id: r.id, changes: { seq: r.seq } }))
}

/** Score at a timeline entry, as {home, away}. */
function entryScore(entry) {
  return { home: entry?.home || 0, away: entry?.away || 0 }
}

/**
 * The team's line-up event in force just before the insertion point
 * (events with base seq below `seq`), or null.
 */
function lineupBefore(events, setIndex, team, seq) {
  const rows = (events || [])
    .filter(e => e.type === 'lineup' && setOf(e) === setIndex && e.payload?.team === team && baseOf(e) < seq)
    .sort(compareBySeq)
  return rows.length ? rows[rows.length - 1] : null
}

/**
 * Who was on court for a team at a timeline entry: the six positions and, if
 * a libero was on court, whom he replaced. For the player pickers.
 * @returns {{ lineup: Record<string,any>|null, libero: null | {position:string, liberoNumber:any, playerNumber:any} }}
 */
export function courtAt(events, setIndex, team, idx) {
  const tl = scoreTimeline(events, setIndex)
  const ins = insertionAt(events, setIndex, idx, tl)
  if (!ins) return { lineup: null, libero: null }
  const row = lineupBefore(events, setIndex, team, ins.seq)
  return { lineup: row?.payload?.lineup || null, libero: row?.payload?.liberoSubstitution || null }
}

function setNumber(setIndex, ctx) {
  return displaySetNumber(setIndex, ctx?.match)
}

/** Log text: "Added: Time-out · Volley Bern (B) · Set 2 · B 10:12 A". */
function logText(kind, row, eventsAfter, ctx, extra = {}) {
  const what = describeEvent(row, eventsAfter, ctx)?.text || ''
  const defaults = {
    added: 'Added: {{what}}',
    removed: 'Removed: {{what}}',
    changed: 'Changed: {{what}} (was: {{from}})'
  }
  let text = tr(ctx?.t, `corrections.log.${kind}`, defaults[kind], { what, ...extra })
  if (ctx?.mode === 'review') text += tr(ctx?.t, 'corrections.log.afterMatchSuffix', ' (entered after the match)')
  return text
}

function makeLog(action, row, eventsAfter, ctx, extra = {}) {
  const kind = action.startsWith('add') ? 'added' : action.startsWith('remove') ? 'removed' : 'changed'
  return {
    action,
    setIndex: setOf(row),
    team: row?.payload?.team ?? null,
    before: extra.from ?? null,
    after: describeEvent(row, eventsAfter, ctx)?.text ?? null,
    text: logText(kind, row, eventsAfter, ctx, extra)
  }
}

function finishPlan(plan, events, ctx, action, rowForLog, extra) {
  const after = applyPlanToEvents(events, plan)
  const row = rowForLog?.tempKey
    ? after.find(e => e.id === rowForLog.tempKey) || rowForLog
    : after.find(e => e.id === rowForLog?.id) || rowForLog
  plan.log = makeLog(action, row, action.startsWith('remove') ? events : after, ctx, extra)
  return plan
}

// ───────────────────────────── time-outs ─────────────────────────────

/** + Add time-out: one `timeout {team}` at the chosen score. */
export function planAddTimeout(events, { setIndex, team, at } = {}, ctx = {}) {
  const tl = scoreTimeline(events, setIndex)
  if (!tl[at]) return fail('noSuchScore', { set: setNumber(setIndex, ctx) })
  if (team !== 'home' && team !== 'away') return fail('chooseTarget')
  const ins = insertionAt(events, setIndex, at, tl)
  const row = newRow(ctx, { type: 'timeout', setIndex, payload: { team }, seq: ins.seq, ts: ins.ts })
  const plan = emptyPlan()
  // a third time-out is recorded if the scorer says so (a warning)
  if (!validateManualTimeout(events, team, setIndex).legal) plan.notes.push(note('timeoutLimit', { set: setNumber(setIndex, ctx) }, ctx.t))
  plan.add = [row]
  plan.update = renumberUpdates(ins)
  return done(events, finishPlan(plan, events, ctx, 'addTimeout', row), ctx)
}

/** Remove a time-out (nothing else depends on it). */
export function planRemoveTimeout(events, id, ctx = {}) {
  const ev = (events || []).find(e => e.id === id)
  if (!ev) return fail('notFound')
  const plan = emptyPlan()
  plan.remove = [id]
  return done(events, finishPlan(plan, events, ctx, 'removeTimeout', ev), ctx)
}

// ─────────────────────────── substitutions ───────────────────────────

function typedLike(sample, value) {
  return typeof sample === 'number' ? Number(value) : String(value)
}

/**
 * + Add substitution at a past (or the current) score. The line-up at that
 * moment gives the position; every later line-up of the team in the set is
 * remapped (playerOut -> playerIn), the inverse of planSubstitutionDeletion.
 */
export function planAddSubstitution(events, { setIndex, team, playerOut, playerIn, at, exceptional = false, reason = null } = {}, ctx = {}) {
  const set = setNumber(setIndex, ctx)
  const tl = scoreTimeline(events, setIndex)
  const entry = tl[at]
  if (!entry) return fail('noSuchScore', { set })
  if (!hasNumber(playerOut) || !hasNumber(playerIn)) return fail('choosePlayers')
  if (sameNumber(playerOut, playerIn)) return fail('samePlayer')
  const ins = insertionAt(events, setIndex, at, tl)
  const scoreStr = formatScore(entryScore(entry), team, ctx)

  const lineupRow = lineupBefore(events, setIndex, team, ins.seq)
  const lineup = lineupRow?.payload?.lineup
  if (!lineup) return fail('noLineup', { set })
  const ls = lineupRow.payload?.liberoSubstitution
  // A libero is never substituted (FIVB 19.3.1: libero replacements are not
  // substitutions), and the player the libero replaced cannot come back by a
  // substitution while the libero is on court for him
  if (ls && sameNumber(ls.liberoNumber, playerOut)) return fail('liberoNotSubstituted', { n: playerOut })
  if (ls && sameNumber(ls.playerNumber, playerIn)) return fail('liberoOnCourt', { score: scoreStr, n: playerIn, libero: ls.liberoNumber })
  // The roster's liberos, when the caller knows them (ctx.liberos = { home: [9], away: [20] })
  const liberos = ctx.liberos?.[team] || []
  if (liberos.some(n => sameNumber(n, playerOut) || sameNumber(n, playerIn))) {
    return fail('liberoNotSubstituted', { n: liberos.some(n => sameNumber(n, playerOut)) ? playerOut : playerIn })
  }
  const position = POSITIONS.find(pos => sameNumber(lineup[pos], playerOut))
  if (!position) {
    if (ls && sameNumber(ls.playerNumber, playerOut)) return fail('liberoOnCourt', { score: scoreStr, n: playerOut, libero: ls.liberoNumber })
    return fail('playerNotOnCourt', { score: scoreStr, n: playerOut })
  }
  if (POSITIONS.some(pos => sameNumber(lineup[pos], playerIn))) return fail('playerInOnCourt', { score: scoreStr, n: playerIn })

  // A later substitution or libero record of these players is not refused:
  // the line-ups after this one are rebuilt (finalizePlan) and a later entry
  // that no longer fits is listed for the scorer to fix.
  const plan = emptyPlan()
  if (!exceptional) {
    // Six regular substitutions per set (FIVB 15.6); exceptional ones are made
    // beyond the limit and never use one of the six (domain/substitutions).
    // Recorded if the scorer says so: a warning, not a refusal.
    if (classifySubstitutionRequest(events, team, setIndex) === 'improper_request') {
      plan.notes.push(note('subLimit', { set }, ctx.t))
    } else {
      const regular = (events || []).filter(e => !(e.type === 'substitution' && e.payload?.isExceptional))
      const v = validateManualSubstitution(regular, team, setIndex, playerOut, playerIn)
      if (!v.legal) plan.notes.push(note(/limit/i.test(v.reason || '') ? 'subLimit' : 'subRule', { set, reason: v.reason }, ctx.t))
    }
  }

  const newLineup = { ...lineup, [position]: typedLike(lineup[position], playerIn) }
  let autoRemark = ''
  if (exceptional) {
    autoRemark = remarkText('exceptionalSub', {
      team: teamLetter(team, ctx.match),
      set,
      score: plainScore(entryScore(entry), team),
      out: playerOut,
      in: playerIn,
      reason: reason || 'injury'
    }, ctx.t)
  }
  const sub = newRow(ctx, {
    type: 'substitution',
    setIndex,
    seq: ins.seq,
    ts: ins.ts,
    payload: {
      team,
      position,
      playerOut: Number(playerOut),
      playerIn: Number(playerIn),
      isExceptional: !!exceptional,
      ...(exceptional && reason ? { exceptionalReason: reason } : {}),
      ...(reason === 'expulsion' ? { isExpelled: true } : {}),
      ...(reason === 'disqualification' ? { isDisqualified: true } : {}),
      ...(autoRemark ? { autoRemark } : {})
    }
  })
  const lineupPayload = { team, lineup: newLineup, fromSubstitution: true }
  if (ls) lineupPayload.liberoSubstitution = ls
  const lineupEv = newRow(ctx, { type: 'lineup', setIndex, seq: Math.round((ins.seq + 0.1) * 1000) / 1000, ts: ins.ts, payload: lineupPayload })

  // the later line-ups of the team are rebuilt with the substitute (finalizePlan)
  plan.add = [sub, lineupEv]
  plan.update = renumberUpdates(ins)
  if (autoRemark) plan.remarkAdd = [autoRemark]
  return done(events, finishPlan(plan, events, ctx, 'addSubstitution', sub), ctx)
}

/**
 * The rows written for an entry: the entry and its N.x sub-rows (its
 * line-up, a point's rotation and automatic libero exit).
 */
export function entryGroupIds(events, ev) {
  if (!ev) return []
  if ((ev.seq || 0) !== baseOf(ev)) return [ev.id]
  return (events || []).filter(e => e.id === ev.id || (baseOf(e) === baseOf(ev) && (e.seq || 0) !== baseOf(e) && isSubRowOf(e, ev))).map(e => e.id)
}

/** True when `row` (N.x) was written by `head` (N): its line-up / rotation rows. */
function isSubRowOf(row, head) {
  if (row.type === 'lineup') return row.payload?.team === head.payload?.team || head.type === 'point'
  if (isRotationLiberoExit(row)) return head.type === 'point'
  return false
}

/**
 * Remove a substitution with its line-up row; every later line-up of the
 * team is rebuilt without it (a later entry that no longer fits, e.g. the
 * substitute going out again, is listed, never refused).
 */
export function planRemoveSubstitution(events, id, ctx = {}) {
  const ev = (events || []).find(e => e.id === id)
  if (!ev) return fail('notFound')
  const plan = emptyPlan()
  plan.remove = entryGroupIds(events, ev)
  if (ev.payload?.autoRemark) plan.remarkRemove = [ev.payload.autoRemark]
  return done(events, finishPlan(plan, events, ctx, 'removeSubstitution', ev), ctx)
}

// ───────────────────────────── sanctions ─────────────────────────────

/** The opponent's first point after `seq` (base seq) in the set, or null. */
function nextPointOf(events, setIndex, team, seq) {
  return setEvents(events, setIndex).find(e => e.type === 'point' && e.payload?.team === team && baseOf(e) >= seq) || null
}

function pointScoreAfter(events, point) {
  const s = scoreBeforeEvent(events, point)
  if (point.payload?.team === 'home') s.home++
  else if (point.payload?.team === 'away') s.away++
  return s
}

function setIsFinished(events, setIndex) {
  return (events || []).some(e => e.type === 'set_end' && setOf(e) === setIndex)
}

/**
 * + Add sanction. Team sanctions (delay, improper request) follow the ladder
 * (resolveSanction); misconduct follows the per-member checks. During the
 * match an inconsistency blocks (as live entry does); at the match end it is
 * a warning, because what the referee decided is what is recorded.
 * target: { playerType: 'player'|'bench'|'libero'|'official', playerNumber, role }
 */
export function planAddSanction(events, { setIndex, team, type, target = {}, at, pointAlreadyGiven = true } = {}, ctx = {}) {
  const t = ctx.t
  const set = setNumber(setIndex, ctx)
  const tl = scoreTimeline(events, setIndex)
  const entry = tl[at]
  if (!entry) return fail('noSuchScore', { set })
  if (team !== 'home' && team !== 'away') return fail('chooseTarget')
  if (!type) return fail('chooseTarget')
  const ins = insertionAt(events, setIndex, at, tl)
  const prior = (events || []).filter(e => baseOf(e) < ins.seq)
  const plan = emptyPlan()
  // What the referee decided is recorded: a sanction outside the ladder is
  // a warning, during the match as at its end
  const issue = (key, params = {}) => { plan.notes.push(note(key, params, t)); return null }

  let payload
  if (isTeamSanctionType(type)) {
    const teamPrior = prior.filter(e => e.type === 'sanction' && e.payload?.team === team)
    const expected = resolveSanction(type, {
      priorDelayCount: teamPrior.filter(e => isDelaySanction(e.payload?.type)).length,
      priorImproperCount: teamPrior.filter(e => e.payload?.type === 'improper_request').length
    })
    if (expected !== type) {
      const f = issue('ladder', { expected: sanctionLabel(expected, t).toLowerCase() })
      if (f) return f
    }
    payload = { team, type }
  } else {
    const pt = target.playerType
    const isPerson = pt === 'player' || pt === 'bench' || pt === 'libero'
    if (isPerson && !hasNumber(target.playerNumber)) return fail('chooseTarget')
    if (pt === 'official' && !target.role) return fail('chooseTarget')
    if (!isPerson && pt !== 'official') return fail('chooseTarget')
    const v = validateMemberSanction(prior, { team, playerNumber: isPerson ? target.playerNumber : undefined, role: pt === 'official' ? target.role : undefined, type })
    if (!v.legal) {
      const f = issue(v.reason)
      if (f) return f
    }
    payload = { team, type, playerType: pt }
    if (isPerson) payload.playerNumber = Number(target.playerNumber)
    if (pt === 'official') payload.role = target.role
    if (pt === 'player' || pt === 'libero') {
      const lu = lineupBefore(events, setIndex, team, ins.seq)?.payload?.lineup || {}
      const pos = POSITIONS.find(p => sameNumber(lu[p], target.playerNumber))
      if (pos) payload.position = pos
    }
    if ((type === 'expulsion' || type === 'disqualification') && pt === 'player') {
      plan.notes.push(note('expulsionReplacement', {}, t))
    }
  }

  const opp = otherTeam(team)
  if (awardsPoint(type)) {
    const oppLabel = teamLabel(opp, ctx)?.name || '?'
    if (pointAlreadyGiven === false) {
      const latest = at === tl.length - 1
      if (ctx.mode !== 'live' || ctx.liveSetIndex !== setIndex || !latest || setIsFinished(events, setIndex)) {
        return fail('pointNowOnlyLive')
      }
      plan.followUp = { awardPointTo: opp }
      plan.notes.push(note('pointNow', { team: oppLabel }, t))
    } else {
      const p = nextPointOf(events, setIndex, opp, ins.seq)
      if (!p) return fail('noLaterOpponentPoint', { team: oppLabel, set })
      plan.notes.push(note('circledPoint', { team: oppLabel, score: formatScore(pointScoreAfter(events, p), opp, ctx) }, t))
      // A penalty gives the point at once: if the rally right after this
      // score went to the sanctioned team, the score chosen is probably wrong
      const firstAfter = setEvents(events, setIndex).find(e => e.type === 'point' && baseOf(e) >= ins.seq)
      if (firstAfter && firstAfter.id !== p.id) {
        plan.notes.push(note('penaltyNotNext', { score: formatScore(entryScore(entry), team, ctx), team: teamLabel(team, ctx)?.name || '?' }, t))
      }
    }
  }
  if (type === 'improper_request') plan.notes.push(note('irBox', { letter: teamLetter(team, ctx.match) }, t))

  const row = newRow(ctx, { type: 'sanction', setIndex, seq: ins.seq, ts: ins.ts, payload })
  plan.add = [row]
  plan.update = renumberUpdates(ins)
  return done(events, finishPlan(plan, events, ctx, 'addSanction', row), ctx)
}

/**
 * Remove a sanction. A penalty's point stays (now a normal rally point)
 * unless `removePoint` and that point is still the last point of the set
 * being played, in which case its whole group goes, as Undo would.
 */
export function planRemoveSanction(events, id, { removePoint = false } = {}, ctx = {}) {
  const ev = (events || []).find(e => e.id === id)
  if (!ev) return fail('notFound')
  const plan = emptyPlan()
  plan.remove = [id]
  const type = ev.payload?.type
  const setIndex = setOf(ev)
  if (awardsPoint(type)) {
    const p = nextPointOf(events, setIndex, otherTeam(ev.payload?.team), baseOf(ev) + 1)
    if (removePoint && p) {
      const points = setEvents(events, setIndex).filter(e => e.type === 'point')
      const isLast = points[points.length - 1]?.id === p.id
      if (ctx.mode !== 'live' || ctx.liveSetIndex !== setIndex || !isLast || setIsFinished(events, setIndex)) {
        return fail('removePointNotLast')
      }
      plan.remove.push(...pointGroupIds(events, p))
      plan.affectedSets = [setIndex]
    } else if (p) {
      plan.notes.push(note('pointStays', {}, ctx.t))
    }
  }
  plan.remove = [...new Set(plan.remove)]
  return done(events, finishPlan(plan, events, ctx, 'removeSanction', ev), ctx)
}

/** A point and everything it wrote (N.x rows), plus the rally start before it. */
export function pointGroupIds(events, point) {
  const ids = entryGroupIds(events, point)
  const before = setEvents(events, setOf(point)).filter(e => compareBySeq(e, point) < 0)
  for (let i = before.length - 1; i >= 0; i--) {
    const e = before[i]
    if (e.type === 'rally_start') { ids.push(e.id); break }
    if (e.type === 'point') break
  }
  return [...new Set(ids)]
}

// ─────────────────────── edit / move (generic) ───────────────────────

function planRemoveAny(events, id, ctx) {
  const ev = (events || []).find(e => e.id === id)
  if (!ev) return fail('notFound')
  if (ev.type === 'substitution') return planRemoveSubstitution(events, id, ctx)
  if (ev.type === 'sanction') return planRemoveSanction(events, id, {}, ctx)
  if (ev.type === 'timeout') return planRemoveTimeout(events, id, ctx)
  return fail('useUndo')
}

/**
 * Edit a time-out, substitution or sanction: remove it and add it again with
 * the new values (set, score, team, players, type, target), validated as a
 * new entry; the original row keeps its id (an in-place update with the new
 * seq / ts / set / payload).
 * values: the fields of the matching planAdd* call.
 * Every other entry is edited with planEditEntry.
 */
export function planEditEvent(events, id, values = {}, ctx = {}) {
  const ev = (events || []).find(e => e.id === id)
  if (!ev) return fail('notFound')
  if (!['timeout', 'substitution', 'sanction'].includes(ev.type)) return planEditEntry(events, id, values, ctx)
  const raw = { ...ctx, raw: true }
  const removal = planRemoveAny(events, id, raw)
  if (removal.error) return removal
  const without = applyPlanToEvents(events, removal)
  const v = { setIndex: setOf(ev), team: ev.payload?.team, ...values }
  let addition
  if (ev.type === 'timeout') addition = planAddTimeout(without, v, raw)
  else if (ev.type === 'substitution') addition = planAddSubstitution(without, v, raw)
  else addition = planAddSanction(without, { pointAlreadyGiven: true, ...v }, raw)
  if (addition.error) return addition

  // Keep the original row: its replacement becomes an update of it
  const merged = mergePlans(removal, addition)
  const replacement = merged.add.find(r => r.type === ev.type)
  merged.add = merged.add.filter(r => r !== replacement)
  merged.remove = merged.remove.filter(x => x !== id)
  merged.update = merged.update.filter(u => u.id !== id)
  merged.update.push({ id, changes: { seq: replacement.seq, ts: replacement.ts, setIndex: replacement.setIndex, payload: replacement.payload } })
  merged.remarkRemove = removal.remarkRemove
  merged.remarkAdd = addition.remarkAdd
  // the removal's "point stays" note is about a removal; not shown on an edit
  merged.notes = addition.notes
  const after = applyPlanToEvents(events, merged)
  const from = describeEvent(ev, events, ctx)?.text || ''
  merged.log = makeLog(`edit${ev.type[0].toUpperCase()}${ev.type.slice(1)}`, after.find(e => e.id === id), after, ctx, { from })
  return done(events, merged, ctx)
}

/** Move a time-out / substitution / sanction / libero replacement to another score (or set). */
export function planMoveEvent(events, id, { setIndex, at } = {}, ctx = {}) {
  const ev = (events || []).find(e => e.id === id)
  if (!ev) return fail('notFound')
  const p = ev.payload || {}
  const values = { setIndex, at }
  if (ev.type === 'substitution') Object.assign(values, { playerOut: p.playerOut, playerIn: p.playerIn, exceptional: !!p.isExceptional, reason: p.exceptionalReason || null })
  if (ev.type === 'sanction') Object.assign(values, { type: p.type, target: { playerType: p.playerType, playerNumber: p.playerNumber, role: p.role } })
  return planEditEvent(events, id, values, ctx)
}

/**
 * The plan that moves an entry with its N.x rows to another score: the rows
 * keep their ids (updates with the new seq, time and set), every later row
 * makes room as for an insertion.
 */
function relocate(events, ev, { setIndex, at, payload } = {}, ctx = {}) {
  const ids = new Set(entryGroupIds(events, ev))
  const group = (events || []).filter(e => ids.has(e.id)).sort(compareBySeq)
  const without = (events || []).filter(e => !ids.has(e.id))
  const tl = scoreTimeline(without, setIndex)
  if (!tl[at]) return fail('noSuchScore', { set: setNumber(setIndex, ctx) })
  const ins = insertionAt(without, setIndex, at, tl)
  const plan = emptyPlan()
  plan.update = renumberUpdates(ins)
  for (const row of group) {
    const frac = Math.round(((row.seq || 0) - baseOf(row)) * 1000) / 1000
    const changes = { seq: Math.round((ins.seq + frac) * 1000) / 1000, ts: ins.ts, setIndex }
    if (row.id === ev.id && payload) changes.payload = payload
    plan.update.push({ id: row.id, changes })
  }
  return plan
}

// The number fields of each entry the generic editor changes, with how the
// form offers them (a player on court, a libero, any player of the roster)
export const ENTRY_FIELDS = Object.freeze({
  libero_entry: [{ key: 'liberoIn', pick: 'libero' }, { key: 'playerOut', pick: 'onCourt' }],
  libero_exit: [],
  libero_exchange: [{ key: 'liberoIn', pick: 'libero' }],
  libero_unable: [{ key: 'liberoNumber', pick: 'libero' }],
  libero_redesignation: [{ key: 'newLiberoNumber', pick: 'player' }],
  court_captain_designation: [{ key: 'playerNumber', pick: 'player' }],
  bench_injury: [{ key: 'playerNumber', pick: 'player' }]
})

// Entries the generic editor can move to another score
const MOVABLE = new Set(['libero_entry', 'libero_exit', 'libero_exchange', 'libero_unable', 'libero_redesignation', 'court_captain_designation', 'bench_injury'])

/** The team's game captain designation in force (its latest one), or null. */
function latestDesignation(events, team) {
  return (events || []).filter(e => e.type === 'court_captain_designation' && e.payload?.team === team).sort(compareBySeq).pop() || null
}

const courtCaptainField = (team) => (team === 'home' ? 'homeCourtCaptain' : 'awayCourtCaptain')

/**
 * Edit any other entry: its number fields (ENTRY_FIELDS), and where it
 * makes sense its score (setIndex + at: a libero replacement, a game
 * captain). The line-ups after it are rebuilt (a libero entered for another
 * player: the exit brings that one back).
 * values: { [field]: number, setIndex?, at? }
 */
export function planEditEntry(events, id, values = {}, ctx = {}) {
  const ev = (events || []).find(e => e.id === id)
  if (!ev) return fail('notFound')
  const fields = ENTRY_FIELDS[ev.type]
  if (!fields) return fail('useUndo')
  const p = ev.payload || {}
  const payload = { ...p }
  for (const f of fields) {
    if (!(f.key in values)) continue
    const v = values[f.key]
    if (!hasNumber(v)) return fail('chooseNumber')
    payload[f.key] = typedLike(p[f.key] ?? 0, v)
  }
  if (ev.type === 'libero_entry' && sameNumber(payload.liberoIn, payload.playerOut)) return fail('samePlayer')
  if (ev.type === 'libero_exchange' && sameNumber(payload.liberoIn, p.liberoOut)) return fail('samePlayer')
  const moving = MOVABLE.has(ev.type) && values.at != null
  let plan
  if (moving) {
    plan = relocate(events, ev, { setIndex: values.setIndex ?? setOf(ev), at: values.at, payload }, ctx)
    if (plan.error) return plan
  } else {
    plan = emptyPlan()
    plan.update = [{ id, changes: { payload } }]
  }
  const changedFields = fields.some(f => String(p[f.key] ?? '') !== String(payload[f.key] ?? ''))
  if (!changedFields && !moving) return fail('noScoreChange')

  // Its remark line names its players ("#12 re-designated as Libero ...",
  // "#4 injured (bench)"): it follows them, where it stands in the remarks
  const renamed = new Map(fields
    .filter(f => hasNumber(p[f.key]) && !sameNumber(p[f.key], payload[f.key]))
    .map(f => [String(p[f.key]), String(payload[f.key])]))
  if (renamed.size && typeof p.autoRemark === 'string') {
    const text = renumberRemarkText(p.autoRemark, renamed)
    if (text !== p.autoRemark) {
      payload.autoRemark = text
      plan.remarkReplace = [{ from: p.autoRemark, to: text }]
    }
  } else if (renamed.size && ev.type === 'bench_injury') {
    const [line] = benchInjuryLines(p.team, [p.playerNumber], ctx)
    if (line) plan.remarkReplace = [{ from: line, to: renumberRemarkText(line, renamed) }]
  }

  // The game captain in force follows its designation
  if (ev.type === 'court_captain_designation' && (p.team === 'home' || p.team === 'away')) {
    const latest = latestDesignation(events, p.team)
    const field = courtCaptainField(p.team)
    if (latest?.id === id && sameNumber(ctx.match?.[field], p.playerNumber)) {
      plan.matchPatch = { [field]: typedLike(ctx.match[field], payload.playerNumber) }
    }
  }
  // A re-designated libero: the roster's libero mark moves to the new player
  if (ev.type === 'libero_redesignation' && !sameNumber(p.newLiberoNumber, payload.newLiberoNumber)) {
    const roster = rosterOfCtx(ctx, p.team)
    const oldP = roster.find(x => sameNumber(x.number, p.newLiberoNumber))
    const newP = roster.find(x => sameNumber(x.number, payload.newLiberoNumber))
    plan.playerUpdates = []
    if (oldP?.id != null) plan.playerUpdates.push({ id: oldP.id, changes: { libero: p.previousLiberoFlags?.newLibero?.libero ?? '' } })
    if (newP?.id != null) plan.playerUpdates.push({ id: newP.id, changes: { libero: 'redesignated' } })
    if (newP?.id != null) {
      payload.previousLiberoFlags = { ...(p.previousLiberoFlags || {}), newLibero: { id: newP.id, libero: newP.libero ?? '' } }
    }
  }
  const after = applyPlanToEvents(events, plan)
  const from = describeEvent(ev, events, ctx)?.text || ''
  plan.log = makeLog(`edit${camel(ev.type)}`, after.find(e => e.id === id), after, ctx, { from })
  if (setHasPointAfter(events, ev)) plan.notes.push(note('recalculated', {}, ctx.t))
  return done(events, plan, ctx)
}

function camel(type) {
  return String(type).split('_').map(w => w[0].toUpperCase() + w.slice(1)).join('')
}

function rosterOfCtx(ctx, team) {
  return (team === 'home' ? ctx?.players?.home : ctx?.players?.away) || []
}

// "Set 3, 14:28, B 15:5, #4 injured (bench)": the remark line the bench
// injury button writes. Entries written before the event carried its line
// (payload.autoRemark) are found by it: their team's letter and number.
const BENCH_INJURY_LINE = /^Set \d+, \d{1,2}:\d{2}, ([AB]) \d+:\d+, #(\d{1,2}) injured \(bench\)$/

/** The remark lines of a team's bench injuries of `numbers` (entries without autoRemark). */
function benchInjuryLines(team, numbers, ctx) {
  const letter = teamLetter(team, ctx?.match)
  const wanted = new Set([...(numbers || [])].map(String))
  if (!letter || !wanted.size) return []
  return String(ctx?.match?.remarks || '').split('\n').filter(line => {
    const m = line.match(BENCH_INJURY_LINE)
    return !!m && m[1] === letter && wanted.has(m[2])
  })
}

/** The bench-injury numbers of a team's entries that do not carry their remark line. */
function benchInjuriesWithoutRemark(events, team) {
  return (events || [])
    .filter(e => e.type === 'bench_injury' && e.payload?.team === team && typeof e.payload?.autoRemark !== 'string' && hasNumber(e.payload?.playerNumber))
    .map(e => String(e.payload.playerNumber))
}

function setHasPointAfter(events, ev) {
  return (events || []).some(e => e.type === 'point' && setOf(e) === setOf(ev) && compareBySeq(e, ev) > 0)
}

/**
 * Give a point to the other team (the point stays where it is): the old
 * team's rotation goes, the new team's is written if it won the serve, and
 * every rotation, serve and score after it follows (finalizePlan). A set
 * whose result changes is listed, not refused.
 */
export function planSetPointTeam(events, id, team, ctx = {}) {
  const ev = (events || []).find(e => e.id === id)
  if (!ev || ev.type !== 'point') return fail('notFound')
  if (team !== 'home' && team !== 'away') return fail('chooseTarget')
  if (ev.payload?.team === team) return fail('noScoreChange')
  const plan = emptyPlan()
  plan.remove = pointSubEventsForTeam(events, ev, ev.payload?.team).map(e => e.id)
  plan.update = [{ id, changes: { payload: { ...ev.payload, team } } }]
  plan.affectedSets = [setOf(ev)]
  const after = applyPlanToEvents(events, plan)
  plan.log = makeLog('editPoint', after.find(e => e.id === id), after, ctx, { from: describeEvent(ev, events, ctx)?.text || '' })
  if (setHasPointAfter(events, ev)) plan.notes.push(note('recalculated', {}, ctx.t))
  return done(events, plan, ctx)
}

const isEnteredLineup = (e) => {
  const p = e?.payload || {}
  return e?.type === 'lineup' && typeof p.isInitial === 'boolean' && !p.fromSubstitution && !p.fromRotation &&
    (p.liberoSubstitution === undefined || p.liberoSubstitution === null)
}

/**
 * The line-up row holding a team's starting line-up of a set, as the
 * scoresheet reads it (scoresheetModel getStartingLineupEvent): the latest
 * entered line-up before the set's first point, else the first starting one.
 */
export function startingLineupEvent(events, setIndex, team) {
  const rows = setEvents(events, setIndex).filter(e => e.type === 'lineup' && e.payload?.team === team)
  const firstPoint = setEvents(events, setIndex).find(e => e.type === 'point')
  const pre = rows.filter(e => isEnteredLineup(e) && (!firstPoint || compareBySeq(e, firstPoint) < 0))
  if (pre.length) return pre[pre.length - 1]
  return rows.find(e => e.payload?.isInitial === true) || null
}

function lineupText(lineup) {
  return POSITIONS.map(pos => (hasNumber(lineup?.[pos]) ? lineup[pos] : '?')).join(' · ')
}

/**
 * Set a line-up: the starting line-up of a set (also after rallies were
 * played: everything after it is rebuilt) or, with `id`, a line-up
 * corrected later in the set. Six different players are needed; a libero
 * in it is a warning.
 */
export function planSetLineup(events, { setIndex, team, lineup, id = null } = {}, ctx = {}) {
  if (team !== 'home' && team !== 'away') return fail('chooseTarget')
  const seen = new Set()
  for (const pos of POSITIONS) {
    const n = lineup?.[pos]
    if (!hasNumber(n)) return fail('lineupIncomplete')
    if (seen.has(String(n))) return fail('lineupDuplicate', { n })
    seen.add(String(n))
  }
  const target = id != null ? (events || []).find(e => e.id === id) : startingLineupEvent(events, setIndex, team)
  if (id != null && (!target || target.type !== 'lineup')) return fail('notFound')
  const plan = emptyPlan()
  const liberos = ctx.liberos?.[team] || rosterOfCtx(ctx, team).filter(x => x.libero).map(x => x.number)
  for (const pos of POSITIONS) {
    if (liberos.some(n => sameNumber(n, lineup[pos]))) plan.notes.push(note('liberoInLineup', { n: lineup[pos] }, ctx.t))
  }
  const set = setIndex ?? setOf(target)
  let row
  if (target) {
    const old = target.payload?.lineup || {}
    const next = {}
    for (const pos of POSITIONS) next[pos] = typedLike(old[pos] ?? 0, lineup[pos])
    if (POSITIONS.every(pos => String(old[pos] ?? '') === String(next[pos]))) return fail('noScoreChange')
    plan.update = [{ id: target.id, changes: { payload: { ...target.payload, lineup: next } } }]
    row = target
  } else {
    // no line-up yet in this set: a starting line-up before its first rally
    const tl = scoreTimeline(events, set)
    const ins = tl.length ? insertionAt(events, set, 0, tl) : { seq: Math.floor(Math.max(0, ...(events || []).map(e => e.seq || 0))) + 1, ts: new Date().toISOString(), renumber: [] }
    row = newRow(ctx, { type: 'lineup', setIndex: set, seq: ins.seq, ts: ins.ts, payload: { team, lineup: Object.fromEntries(POSITIONS.map(pos => [pos, Number(lineup[pos])])), isInitial: true } })
    plan.add = [row]
    plan.update = renumberUpdates(ins)
  }
  const after = applyPlanToEvents(events, plan)
  const now = after.find(e => e.id === (row.tempKey || row.id))
  const what = describeEvent(now, after, ctx)?.text || ''
  const label = teamLabel(team, ctx)?.name || '?'
  const from = target ? lineupText(target.payload?.lineup) : ''
  let text = target
    ? tr(ctx.t, 'corrections.log.lineupChanged', 'Line-up of {{team}} in set {{set}} changed: {{from}} → {{to}}', { team: label, set: setNumber(set, ctx), from, to: lineupText(lineup) })
    : tr(ctx.t, 'corrections.log.added', 'Added: {{what}}', { what })
  if (ctx.mode === 'review') text += tr(ctx.t, 'corrections.log.afterMatchSuffix', ' (entered after the match)')
  plan.log = { action: target ? 'editLineup' : 'addLineup', setIndex: set, team, before: from || null, after: what, text }
  if (setEvents(events, set).some(e => e.type === 'point')) plan.notes.push(note('recalculated', {}, ctx.t))
  return done(events, plan, ctx)
}

/** "VC Smash (A)" */
function nameWithLetter(team, ctx) {
  const lbl = teamLabel(team, ctx)
  return lbl ? tr(ctx?.t, 'corrections.teamWithLetter', '{{name}} ({{letter}})', { name: lbl.name, letter: lbl.letter }) : '?'
}

/**
 * Correct the coin toss: which team is A (the labels only, nothing moves:
 * domain/coinToss swapTeamDesignation) and which team serves first in set 1
 * (and so in sets 2-4). The rotations of every set are rebuilt for the new
 * serve order (finalizePlan reads the match after plan.matchPatch).
 */
export function planCoinToss(events, { teamA, firstServe } = {}, ctx = {}) {
  const match = ctx.match || {}
  let patch = {}
  const curA = match.coinTossTeamA === 'away' ? 'away' : 'home'
  if ((teamA === 'home' || teamA === 'away') && teamA !== curA) {
    patch = swapTeamDesignationPatch(match, { currentSetIndex: ctx.liveSetIndex ?? lastSetOf(events) })
  }
  const m2 = { ...match, ...patch }
  const curServe = m2.firstServe || 'home'
  if ((firstServe === 'home' || firstServe === 'away') && firstServe !== curServe) {
    patch.firstServe = firstServe
    patch.coinTossServeA = firstServe === (m2.coinTossTeamA || 'home')
    patch.coinTossServeB = !patch.coinTossServeA
  }
  if (!Object.keys(patch).length) return fail('noScoreChange')
  const m3 = { ...m2, ...patch }
  const a = m3.coinTossTeamA || 'home'
  const b = a === 'home' ? 'away' : 'home'
  const serve = m3.firstServe || 'home'
  const plan = emptyPlan()
  plan.matchPatch = patch
  // The cloud's coin_toss column (as the coin toss writes it); set 5's toss
  // reaches the server through its set5_coin_toss event (backupManager
  // set5TossFromEvents), the matches table has no set5 column: an unknown
  // column refuses the whole update
  plan.cloudMatch = {
    coin_toss: { team_a: a, team_b: b, serve_a: serve === a, confirmed: true, first_serve: serve }
  }
  const ct = (events || []).find(e => e.type === 'coin_toss')
  if (ct) plan.update = [{ id: ct.id, changes: { payload: { ...ct.payload, teamA: a, teamB: b, serveA: serve === a, serveB: serve !== a, firstServe: serve } } }]
  const lctx = { ...ctx, match: m3 }
  let text = tr(ctx.t, 'corrections.log.coinToss', 'Coin toss corrected: Team A is {{teamA}}, {{serve}} serves first', {
    teamA: teamLabel(a, lctx)?.name || '?', serve: nameWithLetter(serve, lctx)
  })
  if (ctx.mode === 'review') text += tr(ctx.t, 'corrections.log.afterMatchSuffix', ' (entered after the match)')
  plan.log = {
    action: 'coinToss', setIndex: null, team: null,
    before: { teamA: curA, firstServe: match.firstServe || 'home' },
    after: { teamA: a, firstServe: serve },
    text
  }
  if (patch.firstServe && (events || []).some(e => e.type === 'point')) plan.notes.push(note('recalculated', {}, ctx.t))
  return done(events, plan, ctx)
}

/**
 * Correct the coin toss of the deciding set: who serves first in it ('A' /
 * 'B'). Its rotations are rebuilt.
 */
export function planSet5CoinToss(events, { firstServe } = {}, ctx = {}) {
  const match = ctx.match || {}
  if (firstServe !== 'A' && firstServe !== 'B') return fail('chooseTarget')
  const cur = match.set5FirstServe || 'A'
  if (cur === firstServe) return fail('noScoreChange')
  const plan = emptyPlan()
  plan.matchPatch = { set5FirstServe: firstServe }
  // (no match column: the server reads it from the set5_coin_toss event updated below)
  const a = match.coinTossTeamA || 'home'
  const serveKey = firstServe === 'A' ? a : (a === 'home' ? 'away' : 'home')
  const ct = (events || []).find(e => e.type === 'set5_coin_toss')
  if (ct) plan.update = [{ id: ct.id, changes: { payload: { ...ct.payload, firstServe, firstServeTeamKey: serveKey } } }]
  let text = tr(ctx.t, 'corrections.log.set5CoinToss', 'Coin toss of the deciding set corrected: {{serve}} serves first', { serve: nameWithLetter(serveKey, ctx) })
  if (ctx.mode === 'review') text += tr(ctx.t, 'corrections.log.afterMatchSuffix', ' (entered after the match)')
  plan.log = { action: 'set5CoinToss', setIndex: 5, team: null, before: { set5FirstServe: cur }, after: { set5FirstServe: firstServe }, text }
  if ((events || []).some(e => e.type === 'point' && setOf(e) === 5)) plan.notes.push(note('recalculated', {}, ctx.t))
  return done(events, plan, ctx)
}

function lastSetOf(events) {
  return Math.max(1, ...(events || []).map(setOf))
}

/**
 * The game captain of a team (FIVB 5.2: when the team captain is not on
 * court): the latest designation gets the new number, or a designation is
 * added at the current score of the set being played; the match's game
 * captain follows.
 */
export function planGameCaptain(events, { team, number } = {}, ctx = {}) {
  if (team !== 'home' && team !== 'away') return fail('chooseTarget')
  if (!hasNumber(number)) return fail('chooseNumber')
  const field = courtCaptainField(team)
  const latest = latestDesignation(events, team)
  if (latest) {
    if (sameNumber(latest.payload?.playerNumber, number)) return fail('noScoreChange')
    const plan = planEditEntry(events, latest.id, { playerNumber: number }, { ...ctx, raw: true })
    if (plan.error) return plan
    plan.matchPatch = { ...(plan.matchPatch || {}), [field]: typedLike(ctx.match?.[field] ?? 0, number) }
    return done(events, plan, ctx)
  }
  const setIndex = ctx.liveSetIndex ?? lastSetOf(events)
  const tl = scoreTimeline(events, setIndex)
  if (!tl.length) return fail('noSuchScore', { set: setNumber(setIndex, ctx) })
  const ins = insertionAt(events, setIndex, tl.length - 1, tl)
  const row = newRow(ctx, { type: 'court_captain_designation', setIndex, seq: ins.seq, ts: ins.ts, payload: { team, playerNumber: Number(number), previousCourtCaptain: ctx.match?.[field] ?? null } })
  const plan = emptyPlan()
  plan.add = [row]
  plan.update = renumberUpdates(ins)
  plan.matchPatch = { [field]: Number(number) }
  return done(events, finishPlan(plan, events, ctx, 'addGameCaptain', row), ctx)
}

/**
 * What a removed entry wrote outside the log, put back (as the scoreboard's
 * Undo does, reverseEventSideEffects): its remark line, the game captain it
 * designated, the libero marks of a re-designation.
 */
function removalSideEffects(events, removed, ctx) {
  const out = { remarkRemove: [], matchPatch: {}, playerUpdates: [] }
  const list = [...removed].sort((a, b) => compareBySeq(b, a))
  for (const e of list) if (e.payload?.autoRemark) out.remarkRemove.push(e.payload.autoRemark)
  // a bench injury written before its entry carried its remark line
  for (const e of list) {
    if (e.type !== 'bench_injury' || typeof e.payload?.autoRemark === 'string') continue
    const [line] = benchInjuryLines(e.payload?.team, [e.payload?.playerNumber], ctx).filter(l => !out.remarkRemove.includes(l))
    if (line) out.remarkRemove.push(line)
  }
  for (const e of list) {
    const team = e.payload?.team
    if (team !== 'home' && team !== 'away') continue
    if ((e.type === 'lineup' || e.type === 'court_captain_designation') && Object.prototype.hasOwnProperty.call(e.payload, 'previousRememberedCourtCaptain')) {
      out.matchPatch[team === 'home' ? 'homeRememberedCourtCaptain' : 'awayRememberedCourtCaptain'] = e.payload.previousRememberedCourtCaptain ?? null
    }
    if (e.type === 'court_captain_designation' && latestDesignation(events, team)?.id === e.id) {
      out.matchPatch[courtCaptainField(team)] = e.payload.previousCourtCaptain ?? null
    }
    if (e.type === 'libero_redesignation' && e.payload?.previousLiberoFlags) {
      const { unableLibero, newLibero } = e.payload.previousLiberoFlags
      if (unableLibero?.id != null) out.playerUpdates.push({ id: unableLibero.id, changes: { libero: unableLibero.libero } })
      if (newLibero?.id != null) out.playerUpdates.push({ id: newLibero.id, changes: { libero: newLibero.libero } })
    }
  }
  return out
}

// ──────────────────────── final score (review) ───────────────────────

function isValidFinalScore(winnerPts, loserPts, setIndex) {
  const toWin = isDecidingSet(setIndex) ? 15 : 25
  return (winnerPts === toWin && loserPts <= toWin - 2) || (winnerPts > toWin && winnerPts - loserPts === 2)
}

/**
 * Correct the final score of a finished set by one point, at the END of the
 * set only (the Swiss course: missed points in the middle generally cannot be
 * fixed). +1 adds a point (with the side-out rotation and the automatic
 * libero exit at the front row): for the loser just before the winning point
 * (which becomes a side-out), otherwise at the end, before the set end; -1
 * removes the team's last point if it is the set's last point. Refused when
 * the set winner would change or the result is not a possible final score.
 */
export function planAdjustFinalScore(events, sets, { setIndex, team, delta } = {}, ctx = {}) {
  const set = setNumber(setIndex, ctx)
  const row = (sets || []).find(s => s.index === setIndex)
  if (!row?.finished && !setIsFinished(events, setIndex)) return fail('setNotFinished', { set })
  if (team !== 'home' && team !== 'away') return fail('chooseTarget')
  if (delta !== 1 && delta !== -1) return fail('noScoreChange')
  const cur = scoreFromPointEvents(events, setIndex)
  const curWinner = getSetResult(cur.homePoints, cur.awayPoints, setIndex).winner ||
    (row ? (row.homePoints > row.awayPoints ? 'home' : row.awayPoints > row.homePoints ? 'away' : null) : null)
  const next = { home: cur.homePoints, away: cur.awayPoints }
  next[team] += delta
  if (next[team] < 0) return fail('noScoreChange')
  const res = getSetResult(next.home, next.away, setIndex)
  if (!res.winner || res.winner !== curWinner) return fail('winnerWouldChange', { set })
  const w = res.winner
  if (!isValidFinalScore(next[w], next[otherTeam(w)], setIndex)) {
    return fail('invalidFinalScore', { set, score: formatScore(next, null, ctx) })
  }

  const plan = emptyPlan()
  plan.affectedSets = [setIndex]
  const points = setEvents(events, setIndex).filter(e => e.type === 'point')
  if (delta === -1) {
    const last = points[points.length - 1]
    if (!last || last.payload?.team !== team) return fail('notLastPoint', { set, team: teamLabel(team, ctx)?.name || '?' })
    plan.remove = pointGroupIds(events, last)
    return done(events, finishPlan(plan, events, ctx, 'removePoint', last), ctx)
  }

  // The set's last point is the winner's set point. A missed point of the
  // LOSER was played before it: it goes in just before the winning point
  // (25:20 -> 24:20, 24:21, 25:21), never after the set was already won.
  const tl = scoreTimeline(events, setIndex)
  const last = points[points.length - 1]
  const beforeWinning = team !== w && last && last.payload?.team === w && tl.length >= 2
  const atIdx = beforeWinning ? tl.length - 2 : tl.length - 1
  const ins = insertionAt(events, setIndex, atIdx, tl)
  if (!ins) return fail('noSuchScore', { set })
  const prevPoint = beforeWinning ? points[points.length - 2] : last
  const server = prevPoint ? prevPoint.payload?.team : getFirstServeForSet(setIndex, ctx.match || {})
  const at = entryScore(tl[atIdx])
  const scoreAfter = { ...at, [team]: at[team] + 1 }
  const point = newRow(ctx, { type: 'point', setIndex, seq: ins.seq, ts: ins.ts, payload: { team, score: scoreAfter } })
  plan.add = [point]
  if (server !== team) plan.add.push(...rotationRows(events, setIndex, team, ins.seq, ins.ts, ctx))
  const updates = new Map(renumberUpdates(ins).map(u => [u.id, u.changes]))

  if (beforeWinning) {
    // The winning point is now won against the serve of the team that just
    // scored: it becomes a side-out with its rotation (if it was not one).
    const winSeq = updates.get(last.id)?.seq ?? last.seq
    updates.set(last.id, { ...(updates.get(last.id) || {}), payload: { ...last.payload, score: { ...next } } })
    const hadRotation = (events || []).some(e => e.type === 'lineup' && baseOf(e) === baseOf(last) && e.seq !== last.seq && e.payload?.team === w)
    if (!hadRotation) {
      const subs = (events || []).filter(e => baseOf(e) === baseOf(last) && e.seq !== last.seq)
      const maxSub = subs.reduce((m, e) => Math.max(m, Math.round(((e.seq || 0) - baseOf(e)) * 10)), 0)
      // the rotation reads the winner's line-up before the winning point,
      // which the inserted point (of the other team) does not change
      plan.add.push(...rotationRows(events, setIndex, w, baseOf(last), last.ts, ctx, { base: Math.floor(winSeq), sub: maxSub + 1 }))
    }
  }
  plan.update = [...updates.entries()].map(([id, changes]) => ({ id, changes }))
  return done(events, finishPlan(plan, events, ctx, 'addPoint', point), ctx)
}

/**
 * The side-out rotation a point writes for `team` (its line-up rotated, and
 * the automatic libero exit when the libero would reach the front row), read
 * from the line-up in force before base seq `seq`. The rows are numbered
 * base.sub, base.(sub+1) — by default the new point's own seq.1 / seq.2.
 */
function rotationRows(events, setIndex, team, seq, ts, ctx, { base = seq, sub = 1 } = {}) {
  const lu = lineupBefore(events, setIndex, team, seq)
  const lineup = lu?.payload?.lineup
  if (!lineup) return []
  const rotated = rotateLineup(lineup)
  const ls = lu.payload?.liberoSubstitution
  let rotatedLs = null
  let exit = null
  const at = (k) => Math.round((base + k / 10) * 1000) / 1000
  if (ls) {
    const map = { I: 'VI', II: 'I', III: 'II', IV: 'III', V: 'IV', VI: 'V' }
    const pos = map[ls.position]
    if (FRONT_ROW.includes(pos)) {
      rotated[pos] = typedLike(rotated[pos], ls.playerNumber)
      exit = newRow(ctx, {
        type: 'libero_exit', setIndex, seq: at(sub + 1), ts,
        payload: { team, position: pos, liberoOut: ls.liberoNumber, playerIn: ls.playerNumber, liberoType: ls.liberoType, reason: 'rotation_to_front_row' }
      })
    } else if (pos) {
      rotatedLs = { ...ls, position: pos }
    }
  }
  const rows = [newRow(ctx, { type: 'lineup', setIndex, seq: at(sub), ts, payload: { team, lineup: rotated, liberoSubstitution: rotatedLs } })]
  if (exit) rows.push(exit)
  return rows
}

// ────────────────────────────── set times ─────────────────────────────

/**
 * Correct a finished set's start / end time: the set row and the set_end
 * payload. When the start is more than 5 minutes after the previous set's end
 * (or the scheduled time of day for set 1), a delayed-start remark is
 * SUGGESTED (never added silently, field-spec §5): plan.suggestedRemark.
 *
 * Set 1 of a match with a scheduled time (owner 2026-10-08): a start other
 * than the scheduled time of day is in the remarks as ONE line "Actual start
 * time: HH:MM" (the line the start dialog wrote is replaced; a start back on
 * the scheduled time removes it). `remarks` is the match's remarks text.
 */
export function planSetTimes(events, sets, { setIndex, startTime, endTime, scheduledAt = null, remarks = '' } = {}, ctx = {}) {
  const set = setNumber(setIndex, ctx)
  const row = (sets || []).find(s => s.index === setIndex)
  if (!row) return fail('notFound')
  const plan = emptyPlan()
  const changes = {}
  if (startTime !== undefined) changes.startTime = startTime
  if (endTime !== undefined) changes.endTime = endTime
  if (Object.keys(changes).length === 0) return fail('noScoreChange')
  const startAt = tsMs(changes.startTime ?? row.startTime)
  const endAt = tsMs(changes.endTime ?? row.endTime)
  if (startAt && endAt && endAt < startAt) return fail('endBeforeStart', { set })
  plan.setUpdates = [{ setIndex, changes }]
  const end = setEvents(events, setIndex).find(e => e.type === 'set_end')
  if (end) plan.update = [{ id: end.id, changes: { payload: { ...end.payload, ...changes } } }]

  if (changes.startTime) {
    const line = actualStartRemark({ setIndex, scheduledAt, startTime: changes.startTime })
    const existing = actualStartLines(remarks)
    if (setIndex === 1 && scheduledStartOnDay(scheduledAt) && !(line && existing.length === 1 && existing[0] === line)) {
      plan.remarkRemove = existing
      plan.remarkAdd = line ? [line] : []
    }
  }

  const prev = [...(sets || [])].filter(s => s.index < setIndex).sort((a, b) => b.index - a.index)[0]
  const startMs = tsMs(changes.startTime ?? row.startTime)
  // set 1: the scheduled time of day on the day the set was played, never the
  // scheduled date (a past date gave a delay of 827890 minutes)
  const ref = prev?.endTime || (setIndex === 1 && startMs ? scheduledStartOnDay(scheduledAt, new Date(startMs)) : null)
  const refMs = tsMs(ref)
  if (startMs && refMs) {
    const minutes = Math.round((startMs - refMs) / 60000)
    if (minutes > 5) {
      plan.suggestedRemark = remarkText('delayedStart', {
        set,
        time: remarkClock(new Date(startMs)),
        minutes,
        reason: '…'
      }, ctx.t)
    }
  }
  let text = tr(ctx.t, 'corrections.log.setTimes', 'Set {{set}} times corrected', { set })
  if (ctx.mode === 'review') text += tr(ctx.t, 'corrections.log.afterMatchSuffix', ' (entered after the match)')
  plan.log = { action: 'setTimes', setIndex, team: null, before: { startTime: row.startTime ?? null, endTime: row.endTime ?? null }, after: changes, text }
  return plan
}

// ───────────────────────────── line-up (live) ─────────────────────────────

/** Rotate a lineup one position backwards (the inverse of rotateLineup). */
export function rotateLineupBack(lineup) {
  if (!lineup) return null
  return { I: lineup.VI || '', II: lineup.I || '', III: lineup.II || '', IV: lineup.III || '', V: lineup.IV || '', VI: lineup.V || '' }
}

/**
 * Rotate a team one position forward / back at the current score (live): one
 * manual line-up event, as a pre-rally rectification writes it.
 */
export function planRotateTeam(events, { setIndex, team, direction = 1 } = {}, ctx = {}) {
  const tl = scoreTimeline(events, setIndex)
  if (!tl.length) return fail('noSuchScore', { set: setNumber(setIndex, ctx) })
  const ins = insertionAt(events, setIndex, tl.length - 1, tl)
  const lu = lineupBefore(events, setIndex, team, ins.seq)
  if (!lu?.payload?.lineup) return fail('noLineup', { set: setNumber(setIndex, ctx) })
  if (lu.payload?.liberoSubstitution) return fail('liberoOnCourtRotate')
  const lineup = direction >= 0 ? rotateLineup(lu.payload.lineup) : rotateLineupBack(lu.payload.lineup)
  const row = newRow(ctx, { type: 'lineup', setIndex, seq: ins.seq, ts: ins.ts, payload: { team, lineup, isInitial: false, mode: 'manual' } })
  const plan = emptyPlan()
  plan.add = [row]
  plan.update = renumberUpdates(ins)
  plan.before = lu.payload.lineup
  plan.after = lineup
  return done(events, finishPlan(plan, events, ctx, 'rotateTeam', row), ctx)
}

// ───────────────────────── player numbers ─────────────────────────

/**
 * Change a player's shirt number for the whole match (owner 2026-10-29):
 * the roster row, and every reference the match record holds — line-ups and
 * libero records, substitutions, libero replacements, sanctions, game
 * captains (and the numbers their undo puts back), injuries, the automatic
 * remark lines (rewritten where they stand), the snapshots the tablets were
 * shown — in one correction, logged for the referee. The scoresheet, the
 * PDF and the tablets read the new number from all of them.
 * Refused when the new number is another player's of the team, or already
 * appears in the team's record (two histories would merge).
 * values: { team, playerId?, from, to } (playerId: the roster row; from:
 * its number when the row is not known)
 */
export function planRenumberPlayer(events, { team, playerId = null, from = null, to } = {}, ctx = {}) {
  if (team !== 'home' && team !== 'away') return fail('chooseTarget')
  const roster = rosterOfCtx(ctx, team)
  const player = playerId != null ? roster.find(p => p.id === playerId) : roster.find(p => sameNumber(p.number, from))
  if (!player && !hasNumber(from)) return fail('noSuchPlayer')
  const old = player ? player.number : from
  if (!hasNumber(to) || !isShirtNumber(to)) return fail('invalidNumber')
  const next = String(Number(to))
  if (sameNumber(old, next)) return fail('sameNumber')
  const label = teamLabel(team, ctx)?.name || '?'
  const taken = roster.find(p => p !== player && sameNumber(p.number, next))
  if (taken) {
    const name = taken.name || [taken.firstName, taken.lastName].filter(Boolean).join(' ') || `#${next}`
    return fail('numberTaken', { n: next, name, team: label })
  }
  if (referencedPlayerNumbers(events, team).has(next)) return fail('numberInRecord', { n: next, team: label })

  return planRenumberPlayers(events, { team, renumbers: [{ from: String(old), to: next, playerId: player?.id ?? null }] }, ctx)
}

/**
 * The renumbering of one or more players of a team (already checked: the
 * Corrections form above, or the roster editor's validateReopenedRoster),
 * all at once so 5->12 and 12->... never chain.
 * values: { team, renumbers: [{ from, to, playerId? }] }
 */
export function planRenumberPlayers(events, { team, renumbers = [] } = {}, ctx = {}) {
  if (team !== 'home' && team !== 'away') return fail('chooseTarget')
  const list = (renumbers || []).filter(r => hasNumber(r?.from) && hasNumber(r?.to) && !sameNumber(r.from, r.to))
    .map(r => ({ ...r, from: String(r.from), to: String(Number(r.to)) }))
  if (!list.length) return fail('sameNumber')
  const roster = rosterOfCtx(ctx, team)
  const label = teamLabel(team, ctx)?.name || '?'
  const plan = emptyPlan()
  const map = new Map(list.map(r => [r.from, r.to]))
  const byId = new Map((events || []).map(e => [e.id, e]))
  for (const u of renumberPlayerInEvents(events, team, list)) {
    // the payload only when it changes (a point's stored snapshot alone often does)
    const changes = u.payload !== byId.get(u.id)?.payload ? { payload: u.payload } : {}
    if (u.stateSnapshot) changes.stateSnapshot = u.stateSnapshot
    plan.update.push({ id: u.id, changes })
    if (u.autoRemark) plan.remarkReplace.push(u.autoRemark)
  }
  // the remark line of a bench injury written before the entry carried it
  for (const line of benchInjuryLines(team, benchInjuriesWithoutRemark(events, team).filter(n => map.has(n)), ctx)) {
    const to = renumberRemarkText(line, map)
    if (to !== line && !plan.remarkReplace.some(r => r.from === line)) plan.remarkReplace.push({ from: line, to })
  }
  // the game captain in force and the one remembered for later
  const match = ctx.match || {}
  const patch = {}
  for (const f of team === 'home' ? ['homeCourtCaptain', 'homeRememberedCourtCaptain'] : ['awayCourtCaptain', 'awayRememberedCourtCaptain']) {
    const r = list.find(x => sameNumber(match[f], x.from))
    if (r) patch[f] = typeof match[f] === 'number' ? Number(r.to) : r.to
  }
  if (Object.keys(patch).length) plan.matchPatch = patch
  plan.playerUpdates = []
  for (const r of list) {
    const row = r.playerId != null ? roster.find(p => p.id === r.playerId) : roster.find(p => sameNumber(p.number, r.from))
    const id = r.playerId ?? row?.id
    if (id != null) plan.playerUpdates.push({ id, changes: { number: typeof row?.number === 'string' ? r.to : Number(r.to) } })
  }
  plan.renumber = { team, renumbers: list.map(({ from, to }) => ({ from, to })) }
  const sentence = list.map(r => tr(ctx.t, 'corrections.log.renumbered', 'Player #{{from}} of {{team}} renumbered to #{{to}}', { from: r.from, to: r.to, team: label })).join('; ')
  let text = sentence
  if (ctx.mode === 'review') text += tr(ctx.t, 'corrections.log.afterMatchSuffix', ' (entered after the match)')
  // before: the old numbers; after: the sentence (the preview shows it)
  plan.log = { action: 'renumberPlayer', setIndex: null, team, before: list.map(r => r.from).join(','), after: sentence, text }
  // the rebuild reads the roster with the new numbers
  const players = {
    ...(ctx.players || {}),
    [team]: roster.map(p => {
      const r = list.find(x => (x.playerId != null ? x.playerId === p.id : sameNumber(x.from, p.number)))
      return r ? { ...p, number: Number(r.to) } : p
    })
  }
  return done(events, plan, { ...ctx, players })
}

// ───────────────────────── advanced: event log ─────────────────────────

// Taken back with Reopen set (the set, the next set and the match result go
// with them), never removed here
const REOPEN_TYPES = ['set_end', 'forfait', 'match_stopped']
// A match always has its coin toss: corrected, never removed
const COIN_TOSS_TYPES = ['coin_toss', 'set5_coin_toss']

/**
 * True for a row the app writes itself and recalculates from the entries:
 * a point's rotation line-up and automatic libero exit, the line-up row of
 * a substitution / libero replacement, the set start (its time is a set
 * time). They follow the entry they belong to.
 */
export function isAutomaticEntry(ev, events = null) {
  if (!ev) return false
  if (ev.type === 'set_start') return true
  if (isRotationLiberoExit(ev)) return true
  if (ev.type === 'lineup' && (ev.seq || 0) !== baseOf(ev)) {
    // a line-up at N.x with no entry of its own at N is an entered one
    // (the line-up form numbers it after the last row)
    if (!events) return true
    return (events || []).some(e => e.id !== ev.id && e.seq === baseOf(ev))
  }
  return false
}

/**
 * How a row of the event log is corrected:
 *   remove: 'plan' (planRemoveEntry), 'reopen' (the Reopen set flow) or null
 *   edit:   the form that edits it, or null
 * Every entry the scorer wrote can be removed or corrected; only the rows
 * the app derives (isAutomaticEntry) are not, they follow their entry.
 */
export function entryActions(ev, events = null) {
  const none = { remove: null, edit: null, automatic: false }
  if (!ev) return none
  if (isAutomaticEntry(ev, events)) return { ...none, automatic: true, edit: ev.type === 'set_start' ? 'setTimes' : null }
  if (COIN_TOSS_TYPES.includes(ev.type)) return { ...none, edit: ev.type === 'coin_toss' ? 'coinToss' : 'set5CoinToss' }
  if (REOPEN_TYPES.includes(ev.type)) return { ...none, remove: 'reopen', edit: ev.type === 'set_end' ? 'setTimes' : null }
  let edit = null
  if (ev.type === 'timeout' || ev.type === 'substitution' || ev.type === 'sanction') edit = ev.type
  else if (ev.type === 'point') edit = 'point'
  else if (ev.type === 'lineup') edit = 'lineup'
  else if (ENTRY_FIELDS[ev.type]) edit = 'entry'
  return { remove: 'plan', edit, automatic: false }
}

/** True when the Advanced log offers Remove for this row (planRemoveEntry would not refuse it outright). */
export function isRemovableEntry(ev, events = null) {
  return entryActions(ev, events).remove === 'plan'
}

/**
 * Remove one entry of the log with everything that belongs to it (Advanced:
 * event log, and the cards). Time-outs, substitutions and sanctions use their
 * own planner; a point takes its N.x rows and the rally start before it; a
 * libero replacement its line-up row; a decision change gives the point back
 * to the team it was taken from. What follows is rebuilt (finalizePlan) and
 * what no longer fits is listed. A set end is taken back with Reopen set and
 * the coin toss is corrected, not removed.
 */
export function planRemoveEntry(events, id, ctx = {}) {
  const ev = (events || []).find(e => e.id === id)
  if (!ev) return fail('notFound')
  if (ev.type === 'timeout' || ev.type === 'substitution' || ev.type === 'sanction') return planRemoveAny(events, id, ctx)
  if (REOPEN_TYPES.includes(ev.type)) return fail('useReopen')
  if (COIN_TOSS_TYPES.includes(ev.type)) return fail('coinTossNotRemovable')
  if (isAutomaticEntry(ev, events)) return fail('automaticEntry')
  const plan = emptyPlan()
  const setIndex = setOf(ev)
  if (ev.type === 'point') {
    // A finished set may lose its result: listed (finalizePlan), not refused
    const setDone = setIsFinished(events, setIndex)
    if (setDone) {
      const cur = scoreFromPointEvents(events, setIndex)
      const next = { home: cur.homePoints, away: cur.awayPoints }
      const team = ev.payload?.team
      if (team === 'home' || team === 'away') next[team] -= 1
      const before = getSetResult(cur.homePoints, cur.awayPoints, setIndex).winner
      const res = getSetResult(next.home, next.away, setIndex)
      if (!res.winner || res.winner !== before) plan.notes.push(note('winnerWouldChange', { set: setNumber(setIndex, ctx) }, ctx.t))
      else if (!isValidFinalScore(next[res.winner], next[otherTeam(res.winner)], setIndex)) {
        plan.notes.push(note('invalidFinalScore', { set: setNumber(setIndex, ctx), score: formatScore(next, null, ctx) }, ctx.t))
      }
    }
    plan.remove = pointGroupIds(events, ev)
    plan.affectedSets = [setIndex]
    if (setHasPointAfter(events, ev)) plan.notes.push(note('recalculated', {}, ctx.t))
  } else if (ev.type === 'decision_change') {
    // the point goes back to the team the decision took it from
    const point = (events || []).find(e => e.id === ev.payload?.pointEventId && e.type === 'point')
    const back = ev.payload?.fromTeam
    plan.remove = [ev.id]
    if (point && (back === 'home' || back === 'away') && point.payload?.team !== back) {
      plan.remove.push(...pointSubEventsForTeam(events, point, point.payload?.team).map(e => e.id))
      plan.update = [{ id: point.id, changes: { payload: { ...point.payload, team: back } } }]
      plan.affectedSets = [setOf(point)]
    }
  } else {
    plan.remove = entryGroupIds(events, ev)
    if (setHasPointAfter(events, ev) && (ev.type === 'lineup' || ev.type.startsWith('libero_'))) plan.notes.push(note('recalculated', {}, ctx.t))
  }
  const removed = new Set(plan.remove)
  const fx = removalSideEffects(events, (events || []).filter(e => removed.has(e.id)), ctx)
  plan.remarkRemove = fx.remarkRemove
  if (Object.keys(fx.matchPatch).length) plan.matchPatch = fx.matchPatch
  if (fx.playerUpdates.length) plan.playerUpdates = fx.playerUpdates
  return done(events, finishPlan(plan, events, ctx, 'removeEntry', ev), ctx)
}

/** The former name of planRemoveEntry (Advanced: event log). */
export const planRemoveGroup = planRemoveEntry

/**
 * What a removal takes with it, as sentences for the confirmation
 * ("Removes: Point for VC Smash · A 12:10 B and its rotation").
 */
export function describeRemoval(events, plan, ctx = {}) {
  const removed = new Set(plan?.remove || [])
  return (events || [])
    .filter(e => removed.has(e.id))
    .sort(compareBySeq)
    .map(e => describeEvent(e, events, ctx)?.text)
    .filter(Boolean)
}
