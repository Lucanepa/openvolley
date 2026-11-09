/**
 * Going back in the game: the situations in which the rules take the score
 * back to an earlier moment, cancel points, or end a set — pure planners, no
 * React, no Dexie (owner 2026-11-09: "make sure that in place there's
 * something that makes you 'go back' to a certain point in the game. even
 * forfait a set. check the rules").
 *
 * Sources: FIVB Official Volleyball Rules 2025-2028 (R), FIVB Casebook 2025
 * (CB), FIVB Refereeing Guidelines 2025 (GL), SSK note "Checking the starting
 * line-up by the second referee" (SSK).
 *
 * THE TEAM AT FAULT LOSES ITS POINTS SINCE THE FAULT (kinds with
 * cancels: 'team'). The rules say it the same way each time: the opponent
 * gains a point and the service, the team at fault is put right, and "all
 * points scored by the team at fault from the moment of the fault up to its
 * discovery are cancelled; the opponent's points remain valid".
 *   illegal_substitution  R15.9.2 (.1 point and service to the opponent, .2
 *                         the substitution rectified, .3 points cancelled),
 *                         R7.5.1 (play restarted with a player on court
 *                         through an illegal substitution), CB 4.13 (the
 *                         rectification does not count as a substitution,
 *                         no further penalty).
 *   illegal_libero        R19.3.2.9, CB 5.7: noticed after the service hit,
 *                         the same consequences as an illegal substitution.
 *   lineup_discrepancy    R7.3.5.3: positions on court differ from the
 *                         line-up sheet, discovered later; SSK (5:7, wrong
 *                         player since 0:0: play goes on at 0:8).
 *   unregistered_player   R7.3.5.4, CB 4.22: a player not on the roster on
 *                         court; points since he/she entered cancelled.
 *   rotation_fault        R7.7.1 / 7.7.2, CB 2.5, GL R12 §9: the wrong
 *                         server. Found right after the rally it started:
 *                         one single point to the opponent, whatever the
 *                         rally gave (7.7.1.1). Found later: the points since
 *                         the wrong service are cancelled; if that moment
 *                         cannot be determined, only the point and service.
 * A cancelled point stays in the log as a rally (type 'cancelled_point',
 * domain/recompute isRally): the serve went over and the team rotated, the
 * opponent's players stayed where they are, so the rotations of both teams
 * are kept and only the score changes. The penalty point is an ordinary
 * point of the opponent (the loss of a rally; not a sanction, so it is not
 * circled on the sheet) written with its rotation when it wins the serve.
 *
 * BACK TO AN EARLIER SCORE FOR BOTH TEAMS (official_error, CB 2.3 and 2.4):
 * the officials gave a team wrong information (who serves, ...) and play went
 * on, or a rally was played with five or seven players of a team and found
 * after the next rally. "The score is taken back to the point where the wrong
 * information was given ... the already issued warnings/sanctions remain
 * valid. This event must be recorded on the score sheet." The rallies since
 * that moment are taken out (both teams, with their rotations: the teams go
 * back to their line-up of that moment), time-outs, substitutions and
 * sanctions stay, and so do the points of penalties.
 *
 * NOTICED BEFORE THE NEXT SERVICE (planIllegalEntryBeforeService): an
 * illegal substitution or libero replacement recorded, noticed before play
 * resumes, is taken back and the team gets a delay sanction (R16.1.3,
 * R19.3.2.9, CB 5.7, CB 4.15, GL R15 §3). The request itself is handled where
 * it is made (Scoreboard openIllegalSubstitution).
 *
 * Every plan is written by the corrections executor
 * (services/corrections/applyCorrectionPlan) as ONE correction. Its head
 * event ('rectification', the newest entry of the set) carries the undo
 * record, so Undo (Scoreboard undoEventTx) and Remove in the corrections take
 * the whole of it back (planRectificationReversal). The remark the rules ask
 * for is written with it (payload.autoRemark: it goes when the entry goes).
 *
 * Out of scope here: a decision reversed after a protest (the protest
 * procedure, outside the scorer), a fault found after the end of the set or
 * of the match (CB 4.22: the set or the match is lost; the referee and the
 * competition decide: Corrections and the remarks), the default result 0:3,
 * 0:25 of R6.4.1 for the standings (the sheet records the points played and
 * awarded, as the forfeit does).
 */
import { compareBySeq, formatScore, plainScore, teamLetter, displaySetNumber, tr, teamLabel, otherTeam, describeEvent } from './describe'
import { scoreFromPointEvents, getFirstServeForSet, getSetResult } from './rules'
import { finalizePlan, applyPlanToEvents, isRally, isRotationLiberoExit, POSITIONS } from './recompute'
import { emptyPlan, mergePlans, scoreTimeline, entryGroupIds, pointGroupIds, planRemoveEntry, planAddSanction } from './manualCorrections'
import { penaltyOfPoint, resolveSanction, isDelaySanction } from './sanctions'

const baseOf = (e) => Math.floor(e?.seq || 0)
const setOf = (e) => e?.setIndex ?? 1
const isTeam = (t) => t === 'home' || t === 'away'
const has = (n) => n !== undefined && n !== null && n !== '' && n !== '?'
const same = (a, b) => has(a) && has(b) && String(a) === String(b)

/**
 * The situations, in the order the scorer is offered them.
 *   moment   what the scorer picks: 'substitution' / 'libero' (the entry),
 *            'service' (a service turn of the team), 'score' (a score of the set)
 *   cancels  'team': the team at fault's points since the moment;
 *            'both': every rally since the moment (official_error)
 *   penalty  point and service to the opponent
 *   lineup   'suggest': the line-up is put right (a suggestion the scorer
 *            can change); 'edit': kept unless the scorer changes it;
 *            'none': follows from the rallies (official_error)
 */
export const RECTIFY_KINDS = Object.freeze({
  illegal_substitution: { rule: '15.9.2', refs: 'R7.5.1, 15.9.2; Casebook 4.13', moment: 'substitution', cancels: 'team', penalty: true, lineup: 'suggest' },
  illegal_libero: { rule: '19.3.2.9', refs: 'R19.3.2.9; Casebook 5.7', moment: 'libero', cancels: 'team', penalty: true, lineup: 'edit' },
  lineup_discrepancy: { rule: '7.3.5.3', refs: 'R7.3.5.3', moment: 'score', cancels: 'team', penalty: true, lineup: 'edit' },
  unregistered_player: { rule: '7.3.5.4', refs: 'R7.3.5.4; Casebook 4.22', moment: 'score', cancels: 'team', penalty: true, lineup: 'edit' },
  rotation_fault: { rule: '7.7', refs: 'R7.7.1, 7.7.2; Casebook 2.5', moment: 'service', cancels: 'team', penalty: true, lineup: 'edit', unknownMoment: true },
  official_error: { rule: 'CB 2.3', refs: 'Casebook 2.3, 2.4', moment: 'score', cancels: 'both', penalty: false, lineup: 'none' }
})

export const RECTIFY_KIND_ORDER = Object.freeze(['illegal_substitution', 'illegal_libero', 'lineup_discrepancy', 'unregistered_player', 'rotation_fault', 'official_error'])

// English texts (the UI translates the keys: rectify.*)
const KIND_DEFAULTS = {
  illegal_substitution: 'Illegal substitution found after play went on',
  illegal_libero: 'Illegal libero replacement found after the service',
  lineup_discrepancy: 'Players not in the positions of the line-up sheet',
  unregistered_player: 'Player not on the roster found on court',
  rotation_fault: 'Wrong server found later (rotational fault)',
  official_error: 'Back to an earlier score (officials\' mistake)'
}
const HELP_DEFAULTS = {
  illegal_substitution: 'Point and service to the opponent. The substitution is put right (this does not count as a substitution). The points of the team at fault since the substitution are cancelled; the opponent keeps its points.',
  illegal_libero: 'The same as an illegal substitution: point and service to the opponent, the replacement put right, the points of the team at fault since then cancelled.',
  lineup_discrepancy: 'The team goes back to the positions of its line-up sheet. Point and service to the opponent; the points of the team at fault since the moment of the fault are cancelled.',
  unregistered_player: 'A registered player replaces him or her. Point and service to the opponent; the points of the team at fault since the player entered are cancelled. Found after the set or the match: the set or the match is lost, tell the 1st referee.',
  rotation_fault: 'Point and service to the opponent; the rotational order is put right. Found right after the rally of the wrong service: one single point to the opponent. Found later: the points of the team at fault since the wrong service are cancelled; moment not known: only the point.',
  official_error: 'The officials gave wrong information and play went on, or a rally was played with five or seven players: the score goes back to that moment for both teams. Sanctions stay; no penalty point.'
}
const MOMENT_PROMPT_DEFAULTS = {
  substitution: 'Which substitution was illegal?',
  libero: 'Which libero replacement was illegal?',
  service: 'At which service did the wrong player serve?',
  score: 'From which score?'
}

const ERROR_DEFAULTS = {
  chooseSituation: 'Choose what happened.',
  chooseTeam: 'Choose the team at fault.',
  chooseMoment: 'Choose the moment of the fault.',
  notLive: 'Only the set being played can be taken back here. For an earlier set, use Corrections and tell the referee.',
  setFinished: 'Set {{set}} is over. Use Corrections and tell the referee.',
  nothingToChange: 'Nothing changes: the team at fault scored no point since then.',
  nothingToGoBack: 'No rally was played since that score.',
  lineupIncomplete: 'Choose a player for each of the six positions.',
  lineupDuplicate: '#{{n}} is chosen twice.',
  notFound: 'This entry no longer exists.',
  notLast: 'Rallies were played after this going back: take them back first.',
  laterRectification: 'A later going back in this set comes first: take it back first.',
  notBeforeService: 'A rally was played since this entry: use "Illegal substitution found after play went on".'
}

const NOTE_DEFAULTS = {
  singlePoint: 'Found right after the rally of the wrong service, which {{team}} won: that is the one single point (7.7.1.1), no point is added.',
  momentUnknown: 'Moment not known: no point is cancelled, only point and service to the opponent (7.7.2).',
  setWon: 'This point ends set {{set}}: confirm the set end next.',
  timeline: 'Time-outs, substitutions and sanctions after it stay; on the scoresheet they now show the corrected score.',
  sanctionsStay: 'Sanctions stay valid, with their points (Casebook 2.3).'
}

const REMARK_DEFAULTS = {
  team: 'Team {{team}}, Set {{set}}, Result {{score}}: {{what}} (rule {{rule}}) since {{from}}; {{n}} point(s) of team {{team}} cancelled, point and service to team {{opp}}; score now {{after}}.',
  teamNoPenalty: 'Team {{team}}, Set {{set}}, Result {{score}}: {{what}} (rule {{rule}}) since {{from}}; {{n}} point(s) of team {{team}} cancelled; score now {{after}}.',
  unknown: 'Team {{team}}, Set {{set}}, Result {{score}}: {{what}} (rule {{rule}}), moment not known; point and service to team {{opp}}; score now {{after}}.',
  official: 'Set {{set}}, Result {{score}}: officials\' mistake (Casebook 2.3); score taken back to {{after}}, sanctions remain valid.'
}

const REMARK_WHAT_DEFAULTS = {
  illegal_substitution: 'illegal substitution',
  illegal_libero: 'illegal libero replacement',
  lineup_discrepancy: 'positions not as on the line-up sheet',
  unregistered_player: 'player not on the roster on court',
  rotation_fault: 'rotational fault'
}

/** The words of a situation (title, help, the moment question). */
export function kindText(kind, t) {
  return {
    title: tr(t, `rectify.kind.${kind}`, KIND_DEFAULTS[kind] || kind),
    help: tr(t, `rectify.help.${kind}`, HELP_DEFAULTS[kind] || ''),
    refs: RECTIFY_KINDS[kind]?.refs || '',
    momentPrompt: tr(t, `rectify.momentPrompt.${RECTIFY_KINDS[kind]?.moment}`, MOMENT_PROMPT_DEFAULTS[RECTIFY_KINDS[kind]?.moment] || '')
  }
}

function fail(key, params = {}) {
  return { error: `rectify.error.${key}`, params, text: tr(null, '', ERROR_DEFAULTS[key] || key, params) }
}

/** The translated text of a planner error (this module's, or a correction planner's). */
export function rectifyErrorText(result, t) {
  if (!result?.error) return ''
  if (!result.error.startsWith('rectify.error.')) return tr(t, result.error, result.text || result.error, result.params)
  const key = result.error.replace(/^rectify\.error\./, '')
  return tr(t, result.error, ERROR_DEFAULTS[key] || key, result.params)
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

/** Points of the set before `seq` (base seq), as {home, away}. */
function scoreBeforeSeq(events, setIndex, seq) {
  const s = { home: 0, away: 0 }
  for (const e of events || []) {
    if (e.type !== 'point' || setOf(e) !== setIndex || (e.seq || 0) >= seq) continue
    if (e.payload?.team === 'home') s.home++
    else if (e.payload?.team === 'away') s.away++
  }
  return s
}

function scoreNowOf(events, setIndex) {
  const s = scoreFromPointEvents(events, setIndex)
  return { home: s.homePoints, away: s.awayPoints }
}

/** The team's line-up row in force before `seq` (or at the end of the set). */
function lineupRowBefore(events, setIndex, team, seq = Infinity) {
  return setEvents(events, setIndex)
    .filter(e => e.type === 'lineup' && e.payload?.team === team && (e.seq || 0) < seq)
    .pop() || null
}

/** The team's line-up now: { lineup, liberoSubstitution } (null without one). */
export function lineupNow(events, setIndex, team) {
  const row = lineupRowBefore(events, setIndex, team)
  if (!row?.payload?.lineup) return null
  return { lineup: { ...row.payload.lineup }, liberoSubstitution: row.payload.liberoSubstitution || null }
}

/** The newest rectification of the set, or null. */
function latestRectification(events, setIndex) {
  return setEvents(events, setIndex).filter(e => e.type === 'rectification').pop() || null
}

/**
 * Who served each rally of the set: [{ rally, server }] in order. A rally
 * (point or cancelled point) gives the serve to the team that won it.
 */
export function servedRallies(events, setIndex, match) {
  let server = getFirstServeForSet(setIndex, match || {})
  if (!isTeam(server)) server = 'home'
  const out = []
  for (const e of setEvents(events, setIndex)) {
    if (!isRally(e) || !isTeam(e.payload?.team)) continue
    out.push({ rally: e, server })
    server = e.payload.team
  }
  return { rallies: out, serverNow: server }
}

/**
 * The moments the scorer can pick for a situation, newest first:
 *   { key, kind: 'event'|'service'|'score'|'unknown', eventId, boundarySeq,
 *     score: {home, away}, label, server? }
 * Points (or rallies) with a seq above boundarySeq are the ones "since the
 * fault". Only moments after the newest rectification of the set are offered
 * (one going back at a time, taken back in the reverse order).
 */
export function rectifyMoments(events, { kind, setIndex, team } = {}, ctx = {}) {
  const def = RECTIFY_KINDS[kind]
  if (!def) return []
  const t = ctx.t
  const list = setEvents(events, setIndex)
  const floor = latestRectification(events, setIndex)?.seq ?? -Infinity
  const out = []
  if (def.moment === 'substitution' || def.moment === 'libero') {
    const types = def.moment === 'substitution' ? ['substitution'] : ['libero_entry', 'libero_exit', 'libero_exchange']
    for (const e of list) {
      if (!types.includes(e.type) || e.payload?.team !== team || isRotationLiberoExit(e)) continue
      if ((e.seq || 0) <= floor) continue
      const score = scoreBeforeSeq(events, setIndex, e.seq || 0)
      const what = describeEvent(e, events, ctx)
      out.push({
        key: `event:${e.id}`, kind: 'event', eventId: e.id, boundarySeq: e.seq || 0, score,
        label: tr(t, 'rectify.moment.event', '{{what}} at {{score}}', { what: what?.title && what?.detail ? `${what.title} ${what.detail}` : (what?.title || e.type), score: formatScore(score, team, ctx) })
      })
    }
  } else if (def.moment === 'service') {
    const { rallies } = servedRallies(events, setIndex, ctx.match)
    let prevServer = null
    for (const { rally, server } of rallies) {
      const turnStart = server !== prevServer
      prevServer = server
      if (!turnStart || server !== team || (rally.seq || 0) <= floor) continue
      const score = scoreBeforeSeq(events, setIndex, rally.seq || 0)
      const lu = lineupRowBefore(events, setIndex, team, rally.seq || 0)?.payload
      const serverNumber = lu?.lineup?.I ?? null
      out.push({
        key: `service:${rally.id}`, kind: 'service', eventId: rally.id, boundarySeq: (rally.seq || 0) - 0.5, score, server: serverNumber,
        label: has(serverNumber)
          ? tr(t, 'rectify.moment.service', 'Service of #{{n}} at {{score}}', { n: serverNumber, score: formatScore(score, team, ctx) })
          : tr(t, 'rectify.moment.serviceNoNumber', 'Service at {{score}}', { score: formatScore(score, team, ctx) })
      })
    }
  } else {
    const tl = scoreTimeline(events, setIndex)
    tl.forEach((entry, i) => {
      const boundarySeq = entry.anchorSeq != null ? entry.anchorSeq : (entry.closerSeq != null ? entry.closerSeq - 0.5 : -Infinity)
      if (boundarySeq < floor) return
      // going back to the current score changes nothing
      if (def.cancels === 'both' && i === tl.length - 1) return
      const score = { home: entry.home, away: entry.away }
      out.push({
        key: `score:${i}`, kind: 'score', boundarySeq, score,
        label: i === 0
          ? tr(t, 'rectify.moment.setStart', 'Start of the set ({{score}})', { score: formatScore(score, isTeam(team) ? team : null, ctx) })
          : formatScore(score, isTeam(team) ? team : null, ctx)
      })
    })
  }
  out.reverse()
  if (def.unknownMoment) {
    out.push({ key: 'unknown', kind: 'unknown', boundarySeq: Infinity, score: scoreNowOf(events, setIndex), label: tr(t, 'rectify.moment.unknown', 'Moment not known') })
  }
  return out
}

/**
 * The line-up the team is put right to, as a suggestion: an illegal
 * substitution undone (the player who came in illegally goes out, the one
 * he replaced comes back where he stands now; CB 4.13). Otherwise the line-up
 * now: the app keeps the line-up sheet and the rotational order, so the
 * players on court go back to what it shows.
 */
export function suggestedLineup(events, { kind, setIndex, team, moment } = {}) {
  const now = lineupNow(events, setIndex, team)
  if (!now) return null
  if (kind !== 'illegal_substitution' || moment?.kind !== 'event') return now.lineup
  const sub = (events || []).find(e => e.id === moment.eventId)
  const p = sub?.payload || {}
  const pos = POSITIONS.find(x => same(now.lineup[x], p.playerIn))
  if (!pos || POSITIONS.some(x => same(now.lineup[x], p.playerOut))) return now.lineup
  const sample = now.lineup[pos]
  return { ...now.lineup, [pos]: typeof sample === 'number' ? Number(p.playerOut) : String(p.playerOut) }
}

let tempCounter = 0
function newRow(ctx, fields) {
  tempCounter += 1
  return { matchId: ctx?.matchId, stateSnapshot: null, manual: true, tempKey: `rx:${tempCounter}`, ...fields }
}

/** "I 3 · II 4 · III 6 · IV 7 · V 1 · VI 2" */
function lineupText(lineup) {
  return POSITIONS.map(pos => `${pos} ${has(lineup?.[pos]) ? lineup[pos] : '?'}`).join(' · ')
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

/**
 * Plan a going back.
 * @param {Array} events the match log
 * @param {{ kind:string, setIndex:number, team?:'home'|'away', moment:object, lineup?:object|null }} opts
 *   moment: one of rectifyMoments(); lineup: the team at fault's line-up from
 *   the next rally (null: unchanged)
 * @param {{ t?, match?, homeTeam?, awayTeam?, matchId?, liveSetIndex?, now?: Date }} ctx
 * @returns plan (manualCorrections shape, finalized) with plan.rectification
 *   = { kind, setIndex, team, penaltyTo } and plan.preview, or { error }
 */
export function planRectification(events, { kind, setIndex, team = null, moment = null, lineup = null } = {}, ctx = {}) {
  const def = RECTIFY_KINDS[kind]
  if (!def) return fail('chooseSituation')
  const t = ctx.t
  const set = displaySetNumber(setIndex, ctx.match)
  if (ctx.liveSetIndex != null && ctx.liveSetIndex !== setIndex) return fail('notLive')
  if (setIsFinished(events, setIndex)) return fail('setFinished', { set })
  if (def.cancels === 'team' && !isTeam(team)) return fail('chooseTeam')
  if (!moment || moment.boundarySeq === undefined) return fail('chooseMoment')
  const floor = latestRectification(events, setIndex)?.seq ?? -Infinity
  if (moment.kind !== 'unknown' && moment.boundarySeq < floor) return fail('laterRectification')

  const all = [...(events || [])].sort(compareBySeq)
  const inSet = setEvents(all, setIndex)
  const rallies = inSet.filter(isRally)
  const boundary = moment.boundarySeq
  const scoreBefore = scoreNowOf(all, setIndex)
  const opp = otherTeam(team)
  const plan = emptyPlan()
  const now = ctx.now instanceof Date ? ctx.now : new Date()
  const ts = now.toISOString()
  const maxBase = Math.floor(Math.max(0, ...all.map(e => e.seq || 0)))

  let cancelled = []
  let removedRows = []
  let penalty = def.penalty
  if (def.cancels === 'team') {
    cancelled = rallies.filter(e => e.type === 'point' && e.payload?.team === team && (e.seq || 0) > boundary && e.payload?.forfeitAwarded !== true)
    if (kind === 'rotation_fault' && moment.kind === 'service') {
      // 7.7.1.1: found right after the rally the wrong service started, one
      // single point to the opponent, whatever that rally gave
      const faulty = rallies.find(e => (e.seq || 0) > boundary)
      const last = rallies[rallies.length - 1]
      if (faulty && faulty === last && faulty.type === 'point' && faulty.payload?.team === opp) {
        penalty = false
        plan.notes.push(note('singlePoint', { team: teamLabel(opp, ctx)?.name || '?' }, t))
      }
    }
    if (moment.kind === 'unknown') plan.notes.push(note('momentUnknown', {}, t))
  } else {
    // both teams: the rallies since that score go, the points of penalties
    // (and their sanctions) stay
    const goes = rallies.filter(e => e.type === 'point' && (e.seq || 0) > boundary && !penaltyOfPoint(all, e) && e.payload?.forfeitAwarded !== true)
    if (!goes.length) return fail('nothingToGoBack')
    const ids = new Set()
    for (const p of goes) for (const id of pointGroupIds(all, p)) ids.add(id)
    removedRows = all.filter(e => ids.has(e.id))
    plan.remove = [...ids]
    if (inSet.some(e => (e.seq || 0) > boundary && ['timeout', 'substitution', 'sanction', 'libero_entry', 'libero_exit', 'libero_exchange'].includes(e.type) && !isRotationLiberoExit(e))) {
      plan.notes.push(note('timeline', {}, t))
    }
    if (inSet.some(e => (e.seq || 0) > boundary && e.type === 'sanction')) plan.notes.push(note('sanctionsStay', {}, t))
  }

  plan.update = cancelled.map(e => ({ id: e.id, changes: { type: 'cancelled_point', payload: { ...e.payload, cancelledBy: kind } } }))
  const removedPointCount = (team) => removedRows.filter(e => e.type === 'point' && e.payload?.team === team).length
  const afterCancel = {
    home: scoreBefore.home - cancelled.filter(e => e.payload?.team === 'home').length - removedPointCount('home'),
    away: scoreBefore.away - cancelled.filter(e => e.payload?.team === 'away').length - removedPointCount('away')
  }
  const scoreAfter = { ...afterCancel }
  if (penalty) scoreAfter[opp] += 1

  // The team at fault put right: its line-up from the next rally
  const current = isTeam(team) ? lineupNow(all, setIndex, team) : null
  let lineupRow = null
  let lineupAfter = current?.lineup || null
  if (lineup && current && def.lineup !== 'none' && !sameLineupValues(lineup, current.lineup)) {
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
    lineupAfter = next
    lineupRow = { team, lineup: next, isInitial: false, mode: 'manual', fromRectification: true, liberoSubstitution: ls }
  }

  // nothing to cancel, no point and the line-up as it is: nothing to write
  if (def.cancels === 'team' && !cancelled.length && !penalty && !lineupRow) return fail('nothingToChange')

  const pointSeq = maxBase + 1
  const headSeq = penalty ? maxBase + 2 : maxBase + 1
  const rows = []
  if (penalty) {
    rows.push(newRow(ctx, { type: 'point', setIndex, seq: pointSeq, ts, payload: { team: opp, score: { ...scoreAfter }, rectification: kind } }))
  }

  // The remark the rules ask for (CB 2.3: "This event must be recorded on
  // the score sheet"), concerned team first
  const letter = teamLetter(team, ctx.match)
  const oppLetter = teamLetter(opp, ctx.match)
  const fromText = moment.kind === 'score' && moment.boundarySeq === -Infinity
    ? '0:0'
    : plainScore(moment.score || { home: 0, away: 0 }, team)
  let remark
  if (def.cancels === 'both') {
    remark = tr(t, 'rectify.remark.official', REMARK_DEFAULTS.official, { set, score: plainScore(scoreBefore, teamAKey(ctx.match)), after: plainScore(scoreAfter, teamAKey(ctx.match)) })
  } else {
    const params = {
      team: letter, opp: oppLetter, set, rule: def.rule, n: cancelled.length,
      what: tr(t, `rectify.remarkWhat.${kind}`, REMARK_WHAT_DEFAULTS[kind] || kind),
      score: plainScore(scoreBefore, team), from: fromText, after: plainScore(scoreAfter, team)
    }
    const which = moment.kind === 'unknown' ? 'unknown' : (penalty ? 'team' : 'teamNoPenalty')
    remark = tr(t, `rectify.remark.${which}`, REMARK_DEFAULTS[which], params)
  }

  const head = newRow(ctx, {
    type: 'rectification',
    setIndex,
    seq: headSeq,
    ts,
    payload: {
      kind,
      team: isTeam(team) ? team : null,
      rule: def.refs,
      moment: { kind: moment.kind, key: moment.key ?? null, eventId: moment.eventId ?? null, boundarySeq: Number.isFinite(boundary) ? boundary : null, score: moment.score || null },
      scoreBefore,
      scoreAfter,
      cancelledPointIds: cancelled.map(e => e.id),
      removedRows: removedRows.map(keepRow),
      penalty,
      penaltySeq: penalty ? pointSeq : null,
      lineupBefore: lineupRow ? current.lineup : null,
      lineupAfter: lineupRow ? lineupRow.lineup : null,
      autoRemark: remark
    }
  })
  rows.push(head)
  if (lineupRow) rows.push(newRow(ctx, { type: 'lineup', setIndex, seq: Math.round((headSeq + 0.1) * 1000) / 1000, ts, payload: lineupRow }))

  plan.add = rows
  plan.affectedSets = [setIndex]
  plan.remarkAdd = [remark]
  const label = kindText(kind, t).title
  plan.log = {
    action: 'rectify',
    setIndex,
    team: isTeam(team) ? team : null,
    before: formatScore(scoreBefore, isTeam(team) ? team : null, ctx),
    after: formatScore(scoreAfter, isTeam(team) ? team : null, ctx),
    text: tr(t, 'rectify.log.applied', '{{what}}: set {{set}}, {{before}} → {{after}}', {
      what: label, set, before: formatScore(scoreBefore, isTeam(team) ? team : null, ctx), after: formatScore(scoreAfter, isTeam(team) ? team : null, ctx)
    })
  }
  plan.rectification = { kind, setIndex, team: isTeam(team) ? team : null, penaltyTo: penalty ? opp : null }

  const finalized = finalizePlan(events, plan, ctx)
  finalized.preview = rectificationPreview(events, finalized, { kind, setIndex, team, cancelled, removedRows, penalty, opp, scoreBefore, scoreAfter, lineupBefore: current?.lineup || null, lineupAfter }, ctx)
  if (finalized.preview.setWon) finalized.notes.push(note('setWon', { set }, t))
  return finalized
}

function teamAKey(match) {
  return match?.coinTossTeamA === 'away' ? 'away' : 'home'
}

/**
 * What the scorer sees before confirming: the points cancelled (or the
 * rallies taken out), the penalty point, the score before and after, who
 * serves next (and which player), the line-up of the team at fault.
 */
function rectificationPreview(events, plan, info, ctx) {
  const after = applyPlanToEvents(events, plan)
  const { rallies, serverNow } = servedRallies(after, info.setIndex, ctx.match)
  const server = rallies.length ? serverNow : getFirstServeForSet(info.setIndex, ctx.match || {})
  const serverLineup = isTeam(server) ? lineupRowBefore(after, info.setIndex, server)?.payload?.lineup : null
  const scoreAt = (p) => {
    const s = scoreBeforeSeq(events, info.setIndex, p.seq || 0)
    s[p.payload?.team] += 1
    return s
  }
  const res = getSetResult(info.scoreAfter.home, info.scoreAfter.away, info.setIndex)
  return {
    kind: info.kind,
    team: isTeam(info.team) ? info.team : null,
    cancelled: info.cancelled.map(p => ({ id: p.id, score: scoreAt(p) })),
    removed: info.removedRows.filter(e => e.type === 'point').map(p => ({ id: p.id, team: p.payload?.team, score: scoreAt(p) })),
    penalty: info.penalty,
    penaltyTo: info.penalty ? info.opp : null,
    scoreBefore: info.scoreBefore,
    scoreAfter: info.scoreAfter,
    server,
    serverNumber: serverLineup?.I ?? null,
    lineupBefore: info.lineupBefore,
    lineupAfter: info.lineupAfter,
    lineupChanged: !!(info.lineupBefore && info.lineupAfter && !sameLineupValues(info.lineupBefore, info.lineupAfter)),
    lineupText: info.lineupAfter ? lineupText(info.lineupAfter) : '',
    setWon: !!res.winner
  }
}

/**
 * Take a going back back: the cancelled points count again, the penalty
 * point and the line-up row go, the rallies taken out (official_error) come
 * back, the remark goes. The newest going back of a set only; one that took
 * rallies out only while it is still the set's newest entry.
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
  const penaltyPoint = p.penalty
    ? inSet.find(e => e.type === 'point' && e.payload?.rectification === p.kind && (p.penaltySeq == null || e.seq === p.penaltySeq) && compareBySeq(e, head) < 0)
    : null
  if (penaltyPoint) for (const x of entryGroupIds(events, penaltyPoint)) remove.add(x)
  plan.remove = [...remove]
  for (const row of p.removedRows || []) {
    // rotation rows are rebuilt (finalizePlan); points and rally starts come back where they were
    if (row.type !== 'point' && row.type !== 'rally_start') continue
    // eslint-disable-next-line no-unused-vars
    const { id: _old, ...rest } = row
    plan.add.push(newRow(ctx, { ...rest, stateSnapshot: null }))
  }
  plan.affectedSets = [setIndex]
  if (typeof p.autoRemark === 'string' && p.autoRemark) plan.remarkRemove = [p.autoRemark]
  const set = displaySetNumber(setIndex, ctx.match)
  plan.log = {
    action: 'rectifyUndo',
    setIndex,
    team: p.team ?? null,
    before: null,
    after: null,
    text: tr(ctx.t, 'rectify.log.reversed', 'Taken back: {{what}} (set {{set}})', { what: kindText(p.kind, ctx.t).title, set })
  }
  return finalizePlan(events, plan, ctx)
}

/**
 * The team's entries an illegal substitution / libero replacement "noticed
 * before the next service" can take back: its substitutions and libero
 * replacements since the set's last rally, newest first.
 */
export function entriesBeforeService(events, { setIndex, team } = {}) {
  const list = setEvents(events, setIndex)
  const lastRally = list.filter(isRally).pop()
  return list
    .filter(e => ['substitution', 'libero_entry', 'libero_exit', 'libero_exchange'].includes(e.type) &&
      e.payload?.team === team && !isRotationLiberoExit(e) && (!lastRally || compareBySeq(e, lastRally) > 0) &&
      (e.seq || 0) === baseOf(e))
    .reverse()
}

/**
 * An illegal substitution or libero replacement noticed before the next
 * service (R16.1.3 "requesting an illegal substitution", R19.3.2.9, CB 5.7):
 * the entry is taken back and the team gets a delay sanction, at the level
 * its earlier delays give (R16.2: warning first, then penalty: the point
 * then follows, plan.followUp). One correction.
 */
export function planIllegalEntryBeforeService(events, { setIndex, team, eventId } = {}, ctx = {}) {
  if (!isTeam(team)) return fail('chooseTeam')
  if (setIsFinished(events, setIndex)) return fail('setFinished', { set: displaySetNumber(setIndex, ctx.match) })
  const ev = (events || []).find(e => e.id === eventId)
  if (!ev) return fail('notFound')
  if (!entriesBeforeService(events, { setIndex, team }).some(e => e.id === eventId)) return fail('notBeforeService')
  const raw = { ...ctx, raw: true, mode: 'live', liveSetIndex: setIndex }
  const removal = planRemoveEntry(events, eventId, raw)
  if (removal.error) return removal
  const without = applyPlanToEvents(events, removal)
  const prior = (events || []).filter(e => e.type === 'sanction' && e.payload?.team === team)
  const type = resolveSanction('delay_warning', {
    priorDelayCount: prior.filter(e => isDelaySanction(e.payload?.type)).length,
    priorImproperCount: prior.filter(e => e.payload?.type === 'improper_request').length
  })
  const tl = scoreTimeline(without, setIndex)
  const addition = planAddSanction(without, { setIndex, team, type, at: Math.max(0, tl.length - 1), pointAlreadyGiven: false }, raw)
  if (addition.error) return addition
  const merged = mergePlans(removal, addition)
  merged.notes = addition.notes
  const what = describeEvent(ev, events, ctx)?.text || ''
  const sanction = merged.add.find(r => r.type === 'sanction')
  merged.log = {
    action: 'rectifyBeforeService',
    setIndex,
    team,
    before: what,
    after: type,
    text: tr(ctx.t, 'rectify.log.beforeService', 'Taken back before the service: {{what}}; {{sanction}} for {{team}}', {
      what, team: teamLabel(team, ctx)?.name || '?',
      sanction: tr(ctx.t, `corrections.sanction.${type}`, type === 'delay_penalty' ? 'Delay penalty' : 'Delay warning').toLowerCase()
    })
  }
  merged.rectification = { kind: 'before_service', setIndex, team, penaltyTo: null, sanctionType: type, penaltySeq: type === 'delay_penalty' ? sanction?.seq ?? null : null }
  return finalizePlan(events, merged, ctx)
}
