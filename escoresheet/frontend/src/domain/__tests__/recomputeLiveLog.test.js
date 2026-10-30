/**
 * The rebuild (domain/recompute) against logs written the way the live
 * Scoreboard writes them — its payload shapes, value types and seq rules
 * (components/Scoreboard.jsx handlePoint, confirmSubstitution,
 * handleSanctionSubstitution, the libero entry / exit / exchange handlers,
 * confirmSanction's libero expulsion, handleDecisionChange). A correction runs
 * the rebuild over the whole match, so on such a log it must change nothing.
 */
import { describe, it, expect } from 'vitest'
import { recomputeMatch, applyPlanToEvents } from '../recompute'
import { planSetLineup, planRemoveEntry, planCoinToss } from '../manualCorrections'
import { compareBySeq } from '../describe'
import { rotateLineup } from '../rotation'
import { getFirstServeForSet } from '../rules'

const MOVE = { I: 'VI', II: 'I', III: 'II', IV: 'III', V: 'IV', VI: 'V' }
const FRONT = ['II', 'III', 'IV']
const same = (a, b) => a != null && b != null && String(a) === String(b)

const ROSTER = {
  home: [1, 2, 3, 4, 5, 6, 7, 8, 10, 11].map(n => ({ id: n, number: n, libero: '' }))
    .concat([{ id: 9, number: 9, libero: 'libero1' }, { id: 12, number: 12, libero: 'libero2' }]),
  away: [21, 22, 23, 24, 25, 26, 27, 28].map(n => ({ id: n, number: n, libero: '' }))
    .concat([{ id: 29, number: 29, libero: 'libero1' }])
}
const MATCH = { id: 1, bestOf: 5, firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true, status: 'live' }
const CTX = { match: MATCH, homeTeam: { name: 'Home' }, awayTeam: { name: 'Away' }, matchId: 1, players: ROSTER }

/** A tiny live scorer: the Scoreboard's writes, step by step. */
function liveScorer(initialMatch = MATCH) {
  let match = initialMatch
  const events = []
  let clock = Date.parse('2026-10-03T18:00:00Z')
  const voided = [] // seqs of deleted rows (event history: never given out again)
  let set = 1
  const score = { home: 0, away: 0 }
  const maxSeq = () => Math.max(0, ...events.map(e => e.seq || 0))
  const nextSeq = () => Math.max(Math.floor(maxSeq()), Math.floor(Math.max(0, ...voided))) + 1
  const nextSubSeq = (parent) => {
    const base = Math.floor(parent)
    const inBase = events.filter(e => Math.floor(e.seq) === base).map(e => e.seq)
    const v = voided.filter(s => Math.floor(s) === base)
    const max = Math.max(base, ...inBase, ...v) - base
    return base + Math.round((max + 0.1) * 10) / 10
  }
  const add = (type, payload, seq, setIndex = set) => {
    clock += 5000
    const id = Math.max(0, ...events.map(e => (typeof e.id === 'number' ? e.id : 0))) + 1
    const row = { id, matchId: 1, setIndex, type, payload, seq, ts: new Date(clock).toISOString() }
    events.push(row)
    return row
  }
  const log = (type, payload, opts = {}) => add(type, payload, opts.parentSeq !== undefined ? nextSubSeq(opts.parentSeq) : nextSeq())
  const del = (row) => {
    const i = events.indexOf(row)
    if (i >= 0) { events.splice(i, 1); voided.push(row.seq) }
  }
  const lineupRows = (team) => events.filter(e => e.type === 'lineup' && e.payload?.team === team && e.setIndex === set).sort(compareBySeq)
  const lastLineup = (team) => lineupRows(team).pop()
  const roster = (team) => ROSTER[team]
  const isLibero = (team, n) => roster(team).some(p => same(p.number, n) && p.libero && p.libero !== '')
  const liberoOnCourt = (team) => {
    const row = lastLineup(team)
    const ls = row?.payload?.liberoSubstitution
    if (!ls) return null
    return same(row.payload.lineup?.[ls.position], ls.liberoNumber) ? ls : null
  }
  const positionOf = (team, n) => Object.keys(lastLineup(team).payload.lineup).find(p => same(lastLineup(team).payload.lineup[p], n))

  const api = {
    events,
    setMatch(m) { match = m },
    startSet(index, lineups) {
      set = index
      score.home = 0
      score.away = 0
      log('set_start', { setIndex: index })
      for (const team of ['home', 'away']) log('lineup', { team, lineup: { ...lineups[team] }, isInitial: true })
    },
    point(team) {
      const points = events.filter(e => e.type === 'point' && e.setIndex === set).sort(compareBySeq)
      const serveBefore = points.length ? points[points.length - 1].payload.team : getFirstServeForSet(set, match)
      score[team] += 1
      const point = log('point', { team, score: { home: score.home, away: score.away } })
      if (serveBefore !== team) api.rotate(team, point)
      return point
    },
    rotate(team, point, reason = 'rotation_to_front_row', extra = {}) {
      const cur = lastLineup(team)
      if (!cur) return
      const rotated = rotateLineup(cur.payload.lineup)
      const ls = cur.payload.liberoSubstitution
      let rls = ls ? { ...ls, position: MOVE[ls.position] } : null
      const front = Object.entries(rotated).find(([pos, n]) => FRONT.includes(pos) && isLibero(team, n))
      if (front) {
        const [position, liberoNumber] = front
        let original = rls && same(rls.liberoNumber, liberoNumber) ? rls.playerNumber : null
        if (!original) {
          for (const row of lineupRows(team).reverse()) {
            if (row.payload?.liberoSubstitution && same(row.payload.liberoSubstitution.liberoNumber, liberoNumber)) { original = row.payload.liberoSubstitution.playerNumber; break }
          }
        }
        if (original) {
          rotated[position] = String(original)
          rls = null
          const libero = roster(team).find(p => same(p.number, liberoNumber))
          add('libero_exit', { team, position, liberoOut: liberoNumber, playerIn: original, liberoType: libero?.libero, reason }, nextSubSeq(point.seq))
        } else {
          rls = null
        }
      }
      add('lineup', { team, lineup: rotated, liberoSubstitution: rls, ...extra }, nextSubSeq(point.seq))
    },
    sub(team, playerOut, playerIn, flags = {}) {
      const cur = lastLineup(team)
      const position = positionOf(team, playerOut)
      const lineup = { ...cur.payload.lineup, [position]: String(playerIn) }
      const sub = log('substitution', { team, position, playerOut, playerIn, isExceptional: !!flags.isExceptional, isExpelled: !!flags.isExpelled, isDisqualified: !!flags.isDisqualified })
      const lp = { team, lineup, fromSubstitution: true }
      if (cur.payload.liberoSubstitution) lp.liberoSubstitution = cur.payload.liberoSubstitution
      add('lineup', lp, sub.seq + 0.1)
      return sub
    },
    liberoIn(team, playerOut, liberoNumber) {
      const cur = lastLineup(team)
      const position = positionOf(team, playerOut)
      const libero = roster(team).find(p => same(p.number, liberoNumber))
      log('libero_entry', { team, position, playerOut, liberoIn: libero.number, liberoType: libero.libero })
      add('lineup', {
        team,
        lineup: { ...cur.payload.lineup, [position]: String(libero.number) },
        liberoSubstitution: { position, liberoNumber: libero.number, playerNumber: playerOut, liberoType: libero.libero }
      }, Math.floor(maxSeq()) + 0.1)
    },
    liberoOut(team) {
      const ls = liberoOnCourt(team)
      const cur = lastLineup(team)
      const lineup = { ...cur.payload.lineup, [ls.position]: String(ls.playerNumber) }
      log('libero_exit', { team, position: ls.position, liberoOut: ls.liberoNumber, playerIn: ls.playerNumber, liberoType: ls.liberoType })
      add('lineup', { team, lineup, fromSubstitution: true, liberoSubstitution: null }, Math.floor(maxSeq()) + 0.1)
    },
    exchange(team, otherNumber) {
      const ls = liberoOnCourt(team)
      const cur = lastLineup(team)
      const other = roster(team).find(p => same(p.number, otherNumber))
      log('libero_exchange', { team, position: ls.position, liberoOut: ls.liberoNumber, liberoIn: other.number, liberoOutType: ls.liberoType, liberoInType: other.libero, playerNumber: ls.playerNumber })
      add('lineup', {
        team,
        lineup: { ...cur.payload.lineup, [ls.position]: String(other.number) },
        liberoSubstitution: { position: ls.position, liberoNumber: other.number, playerNumber: ls.playerNumber, liberoType: other.libero }
      }, Math.floor(maxSeq()) + 0.1)
    },
    /** The player the libero replaced is expelled from the bench: the libero stays (handleSanctionSubstitution). */
    expelReplacedPlayer(team, substitute) {
      const ls = liberoOnCourt(team)
      log('sanction', { team, type: 'expulsion', playerType: 'player', playerNumber: ls.playerNumber })
      const sub = log('substitution', { team, position: ls.position, playerOut: ls.playerNumber, playerIn: substitute, isExpelled: true, isDisqualified: false, isExceptional: false, isLiberoReplacementSub: true })
      const cur = lastLineup(team)
      log('lineup', { team, lineup: { ...cur.payload.lineup }, liberoSubstitution: { ...cur.payload.liberoSubstitution, playerNumber: substitute } }, { parentSeq: sub.seq })
    },
    /** The libero on court is expelled: the player he replaced comes back (confirmSanction). */
    expelLibero(team) {
      const ls = liberoOnCourt(team)
      const libero = roster(team).find(p => same(p.number, ls.liberoNumber))
      log('sanction', { team, type: 'expulsion', playerType: 'player', playerNumber: ls.liberoNumber, position: ls.position })
      log('libero_unable', { team, liberoNumber: ls.liberoNumber, liberoType: libero.libero, reason: 'expulsion' })
      const cur = lastLineup(team)
      const exit = log('libero_exit', { team, position: ls.position, liberoOut: ls.liberoNumber, playerIn: ls.playerNumber, liberoType: libero.libero, reason: 'expulsion' })
      add('lineup', { team, lineup: { ...cur.payload.lineup, [ls.position]: String(ls.playerNumber) }, fromSubstitution: true, liberoSubstitution: null }, exit.seq + 0.1)
    },
    timeout(team) { log('timeout', { team }) },
    rallyStart() { add('rally_start', {}, nextSeq()) },
    /** Decision change: the last point to the other team (handleDecisionChange). */
    decisionChange() {
      const point = events.filter(e => e.type === 'point' && e.setIndex === set).sort(compareBySeq).pop()
      const oldTeam = point.payload.team
      const newTeam = oldTeam === 'home' ? 'away' : 'home'
      score[oldTeam] -= 1
      score[newTeam] += 1
      point.payload = { ...point.payload, team: newTeam, swappedFrom: oldTeam }
      const old = events.filter(e => Math.floor(e.seq) === point.seq && e.seq !== point.seq && e.payload?.team === oldTeam)
      old.forEach(del)
      log('decision_change', { reason: 'point_swap', fromTeam: oldTeam, toTeam: newTeam, pointEventId: point.id })
      const before = events.filter(e => e.type === 'point' && e.setIndex === set && e.seq < point.seq).sort(compareBySeq).pop()
      const serveBefore = before ? before.payload.team : getFirstServeForSet(set, match)
      if (serveBefore !== newTeam) api.rotate(newTeam, point, 'rotation_to_front_row_decision_change', { isInitial: false, fromRotation: true, fromDecisionChange: true })
    },
    /** Undo: the newest main entry and its sub-rows (and the rally start of a point). */
    undo() {
      const last = [...events].sort(compareBySeq).pop()
      const base = Math.floor(last.seq)
      const rows = events.filter(e => Math.floor(e.seq) === base)
      const point = rows.find(e => e.type === 'point')
      if (point) score[point.payload.team] -= 1
      rows.forEach(del)
      if (point) {
        const rs = [...events].sort(compareBySeq).filter(e => e.type === 'rally_start').pop()
        if (rs) del(rs)
      }
    },
    endSet(winner) {
      log('set_end', { team: winner, setIndex: set, homePoints: score.home, awayPoints: score.away })
    },
    score,
    liberoOnCourt
  }
  return api
}

const play = (s, pattern) => { for (const c of pattern) { s.rallyStart(); s.point(c === 'H' ? 'home' : 'away') } }
const HOME_LU = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 }
const AWAY_LU = { I: 21, II: 22, III: 23, IV: 24, V: 25, VI: 26 }

function expectNoOp(events, ctx = CTX) {
  const rc = recomputeMatch(events, ctx)
  expect({ add: rc.add, update: rc.update, remove: rc.remove }).toEqual({ add: [], update: [], remove: [] })
  // and nothing is listed under "Check these entries"
  expect(rc.issues.map(i => i.text)).toEqual([])
  return rc
}

describe('recompute is a no-op on logs the live scoreboard wrote', () => {
  it('libero in at the start, rotations take him off, back in, exchange, out by hand', () => {
    const s = liveScorer()
    s.startSet(1, { home: HOME_LU, away: AWAY_LU })
    s.liberoIn('away', 25, 29) // receiving team, position V
    play(s, 'AHAHHAAHAHAAHHAH')
    s.liberoIn('home', 6, 9)
    play(s, 'AHHAAHAAH')
    if (s.liberoOnCourt('home')) s.exchange('home', 12)
    play(s, 'AHAH')
    if (s.liberoOnCourt('home')) s.liberoOut('home')
    play(s, 'HAHA')
    expect(s.events.some(e => e.type === 'libero_exit' && e.payload.reason === 'rotation_to_front_row')).toBe(true)
    expectNoOp(s.events)
  })

  it('expulsion of the player the libero replaced, then the libero rotates off (the substitute comes on)', () => {
    const s = liveScorer()
    s.startSet(1, { home: HOME_LU, away: AWAY_LU })
    s.liberoIn('home', 1, 9) // position I: rotates to VI, V, then IV (front row)
    s.rallyStart(); s.point('away')
    s.rallyStart(); s.point('home')
    s.expelReplacedPlayer('home', 7)
    play(s, 'AHAHAH')
    const exit = s.events.find(e => e.type === 'libero_exit' && e.payload.team === 'home')
    expect(String(exit.payload.playerIn)).toBe('7')
    expectNoOp(s.events)
  })

  it('the libero on court expelled: the replaced player returns', () => {
    const s = liveScorer()
    s.startSet(1, { home: HOME_LU, away: AWAY_LU })
    s.liberoIn('home', 5, 9)
    play(s, 'HHA')
    s.expelLibero('home')
    play(s, 'HAHAAH')
    expectNoOp(s.events)
  })

  it('exceptional and expulsion substitutions with a libero on court for another player', () => {
    const s = liveScorer()
    s.startSet(1, { home: HOME_LU, away: AWAY_LU })
    s.liberoIn('home', 6, 9)
    play(s, 'HAH')
    s.sub('home', 3, 7, { isExpelled: true })
    play(s, 'AHAH')
    s.sub('home', 2, 8, { isExceptional: true })
    play(s, 'AHAHAH')
    expectNoOp(s.events)
  })

  it('a decision change with the new team rotating (and its libero leaving the front row)', () => {
    const s = liveScorer()
    s.startSet(1, { home: HOME_LU, away: AWAY_LU })
    s.liberoIn('away', 25, 29)
    play(s, 'AHHH') // away rotated once (libero to IV? no: V -> IV is front row)
    s.rallyStart(); s.point('home')
    s.decisionChange()
    play(s, 'AHAH')
    // the swap keeps the point's old running score (handleDecisionChange
    // spreads the old payload): the rebuild only puts that number right
    const swapped = s.events.find(e => e.payload?.swappedFrom)
    const rc = recomputeMatch(s.events, CTX)
    expect([rc.add, rc.remove]).toEqual([[], []])
    expect(rc.update.map(u => u.id)).toEqual([swapped.id])
    expect(Object.keys(rc.update[0].changes.payload)).toEqual(Object.keys(swapped.payload))
    expect(rc.update[0].changes.payload.team).toBe(swapped.payload.team)
  })

  it('undo of points, substitutions and libero actions, then play on', () => {
    const s = liveScorer()
    s.startSet(1, { home: HOME_LU, away: AWAY_LU })
    play(s, 'HAHA')
    s.sub('home', 2, 7)
    s.undo()
    s.liberoIn('home', 1, 9)
    s.undo()
    play(s, 'AH')
    s.undo()
    play(s, 'HAAH')
    expectNoOp(s.events)
  })

  it('set 5 with its own coin toss (B serves first)', () => {
    const match = { ...MATCH, set5FirstServe: 'B' }
    const s = liveScorer(match)
    for (const i of [1, 2, 3, 4]) {
      s.startSet(i, { home: HOME_LU, away: AWAY_LU })
      play(s, i % 2 ? 'H'.repeat(25) : 'A'.repeat(25))
      s.endSet(i % 2 ? 'home' : 'away')
    }
    s.startSet(5, { home: HOME_LU, away: AWAY_LU })
    s.liberoIn('home', 5, 9)
    play(s, 'HAHAHAAHHAHAHAH')
    expectNoOp(s.events, { ...CTX, match })
  })

  it('a penalty point, a libero entering before the first rally, an unable libero, a re-designation, a reopened set', () => {
    const s = liveScorer()
    const nextSeq = () => Math.floor(Math.max(...s.events.map(e => e.seq))) + 1
    s.startSet(1, { home: HOME_LU, away: AWAY_LU })
    s.liberoIn('home', 6, 9) // before the first rally
    play(s, 'HAAH')
    s.events.push({ id: 900, matchId: 1, setIndex: 1, type: 'sanction', payload: { team: 'away', type: 'penalty', playerType: 'player', playerNumber: 22 }, seq: nextSeq(), ts: new Date().toISOString() })
    s.point('home') // the penalty's point (handlePoint, with its rotation)
    play(s, 'AHAHAHAAAHHH')
    if (s.liberoOnCourt('home')) s.liberoOut('home')
    s.events.push({ id: 901, matchId: 1, setIndex: 1, type: 'libero_unable', payload: { team: 'home', liberoNumber: 9, liberoType: 'libero1', reason: 'declared' }, seq: nextSeq(), ts: new Date().toISOString() })
    s.events.push({ id: 902, matchId: 1, setIndex: 1, type: 'libero_redesignation', payload: { team: 'home', unableLiberoNumber: 9, newLiberoNumber: 12, reason: 'declared' }, seq: nextSeq(), ts: new Date().toISOString() })
    const back = Object.entries(s.events.filter(e => e.type === 'lineup' && e.payload.team === 'home').sort(compareBySeq).pop().payload.lineup).find(([pos]) => ['I', 'V', 'VI'].includes(pos))
    s.liberoIn('home', back[1], 12)
    while (s.score.home < 24) play(s, 'AH'.slice(s.score.away >= 20 ? 1 : 0))
    // the set end written at 24 by mistake, then "Reopen set": the set end goes, the set is played on
    s.endSet('home')
    s.events.splice(s.events.findIndex(e => e.type === 'set_end'), 1)
    play(s, 'H')
    s.endSet('home')
    expectNoOp(s.events)
  })

  it('best of 3: the deciding set (index 5) with its own coin toss', () => {
    const match = { ...MATCH, bestOf: 3, set5FirstServe: 'A' }
    const s = liveScorer(match)
    s.startSet(1, { home: HOME_LU, away: AWAY_LU }); play(s, 'A'.repeat(25)); s.endSet('away')
    s.startSet(2, { home: HOME_LU, away: AWAY_LU }); play(s, 'H'.repeat(25)); s.endSet('home')
    s.startSet(5, { home: HOME_LU, away: AWAY_LU })
    s.liberoIn('away', 21, 29)
    play(s, 'AAHAHHAHAHHAHAAHAAH')
    expectNoOp(s.events, { ...CTX, match })
  })
})

describe('a correction in the live match, then live scoring goes on', () => {
  // the corrected log as applyCorrectionPlan writes it (new rows get ids)
  const applyTo = (s, plan) => {
    expect(plan.error).toBeUndefined()
    const after = applyPlanToEvents(s.events, plan)
    let next = Math.max(...s.events.map(e => (typeof e.id === 'number' ? e.id : 0))) + 1
    s.events.splice(0, s.events.length, ...after.map(e => (typeof e.id === 'number' ? e : { ...e, id: next++, tempKey: undefined })))
  }

  it('the starting line-up corrected after rallies, a libero entry removed, the first serve corrected: the next rallies follow the corrected court', () => {
    const s = liveScorer()
    s.startSet(1, { home: HOME_LU, away: AWAY_LU })
    s.liberoIn('away', 25, 29)
    play(s, 'AHAHHAAH')
    applyTo(s, planSetLineup(s.events, { setIndex: 1, team: 'home', lineup: { I: 1, II: 2, III: 8, IV: 4, V: 5, VI: 6 } }, CTX))
    play(s, 'HAHA')
    applyTo(s, planRemoveEntry(s.events, s.events.find(e => e.type === 'libero_entry').id, CTX))
    play(s, 'AHHA')
    const match = { ...MATCH, firstServe: 'away', coinTossServeA: false, coinTossServeB: true }
    applyTo(s, planCoinToss(s.events, { firstServe: 'away' }, CTX))
    // the scorer goes on with the corrected match (the set score follows the points)
    s.setMatch(match)
    s.score.home = s.events.filter(e => e.type === 'point' && e.payload.team === 'home').length
    s.score.away = s.events.filter(e => e.type === 'point' && e.payload.team === 'away').length
    play(s, 'HAAH')
    const live = s
    const lastHome = live.events.filter(e => e.type === 'lineup' && e.payload.team === 'home').sort(compareBySeq).pop()
    expect(Object.values(lastHome.payload.lineup).map(String)).toContain('8')
    const rc = recomputeMatch(live.events, { ...CTX, match })
    expect({ add: rc.add, update: rc.update, remove: rc.remove }).toEqual({ add: [], update: [], remove: [] })
  })
})
