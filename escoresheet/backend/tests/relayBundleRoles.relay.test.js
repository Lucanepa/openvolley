/**
 * What the cloud relay hands each PIN holder of a match (lib/publicColumns.js
 * relayBundleView): the referee and the scorer's own devices (game PIN) both
 * rosters and the remarks, a bench its own roster and only the shirt numbers
 * of the other team; team rows name, short name and colour only; the account
 * approvals and dates of birth to nobody; a team's first line-up of a set not
 * to the other bench while it is covered (FIVB 7.3, domain/lineupPrivacy.js).
 * Boots server.js in local mode (no database) on a random port, like
 * relay-protocol.test.js.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import WebSocket from 'ws'
import { redactRemarkDobs, relayBundleView } from '../lib/publicColumns.js'

const BACKEND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const PINS = {
  refereePin: '314159',
  homeTeamPin: '271828',
  awayTeamPin: '161803',
  homeTeamUploadPin: '141421',
  awayTeamUploadPin: '173205'
}
const GAME_PIN = '987654'
const containsPin = (text) => [GAME_PIN, ...Object.values(PINS)].some((pin) => text.includes(pin))

// Every date of birth in the scorer's bundle, as the scorer stores them and as ISO
const DOBS = ['03.05.2011', '04.06.2011', '01.02.2010', '02.01.1980', '04.03.1979', '2011-05-03', '1980-01-02']
const hasDob = (text) => DOBS.some((d) => text.includes(d))
// The home team's people by name, and the referee's approval
const HOME_NAMES = ['Hana', 'Homeplayer', 'Cora', 'Homecoach']
const AWAY_NAMES = ['Ava', 'Awayplayer', 'Abe', 'Awaycoach']

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer()
    srv.on('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => res(port))
    })
  })
}

function openClient(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url)
    const client = { ws, messages: [], raw: [] }
    client.send = (m) => ws.send(JSON.stringify(m))
    client.waitFor = (pred, timeoutMs = 3000) => new Promise((ok, fail) => {
      const found = client.messages.find(pred)
      if (found) return ok(found)
      const timer = setTimeout(() => fail(new Error('timed out waiting for message')), timeoutMs)
      const check = () => {
        const m = client.messages.find(pred)
        if (m) {
          clearTimeout(timer)
          ws.off('message', check)
          ok(m)
        }
      }
      ws.on('message', check)
    })
    ws.on('message', (data) => {
      client.raw.push(data.toString())
      client.messages.push(JSON.parse(data.toString()))
    })
    ws.once('open', () => client.waitFor((m) => m.type === 'connected').then(() => res(client), rej))
    ws.once('error', rej)
  })
}

const lineupEvent = (id, team, setIndex, seq, first) => ({
  id, matchId: 7, setIndex, seq, type: 'lineup',
  payload: { team, isInitial: true, lineup: { I: first, II: first + 1, III: first + 2, IV: first + 3, V: first + 4, VI: first + 5 } }
})

/** An older scorer's whole bundle: every personal field it ever sent. */
function scorerSync(seed, { events } = {}) {
  return {
    type: 'sync-match-data',
    matchId: seed,
    match: {
      id: 7,
      seed_key: seed,
      gamePin: GAME_PIN,
      gameNumber: 4243,
      status: 'live',
      coinTossTeamA: 'home',
      refereeConnectionEnabled: true,
      homeTeamConnectionEnabled: true,
      awayTeamConnectionEnabled: true,
      ...PINS,
      bench_home: [{ role: 'Coach', firstName: 'Cora', lastName: 'Homecoach', dob: '02.01.1980' }],
      bench_away: [{ role: 'Coach', firstName: 'Abe', lastName: 'Awaycoach', dob: '04.03.1979' }],
      remarks: '- Player #7 dob: 03.05.2011 → 04.06.2011 (Home VC)\nSet 1, 14:02, A 3:1, #4 injured (bench)',
      accountApprovals: { referee1: { id: 'acc-1', name: 'Rita Referee', at: '2026-11-12T10:00:00.000Z' } },
      homeShortName: 'HOME',
      awayShortName: 'AWAY'
    },
    homeTeam: {
      id: 1, name: 'Home VC', shortName: 'HOME', color: '#e2001a', seedKey: 'team-home',
      benchStaff: [{ role: 'Coach', firstName: 'Cora', lastName: 'Homecoach', dob: '02.01.1980' }],
      benchOfficials: [{ role: 'Coach', firstName: 'Cora', lastName: 'Homecoach', dob: '1980-01-02' }]
    },
    awayTeam: {
      id: 2, name: 'Away VC', shortName: 'AWAY', color: '#1d4ed8',
      benchStaff: [{ role: 'Coach', firstName: 'Abe', lastName: 'Awaycoach', dob: '04.03.1979' }]
    },
    homePlayers: [{ id: 1, teamId: 1, number: 7, firstName: 'Hana', lastName: 'Homeplayer', dob: '04.06.2011', isCaptain: true, libero: '' }],
    awayPlayers: [{ id: 2, teamId: 2, number: 9, firstName: 'Ava', lastName: 'Awayplayer', dob: '01.02.2010', country: 'SUI' }],
    sets: [{ id: 1, index: 1, homePoints: 3, awayPoints: 1 }],
    events: events ?? [
      lineupEvent(1, 'home', 1, 1, 1),
      lineupEvent(2, 'away', 1, 2, 11),
      { id: 3, matchId: 7, setIndex: 1, seq: 3, type: 'point', payload: { team: 'home' } },
      { id: 4, matchId: 7, setIndex: 1, seq: 4, type: 'bench_injury', payload: { team: 'home', playerNumber: 4, autoRemark: 'Set 1, 14:02, A 3:1, #4 injured (bench)' } }
    ],
    _timestamp: Date.now()
  }
}

describe('cloud relay: the bundle by role', () => {
  let child
  let port
  let wsUrl

  before(async () => {
    port = await freePort()
    wsUrl = `ws://127.0.0.1:${port}`
    const env = { ...process.env, PORT: String(port) }
    for (const k of ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'IS_CLOUD', 'TRUST_PROXY']) delete env[k]
    child = spawn(process.execPath, ['server.js', '--local'], { cwd: BACKEND_DIR, env, stdio: 'ignore' })
    const start = Date.now()
    for (;;) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break
      } catch { /* not up yet */ }
      if (Date.now() - start > 10000) throw new Error('backend did not start')
      await new Promise((r) => setTimeout(r, 100))
    }
  })

  after(() => {
    child?.kill('SIGKILL')
  })

  async function publish(seed, opts) {
    const scoreboard = await openClient(wsUrl)
    scoreboard.send(scorerSync(seed, opts))
    scoreboard.send({ type: 'ping' })
    await scoreboard.waitFor((m) => m.type === 'pong')
    assert.equal(scoreboard.messages.some((m) => m.type === 'error'), false, JSON.stringify(scoreboard.messages))
    return scoreboard
  }

  async function subscriber(seed, pin) {
    const c = await openClient(wsUrl)
    c.send({ type: 'subscribe-match', matchId: seed, ...(pin ? { pin } : {}) })
    const full = await c.waitFor((m) => m.type === 'match-full-data')
    return { c, full }
  }

  it('a bench PIN gets its own roster and only the shirt numbers of the other team', async () => {
    const seed = 'match_1791215210101_roles1'
    const scoreboard = await publish(seed)
    const { c: away, full } = await subscriber(seed, PINS.awayTeamPin)
    assert.equal(full.access, 'full')
    // team rows: name, short name, colour
    assert.deepEqual(full.homeTeam, { name: 'Home VC', shortName: 'HOME', color: '#e2001a' })
    assert.deepEqual(full.awayTeam, { name: 'Away VC', shortName: 'AWAY', color: '#1d4ed8' })
    // the other team: shirt numbers only; its own: names, never a date of birth
    assert.deepEqual(full.homePlayers, [{ number: 7 }])
    assert.deepEqual(full.awayPlayers, [{ id: 2, teamId: 2, number: 9, firstName: 'Ava', lastName: 'Awayplayer' }])
    assert.deepEqual(full.match.bench_home, [{ role: 'Coach' }])
    assert.deepEqual(full.match.bench_away, [{ role: 'Coach', firstName: 'Abe', lastName: 'Awaycoach' }])
    // no remarks, no approvals, no remark text on the events
    assert.equal('remarks' in full.match, false)
    assert.equal('accountApprovals' in full.match, false)
    const injury = full.events.find((e) => e.type === 'bench_injury')
    assert.deepEqual(injury.payload, { team: 'home', playerNumber: 4 })
    assert.equal(full.events.length, 4)
    // later bundles the same
    scoreboard.send(scorerSync(seed))
    await away.waitFor((m) => m.type === 'match-data-update')
    const text = away.raw.join('\n')
    assert.equal(hasDob(text), false, text.slice(0, 600))
    for (const name of [...HOME_NAMES, 'Rita', 'injured', 'benchStaff', 'benchOfficials']) assert.equal(text.includes(name), false, name)
    assert.equal(containsPin(text), false)

    // The home bench: the mirror image
    const { c: home, full: homeFull } = await subscriber(seed, PINS.homeTeamPin)
    assert.deepEqual(homeFull.homePlayers, [{ id: 1, teamId: 1, number: 7, firstName: 'Hana', lastName: 'Homeplayer', isCaptain: true, libero: '' }])
    assert.deepEqual(homeFull.awayPlayers, [{ number: 9 }])
    assert.deepEqual(homeFull.match.bench_away, [{ role: 'Coach' }])
    const homeText = home.raw.join('\n')
    assert.equal(hasDob(homeText), false)
    for (const name of [...AWAY_NAMES, 'Rita', 'injured']) assert.equal(homeText.includes(name), false, name)

    for (const c of [scoreboard, away, home]) c.ws.close()
  })

  it('the referee (and the game PIN) get both rosters and the remarks, without dates of birth or approvals', async () => {
    const seed = 'match_1791215210102_roles2'
    const scoreboard = await publish(seed)
    for (const pin of [PINS.refereePin, GAME_PIN]) {
      const { c, full } = await subscriber(seed, pin)
      assert.equal(full.access, 'full')
      assert.deepEqual(full.homeTeam, { name: 'Home VC', shortName: 'HOME', color: '#e2001a' })
      assert.deepEqual(full.homePlayers, [{ id: 1, teamId: 1, number: 7, firstName: 'Hana', lastName: 'Homeplayer', isCaptain: true, libero: '' }])
      assert.deepEqual(full.awayPlayers, [{ id: 2, teamId: 2, number: 9, firstName: 'Ava', lastName: 'Awayplayer' }])
      assert.deepEqual(full.match.bench_home, [{ role: 'Coach', firstName: 'Cora', lastName: 'Homecoach' }])
      // the remarks, the date-of-birth correction without its values
      assert.equal(full.match.remarks, '- Player #7 date of birth changed (Home VC)\nSet 1, 14:02, A 3:1, #4 injured (bench)')
      assert.equal(full.events.find((e) => e.type === 'bench_injury').payload.autoRemark, 'Set 1, 14:02, A 3:1, #4 injured (bench)')
      assert.equal('accountApprovals' in full.match, false)
      const text = c.raw.join('\n')
      assert.equal(hasDob(text), false, text.slice(0, 600))
      assert.equal(text.includes('Rita'), false)
      assert.equal(containsPin(text), false)
      c.ws.close()
    }
    scoreboard.ws.close()
  })

  it('GET /api/match/:id answers by the PIN or the token it is given', async () => {
    const seed = 'match_1791215210103_roles3'
    const scoreboard = await publish(seed)
    const byPin = await (await fetch(`http://127.0.0.1:${port}/api/match/${seed}`, { headers: { 'X-OV-Match-Pin': PINS.awayTeamPin } })).json()
    assert.equal(byPin.access, 'full')
    assert.deepEqual(byPin.homePlayers, [{ number: 7 }])
    assert.equal('remarks' in byPin.match, false)
    assert.deepEqual(byPin.homeTeam, { name: 'Home VC', shortName: 'HOME', color: '#e2001a' })

    const validate = await (await fetch(`http://127.0.0.1:${port}/api/match/validate-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: PINS.awayTeamPin, type: 'awayTeam' })
    })).json()
    assert.equal(validate.success, true)
    assert.ok(validate.token)
    const byTokenText = await (await fetch(`http://127.0.0.1:${port}/api/match/${seed}`, { headers: { 'X-OV-Match-Token': validate.token } })).text()
    const byToken = JSON.parse(byTokenText)
    assert.equal(byToken.access, 'full')
    assert.deepEqual(byToken.homePlayers, [{ number: 7 }])
    assert.equal(hasDob(byTokenText), false)
    for (const name of [...HOME_NAMES, 'Rita']) assert.equal(byTokenText.includes(name), false, name)

    const referee = await (await fetch(`http://127.0.0.1:${port}/api/match/${seed}`, { headers: { 'X-OV-Match-Pin': PINS.refereePin } })).json()
    assert.equal(referee.match.remarks.startsWith('- Player #7 date of birth changed'), true)
    assert.equal(referee.homePlayers[0].lastName, 'Homeplayer')
    scoreboard.ws.close()
  })

  it('a first line-up stays off the other bench while it is covered', async () => {
    const seed = 'match_1791215210104_roles4'
    // Set 1 played; set 2: only the home line-up and its game captain are in
    const set1 = [lineupEvent(1, 'home', 1, 1, 1), lineupEvent(2, 'away', 1, 2, 11), { id: 3, matchId: 7, setIndex: 1, seq: 3, type: 'point', payload: { team: 'home' } }]
    const homeSet2 = [lineupEvent(4, 'home', 2, 4, 21), { id: 5, matchId: 7, setIndex: 2, seq: 5, type: 'court_captain_designation', payload: { team: 'home', playerNumber: 23 } }]
    const scoreboard = await publish(seed, { events: [...set1, ...homeSet2] })
    const set2Home = (events) => events.filter((e) => e.setIndex === 2 && e.payload?.team === 'home').map((e) => e.id)

    const { c: away, full } = await subscriber(seed, PINS.awayTeamPin)
    assert.deepEqual(set2Home(full.events), [], 'the covered home line-up reached the away bench')
    assert.deepEqual(full.events.map((e) => e.id), [1, 2, 3], 'set 1 stays')
    // its own bench and the referee (whose screen covers it) keep it
    const { c: home, full: homeFull } = await subscriber(seed, PINS.homeTeamPin)
    assert.deepEqual(set2Home(homeFull.events), [4, 5])
    const { c: referee, full: refFull } = await subscriber(seed, PINS.refereePin)
    assert.deepEqual(set2Home(refFull.events), [4, 5])

    // Once the away line-up is in, both go to both benches
    scoreboard.send(scorerSync(seed, { events: [...set1, ...homeSet2, lineupEvent(6, 'away', 2, 6, 31)] }))
    const update = await away.waitFor((m) => m.type === 'match-data-update')
    assert.deepEqual(set2Home(update.events), [4, 5])
    assert.deepEqual(update.events.map((e) => e.id), [1, 2, 3, 4, 5, 6])

    for (const c of [scoreboard, away, home, referee]) c.ws.close()
  })
})

describe('relayBundleView', () => {
  const entry = () => {
    const { match, homeTeam, awayTeam, homePlayers, awayPlayers, sets, events } = scorerSync('k')
    return { match, homeTeam, awayTeam, homePlayers, awayPlayers, sets, events, liveState: { points_a: 3 } }
  }

  it('never mutates the stored entry and keeps the live state', () => {
    const e = entry()
    const before = JSON.stringify(e)
    for (const view of ['scorer', 'referee', 'home', 'away']) {
      const out = relayBundleView(e, view)
      assert.deepEqual(out.liveState, { points_a: 3 })
      assert.equal(out.sets, e.sets)
    }
    assert.equal(JSON.stringify(e), before)
  })

  it('an unknown view gets the bench of neither team: numbers only', () => {
    const out = relayBundleView(entry(), 'livescore')
    assert.deepEqual(out.homePlayers, [{ number: 7 }])
    assert.deepEqual(out.awayPlayers, [{ number: 9 }])
    assert.equal('remarks' in out.match, false)
  })

  it('beach roster keys are teams 1 (home) and 2 (away)', () => {
    const out = relayBundleView({ match: { players_team1: [{ number: 1, lastName: 'Sand', dob: '01.01.2000' }], players_team2: [{ number: 2, lastName: 'Dune' }] } }, 'away')
    assert.deepEqual(out.match.players_team1, [{ number: 1 }])
    assert.deepEqual(out.match.players_team2, [{ number: 2, lastName: 'Dune' }])
  })

  it('redactRemarkDobs takes the values out of a date-of-birth correction only', () => {
    assert.equal(redactRemarkDobs('- Bench official Coach dob: (none) → 02.01.1980 (Home VC)'), '- Bench official Coach date of birth changed (Home VC)')
    assert.equal(redactRemarkDobs('- Player #7 dob: 3 May 2011 → (none) (Home (U18))'), '- Player #7 date of birth changed')
    assert.equal(redactRemarkDobs('- Player #7 number: 7 → 8 (Home VC)'), '- Player #7 number: 7 → 8 (Home VC)')
    assert.equal(redactRemarkDobs(''), '')
    assert.equal(redactRemarkDobs(null), null)
  })
})
