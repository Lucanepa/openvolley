// A synthetic best-of-3 match record as lib/scoresheets.js renderRecord sends
// it (the same shape GET /api/scoresheets/:id/match returns, plus approvals):
// won 2:1, deciding set 15:13 (index 5), a warning, remarks, a correction,
// liberos and a captain. No real names.
const seed = 'match_1792931096817_vector'
const at = (min, sec = 0) => new Date(Date.parse('2026-11-15T14:00:00Z') + (min * 60 + sec) * 1000).toISOString()
const POS = ['I', 'II', 'III', 'IV', 'V', 'VI']
const lineupOf = (list) => Object.fromEntries(POS.map((p, i) => [p, String(list[i])]))

export function fixtureRecord ({ longRemarks = false } = {}) {
  let seq = 0
  let id = 100
  const events = []
  const push = (setIndex, type, payload, ts) => events.push({ external_id: `${seed}:e:${++id}`, seq: ++seq, set_index: setIndex, type, payload, ts, created_at: ts })
  push(1, 'coin_toss', {}, at(10))
  const sets = []
  const plan = [[1, 25, 20, 15], [2, 20, 25, 40], [5, 15, 13, 65]]
  for (const [index, h, a, startMin] of plan) {
    push(index, 'lineup', { team: 'home', lineup: lineupOf([1, 2, 3, 4, 5, 6]), isInitial: true }, at(startMin - 1))
    push(index, 'lineup', { team: 'away', lineup: lineupOf([21, 22, 23, 24, 25, 26]), isInitial: true }, at(startMin - 1))
    push(index, 'set_start', { startTime: at(startMin) }, at(startMin))
    let hh = 0
    let aa = 0
    let k = 0
    while (hh < h || aa < a) {
      const team = (hh < h && (aa >= a || (hh + aa) % 3 !== 0)) ? 'home' : 'away'
      if (team === 'home') hh++; else aa++
      push(index, 'point', { team, score: { home: hh, away: aa } }, at(startMin, 30 * ++k))
      if (index === 1 && hh + aa === 5) push(1, 'sanction', { team: 'away', type: 'warning', playerNumber: 22, playerType: 'player' }, at(startMin, 30 * k + 5))
    }
    const end = at(startMin, 30 * k)
    push(index, 'set_end', { team: hh > aa ? 'home' : 'away' }, end)
    sets.push({ external_id: `${seed}:s:${index}`, index, home_points: h, away_points: a, finished: true, start_time: at(startMin), end_time: end })
  }
  const remarks = longRemarks
    ? Array.from({ length: 120 }, (_, i) => `Remark line ${i + 1}: the quick brown fox jumps over the lazy dog`).join('\n')
    : 'Late start: the hall was busy'
  return {
    match: {
      id: '11111111-1111-4111-8111-111111111111', external_id: seed, game_n: 424849, status: 'final', test: false, sport_type: 'indoor',
      scheduled_at: at(15), closed_at: at(95),
      home_team: { name: 'Home Volley Club', short_name: 'HOME' }, away_team: { name: 'Away Volley Club', short_name: 'AWAY' },
      players_home: [1, 2, 3, 4, 5, 6, 9].map(n => ({ number: n, first_name: 'Anna', last_name: `Home${n}`, dob: '2006-04-05', is_captain: n === 1, libero: n === 9 ? 'libero1' : '' })),
      players_away: [21, 22, 23, 24, 25, 26, 27].map(n => ({ number: n, first_name: 'Bea', last_name: `Away${n}`, dob: '2007-01-02', is_captain: n === 21, libero: n === 27 ? 'libero1' : '' })),
      officials: [
        { role: '1st referee', firstName: 'Uma', lastName: 'Gruyen', country: 'CHE', dob: '1986-03-12' },
        { role: 'scorer', firstName: 'Lia', lastName: 'Scorer', country: 'CHE', dob: '1993-07-16' }
      ],
      coin_toss: { team_a: 'home', team_b: 'away', confirmed: true, first_serve: 'home' },
      match_info: { best_of: 3, league: 'SM-Quali-U23', hall: 'Sporthalle Nord', city: 'Musterstadt', set5_left_team: 'B', set5_first_serve: 'B', tz: 'Europe/Zurich' },
      remarks,
      manual_changes: [{ afterMatch: true, action: 'setTimes', setIndex: 2, text: 'Set 2 times corrected', after: { startTime: at(40) } }],
      set_results: []
    },
    sets,
    events,
    liveState: null,
    approvals: []
  }
}
