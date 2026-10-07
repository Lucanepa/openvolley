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
 */
import {
  compareBySeq, tsMs, scoreBeforeEvent, formatScore, plainScore, teamLetter,
  displaySetNumber, describeEvent, remarkText, tr, sanctionLabel, otherTeam,
  isTeamSanctionType, teamLabel
} from './describe'
import { getSetResult, scoreFromPointEvents, getFirstServeForSet, isDecidingSet } from './rules'
import { rotateLineup } from './rotation'
import { validateManualTimeout, validateManualSubstitution, planSubstitutionDeletion } from './substitutions'
import { resolveSanction, isDelaySanction, awardsPoint, validateMemberSanction } from './sanctions'

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
  liberoNotSubstituted: '#{{n}} is a libero: a libero is not substituted. To correct a libero replacement, use Undo.',
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
  subEvent: 'This row belongs to another entry; remove that entry instead.',
  liberoOnCourtRotate: 'A libero is on court for this team: rotate after the libero has left the court.',
  removePointNotLast: 'The penalty point can only be removed while it is the last point of the set being played.',
  noScoreChange: 'Nothing to change.'
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
  afterMatch: 'Entered after the match.'
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
  return { add: [], update: [], remove: [], affectedSets: [], setUpdates: [], remarkAdd: [], remarkRemove: [], log: null, notes: [], followUp: null }
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
  out.notes = [...(a.notes || []), ...(b.notes || [])]
  out.log = b.log || a.log
  out.followUp = b.followUp || a.followUp
  return out
}

/** The event log after a plan (new rows get their temp key as id). Pure. */
export function applyPlanToEvents(events, plan) {
  const removed = new Set(plan?.remove || [])
  const upd = new Map()
  for (const u of plan?.update || []) upd.set(u.id, { ...(upd.get(u.id) || {}), ...u.changes })
  const kept = (events || [])
    .filter(e => !removed.has(e.id))
    .map(e => (upd.has(e.id) ? { ...e, ...upd.get(e.id) } : e))
  const added = (plan?.add || []).map(r => ({ ...r, id: r.id ?? r.tempKey }))
  return kept.concat(added).sort(compareBySeq)
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
  if (!validateManualTimeout(events, team, setIndex).legal) return fail('timeoutLimit', { set: setNumber(setIndex, ctx) })
  const ins = insertionAt(events, setIndex, at, tl)
  const row = newRow(ctx, { type: 'timeout', setIndex, payload: { team }, seq: ins.seq, ts: ins.ts })
  const plan = emptyPlan()
  plan.add = [row]
  plan.update = renumberUpdates(ins)
  return finishPlan(plan, events, ctx, 'addTimeout', row)
}

/** Remove a time-out (nothing else depends on it). */
export function planRemoveTimeout(events, id, ctx = {}) {
  const ev = (events || []).find(e => e.id === id)
  if (!ev) return fail('notFound')
  const plan = emptyPlan()
  plan.remove = [id]
  return finishPlan(plan, events, ctx, 'removeTimeout', ev)
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

  // A later record of this team in the set involving either player: the
  // remap would rewrite it into nonsense (same rule as the deletion).
  const involved = (n) => sameNumber(n, playerOut) || sameNumber(n, playerIn)
  const later = (events || []).filter(e => setOf(e) === setIndex && e.payload?.team === team && baseOf(e) >= ins.seq)
  const conflict = later.find(e =>
    (e.type === 'substitution' && (involved(e.payload?.playerIn) || involved(e.payload?.playerOut))) ||
    (e.type === 'libero_entry' && involved(e.payload?.playerOut)) ||
    (e.type === 'libero_exit' && involved(e.payload?.playerIn)) ||
    (e.type === 'lineup' && e.payload?.liberoSubstitution && involved(e.payload.liberoSubstitution.playerNumber))
  )
  if (conflict) return fail('laterConflict', { out: playerOut, in: playerIn })

  if (!exceptional) {
    const regular = (events || []).filter(e => !(e.type === 'substitution' && e.payload?.isExceptional))
    const v = validateManualSubstitution(regular, team, setIndex, playerOut, playerIn)
    if (!v.legal) {
      if (/limit/i.test(v.reason || '')) return fail('subLimit', { set })
      return fail('subRule', { reason: v.reason })
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

  const plan = emptyPlan()
  plan.add = [sub, lineupEv]
  const updates = new Map(renumberUpdates(ins).map(u => [u.id, u.changes]))
  for (const e of later) {
    if (e.type !== 'lineup') continue
    const lu = { ...(e.payload?.lineup || {}) }
    let changed = false
    for (const pos of Object.keys(lu)) {
      if (sameNumber(lu[pos], playerOut)) { lu[pos] = typedLike(lu[pos], playerIn); changed = true }
    }
    if (changed) updates.set(e.id, { ...(updates.get(e.id) || {}), payload: { ...e.payload, lineup: lu } })
  }
  plan.update = [...updates.entries()].map(([id, changes]) => ({ id, changes }))
  if (autoRemark) plan.remarkAdd = [autoRemark]
  return finishPlan(plan, events, ctx, 'addSubstitution', sub)
}

/** Remove a substitution: its line-up goes too and later line-ups are put back. */
export function planRemoveSubstitution(events, id, ctx = {}) {
  const ev = (events || []).find(e => e.id === id)
  if (!ev) return fail('notFound')
  const res = planSubstitutionDeletion(events, ev)
  if (res.blocked) return fail('laterConflict', { out: ev.payload?.playerOut ?? '?', in: ev.payload?.playerIn ?? '?' })
  const plan = emptyPlan()
  plan.remove = res.deleteIds
  plan.update = res.updates.map(u => ({ id: u.id, changes: { payload: u.payload } }))
  if (ev.payload?.autoRemark) plan.remarkRemove = [ev.payload.autoRemark]
  return finishPlan(plan, events, ctx, 'removeSubstitution', ev)
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
  const review = ctx.mode === 'review'
  const plan = emptyPlan()
  const issue = (key, params = {}) => {
    if (review) { plan.notes.push(note(key, params, t)); return null }
    return fail(key, params)
  }

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
  return finishPlan(plan, events, ctx, 'addSanction', row)
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
  return finishPlan(plan, events, ctx, 'removeSanction', ev)
}

/** A point and everything it wrote (N.x rows), plus the rally start before it. */
export function pointGroupIds(events, point) {
  const base = baseOf(point)
  const ids = (events || []).filter(e => baseOf(e) === base).map(e => e.id)
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
 */
export function planEditEvent(events, id, values = {}, ctx = {}) {
  const ev = (events || []).find(e => e.id === id)
  if (!ev) return fail('notFound')
  const removal = planRemoveAny(events, id, { ...ctx, mode: ctx.mode })
  if (removal.error) return removal
  const without = applyPlanToEvents(events, removal)
  const v = { setIndex: setOf(ev), team: ev.payload?.team, ...values }
  let addition
  if (ev.type === 'timeout') addition = planAddTimeout(without, v, ctx)
  else if (ev.type === 'substitution') addition = planAddSubstitution(without, v, ctx)
  else if (ev.type === 'sanction') addition = planAddSanction(without, { pointAlreadyGiven: true, ...v }, ctx)
  else return fail('useUndo')
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
  return merged
}

/** Move a time-out / substitution / sanction to another score (or set). */
export function planMoveEvent(events, id, { setIndex, at } = {}, ctx = {}) {
  const ev = (events || []).find(e => e.id === id)
  if (!ev) return fail('notFound')
  const p = ev.payload || {}
  const values = { setIndex, at }
  if (ev.type === 'substitution') Object.assign(values, { playerOut: p.playerOut, playerIn: p.playerIn, exceptional: !!p.isExceptional, reason: p.exceptionalReason || null })
  if (ev.type === 'sanction') Object.assign(values, { type: p.type, target: { playerType: p.playerType, playerNumber: p.playerNumber, role: p.role } })
  return planEditEvent(events, id, values, ctx)
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
    return finishPlan(plan, events, ctx, 'removePoint', last)
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
  return finishPlan(plan, events, ctx, 'addPoint', point)
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
 * (or the scheduled time for set 1), a delayed-start remark is SUGGESTED
 * (never added silently, field-spec §5): plan.suggestedRemark.
 */
export function planSetTimes(events, sets, { setIndex, startTime, endTime, scheduledAt = null } = {}, ctx = {}) {
  const set = setNumber(setIndex, ctx)
  const row = (sets || []).find(s => s.index === setIndex)
  if (!row) return fail('notFound')
  const plan = emptyPlan()
  const changes = {}
  if (startTime !== undefined) changes.startTime = startTime
  if (endTime !== undefined) changes.endTime = endTime
  if (Object.keys(changes).length === 0) return fail('noScoreChange')
  plan.setUpdates = [{ setIndex, changes }]
  const end = setEvents(events, setIndex).find(e => e.type === 'set_end')
  if (end) plan.update = [{ id: end.id, changes: { payload: { ...end.payload, ...changes } } }]

  const prev = [...(sets || [])].filter(s => s.index < setIndex).sort((a, b) => b.index - a.index)[0]
  const ref = prev?.endTime || (setIndex === 1 ? scheduledAt : null)
  const startMs = tsMs(changes.startTime ?? row.startTime)
  const refMs = tsMs(ref)
  if (startMs && refMs) {
    const minutes = Math.round((startMs - refMs) / 60000)
    if (minutes > 5) {
      const d = new Date(startMs)
      plan.suggestedRemark = remarkText('delayedStart', {
        set,
        time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
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
  return finishPlan(plan, events, ctx, 'rotateTeam', row)
}

// ───────────────────────── advanced: event log ─────────────────────────

const PROTECTED = ['set_end', 'set_start', 'coin_toss', 'set5_coin_toss', 'libero_entry', 'libero_exit', 'libero_exchange', 'libero_unable', 'libero_redesignation', 'decision_change', 'forfait', 'match_stopped']

/** True when the Advanced log offers Remove for this row (planRemoveGroup would not refuse it outright). */
export function isRemovableEntry(ev) {
  if (!ev || (ev.seq || 0) !== baseOf(ev)) return false
  if (ev.type === 'timeout' || ev.type === 'substitution' || ev.type === 'sanction') return true
  return !PROTECTED.includes(ev.type) && !(ev.type === 'lineup' && ev.payload?.isInitial)
}

/**
 * Remove one entry of the log with everything that belongs to it (Advanced:
 * event log). Time-outs, substitutions and sanctions use their own planner;
 * a point takes its N.x rows and the rally start before it. Set boundaries,
 * starting line-ups and libero records are refused (Reopen set, the line-up
 * tool or Undo correct those).
 */
export function planRemoveGroup(events, id, ctx = {}) {
  const ev = (events || []).find(e => e.id === id)
  if (!ev) return fail('notFound')
  if (ev.type === 'timeout' || ev.type === 'substitution' || ev.type === 'sanction') return planRemoveAny(events, id, ctx)
  if (PROTECTED.includes(ev.type) || (ev.type === 'lineup' && ev.payload?.isInitial)) return fail('useUndo')
  if ((ev.seq || 0) !== baseOf(ev)) return fail('subEvent')
  const plan = emptyPlan()
  if (ev.type === 'point') {
    // A finished set keeps a possible final score with the same winner (the
    // set end and the match result were certified on it), as "Correct final
    // score" does
    const setIndex = setOf(ev)
    if (setIsFinished(events, setIndex)) {
      const cur = scoreFromPointEvents(events, setIndex)
      const next = { home: cur.homePoints, away: cur.awayPoints }
      const team = ev.payload?.team
      if (team === 'home' || team === 'away') next[team] -= 1
      const before = getSetResult(cur.homePoints, cur.awayPoints, setIndex).winner
      const res = getSetResult(next.home, next.away, setIndex)
      if (!res.winner || res.winner !== before) return fail('winnerWouldChange', { set: setNumber(setIndex, ctx) })
      if (!isValidFinalScore(next[res.winner], next[otherTeam(res.winner)], setIndex)) {
        return fail('invalidFinalScore', { set: setNumber(setIndex, ctx), score: formatScore(next, null, ctx) })
      }
    }
    plan.remove = pointGroupIds(events, ev)
    plan.affectedSets = [setOf(ev)]
    const points = setEvents(events, setOf(ev)).filter(e => e.type === 'point')
    if (points[points.length - 1]?.id !== ev.id) plan.notes.push(note('laterRotations', {}, ctx.t))
  } else {
    plan.remove = (events || []).filter(e => baseOf(e) === baseOf(ev)).map(e => e.id)
  }
  const removed = new Set(plan.remove)
  plan.remarkRemove = (events || []).filter(e => removed.has(e.id) && e.payload?.autoRemark).map(e => e.payload.autoRemark)
  return finishPlan(plan, events, ctx, 'removeEntry', ev)
}

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
