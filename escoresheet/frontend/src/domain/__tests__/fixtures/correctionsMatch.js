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
 */
import { rotateLineup } from '../../rotation'
import { getFirstServeForSet } from '../../rules'

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
        if (x.type === 'substitution') {
          const team = x.payload.team
          const pos = Object.keys(lineups[team]).find(k => lineups[team][k] === x.payload.playerOut)
          lineups[team][pos] = x.payload.playerIn
          row.payload.position = pos
          add(setIndex, 'lineup', { team, lineup: { ...lineups[team] }, fromSubstitution: true }, row.seq + 0.1)
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
        add(setIndex, 'lineup', { team, lineup: { ...lineups[team] }, liberoSubstitution: null }, point.seq + 0.1)
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
 * Points string for a set ending home:away: the two teams' points mixed
 * (two of one, one of the other) and the winner's last point at the end.
 */
export function pointsFor(home, away) {
  const winner = home > away ? 'H' : 'A'
  let h = winner === 'H' ? home - 1 : home
  let a = winner === 'A' ? away - 1 : away
  const out = []
  let i = 0
  while (h > 0 || a > 0) {
    const pickH = (i % 3 !== 2 && h > 0) || a === 0
    if (pickH) { out.push('H'); h-- } else { out.push('A'); a-- }
    i++
  }
  out.push(winner)
  return out.join('')
}
