/**
 * The match history (scoreboard Match menu → History) — pure, no React, no
 * Dexie. Two views, as DataProject's eScoresheet History window:
 *
 *  - historyRows: the log in order, one row per entry the scorer wrote: the
 *    time, the score of Team A and of Team B, what happened (describeEvent,
 *    the corrections' sentences) and, on each rally, the court of both teams
 *    after it (positions I-VI, the libero where he plays). The rows the app
 *    derives (rotations, rally starts, the libero leaving at the front row)
 *    are left out unless asked for; set starts and ends always show.
 *  - setInformation: per set or for the whole match, the substitutions of
 *    each team (score in / score out), the sanctions in the paper's W P E D
 *    columns, injuries and exceptional substitutions, and the time-outs.
 *
 * Every score is the score of the points logged before the entry in seq
 * order (describe scoreBeforeEvent), the scoresheet's own rule
 * (scoresheet_pdf/utils/setModel buildSetData, sheetModel processSanctions),
 * so a number here is the number on the paper sheet. On the paper a score is
 * written with the CONCERNED team first ("3:7" = the substituting team's 3);
 * the history's score columns are always Team A, Team B.
 *
 * `ctx`: { t, match, homeTeam, awayTeam } as describeEvent takes it.
 */
import {
  describeEvent, compareBySeq, tsMs, scoreBeforeEvent, teamLetter, teamAKeyOf, otherTeam,
  teamNameWithLetter, teamLabel, displaySetNumber, tr, sanctionTarget, humanize, reasonLabel
} from './describe'
import { timeLabel } from '../ui/format'

export const POSITIONS = Object.freeze(['I', 'II', 'III', 'IV', 'V', 'VI'])

const setOf = (e) => e?.setIndex ?? 1
const baseOf = (e) => Math.floor(e?.seq || 0)
const isTeam = (k) => k === 'home' || k === 'away'
const has = (n) => n !== undefined && n !== null && n !== '' && n !== '?'
const same = (a, b) => has(a) && has(b) && String(a) === String(b)
const num = (n) => (has(n) ? String(n) : '?')
const isRally = (e) => e?.type === 'point' || e?.type === 'cancelled_point'

/** A libero exit the rotation wrote (the libero reached the front row). */
const isRotationLiberoExit = (e) => e?.type === 'libero_exit' && /^rotation_to_front_row/.test(String(e.payload?.reason || ''))

/** "19:42:07" in the hall's clock (Zürich), '' when the entry has no time. */
export function clockWithSeconds(ts) {
  const ms = tsMs(ts)
  if (!ms) return ''
  const hm = timeLabel(ms)
  if (!hm) return ''
  return `${hm}:${String(new Date(ms).getUTCSeconds()).padStart(2, '0')}`
}

/** Events in log order, without holes. */
function ordered(events) {
  return [...(events || [])].filter(Boolean).sort(compareBySeq)
}

/**
 * The points of each set. A score "at an entry" only reads the points of its
 * set (scoreBeforeEvent), so handing it these instead of the whole log gives
 * the same score without reading the whole log for every row.
 */
function pointsBySet(list) {
  const out = new Map()
  for (const e of list) {
    if (e.type !== 'point') continue
    const s = setOf(e)
    if (!out.has(s)) out.set(s, [])
    out.get(s).push(e)
  }
  return out
}

/**
 * The sets the match has played (or started), in order, as
 * [{ index, number }] (number = the set as the sheet prints it).
 */
export function playedSets(events, sets = [], match = null) {
  const idx = new Set()
  for (const s of sets || []) {
    if (!s || !Number.isFinite(Number(s.index))) continue
    if (s.startTime || s.finished || Number(s.homePoints) > 0 || Number(s.awayPoints) > 0) idx.add(Number(s.index))
  }
  for (const e of events || []) {
    if (!e) continue
    if (['set_start', 'point', 'cancelled_point', 'timeout', 'substitution', 'sanction', 'set_end', 'rally_start'].includes(e.type)) idx.add(Number(setOf(e)))
  }
  return [...idx].filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b).map(index => ({ index, number: displaySetNumber(index, match) }))
}

/** True when an event belongs to the chosen set ('all' = every set). */
export function inSetFilter(e, setFilter) {
  return setFilter === 'all' || setFilter === undefined || setFilter === null || setFilter === '' || setOf(e) === Number(setFilter)
}

/**
 * A team's court from a line-up payload: positions I-VI in order, the
 * libero marked where he plays (payload.liberoSubstitution). `text` is the
 * DataProject form "6,3,9,12,L7,11".
 * @returns {null | { positions: Array<{pos:string, number:string, libero:boolean}>, text: string }}
 */
export function courtLine(payload) {
  const lu = payload?.lineup
  if (!lu || typeof lu !== 'object') return null
  const ls = payload.liberoSubstitution || null
  const positions = POSITIONS.map(pos => {
    const number = has(lu[pos]) ? String(lu[pos]) : ''
    const libero = !!ls && !!number && (has(ls.liberoNumber) ? same(ls.liberoNumber, number) : ls.position === pos)
    return { pos, number, libero }
  })
  if (positions.every(p => !p.number)) return null
  const text = positions.map(p => (p.number ? (p.libero ? `L${p.number}` : p.number) : '?')).join(',')
  return { positions, text }
}

/**
 * The court of both teams after each rally: the last line-up row of each
 * team up to the rally's group (the rally and its N.x rows — the rotation
 * of the team that won the serve, the libero leaving at the front row).
 * @returns {Map<object, {home: ReturnType<typeof courtLine>, away: ReturnType<typeof courtLine>}>} keyed by the rally event
 */
export function courtsAfterRallies(events) {
  const list = ordered(events)
  const current = new Map() // `${set}:${team}` -> line-up payload
  const out = new Map()
  let pending = []
  let group = null
  let loose = 0
  const flush = () => {
    for (const r of pending) {
      const s = setOf(r)
      out.set(r, { home: courtLine(current.get(`${s}:home`)), away: courtLine(current.get(`${s}:away`)) })
    }
    pending = []
  }
  for (const e of list) {
    // rows without a seq are their own group (no N.x rows to wait for)
    const g = `${setOf(e)}:${baseOf(e) || `loose:${(loose += 1)}`}`
    if (g !== group) { flush(); group = g }
    if (e.type === 'lineup' && isTeam(e.payload?.team)) current.set(`${setOf(e)}:${e.payload.team}`, e.payload)
    if (isRally(e)) pending.push(e)
  }
  flush()
  return out
}

// Entries whose sentence already names the team: no team after it
const TITLE_NAMES_TEAM = new Set(['point', 'cancelled_point', 'set_end', 'decision_change', 'rectification', 'coin_toss', 'set5_coin_toss', 'remark', 'match_stopped'])
const MUTED = new Set(['court_captain_designation', 'libero_entry', 'libero_exit', 'libero_exchange', 'libero_unable', 'libero_recovered', 'libero_redesignation'])

/**
 * The row's tone: 'set' (set start / end, light blue), 'sanction' (amber),
 * 'muted' (captain and libero rows), 'auto' (a row the app derived) or
 * 'plain'.
 */
export function rowTone(event, automatic = false) {
  const type = event?.type
  if (type === 'set_start' || type === 'set_end') return 'set'
  if (type === 'sanction') return 'sanction'
  if (automatic) return 'auto'
  if (MUTED.has(type)) return 'muted'
  return 'plain'
}

/** The sentence of a row describeEvent leaves out (the app wrote it). */
function automaticText(e, ctx, { firstSetStart = false, ofRally = false } = {}) {
  const { t } = ctx
  const p = e.payload || {}
  const teamName = isTeam(p.team) ? teamNameWithLetter(p.team, ctx) : ''
  switch (e.type) {
    case 'set_start': {
      const set = tr(t, 'history.what.setStart', 'Set {{n}} start', { n: displaySetNumber(setOf(e), ctx.match) })
      return firstSetStart ? `${tr(t, 'history.what.matchStart', 'Match start')} · ${set}` : set
    }
    case 'rally_start':
      return tr(t, 'history.what.rallyStart', 'Rally starts')
    case 'lineup':
      // the N.x row of a rally is the rotation of the team that won the serve
      return ofRally && !p.fromSubstitution
        ? tr(t, 'history.what.rotation', 'Rotation of {{team}}', { team: teamName || '?' })
        : tr(t, 'history.what.lineupUpdate', 'Line-up of {{team}} updated', { team: teamName || '?' })
    case 'libero_exit':
      return [tr(t, 'history.what.liberoFrontRow', 'Libero #{{libero}} out at the front row, #{{player}} in', { libero: num(p.liberoOut), player: num(p.playerIn) }), teamName].filter(Boolean).join(' · ')
    default:
      return [humanize(e.type), teamName].filter(Boolean).join(' · ')
  }
}

/**
 * The History tab's rows, oldest first.
 * @param {Array} events the match log
 * @param {object} ctx { t, match, homeTeam, awayTeam }
 * @param {{ showAutomatic?: boolean, setFilter?: 'all'|number|string }} [opts]
 * @returns {Array<{
 *   id:any, event:object, seq:number, setIndex:number, setNumber:number, kind:string,
 *   time:string, scoreA:number, scoreB:number, what:string, team:object|null,
 *   tone:string, automatic:boolean, rally:boolean,
 *   lineupA: ReturnType<typeof courtLine>, lineupB: ReturnType<typeof courtLine>
 * }>}
 */
export function historyRows(events, ctx = {}, opts = {}) {
  const { showAutomatic = false, setFilter = 'all' } = opts
  const list = ordered(events)
  const courts = courtsAfterRallies(list)
  const aKey = teamAKeyOf(ctx.match)
  const bKey = otherTeam(aKey)
  const running = new Map()
  const firstSetStart = list.find(e => e.type === 'set_start') || null
  const points = pointsBySet(list)
  const rallyGroups = new Set(list.filter(e => isRally(e) && baseOf(e)).map(e => `${setOf(e)}:${baseOf(e)}`))
  const rows = []
  for (const e of list) {
    const s = setOf(e)
    const sc = running.get(s) || { home: 0, away: 0 }
    if (e.type === 'point' && isTeam(e.payload?.team)) sc[e.payload.team] += 1
    running.set(s, sc)
    if (!inSetFilter(e, setFilter)) continue

    const d = describeEvent(e, points.get(s) || [], ctx)
    const alwaysShown = e.type === 'set_start'
    const automatic = !d && !alwaysShown
    if (automatic && !showAutomatic) continue

    let what
    if (d) {
      const team = TITLE_NAMES_TEAM.has(e.type) ? '' : d.teamText
      what = [d.title, team, d.detail].filter(Boolean).join(' · ')
    } else {
      what = automaticText(e, ctx, { firstSetStart: e === firstSetStart, ofRally: rallyGroups.has(`${s}:${baseOf(e)}`) })
    }
    // the set end carries its final score (the points may have been edited)
    const score = e.type === 'set_end' && d?.scoreValue ? d.scoreValue : sc
    const court = isRally(e) ? courts.get(e) : null
    rows.push({
      id: e.id ?? `${s}:${e.seq}`,
      event: e,
      seq: e.seq || 0,
      setIndex: s,
      setNumber: displaySetNumber(s, ctx.match),
      kind: e.type,
      time: clockWithSeconds(e.ts),
      scoreA: Number(score[aKey]) || 0,
      scoreB: Number(score[bKey]) || 0,
      what,
      team: isTeam(e.payload?.team) ? teamLabel(e.payload.team, ctx) : null,
      tone: rowTone(e, automatic),
      automatic,
      rally: isRally(e),
      lineupA: court ? court[aKey] : null,
      lineupB: court ? court[bKey] : null
    })
  }
  return rows
}

/** Newest first when asked (the rows come oldest first). */
export function orderRows(rows, order = 'oldest') {
  return order === 'newest' ? [...rows].reverse() : rows
}

/** The rows that contain the search text (time, what, score "a:b", line-ups). */
export function searchRows(rows, query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return rows
  return rows.filter(r => [r.time, r.what, `${r.scoreA}:${r.scoreB}`, r.lineupA?.text, r.lineupB?.text]
    .some(x => x && String(x).toLowerCase().includes(q)))
}

// ───────────────────────────── set information ─────────────────────────────

/** "a:b" with the concerned team's points first (the paper's way). */
function teamFirstScore(points, e, team) {
  const s = scoreBeforeEvent(points.get(setOf(e)) || [], e)
  const other = otherTeam(team)
  return `${s[team] ?? 0}:${other ? s[other] ?? 0 : 0}`
}

const MEMBER_SANCTIONS = ['warning', 'penalty', 'expulsion', 'disqualification']
// The paper's columns: W(arning) P(enalty) E(xpulsion) D(isqualification)
export const SANCTION_COLUMNS = Object.freeze({ warning: 'W', penalty: 'P', expulsion: 'E', disqualification: 'D' })

function exceptionalReason(p) {
  if (p.isExpelled) return 'expulsion'
  if (p.isDisqualified) return 'disqualification'
  if (p.isInjury) return 'injury'
  return p.reason || ''
}

/**
 * The Set information tab, for one set or the whole match ('all').
 * Scores are written as on the paper: the concerned team first.
 * @returns {{
 *   substitutions: { A: Array<{id, setIndex, set, in, out, scoreIn, scoreOut}>, B: Array },
 *   sanctions: Array<{id, setIndex, set, score, team, type, column, code, delay}>,
 *   improperRequests: Array<{id, setIndex, set, score, team}>,
 *   injuries: Array<{id, setIndex, set, score, team, number, kind, what}>,
 *   timeouts: Array<{id, setIndex, set, score, team}>
 * }}
 */
export function setInformation(events, ctx = {}, { setFilter = 'all' } = {}) {
  const { t, match } = ctx
  const list = ordered(events)
  const points = pointsBySet(list)
  const letter = (k) => teamLetter(k, match)
  const setNo = (e) => displaySetNumber(setOf(e), match)
  const out = { substitutions: { A: [], B: [] }, sanctions: [], improperRequests: [], injuries: [], timeouts: [] }

  // Substitutions: one row per substitute who came in. His going back out
  // (the return of the player he replaced, or any later change that takes
  // him off) is the row's "score out"; a return is not a row of its own.
  const open = new Map() // `${set}:${team}` -> rows of that team and set
  for (const e of list) {
    if (e.type !== 'substitution' || !isTeam(e.payload?.team)) continue
    const p = e.payload
    const key = `${setOf(e)}:${p.team}`
    const rows = open.get(key) || []
    open.set(key, rows)
    const score = teamFirstScore(points, e, p.team)
    const leaving = [...rows].reverse().find(r => r.scoreOut === '' && same(r.in, p.playerOut))
    if (leaving) leaving.scoreOut = score
    // an exceptional substitution goes to the remarks on paper (not the
    // grid): listed with the injuries; a regular one for an injury in both
    const exceptional = p.isExceptional === true
    if ((exceptional || p.isInjury === true) && inSetFilter(e, setFilter)) {
      const reason = exceptionalReason(p)
      const params = { in: num(p.playerIn), out: num(p.playerOut) }
      out.injuries.push({
        id: e.id,
        setIndex: setOf(e),
        set: setNo(e),
        score,
        team: letter(p.team),
        number: num(p.playerOut),
        kind: exceptional ? 'exceptional' : 'injury',
        what: [
          exceptional
            ? tr(t, 'history.what.exceptional', 'Exceptional substitution: #{{in}} in for #{{out}}', params)
            : tr(t, 'history.what.injurySub', 'Substitution for injury: #{{in}} in for #{{out}}', params),
          reason ? reasonLabel(reason, t) : ''
        ].filter(Boolean).join(' · ')
      })
    }
    if (exceptional) continue
    // the return of the player the substitute replaced: the row is complete
    if (leaving && same(leaving.out, p.playerIn)) continue
    const row = { id: e.id, setIndex: setOf(e), set: setNo(e), in: num(p.playerIn), out: num(p.playerOut), scoreIn: score, scoreOut: '', team: letter(p.team) }
    rows.push(row)
  }
  for (const [key, rows] of open) {
    const team = key.split(':')[1]
    for (const r of rows) {
      if (!inSetFilter({ setIndex: r.setIndex }, setFilter)) continue
      out.substitutions[letter(team)]?.push(r)
    }
  }
  // by set; within a set in log order (the sort is stable)
  const bySet = (a, b) => a.setIndex - b.setIndex
  out.substitutions.A.sort(bySet)
  out.substitutions.B.sort(bySet)

  for (const e of list) {
    if (!inSetFilter(e, setFilter)) continue
    const p = e.payload || {}
    if (e.type === 'sanction' && isTeam(p.team)) {
      const type = p.type || p.sanctionType
      const base = { id: e.id, setIndex: setOf(e), set: setNo(e), score: teamFirstScore(points, e, p.team), team: letter(p.team) }
      if (type === 'improper_request') { out.improperRequests.push(base); continue }
      if (type === 'delay_warning' || type === 'delay_penalty') {
        const kind = type === 'delay_warning' ? 'warning' : 'penalty'
        out.sanctions.push({ ...base, type, column: SANCTION_COLUMNS[kind], code: 'D', delay: true })
        continue
      }
      if (MEMBER_SANCTIONS.includes(type)) {
        const code = has(p.playerNumber) ? String(p.playerNumber) : (sanctionTarget(p, t).code || '?')
        out.sanctions.push({ ...base, type, column: SANCTION_COLUMNS[type], code, delay: false })
      }
      continue
    }
    if (e.type === 'timeout' && isTeam(p.team)) {
      out.timeouts.push({ id: e.id, setIndex: setOf(e), set: setNo(e), score: teamFirstScore(points, e, p.team), team: letter(p.team) })
      continue
    }
    if (e.type === 'libero_unable' && isTeam(p.team)) {
      out.injuries.push({
        id: e.id,
        setIndex: setOf(e),
        set: setNo(e),
        score: teamFirstScore(points, e, p.team),
        team: letter(p.team),
        number: num(p.liberoNumber),
        kind: 'liberoUnable',
        what: [
          tr(t, 'corrections.describe.liberoUnable', 'Libero #{{n}} declared unable to play', { n: num(p.liberoNumber) }),
          p.reason ? reasonLabel(p.reason, t) : ''
        ].filter(Boolean).join(' · ')
      })
      continue
    }
    if (e.type === 'bench_injury' && isTeam(p.team)) {
      out.injuries.push({
        id: e.id,
        setIndex: setOf(e),
        set: setNo(e),
        score: teamFirstScore(points, e, p.team),
        team: letter(p.team),
        number: num(p.playerNumber),
        kind: 'benchInjury',
        what: tr(t, 'corrections.describe.benchInjury', 'Injury: player #{{n}} (bench)', { n: num(p.playerNumber) })
      })
    }
  }
  // the injuries in log order (substitutions were collected in the first pass)
  const seqOf = new Map(list.map((e, i) => [e.id, i]))
  out.injuries.sort((a, b) => (seqOf.get(a.id) ?? 0) - (seqOf.get(b.id) ?? 0))
  return out
}
