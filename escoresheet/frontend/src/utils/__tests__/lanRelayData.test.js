// @vitest-environment node
/**
 * What the LAN relay hands out of a scorer's match: the shared private-field
 * list (frontend/shared/relayPrivateFields.json) against the relay core and
 * the backend, the by-game-number lookup, the bundle's team rows, and the
 * roster upload (PATCH /api/match/:id) through a standalone server.js relay.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer as createNetServer } from 'node:net'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import WebSocket from 'ws'
import core from '../../../electron/lanRelayCore.cjs'
import * as backendColumns from '../../../../backend/lib/publicColumns.js'

const here = dirname(fileURLToPath(import.meta.url))
const FRONTEND_DIR = resolve(here, '../../..')
const SHARED = JSON.parse(readFileSync(resolve(FRONTEND_DIR, 'shared/relayPrivateFields.json'), 'utf8'))

const PINS = {
  refereePin: '314159',
  homeTeamPin: '271828',
  awayTeamPin: '161803',
  homeTeamUploadPin: '141421',
  awayTeamUploadPin: '173205',
  gamePin: '987654'
}
const DOB = '1975-08-09'

function makeMatch(overrides = {}) {
  return {
    id: 7,
    seed_key: 'room-data-1',
    gameNumber: 5151,
    status: 'scheduled',
    homeTeamName: 'Team North',
    awayTeamName: 'Team South',
    refereeConnectionEnabled: true,
    homeTeamConnectionEnabled: true,
    awayTeamConnectionEnabled: true,
    homeTeamId: 1,
    awayTeamId: 2,
    remarks: 'Player 4 injured (knee)',
    sanctions: [{ team: 'home', type: 'warning' }],
    bench_home: [{ role: 'Coach', firstName: 'Cora', lastName: 'Coach', dob: DOB }],
    accountApprovals: { ref1: { name: 'Ann Ref' } },
    pendingTeam1Roster: { players: [{ number: 3, dob: DOB }] },
    homeCoachSignature: 'data:image/png;base64,SIG',
    futureNoteField: 'not for tablets',
    ...PINS,
    ...overrides
  }
}

function bundle(match = makeMatch()) {
  return {
    match,
    homeTeam: { id: 1, name: 'Team North', color: '#123456', benchStaff: [{ role: 'Coach', lastName: 'Coach', dob: DOB }], contactPhone: '000' },
    awayTeam: { id: 2, name: 'Team South', color: '#654321' },
    homePlayers: [{ number: 4, lastName: 'Player', dob: DOB }],
    awayPlayers: [],
    sets: [],
    events: []
  }
}

describe('one private-field list for the relays', () => {
  it('the relay core and the backend carry the shared lists', () => {
    expect(core.PERSON_PRIVATE_FIELDS).toEqual(SHARED.personPrivateFields)
    expect(core.MATCH_PRIVATE_FIELDS).toEqual(SHARED.matchPrivateFields)
    expect(core.MATCH_ROSTER_FIELDS).toEqual(SHARED.matchRosterFields)
    expect(core.MATCH_PERSON_FIELDS).toEqual(SHARED.matchPersonFields)
    expect(core.MATCH_TEAM_FIELDS).toEqual(SHARED.matchTeamFields)
    expect(core.PUBLIC_MATCH_FIELDS).toEqual(SHARED.publicMatchFields)
    expect(core.PUBLIC_TEAM_FIELDS).toEqual(SHARED.publicTeamFields)
    expect(core.TEAM_PEOPLE_FIELDS).toEqual(SHARED.teamPeopleFields)
    expect([...backendColumns.PERSON_PRIVATE_FIELDS]).toEqual(SHARED.personPrivateFields)
    expect([...backendColumns.MATCH_PRIVATE_FIELDS]).toEqual(SHARED.matchPrivateFields)
    expect([...backendColumns.MATCH_ROSTER_FIELDS]).toEqual(SHARED.matchRosterFields)
    for (const k of [...SHARED.matchPrivateFields, ...core.MATCH_SECRET_FIELDS]) expect(SHARED.publicMatchFields).not.toContain(k)
  })

  it('one match row: no private key or date of birth leaves the core or the backend', () => {
    const row = makeMatch({ pendingTeam2Roster: { players: [] }, team1Players: [{ number: 1, dob: DOB }] })
    for (const out of [core.publicMatch(row), backendColumns.publicRelayMatch(row)]) {
      const text = JSON.stringify(out)
      expect(text).not.toContain(DOB)
      for (const k of SHARED.matchPrivateFields) expect(out).not.toHaveProperty(k)
      expect(Object.keys(out).some((k) => /signature/i.test(k))).toBe(false)
      expect(out.team1Players?.[0]?.number).toBe(1)
    }
    // (the backend strips the PINs separately) the core is an allowlist: a
    // key nobody listed stays on the relay
    for (const k of Object.keys(PINS)) expect(core.publicMatch(row)).not.toHaveProperty(k)
    expect(core.publicMatch(row)).not.toHaveProperty('futureNoteField')
    expect(Object.keys(core.publicMatch(row)).every((k) => SHARED.publicMatchFields.includes(k))).toBe(true)
  })

  it('the bundle\'s team rows lose unlisted keys and the bench officials\' dates of birth', () => {
    const wire = core.toWireBundle(bundle())
    expect(wire.homeTeam).toEqual({ id: 1, name: 'Team North', color: '#123456', benchStaff: [{ role: 'Coach', lastName: 'Coach' }] })
  })
})

function freePort() {
  return new Promise((res, rej) => {
    const srv = createNetServer()
    srv.unref()
    srv.on('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => res(port))
    })
  })
}

function openClient(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url, { perMessageDeflate: false })
    const client = { ws, messages: [] }
    ws.on('message', (d) => { try { client.messages.push(JSON.parse(String(d))) } catch { /* not JSON */ } })
    client.send = (m) => ws.send(JSON.stringify(m))
    client.waitFor = (pred, timeoutMs = 3000) => new Promise((ok, fail) => {
      const start = Date.now()
      const tick = () => {
        const m = client.messages.find(pred)
        if (m) return ok(m)
        if (Date.now() - start > timeoutMs) return fail(new Error('timed out waiting for message'))
        setTimeout(tick, 20)
      }
      tick()
    })
    ws.on('open', () => res(client))
    ws.on('error', rej)
  })
}

describe('LAN relay (server.js): by-game-number and the roster upload', () => {
  let child, http, wsUrl, scorer, intruder
  const roster = { players: [{ number: 4, firstName: 'Anna', lastName: 'Player', dob: '2008-03-14' }], bench: [], coachSignature: null, captainSignature: null, timestamp: null }

  beforeAll(async () => {
    const [port, wsPort] = [await freePort(), await freePort()]
    child = spawn(process.execPath, ['server.js'], {
      cwd: FRONTEND_DIR,
      env: { ...process.env, PORT: String(port), WS_PORT: String(wsPort), HTTPS: 'false', NODE_ENV: 'test' },
      stdio: 'ignore'
    })
    http = `http://127.0.0.1:${port}`
    wsUrl = `ws://127.0.0.1:${wsPort}`
    for (let start = Date.now(); ;) {
      try { if ((await fetch(`${http}/api/server/status`)).ok) break } catch { /* not up yet */ }
      if (Date.now() - start > 10000) throw new Error('server.js did not start')
      await new Promise((r) => setTimeout(r, 100))
    }
    scorer = await openClient(wsUrl)
    scorer.send({ type: 'sync-match-data', matchId: 7, ...bundle(), _timestamp: Date.now() })
    // another device on the hall network owns a match of its own
    intruder = await openClient(wsUrl)
    intruder.send({ type: 'sync-match-data', matchId: 'own-id', ...bundle(makeMatch({ id: 'own-id', seed_key: 'room-other', gameNumber: 9999, gamePin: '111111' })), _timestamp: Date.now() })
    for (let start = Date.now(); ;) {
      const list = await (await fetch(`${http}/api/match/list`)).json()
      if (list.matches?.length === 2) break
      if (Date.now() - start > 3000) throw new Error('matches not stored')
      await new Promise((r) => setTimeout(r, 50))
    }
  }, 20000)

  afterAll(() => {
    for (const c of [scorer, intruder]) c?.ws.close()
    child?.kill('SIGKILL')
  })

  const byGameNumber = (pin) => fetch(`${http}/api/match/by-game-number?gameNumber=5151`, { headers: pin ? { 'X-OV-Match-Pin': pin } : {} })
    .then(async (r) => ({ status: r.status, body: await r.json() }))
  const patch = (body, pin) => fetch(`${http}/api/match/room-data-1`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(pin ? { 'X-OV-Match-Pin': pin } : {}) },
    body: JSON.stringify(body)
  }).then(async (r) => ({ status: r.status, body: await r.json() }))

  it('by-game-number without a PIN or with a wrong one: the summary, team names and the room key', async () => {
    for (const pin of [null, '000000']) {
      const { status, body } = await byGameNumber(pin)
      expect(status).toBe(200)
      expect(body.matchId).toBe('room-data-1')
      expect(body.access).toBe('summary')
      expect(body.homeTeam).toEqual({ name: 'Team North', color: '#123456' })
      expect(Object.keys(body.match).every((k) => core.SUMMARY_MATCH_FIELDS.includes(k))).toBe(true)
      for (const k of ['remarks', 'sanctions', 'bench_home', 'accountApprovals', 'pendingTeam1Roster']) expect(body.match).not.toHaveProperty(k)
    }
  })

  it('by-game-number with a PIN of the match: the public match, still without PINs or dates of birth', async () => {
    const { body } = await byGameNumber(PINS.awayTeamUploadPin)
    expect(body.access).toBe('full')
    expect(body.match.bench_home[0].lastName).toBe('Coach')
    const text = JSON.stringify(body)
    expect(text).not.toContain(DOB)
    for (const pin of Object.values(PINS)) expect(text).not.toContain(pin)
  })

  it('GET /api/match/:id with a bench PIN: team rows without dates of birth or unlisted keys', async () => {
    const r = await fetch(`${http}/api/match/room-data-1`, { headers: { 'X-OV-Match-Pin': PINS.awayTeamPin } })
    const body = await r.json()
    expect(body.access).toBe('full')
    expect(body.homeTeam.benchStaff[0]).toEqual({ role: 'Coach', lastName: 'Coach' })
    expect(body.homeTeam).not.toHaveProperty('contactPhone')
    expect(body.match).not.toHaveProperty('futureNoteField')
  })

  it('PATCH without a PIN, with a wrong one or with the other team\'s upload PIN: refused, nothing forwarded', async () => {
    expect((await patch({ pendingHomeRoster: roster })).status).toBe(401)
    expect((await patch({ pendingHomeRoster: roster }, '000000')).status).toBe(403)
    expect((await patch({ pendingHomeRoster: roster }, PINS.awayTeamUploadPin)).status).toBe(403)
    expect((await patch({ pendingHomeRoster: roster }, PINS.homeTeamPin)).status).toBe(403)
    expect((await patch({ status: 'final' }, PINS.homeTeamUploadPin)).status).toBe(400)
    await new Promise((r) => setTimeout(r, 100))
    for (const c of [scorer, intruder]) expect(c.messages.some((m) => m.type === 'match-update-request')).toBe(false)
  })

  it('PATCH with the team\'s upload PIN reaches only the match\'s scoreboard and needs its bundle', async () => {
    // a bare success is no answer
    const bare = patch({ pendingHomeRoster: roster }, PINS.homeTeamUploadPin)
    const req1 = await scorer.waitFor((m) => m.type === 'match-update-request')
    expect(req1.matchId).toBe('room-data-1')
    expect(req1.updates.pendingHomeRoster.players[0].lastName).toBe('Player')
    intruder.send({ type: 'match-update-response', requestId: req1.requestId, success: true, matchId: 'room-data-1', data: bundle() })
    scorer.send({ type: 'match-update-response', requestId: req1.requestId, success: true, matchId: 'room-data-1' })
    expect((await bare).status).toBe(500)
    expect(intruder.messages.some((m) => m.type === 'match-update-request')).toBe(false)

    scorer.messages.length = 0
    const ok = patch({ pendingHomeRoster: roster }, PINS.homeTeamUploadPin)
    const req2 = await scorer.waitFor((m) => m.type === 'match-update-request')
    scorer.send({ type: 'match-update-response', requestId: req2.requestId, success: true, matchId: 'room-data-1', data: bundle() })
    expect(await ok).toEqual({ status: 200, body: { success: true } })
  })
})
