/**
 * Going back in the game — pure planner, no React, no Dexie (owner
 * 2026-11-09: "make sure that in place there's something that makes you 'go
 * back' to a certain point in the game"; then, on the first version: "Isn't
 * it a little too much? Like when confirmed the error: make sure I can edit
 * stuff" and "i can still manually adjust score etc").
 *
 * ONE action, three answers and then everything editable:
 *   1. when: the score of the set being played where it went wrong;
 *   2. whose points since then are cancelled (team A, team B, or both) and
 *      who gets point and service (nobody, A, B);
 *   3. the result, all of it editable before play resumes: the score (by
 *      hand), who serves, both line-ups (a substitution taken back, a player
 *      put back), the remark on the scoresheet.
 *
 * What the rules say (FIVB Rules 2025-2028 = R, Casebook 2025 = CB), the
 * usual answers the panel offers as hints:
 *   - one team at fault, opponent gains point and service, "all points
 *     scored by the team at fault from the moment of the fault up to its
 *     discovery are cancelled; the opponent's points remain valid":
 *     illegal substitution found after play resumed (R15.9.2, 7.5.1, CB
 *     4.13), illegal libero replacement after the service (R19.3.2.9, CB
 *     5.7), positions not as on the line-up sheet (R7.3.5.3), a player not on
 *     the roster (R7.3.5.4, CB 4.22), wrong server found later (R7.7.1, 7.7.2;
 *     found right after the rally it started: one single point, 7.7.1.1, CB
 *     2.5; moment not known: only the point);
 *   - both teams, no point: the officials gave wrong information, or a rally
 *     was played with five or seven players (CB 2.3, 2.4): "the score is
 *     taken back to the point where the wrong information was given ... the
 *     already issued warnings/sanctions remain valid. This event must be
 *     recorded on the score sheet."
 *
 * HOW IT IS WRITTEN. A point of one team cancelled stays in the log as a
 * rally (type 'cancelled_point', domain/recompute isRally): the serve went
 * over and the team rotated, the opponent's players stayed where they are,
 * so both teams' rotations are kept and only the score changes. "Both" takes
 * the rallies since that score out (with their rotations: the teams go back
 * to their line-up of that moment); time-outs, substitutions, sanctions and
 * the points of penalties stay. The penalty point is an ordinary point with
 * its rotation. A score set by hand is reached by cancelling more of the
 * team's points (newest first), by not cancelling some, or by points
 * awarded by hand (payload.scoreAdjusted: no rally, no rotation, no serve):
 * the set score, the running score on the sheet and the scoreboard all
 * count the same point events. The head event 'rectification', the newest
 * entry of the set, carries who serves next (rules servingTeamFromLog), the
 * undo record and the remark (payload.autoRemark), so Undo (Scoreboard
 * undoEventTx) and Remove in the corrections take the whole of it back
 * (planRectificationReversal). Line-ups edited by hand are line-up rows of
 * the head (N.1, N.2), as a pre-rally rectification writes them.
 *
 * Out of scope: a fault found after the end of the set or the match (CB
 * 4.22: the set or the match is lost; Corrections and the referee), a
 * protest, the forfeits (the scorer's own flows: Stop the match, and the
 * set forfeit of the injury / expulsion dialogs).
 */
import { compareBySeq, formatScore, plainScore, teamLetter, displaySetNumber, tr, otherTeam, remarkPrefix, describeEvent } from './describe'
import { scoreFromPointEvents, getSetResult, servingTeamFromLog } from './rules'
import { finalizePlan, applyPlanToEvents, POSITIONS } from './recompute'
import { emptyPlan, scoreTimeline, entryGroupIds, pointGroupIds } from './manualCorrections'
import { penaltyOfPoint } from './sanctions'

const baseOf = (e) => Math.floor(e?.seq || 0)
const setOf = (e) => e?.setIndex ?? 1
const isTeam = (t) => t === 'home' || t === 'away'
const has = (n) => n !== undefined && n !== null && n !== '' && n !== '?'
const same = (a, b) => has(a) && has(b) && String(a) === String(b)

/** Whose points are cancelled: one team, or both (officials' mistake). */
export const CANCEL_CHOICES = Object.freeze(['home', 'away', 'both'])

const ERROR_DEFAULTS = {
  chooseMoment: 'Choose the score where it went wrong.',
  chooseCancel: 'Choose whose points are cancelled.',
  notLive: 'Only the set being played can be taken back here. For an earlier set, use Corrections and tell the referee.',
  setFinished: 'Set {{set}} is over. Use Corrections and tell the referee.',
  nothingToChange: 'Nothing changes: no point is cancelled or given.',
  lineupIncomplete: 'Choose a player for each of the six positions.',
  lineupDuplicate: '#{{n}} is chosen twice.',
  badScore: 'A score is a whole number from 0.',
  notFound: 'This entry no longer exists.',
  notLast: 'Rallies were played after this going back: take them back first.',
  laterRectification: 'A later going back in this set comes first: take it back first.'
}

const NOTE_DEFAULTS = {
  setWon: 'This score ends set {{set}}: confirm the set end next.',
  timeline: 'Time-outs, substitutions and sanctions after it stay; on the scoresheet they now show the corrected score.'
}

const REMARK_DEFAULTS = {
  since: 'fault since {{from}}',
  backOfficials: 'game taken back to {{from}} (officials\' mistake, Casebook 2.3)',
  cancelled: '{{n}} point(s) of team {{team}} cancelled',
  cancelledBoth: 'the rallies since then taken out, sanctions remain valid',
  penalty: 'point and service to team {{team}}',
  serve: 'team {{team}} to serve',
  subTakenBack: 'substitution #{{in}} for #{{out}} of team {{team}} taken back',
  after: 'score now {{score}}'
}

function fail(key, params = {}) {
  return { error: `rectify.error.${key}`, params, text: tr(null, '', ERROR_DEFAULTS[key] || key, params) }
}

/** The translated text of a planner error. */
export function rectifyErrorText(result, t) {
  if (!result?.error) return ''
  const key = result.error.replace(/^rectify\.error\./, '')
  return tr(t, result.error, ERROR_DEFAULTS[key] || result.text || key, result.params)
}

function note(key, params, t) {
  return { key: `rectify.note.${key}`, params, text: tr(t, `rectify.note.${key}`, NOTE_DEFAULTS[key] || key, params) }
}

function setEvents(events, setIndex) {
  return (events || []).filter(e => setOf(e) === setIndex).sort(compareBySeq)
}

function setIsFinished(events, setIndex) {
  return (events || []).some(e => e.type === 'set_end' && setOf(e) === setIndex)
}

function scoreNowOf(events, setIndex) {
  const s = scoreFromPointEvents(events, setIndex)
  return { home: s.homePoints, away: s.awayPoints }
}

/** Points of the set before `seq`, as {home, away}. */
function scoreBeforeSeq(events, setIndex, seq) {
  const s = { home: 0, away: 0 }
  for (const e of events || []) {
    if (e.type !== 'point' || setOf(e) !== setIndex || (e.seq || 0) >= seq) continue
    if (isTeam(e.payload?.team)) s[e.payload.team]++
  }
  return s
}

/** The team's line-up now: { lineup, liberoSubstitution } (null without one). */
export function lineupNow(events, setIndex, team) {
  const row = setEvents(events, setIndex).filter(e => e.type === 'lineup' && e.payload?.team === team).pop()
  if (!row?.payload?.lineup) return null
  return { lineup: { ...row.payload.lineup }, liberoSubstitution: row.payload.liberoSubstitution || null }
}

/** The newest going back of the set, or null. */
function latestRectification(events, setIndex) {
  return setEvents(events, setIndex).filter(e => e.type === 'rectification').pop() || null
}

/**
 * The scores of the set being played the scorer can go back to, newest
 * first: { key, boundarySeq, score, label }. Points with a seq above
 * boundarySeq are the ones "since then". Only scores after the newest going
 * back of the set (one at a time, taken back in the reverse order).
 */
export function rectifyMoments(events, { setIndex } = {}, ctx = {}) {
  const floor = latestRectification(events, setIndex)?.seq ?? -Infinity
  const out = []
  scoreTimeline(events, setIndex).forEach((entry, i) => {
    const boundarySeq = entry.anchorSeq != null ? entry.anchorSeq : (entry.closerSeq != null ? entry.closerSeq - 0.5 : -Infinity)
    if (boundarySeq < floor) return
    const score = { home: entry.home, away: entry.away }
    out.push({
      key: `score:${i}`,
      boundarySeq,
      score,
      label: i === 0
        ? tr(ctx.t, 'rectify.moment.setStart', 'Start of the set ({{score}})', { score: formatScore(score, null, ctx) })
        : formatScore(score, null, ctx)
    })
  })
  return out.reverse()
}

/** The usual answer to "point and service to": the opponent of the team at fault; nobody for both. */
export function defaultPenaltyTo(cancel) {
  return isTeam(cancel) ? otherTeam(cancel) : null
}

let tempCounter = 0
function newRow(ctx, fields) {
  tempCounter += 1
  return { matchId: ctx?.matchId, stateSnapshot: null, manual: true, tempKey: `rx:${tempCounter}`, ...fields }
}

function sameLineupValues(a, b) {
  return POSITIONS.every(pos => String(a?.[pos] ?? '') === String(b?.[pos] ?? ''))
}

/** A copy of an event row to put back later (without its stored snapshot). */
function keepRow(e) {
  // eslint-disable-next-line no-unused-vars
  const { stateSnapshot, ...rest } = e
  return { ...rest, payload: e.payload ? { ...e.payload } : e.payload }
}

const validScore = (n) => Number.isInteger(n) && n >= 0

/**
 * Plan a going back.
 * @param {Array} events the match log
 * @param {object} opts
 *   setIndex, moment (one of rectifyMoments), cancel ('home'|'away'|'both'),
 *   penaltyTo ('home'|'away'|null),
 *   edits: { score?: {home, away}, serve?: 'home'|'away', lineups?: {home?, away?},
 *            takeBack?: substitution ids, remark?: string }
 * @param {{ t?, match?, homeTeam?, awayTeam?, matchId?, liveSetIndex?, players?, now?: Date }} ctx
 * @returns the plan (manualCorrections shape, finalized) with
 *   plan.rectification = { setIndex, cancel, penaltyTo } and plan.preview, or { error }
 */
export function planRectification(events, opts = {}, ctx = {}) {
  const first = buildRectification(events, opts, ctx, null)
  if (first.error) return first
  // Line-ups changed by hand: one line-up row per team, then planned again
  const wanted = opts.edits?.lineups || {}
  const rows = {}
  for (const team of ['home', 'away']) {
    const lineup = wanted[team]
    const current = first.preview.lineupState[team]
    if (!lineup || !current || sameLineupValues(lineup, current.lineup)) continue
    const seen = new Set()
    for (const pos of POSITIONS) {
      const n = lineup[pos]
      if (!has(n)) return fail('lineupIncomplete')
      if (seen.has(String(n))) return fail('lineupDuplicate', { n })
      seen.add(String(n))
    }
    const next = {}
    for (const pos of POSITIONS) {
      const sample = current.lineup[pos]
      next[pos] = typeof sample === 'number' ? Number(lineup[pos]) : String(lineup[pos])
    }
    // the libero stays on court if he is still where he was
    const ls = current.liberoSubstitution && same(next[current.liberoSubstitution.position], current.liberoSubstitution.liberoNumber)
      ? current.liberoSubstitution
      : null
    rows[team] = { team, lineup: next, isInitial: false, mode: 'manual', fromRectification: true, liberoSubstitution: ls }
  }
  if (!Object.keys(rows).length) return first
  return buildRectification(events, opts, ctx, rows)
}

function buildRectification(events, { setIndex, moment = null, cancel = null, penaltyTo = null, edits = {} } = {}, ctx, lineupRows) {
  const t = ctx.t
  const set = displaySetNumber(setIndex, ctx.match)
  if (ctx.liveSetIndex != null && ctx.liveSetIndex !== setIndex) return fail('notLive')
  if (setIsFinished(events, setIndex)) return fail('setFinished', { set })
  if (!moment || moment.boundarySeq === undefined) return fail('chooseMoment')
  if (!CANCEL_CHOICES.includes(cancel)) return fail('chooseCancel')
  const floor = latestRectification(events, setIndex)?.seq ?? -Infinity
  if (moment.boundarySeq < floor) return fail('laterRectification')
  if (edits.score && !(validScore(edits.score.home) && validScore(edits.score.away))) return fail('badScore')

  const all = [...(events || [])].sort(compareBySeq)
  const inSet = setEvents(all, setIndex)
  const boundary = moment.boundarySeq
  const scoreBefore = scoreNowOf(all, setIndex)
  const plan = emptyPlan()
  const ts = (ctx.now instanceof Date ? ctx.now : new Date()).toISOString()
  const maxBase = Math.floor(Math.max(0, ...all.map(e => e.seq || 0)))

  // Substitutions taken back: out of the record, the line-ups rebuilt without them
  const takeBack = new Set(edits.takeBack || [])
  const removedIds = new Set()
  const takenBack = inSet.filter(e => e.type === 'substitution' && takeBack.has(e.id))
  for (const sub of takenBack) {
    for (const id of entryGroupIds(all, sub)) removedIds.add(id)
    if (sub.payload?.autoRemark) plan.remarkRemove.push(sub.payload.autoRemark)
  }

  // Whose points since then
  const valid = (e) => e.type === 'point' && !removedIds.has(e.id) && e.payload?.forfeitAwarded !== true
  let cancelled = []
  if (cancel === 'both') {
    // the rallies since that score go, the points of penalties (and their sanctions) stay
    const goes = inSet.filter(e => valid(e) && (e.seq || 0) > boundary && !penaltyOfPoint(all, e))
    for (const p of goes) for (const id of pointGroupIds(all, p)) removedIds.add(id)
    if (inSet.some(e => (e.seq || 0) > boundary && ['timeout', 'substitution', 'sanction'].includes(e.type) && !removedIds.has(e.id))) {
      plan.notes.push(note('timeline', {}, t))
    }
  } else {
    cancelled = inSet.filter(e => valid(e) && e.payload?.team === cancel && (e.seq || 0) > boundary)
  }
  const removedPoints = (team) => all.filter(e => removedIds.has(e.id) && e.type === 'point' && e.payload?.team === team).length
  const counted = (team, list) => list.filter(e => e.payload?.team === team).length

  // The score: as the answers give it, or as the scorer set it by hand
  let penalty = isTeam(penaltyTo) ? penaltyTo : null
  const computed = (team) => scoreBefore[team] - removedPoints(team) - counted(team, cancelled) + (penalty === team ? 1 : 0)
  const awarded = { home: 0, away: 0 }
  if (edits.score) {
    for (const team of ['home', 'away']) {
      let diff = edits.score[team] - computed(team)
      // fewer: no penalty point first, then the team's newest valid points cancelled
      if (diff < 0 && penalty === team) { penalty = null; diff += 1 }
      if (diff < 0) {
        const more = inSet.filter(e => valid(e) && e.payload?.team === team && !cancelled.includes(e) && !removedIds.has(e.id)).reverse()
        for (const p of more) {
          if (diff >= 0) break
          cancelled.push(p)
          diff += 1
        }
      }
      // more: its newest cancelled points count again, then points by hand
      while (diff > 0) {
        const idx = cancelled.map(e => e.payload?.team).lastIndexOf(team)
        if (idx < 0) break
        cancelled.splice(idx, 1)
        diff -= 1
      }
      if (diff > 0) awarded[team] = diff
    }
    cancelled.sort(compareBySeq)
  }

  const scoreAfter = { home: computed('home') + awarded.home, away: computed('away') + awarded.away }
  const nothing = !cancelled.length && !removedIds.size && !penalty && !awarded.home && !awarded.away && !lineupRows &&
    !(isTeam(edits.serve) && edits.serve !== servingTeamFromLog(all, setIndex, ctx.match))
  if (nothing) return fail('nothingToChange')

  plan.update = cancelled.map(e => ({ id: e.id, changes: { type: 'cancelled_point', payload: { ...e.payload, cancelledBy: 'rectification' } } }))
  plan.remove = [...removedIds]
  const removedRows = all.filter(e => removedIds.has(e.id)).map(keepRow)

  // New rows: the penalty point, the points by hand, the head and its line-ups
  let seq = maxBase
  const rows = []
  const addedPointSeqs = []
  const running = { home: scoreAfter.home - awarded.home - (penalty === 'home' ? 1 : 0), away: scoreAfter.away - awarded.away - (penalty === 'away' ? 1 : 0) }
  if (penalty) {
    seq += 1
    running[penalty] += 1
    rows.push(newRow(ctx, { type: 'point', setIndex, seq, ts, payload: { team: penalty, score: { ...running }, rectification: true } }))
    addedPointSeqs.push(seq)
  }
  for (const team of ['home', 'away']) {
    for (let i = 0; i < awarded[team]; i++) {
      seq += 1
      running[team] += 1
      rows.push(newRow(ctx, { type: 'point', setIndex, seq, ts, payload: { team, score: { ...running }, rectification: true, scoreAdjusted: true } }))
      addedPointSeqs.push(seq)
    }
  }
  seq += 1
  const head = newRow(ctx, {
    type: 'rectification',
    setIndex,
    seq,
    ts,
    payload: {
      cancel,
      team: isTeam(cancel) ? cancel : null,
      penaltyTo: penalty,
      moment: { key: moment.key ?? null, boundarySeq: Number.isFinite(boundary) ? boundary : null, score: moment.score || null },
      scoreBefore,
      scoreAfter,
      serve: null,
      cancelledPointIds: cancelled.map(e => e.id),
      addedPointSeqs,
      removedRows,
      autoRemark: ''
    }
  })
  rows.push(head)
  let sub = 0
  for (const team of ['home', 'away']) {
    if (!lineupRows?.[team]) continue
    sub += 1
    rows.push(newRow(ctx, { type: 'lineup', setIndex, seq: Math.round((seq + sub / 10) * 1000) / 1000, ts, payload: lineupRows[team] }))
  }
  plan.add = rows
  plan.affectedSets = [setIndex]
  plan.rectification = { setIndex, cancel, penaltyTo: penalty }

  const finalized = finalizePlan(events, plan, ctx)
  // Who serves next: the team the rallies give it to (the penalty point's
  // team), unless the scorer chose another
  const derivedAfter = applyPlanToEvents(events, finalized)
  const derivedServe = servingTeamFromLog(derivedAfter, setIndex, ctx.match)
  const serve = isTeam(edits.serve) ? edits.serve : derivedServe
  head.payload.serve = serve

  // The remark the rules ask for (CB 2.3), concerned team first
  const concerned = isTeam(cancel) ? cancel : (ctx.match?.coinTossTeamA === 'away' ? 'away' : 'home')
  const parts = [
    tr(t, cancel === 'both' ? 'rectify.remark.backOfficials' : 'rectify.remark.since', cancel === 'both' ? REMARK_DEFAULTS.backOfficials : REMARK_DEFAULTS.since, { from: plainScore(moment.score || { home: 0, away: 0 }, concerned) }),
    cancel === 'both'
      ? tr(t, 'rectify.remark.cancelledBoth', REMARK_DEFAULTS.cancelledBoth)
      : (cancelled.length ? tr(t, 'rectify.remark.cancelled', REMARK_DEFAULTS.cancelled, { n: cancelled.length, team: teamLetter(cancel, ctx.match) }) : ''),
    ...takenBack.map(s => tr(t, 'rectify.remark.subTakenBack', REMARK_DEFAULTS.subTakenBack, { in: s.payload?.playerIn ?? '?', out: s.payload?.playerOut ?? '?', team: teamLetter(s.payload?.team, ctx.match) })),
    penalty ? tr(t, 'rectify.remark.penalty', REMARK_DEFAULTS.penalty, { team: teamLetter(penalty, ctx.match) }) : '',
    serve !== derivedServe ? tr(t, 'rectify.remark.serve', REMARK_DEFAULTS.serve, { team: teamLetter(serve, ctx.match) }) : '',
    tr(t, 'rectify.remark.after', REMARK_DEFAULTS.after, { score: plainScore(scoreAfter, concerned) })
  ].filter(Boolean)
  const prefix = remarkPrefix({ team: isTeam(cancel) ? teamLetter(cancel, ctx.match) : null, set, score: plainScore(scoreBefore, concerned) }, t)
  const remarkDefault = `${prefix}${parts.join('; ')}.`
  const remark = typeof edits.remark === 'string' && edits.remark.trim() ? edits.remark.trim() : remarkDefault
  head.payload.autoRemark = remark
  finalized.remarkAdd = [remark]

  const before = formatScore(scoreBefore, null, ctx)
  const afterText = formatScore(scoreAfter, null, ctx)
  finalized.log = {
    action: 'rectify',
    setIndex,
    team: isTeam(cancel) ? cancel : null,
    before,
    after: afterText,
    text: tr(t, 'rectify.log.applied', 'Game taken back: set {{set}}, {{before}} → {{after}}', { set, before, after: afterText })
  }

  const after = applyPlanToEvents(events, finalized)
  const lineupState = { home: lineupNow(after, setIndex, 'home'), away: lineupNow(after, setIndex, 'away') }
  const serverLineup = lineupState[serve]?.lineup
  const scoreAt = (p) => {
    const s = scoreBeforeSeq(events, setIndex, p.seq || 0)
    s[p.payload?.team] += 1
    return s
  }
  finalized.preview = {
    cancel,
    cancelled: cancelled.map(p => ({ id: p.id, team: p.payload?.team, score: scoreAt(p) })),
    removed: removedRows.filter(e => e.type === 'point').map(p => ({ id: p.id, team: p.payload?.team, score: scoreAt(p) })),
    takenBack: takenBack.map(s => s.id),
    penaltyTo: penalty,
    awarded,
    scoreBefore,
    scoreAfter,
    serve,
    serverNumber: serverLineup?.I ?? null,
    lineupState,
    remark,
    remarkDefault,
    substitutions: inSet.filter(e => e.type === 'substitution').map(e => ({ id: e.id, team: e.payload?.team, text: describeEvent(e, events, ctx)?.text || '' })),
    setWon: !!getSetResult(scoreAfter.home, scoreAfter.away, setIndex).winner
  }
  if (finalized.preview.setWon) finalized.notes.push(note('setWon', { set }, t))
  return finalized
}

/**
 * Take a going back back: the cancelled points count again, the points it
 * added, its line-up rows and its remark go, the rallies and substitutions
 * it took out come back. The newest going back of a set only; one that took
 * entries out only while it is still the set's newest entry.
 */
export function planRectificationReversal(events, id, ctx = {}) {
  const head = (events || []).find(e => e.id === id)
  if (!head || head.type !== 'rectification') return fail('notFound')
  const p = head.payload || {}
  const setIndex = setOf(head)
  const inSet = setEvents(events, setIndex)
  if (latestRectification(events, setIndex)?.id !== head.id) return fail('laterRectification')
  if ((p.removedRows || []).length && inSet.some(e => baseOf(e) > baseOf(head))) return fail('notLast')

  const plan = emptyPlan()
  const byId = new Map((events || []).map(e => [e.id, e]))
  for (const pid of p.cancelledPointIds || []) {
    const e = byId.get(pid)
    if (!e || e.type !== 'cancelled_point') continue
    // eslint-disable-next-line no-unused-vars
    const { cancelledBy, ...payload } = e.payload || {}
    plan.update.push({ id: pid, changes: { type: 'point', payload } })
  }
  const remove = new Set(entryGroupIds(events, head))
  const added = new Set(p.addedPointSeqs || [])
  for (const e of inSet) {
    if (e.type === 'point' && e.payload?.rectification && added.has(e.seq) && compareBySeq(e, head) < 0) {
      for (const x of entryGroupIds(events, e)) remove.add(x)
    }
  }
  plan.remove = [...remove]
  for (const row of p.removedRows || []) {
    // rotation and substitution line-up rows are rebuilt (finalizePlan)
    if (!['point', 'rally_start', 'substitution'].includes(row.type)) continue
    // eslint-disable-next-line no-unused-vars
    const { id: _old, ...rest } = row
    plan.add.push(newRow(ctx, { ...rest, stateSnapshot: null }))
    if (row.type === 'substitution' && row.payload?.autoRemark) plan.remarkAdd.push(row.payload.autoRemark)
  }
  plan.affectedSets = [setIndex]
  if (typeof p.autoRemark === 'string' && p.autoRemark) plan.remarkRemove = [p.autoRemark]
  plan.log = {
    action: 'rectifyUndo',
    setIndex,
    team: p.team ?? null,
    before: null,
    after: null,
    text: tr(ctx.t, 'rectify.log.reversed', 'Taken back: game taken back in set {{set}}', { set: displaySetNumber(setIndex, ctx.match) })
  }
  return finalizePlan(events, plan, ctx)
}

