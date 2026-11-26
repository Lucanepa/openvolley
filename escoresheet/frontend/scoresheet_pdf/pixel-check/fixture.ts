/**
 * The pixel-check match (scripts/sheet-pixels.mjs): a best-of-3 won 2:1 whose
 * deciding set goes past the change of courts, with sanctions, two liberos a
 * team, bench officials, signatures, remarks and approval names with
 * descenders (g, y). Synthetic names only.
 */

// A drawn signature: a squiggle as an SVG picture (no file needed)
const SIGNATURE = 'data:image/svg+xml;base64,' + btoa(
  '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60" viewBox="0 0 240 60">' +
  '<path d="M8 40 C 30 5, 45 55, 70 30 S 110 10, 130 35 S 170 55, 190 25 S 225 20, 232 32" fill="none" stroke="#111" stroke-width="3"/></svg>')

const T0 = new Date(2026, 10, 15, 15, 15).getTime()

export function pixelCheckMatch() {
  const p = (n: number, last: string, extra: Record<string, unknown> = {}) =>
    ({ number: n, firstName: 'Anna Maria', lastName: last, dob: '2006-04-05', ...extra })
  const home = [1, 5, 6, 7, 8, 9, 13, 15, 27].map((n, i) =>
    p(n, ['Muster', 'Beispiel', 'Probst', 'Gerber', 'Keller', 'Jäger', 'Schmid', 'Frei', 'Graf'][i], { isCaptain: n === 1 }))
  home.push(p(38, 'Vogel', { libero: 'libero1' }), p(19, 'Brunner', { libero: 'libero2' }))
  const away = [3, 4, 7, 8, 9, 12, 16, 41].map((n, i) =>
    p(n, ['Huber', 'Meier', 'Weber', 'Fischer', 'Baumann', 'Moser', 'Zimmermann', 'Roth'][i], { isCaptain: n === 9 }))
  away.push(p(20, 'Lehmann', { libero: 'libero1' }), p(14, 'Bühler', { libero: 'libero2' }))

  const events: any[] = []
  const sets: any[] = []
  let seq = 1
  const scores = [[25, 20], [20, 25], [15, 13]]
  scores.forEach(([h, a], si) => {
    const idx = si === 2 ? 5 : si + 1
    let ts = T0 + si * 25 * 60000
    const start = ts
    const lineup = (team: string, l: Record<string, number>) =>
      events.push({ type: 'lineup', setIndex: idx, seq: seq++, ts: new Date(ts).toISOString(), payload: { team, lineup: l, isInitial: true } })
    lineup('home', { I: 5, II: 1, III: 7, IV: 13, V: 8, VI: 6 })
    lineup('away', { I: 41, II: 12, III: 9, IV: 7, V: 4, VI: 16 })
    let hh = 0
    let aa = 0
    while (hh < h || aa < a) {
      const team = (hh < h && (aa >= a || (hh + aa) % 3 !== 0)) ? 'home' : 'away'
      if (team === 'home') hh++
      else aa++
      events.push({ type: 'rally_start', setIndex: idx, seq: seq++, ts: new Date(ts).toISOString(), payload: {} })
      ts += 25000
      events.push({ type: 'point', setIndex: idx, seq: seq++, ts: new Date(ts).toISOString(), payload: { team } })
      if (idx === 1 && hh + aa === 5) events.push({ type: 'sanction', setIndex: 1, seq: seq++, ts: new Date(ts).toISOString(), payload: { team: 'away', type: 'warning', playerNumber: 12, playerType: 'player' } })
      if (idx === 5 && hh + aa === 10) events.push({ type: 'sanction', setIndex: 5, seq: seq++, ts: new Date(ts).toISOString(), payload: { team: 'home', type: 'penalty', playerNumber: 5, playerType: 'player' } })
    }
    sets.push({ index: idx, homePoints: h, awayPoints: a, finished: true, startTime: new Date(start).toISOString(), endTime: new Date(ts).toISOString() })
  })

  return {
    match: {
      id: 1, status: 'ended', bestOf: 3, set5LeftTeam: 'B', set5FirstServe: 'B',
      coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true,
      gameNumber: '900001', league: 'TEST LEAGUE',
      scheduledAt: new Date(T0).toISOString(), hall: 'Testhalle 1', city: 'Musterdorf',
      remarks: 'Corrected after the match: Set 2 times corrected (entered after the match)',
      bench_home: [{ role: 'Coach', firstName: 'Paul', lastName: 'Steiner', dob: '1987-10-10' }, { role: 'Assistant Coach 1', firstName: 'Kurt', lastName: 'Egli', dob: '1990-05-15' }],
      bench_away: [{ role: 'Coach', firstName: 'Lena', lastName: 'Kunz', dob: '2004-01-25' }],
      officials: [
        { role: '1st referee', firstName: 'Yves', lastName: 'Gyger', country: 'CHE', dob: '1986-03-12', signature: SIGNATURE },
        { role: 'scorer', firstName: 'Jürg', lastName: 'Bergqvist', country: 'CHE', dob: '1993-07-16', signature: SIGNATURE }
      ],
      homeCaptainSignature: SIGNATURE, homeCoachSignature: SIGNATURE, awayCaptainSignature: SIGNATURE, awayCoachSignature: SIGNATURE
    },
    homeTeam: { name: 'VBC Musterdorf' },
    awayTeam: { name: 'Volley Beispielstadt' },
    homePlayers: home,
    awayPlayers: away,
    sets,
    events
  }
}
