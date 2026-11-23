/**
 * Sockets that subscribe to a match before the relay holds it wait for its
 * first accepted sync (server.js admitWaiting). They then get the same
 * snapshot as a socket that joins after the sync: the summary without a PIN,
 * the bundle of the view their PIN proved with one (audit 2611 SEC-09: the
 * waiting sockets got access 'full' with the bundle of the bench of neither
 * team, PIN or not).
 * Boots server.js as a venue relay (--local), and as a cloud relay behind
 * Cloudflare (IS_CLOUD, no database): admitWaiting is the same code.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { bootServer, openSocket, sleep } from './helpers/e2eServer.js'

const PINS = { refereePin: '314159', homeTeamPin: '271828', awayTeamPin: '161803' }
const GAME_PIN = '987654'

const people = (prefix) => [1, 2, 3].map((i) => ({ id: i, number: i + 3, firstName: `${prefix}First${i}`, lastName: `${prefix}Last` }))

function scorerSync(seed) {
  return {
    type: 'sync-match-data',
    matchId: seed,
    match: {
      id: 7,
      seed_key: seed,
      gamePin: GAME_PIN,
      status: 'live',
      coinTossTeamA: 'home',
      refereeConnectionEnabled: true,
      homeTeamConnectionEnabled: true,
      awayTeamConnectionEnabled: true,
      ...PINS,
      bench_home: [{ role: 'Coach', firstName: 'Cora', lastName: 'Homecoach' }],
      bench_away: [{ role: 'Coach', firstName: 'Abe', lastName: 'Awaycoach' }]
    },
    homeTeam: { id: 1, name: 'Home VC', color: '#e2001a' },
    awayTeam: { id: 2, name: 'Away VC', color: '#1d4ed8' },
    homePlayers: people('H'),
    awayPlayers: people('A'),
    sets: [{ index: 1, homePoints: 3, awayPoints: 1, finished: false }],
    events: [
      { id: 1, setIndex: 1, seq: 1, type: 'lineup', payload: { team: 'home', isInitial: true, lineup: { I: 4, II: 5, III: 6, IV: 7, V: 8, VI: 9 } } },
      { id: 2, setIndex: 1, seq: 2, type: 'lineup', payload: { team: 'away', isInitial: true, lineup: { I: 4, II: 5, III: 6, IV: 7, V: 8, VI: 9 } } },
      { id: 3, setIndex: 1, seq: 3, type: 'point', payload: { team: 'home' } },
      { id: 4, setIndex: 1, seq: 4, type: 'sanction', payload: { team: 'away', type: 'red', playerNumber: 7 } }
    ],
    _timestamp: Date.now()
  }
}

const fullData = (c) => c.waitFor((m) => m.type === 'match-full-data', 5000, 'match-full-data')
const named = (list) => (list || []).some((p) => p && (p.firstName || p.lastName))

for (const [label, env] of [['the --local relay', {}], ['the cloud relay', { IS_CLOUD: '1', TRUST_PROXY: 'cloudflare' }]]) {
  describe(`admitWaiting: ${label}`, () => {
    let srv
    before(async () => { srv = await bootServer(env, ['--local']) })
    after(async () => { await srv?.stop() })

    const open = (ip) => openSocket(srv.wsUrl, env.IS_CLOUD ? { headers: { 'cf-connecting-ip': ip } } : undefined)

    it('a socket that waited gets what a socket joining after the sync gets: the summary without a PIN, its own view with one', async () => {
      const seed = `seed-wait-${label.length}`
      const early = await open('203.0.113.31')
      const referee = await open('203.0.113.32')
      const home = await open('203.0.113.33')
      early.send({ type: 'subscribe-match', matchId: seed, role: 'subscriber' })
      referee.send({ type: 'subscribe-match', matchId: seed, role: 'referee', pin: PINS.refereePin })
      home.send({ type: 'subscribe-match', matchId: seed, role: 'bench', team: 'home', pin: PINS.homeTeamPin })
      for (const c of [early, referee, home]) {
        const j = await c.waitFor((m) => m.type === 'joined_match', 5000, 'joined_match')
        assert.equal(j.waiting, true)
      }

      const scorer = await open('203.0.113.34')
      scorer.send(scorerSync(seed))

      // PIN-less: the summary, as a late join gets it
      const e = await fullData(early)
      assert.equal(e.access, 'summary')
      assert.deepEqual(e.events, [])
      assert.deepEqual(e.homePlayers, [])
      assert.deepEqual(e.awayPlayers, [])
      assert.equal(e.match?.bench_home, undefined)
      assert.equal(e.match?.bench_away, undefined)

      // the referee: both rosters by name, the events
      const r = await fullData(referee)
      assert.equal(r.access, 'full')
      assert.equal(named(r.homePlayers), true)
      assert.equal(named(r.awayPlayers), true)
      assert.equal(r.events.length, 4)
      assert.equal(named(r.match.bench_away), true)

      // the home bench: its own roster by name, the other team's shirt numbers
      const h = await fullData(home)
      assert.equal(h.access, 'full')
      assert.equal(named(h.homePlayers), true)
      assert.deepEqual(h.awayPlayers, [{ number: 4 }, { number: 5 }, { number: 6 }])
      assert.deepEqual(h.match.bench_away, [{ role: 'Coach' }])

      // control: a PIN-less socket joining after the sync
      const late = await open('203.0.113.35')
      late.send({ type: 'subscribe-match', matchId: seed, role: 'subscriber' })
      const l = await fullData(late)
      assert.deepEqual({ ...e, _timestamp: 0, _scoreboardTimestamp: 0 }, { ...l, _timestamp: 0, _scoreboardTimestamp: 0 })

      for (const c of [early, referee, home, scorer, late]) c.ws.close()
      await sleep(50)
    })
  })
}
