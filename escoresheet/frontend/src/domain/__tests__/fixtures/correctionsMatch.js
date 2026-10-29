/**
 * A match event log written the way the live Scoreboard writes it, for the
 * corrections tests (and the screenshot seed): one global seq across the
 * match, integer seqs for main events, N.1 for the side-out rotation line-up
 * of a point, rally_start before every point, set_start + starting line-ups
 * at the beginning of a set and set_end after its last point.
 *
 * buildMatch({
 *   firstServe: 'home',
 *   sets: [{ points: 'HHAH…', extras: [{ at: 5, type: 'timeout', payload: { team: 'home' } }], finished: true }]
 * })
 * `at` = number of points already played when the extra event is logged.
 * Libero replacements are written as the scoreboard writes them:
 *   { at, type: 'libero_entry', payload: { team, playerOut, liberoIn } } and
 *   { at, type: 'libero_exit', payload: { team } } with their line-up
 *   sub-rows; a rotation that takes the libero to the front row writes the
 *   automatic libero_exit (N.1) before the rotation line-up (N.2).
 */
import { rotateLineup } from '../../rotation'
import { getFirstServeForSet } from '../../rules'

const MOVE = { I: 'VI', II: 'I', III: 'II', IV: 'III', V: 'IV', VI: 'V' }

export const HOME_LINEUP = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 }
export const AWAY_LINEUP = { I: 11, II: 12, III: 13, IV: 14, V: 15, VI: 16 }

export const MATCH = {
  id: 1,
  bestOf: 5,
  firstServe: 'home',
  coinTossTeamA: 'home',
  coinTossTeamB: 'away',
  coinTossServeA: true,
  status: 'ended'
}
export const HOME_TEAM = { id: 10, name: 'VC Smash', color: '#2563eb' }
export const AWAY_TEAM = { id: 20, name: 'Volley Bern', color: '#dc2626' }

export function buildMatch({ sets = [], match = MATCH, start = Date.parse('2026-10-03T18:00:00Z') } = {}) {
  const events = []
  const setRows = []
  let seq = 1
  let id = 1
  let clock = start
  const add = (setIndex, type, payload, s = null) => {
    clock += 15000
    const row = { id: id++, matchId: match.id, setIndex, type, payload, seq: s ?? seq++, ts: new Date(clock).toISOString() }
    events.push(row)
    return row
  }
  add(1, 'coin_toss', { teamA: 'home', teamB: 'away', firstServe: match.firstServe })

  sets.forEach((def, i) => {
    const setIndex = def.index || i + 1
    const lineups = { home: { ...(def.homeLineup || HOME_LINEUP) }, away: { ...(def.awayLineup || AWAY_LINEUP) } }
    const ls = { home: null, away: null }
    const startTime = new Date(clock + 60000).toISOString()
    add(setIndex, 'set_start', { setIndex })
    add(setIndex, 'lineup', { team: 'home', lineup: { ...lineups.home }, isInitial: true })
    add(setIndex, 'lineup', { team: 'away', lineup: { ...lineups.away }, isInitial: true })
    let server = getFirstServeForSet(setIndex, match)
    let home = 0
    let away = 0
    const extrasAt = (n) => (def.extras || []).filter(x => x.at === n)
    const logExtras = (n) => {
      for (const x of extrasAt(n)) {
        const row = add(setIndex, x.type, x.payload)
        const team = x.payload?.team
        if (x.type === 'substitution') {
          const pos = Object.keys(lineups[team]).find(k => lineups[team][k] === x.payload.playerOut)
          lineups[team][pos] = x.payload.playerIn
          row.payload.position = pos
          const lp = { team, lineup: { ...lineups[team] }, fromSubstitution: true }
          if (ls[team]) lp.liberoSubstitution = { ...ls[team] }
          add(setIndex, 'lineup', lp, row.seq + 0.1)
        } else if (x.type === 'libero_entry') {
          const pos = Object.keys(lineups[team]).find(k => lineups[team][k] === x.payload.playerOut)
          lineups[team][pos] = String(x.payload.liberoIn)
          row.payload = { liberoType: 'libero1', ...x.payload, position: pos }
          ls[team] = { position: pos, liberoNumber: x.payload.liberoIn, playerNumber: x.payload.playerOut, liberoType: row.payload.liberoType }
          add(setIndex, 'lineup', { team, lineup: { ...lineups[team] }, liberoSubstitution: { ...ls[team] } }, row.seq + 0.1)
        } else if (x.type === 'libero_exit') {
          const cur = ls[team]
          lineups[team][cur.position] = cur.playerNumber
          row.payload = { ...x.payload, position: cur.position, liberoOut: cur.liberoNumber, playerIn: cur.playerNumber, liberoType: cur.liberoType }
          ls[team] = null
          add(setIndex, 'lineup', { team, lineup: { ...lineups[team] }, fromSubstitution: true, liberoSubstitution: null }, row.seq + 0.1)
        }
      }
    }
    logExtras(0)
    const pts = def.points || ''
    for (let p = 0; p < pts.length; p++) {
      const team = pts[p] === 'H' ? 'home' : 'away'
      add(setIndex, 'rally_start', {})
      if (team === 'home') home++
      else away++
      const point = add(setIndex, 'point', { team, score: { home, away } })
      if (server !== team) {
        lineups[team] = rotateLineup(lineups[team])
        let sub = 1
        if (ls[team]) {
          const pos = MOVE[ls[team].position]
          if (['II', 'III', 'IV'].includes(pos)) {
            lineups[team][pos] = String(ls[team].playerNumber)
            add(setIndex, 'libero_exit', { team, position: pos, liberoOut: ls[team].liberoNumber, playerIn: ls[team].playerNumber, liberoType: ls[team].liberoType, reason: 'rotation_to_front_row' }, point.seq + 0.1)
            sub = 2
            ls[team] = null
          } else {
            ls[team] = { ...ls[team], position: pos }
          }
        }
        add(setIndex, 'lineup', { team, lineup: { ...lineups[team] }, liberoSubstitution: ls[team] ? { ...ls[team] } : null }, Math.round((point.seq + sub / 10) * 1000) / 1000)
        server = team
      }
      logExtras(p + 1)
    }
    const row = { id: 100 + setIndex, matchId: match.id, index: setIndex, homePoints: home, awayPoints: away, finished: !!def.finished, startTime, endTime: null }
    if (def.finished) {
      const endTime = new Date(clock + 60000).toISOString()
      row.endTime = endTime
      add(setIndex, 'set_end', { team: home > away ? 'home' : 'away', teamLabel: home > away ? 'A' : 'B', setIndex, homePoints: home, awayPoints: away, startTime, endTime })
    }
    setRows.push(row)
  })
  return { events, sets: setRows, match }
}

/**
 * Points string for a set ending home:away: the points spread evenly (the
 * team further behind its final total scores next) and the winner's point
 * last. 25:20 passes 12:10, 20:16, ...
 */
export function pointsFor(home, away) {
  const winner = home > away ? 'H' : 'A'
  const H = winner === 'H' ? home - 1 : home
  const A = winner === 'A' ? away - 1 : away
  let h = 0
  let a = 0
  const out = []
  while (h < H || a < A) {
    const pickH = a >= A || (h < H && h * A <= a * H)
    if (pickH) { out.push('H'); h++ } else { out.push('A'); a++ }
  }
  out.push(winner)
  return out.join('')
}
