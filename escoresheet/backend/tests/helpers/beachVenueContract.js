/**
 * Venue mode with beach courts: one relay, several courts. The same contract
 * runs against every relay runtime:
 *   - backend/server.js --local        tests/beachVenue.relay.test.js (node:test)
 *   - the LAN relays (frontend/server.js, the Electron relay, the Vite dev
 *     plugin) and the Tauri relay (OV_TAURI_RELAY_BIN)
 *                                      frontend/src/utils/__tests__/lanRelayProtocol.test.js (vitest)
 *
 * Two beach scorers claim two courts (both Dexie id 1, kept apart by their
 * seed keys), next to an indoor match. Court 1 syncs the home/away wire shape
 * openbeach sends from phase 2 on (homeTeam, homePlayers, homeTeamPin, ...,
 * sport_type 'beach'); court 2 the shape openbeach sends today (team1Team,
 * team1Players, team1Pin, matchPin, team1TeamConnectionEnabled, no sport).
 * Then:
 *   - GET /api/match/list lists every open match (both courts and indoor),
 *     each row with its sportType ('beach' / 'indoor')
 *   - a referee with the court's referee PIN gets both teams with players
 *   - a court's PINs grant that court only; a bench PIN only while its
 *     connection is on (beach: team1 / team2)
 *   - no client ever sees a PIN field or value of any court (a PIN holder does
 *     not learn the other PINs of its match), nor a date of birth
 *   - POST /api/match/validate-pin { sport: 'beach' } finds beach courts only,
 *     an indoor PIN check never finds a beach court
 *   - each court's live state reaches that court's subscribers only
 *
 * Plain node:assert, no test framework: the caller passes its `openClient(url)`
 * ({ ws, send, waitFor, messages, raw }, resolving after 'connected').
 */
import assert from 'node:assert/strict'

export const BEACH_VENUE_PINS = Object.freeze({
  court1: Object.freeze({
    gamePin: '480213',
    refereePin: '602917',
    homeTeamPin: '715304',
    awayTeamPin: '826401',
    homeTeamUploadPin: '937512',
    awayTeamUploadPin: '148623'
  }),
  court2: Object.freeze({
    gamePin: '259730',
    refereePin: '360841',
    team1Pin: '471952',
    team2Pin: '582063',
    team1UploadPin: '693174',
    team2UploadPin: '704285',
    matchPin: '815396'
  }),
  indoor: Object.freeze({
    gamePin: '926407',
    refereePin: '137518'
  })
})
const ALL_PINS = Object.values(BEACH_VENUE_PINS).flatMap((p) => Object.values(p))
const PIN_KEY_RE = /"(gamePin|game_pin|refereePin|homeTeamPin|awayTeamPin|homeTeamUploadPin|awayTeamUploadPin|team1Pin|team2Pin|team1TeamPin|team2TeamPin|team1UploadPin|team2UploadPin|matchPin|connection_pins|connectionPins)"/
const DOB = '1999-03-14'
const leaksPin = (text) => ALL_PINS.some((p) => text.includes(p)) || PIN_KEY_RE.test(text)

const player = (number, firstName, lastName) => ({ number, firstName, lastName, dob: DOB, isCaptain: number === 1 })

/**
 * @param {{ httpBase: string, wsUrl: string, openClient: (url: string) => Promise<any>, tag?: string }} opts
 */
export async function runBeachVenueContract ({ httpBase, wsUrl, openClient, tag = 'venue' }) {
  const seed1 = `beach-${tag}-court-1`
  const seed2 = `beach-${tag}-court-2`
  const seedIndoor = `indoor-${tag}-court-3`
  const P = BEACH_VENUE_PINS
  const clients = []
  const open = async () => {
    const c = await openClient(wsUrl)
    clients.push(c)
    return c
  }
  const settle = async (c) => {
    c.send({ type: 'ping' })
    await c.waitFor((m) => m.type === 'pong')
  }
  const pong = (c) => c.messages.filter((m) => m.type === 'pong').length

  try {
    const court1 = await open()
    const court2 = await open()
    const indoor = await open()

    // Court 1: openbeach with its home/away wire adapter (team1 = home)
    court1.send({
      type: 'sync-match-data',
      matchId: 1,
      match: {
        id: 1,
        seed_key: seed1,
        sport_type: 'beach',
        status: 'live',
        gameNumber: 101,
        scheduledAt: '2026-10-07T09:00:00.000Z',
        refereeConnectionEnabled: true,
        homeTeamConnectionEnabled: false,
        awayTeamConnectionEnabled: false,
        ...P.court1
      },
      homeTeam: { name: 'Muster / Meier', color: '#e2001a' },
      awayTeam: { name: 'Rossi / Bianchi', color: '#3b82f6' },
      homePlayers: [player(1, 'Anna', 'Muster'), player(2, 'Bea', 'Meier')],
      awayPlayers: [player(1, 'Lia', 'Rossi'), player(2, 'Eva', 'Bianchi')],
      sets: [{ id: 1, index: 1, homePoints: 12, awayPoints: 10 }],
      events: [],
      _timestamp: Date.now()
    })
    // Court 2: openbeach as it syncs today (team1 / team2 names, no sport)
    court2.send({
      type: 'sync-match-data',
      matchId: 1,
      match: {
        id: 1,
        seed_key: seed2,
        status: 'scheduled',
        gameNumber: 102,
        scheduledAt: '2026-10-07T09:30:00.000Z',
        refereeConnectionEnabled: true,
        team1TeamConnectionEnabled: true,
        team2TeamConnectionEnabled: false,
        ...P.court2
      },
      team1Team: { id: 11, name: 'Keller / Huber', color: '#16a34a' },
      team2Team: { id: 12, name: 'Weber / Frei', color: '#9333ea' },
      team1Players: [player(1, 'Nina', 'Keller'), player(2, 'Ola', 'Huber')],
      team2Players: [player(1, 'Pia', 'Weber'), player(2, 'Rita', 'Frei')],
      sets: [],
      events: [],
      _timestamp: Date.now()
    })
    // An indoor match on the same relay
    indoor.send({
      type: 'sync-match-data',
      matchId: 1,
      match: {
        id: 1,
        seed_key: seedIndoor,
        status: 'live',
        gameNumber: 103,
        scheduledAt: '2026-10-07T08:00:00.000Z',
        refereeConnectionEnabled: true,
        homeTeamConnectionEnabled: false,
        awayTeamConnectionEnabled: false,
        ...P.indoor
      },
      homeTeam: { name: 'Indoor Home VC' },
      awayTeam: { name: 'Indoor Away VC' },
      homePlayers: [player(7, 'Ivo', 'Indoor')],
      awayPlayers: [],
      sets: [],
      events: [],
      _timestamp: Date.now()
    })
    for (const c of [court1, court2, indoor]) {
      await settle(c)
      assert.deepEqual(c.messages.filter((m) => m.type === 'error'), [], 'every court claims its own match')
    }

    // --- GET /api/match/list: every open match ------------------------------
    const list = await fetch(`${httpBase}/api/match/list`)
    assert.equal(list.status, 200)
    const listText = await list.text()
    const rows = JSON.parse(listText).matches
    const row = (id) => rows.find((m) => m.id === id)
    for (const id of [seed1, seed2, seedIndoor]) assert.ok(row(id), `match list lists ${id}: ${listText}`)
    assert.equal(row(seed1).homeTeam, 'Muster / Meier')
    assert.equal(row(seed1).awayTeam, 'Rossi / Bianchi')
    assert.equal(row(seed1).refereeConnectionEnabled, true)
    assert.equal(row(seed2).homeTeam, 'Keller / Huber')
    assert.equal(row(seed2).awayTeam, 'Weber / Frei')
    assert.equal(row(seed2).status, 'scheduled')
    // Each row names its sport: openbeach lists its courts, OpenVolley its indoor match
    assert.deepEqual([seed1, seed2, seedIndoor].map((id) => row(id).sportType), ['beach', 'beach', 'indoor'])
    assert.equal(leaksPin(listText), false, 'no PINs in the match list')
    assert.equal(listText.includes(DOB), false)

    // --- Referees: the court's referee PIN gives that court's teams and players
    const ref1 = await open()
    ref1.send({ type: 'subscribe-match', matchId: seed1, device: 'referee', pin: P.court1.refereePin })
    const full1 = await ref1.waitFor((m) => m.type === 'match-full-data' && m.matchId === seed1)
    assert.equal(full1.access, 'full')
    assert.equal(full1.homeTeam.name, 'Muster / Meier')
    assert.equal(full1.awayTeam.name, 'Rossi / Bianchi')
    assert.deepEqual(full1.homePlayers.map((p) => p.lastName), ['Muster', 'Meier'])
    assert.deepEqual(full1.awayPlayers.map((p) => p.lastName), ['Rossi', 'Bianchi'])
    assert.equal(full1.match.homeTeamPin, undefined)
    assert.equal(full1.match.awayTeamPin, undefined)

    const ref2 = await open()
    ref2.send({ type: 'subscribe-match', matchId: seed2, device: 'referee', pin: P.court2.refereePin })
    const full2 = await ref2.waitFor((m) => m.type === 'match-full-data' && m.matchId === seed2)
    assert.equal(full2.access, 'full')
    assert.equal(full2.homeTeam.name, 'Keller / Huber')
    assert.equal(full2.awayTeam.name, 'Weber / Frei')
    assert.deepEqual(full2.homePlayers.map((p) => p.lastName), ['Keller', 'Huber'])
    assert.deepEqual(full2.awayPlayers.map((p) => p.lastName), ['Weber', 'Frei'])
    for (const k of ['team1Pin', 'team2Pin', 'team1UploadPin', 'team2UploadPin', 'matchPin', 'refereePin', 'gamePin']) {
      assert.equal(full2.match[k], undefined, `${k} never reaches the referee`)
    }

    // --- A court's PINs grant that court only; beach benches by connection --
    const bench = await open()
    bench.send({ type: 'subscribe-match', matchId: seed2, device: 'bench', team: 'home', pin: P.court2.team1Pin })
    const benchFull = await bench.waitFor((m) => m.type === 'match-full-data' && m.matchId === seed2)
    assert.equal(benchFull.access, 'full', 'team1 bench PIN with its connection on')
    const benchOff = await open()
    benchOff.send({ type: 'subscribe-match', matchId: seed2, device: 'bench', team: 'away', pin: P.court2.team2Pin })
    await benchOff.waitFor((m) => m.type === 'error' && m.code === 'pin-invalid')
    const crossCourt = await open()
    crossCourt.send({ type: 'subscribe-match', matchId: seed2, pin: P.court1.refereePin })
    await crossCourt.waitFor((m) => m.type === 'error' && m.code === 'pin-invalid')
    const crossSummary = await crossCourt.waitFor((m) => m.type === 'match-full-data' && m.matchId === seed2)
    assert.equal(crossSummary.access, 'summary', 'court 1\'s PIN does not open court 2')
    assert.deepEqual(crossSummary.homePlayers, [])

    // GET /api/match/:id: the bench PIN header gives the bundle, no PIN in it
    const pinned = await fetch(`${httpBase}/api/match/${encodeURIComponent(seed2)}`, { headers: { 'X-OV-Match-Pin': P.court2.team1Pin } })
    const pinnedText = await pinned.text()
    assert.equal(pinned.status, 200)
    const pinnedBody = JSON.parse(pinnedText)
    assert.equal(pinnedBody.access, 'full')
    assert.equal(pinnedBody.homePlayers.length, 2)
    assert.equal(leaksPin(pinnedText), false, 'no PINs in GET /api/match/:id')
    assert.equal(pinnedText.includes(DOB), false)

    // --- POST /api/match/validate-pin: by sport -----------------------------
    const validate = (body) => fetch(`${httpBase}/api/match/validate-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    for (const [pin, seed] of [[P.court1.refereePin, seed1], [P.court2.refereePin, seed2]]) {
      const r = await validate({ pin, type: 'referee', sport: 'beach' })
      const text = await r.text()
      assert.equal(r.status, 200, text)
      const body = JSON.parse(text)
      assert.equal(body.match.id, seed)
      assert.equal(body.match.sportType, 'beach')
      assert.equal(leaksPin(text), false, 'a PIN check never answers the other PINs of its match')
    }
    assert.equal((await validate({ pin: P.court1.refereePin, type: 'referee' })).status, 404, 'an indoor PIN check never finds a beach court')
    assert.equal((await validate({ pin: P.indoor.refereePin, type: 'referee', sport: 'beach' })).status, 404, 'a beach PIN check never finds an indoor match')
    const indoorOk = await validate({ pin: P.indoor.refereePin, type: 'referee' })
    assert.equal(indoorOk.status, 200)
    assert.equal((await indoorOk.json()).match.id, seedIndoor)

    // --- Live state: each court to its own subscribers ----------------------
    const live1 = { points_a: 15, points_b: 13, sets_won_a: 1, serve_player: 2 }
    const live2 = { points_a: 3, points_b: 5, sets_won_a: 0, serve_player: 1 }
    court1.send({ type: 'live-state-update', matchId: 1, liveState: live1 }) // its Dexie id: an alias of seed1
    court2.send({ type: 'live-state-update', matchId: 1, liveState: live2 })
    assert.deepEqual((await ref1.waitFor((m) => m.type === 'live-state-update')).liveState, live1)
    assert.deepEqual((await ref2.waitFor((m) => m.type === 'live-state-update')).liveState, live2)
    const before = pong(ref1) + pong(ref2)
    await settle(ref1)
    await settle(ref2)
    assert.equal(pong(ref1) + pong(ref2), before + 2)
    for (const m of ref1.messages.filter((x) => x.type === 'live-state-update')) assert.equal(m.matchId, seed1)
    for (const m of ref2.messages.filter((x) => x.type === 'live-state-update')) assert.equal(m.matchId, seed2)

    // --- Nothing secret ever reached a non-scorer client ---------------------
    for (const c of [ref1, ref2, bench, benchOff, crossCourt]) {
      const seen = c.raw.join('\n')
      assert.equal(leaksPin(seen), false, 'no PIN field or value reaches a subscriber')
      assert.equal(seen.includes(DOB), false, 'no date of birth reaches a subscriber')
    }

    // The scorers end their matches (by their Dexie id); subscribers are told
    court1.send({ type: 'delete-match', matchId: 1 })
    court2.send({ type: 'delete-match', matchId: 1 })
    indoor.send({ type: 'delete-match', matchId: 1 })
    await ref1.waitFor((m) => m.type === 'match-deleted' && m.matchId === seed1)
    await ref2.waitFor((m) => m.type === 'match-deleted' && m.matchId === seed2)
  } finally {
    for (const c of clients) c.ws.close()
  }
}
