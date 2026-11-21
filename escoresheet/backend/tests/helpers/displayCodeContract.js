/**
 * Scoreboard codes (docs/scoreboard-code-spec.md): the same wire scenario
 * against every relay runtime.
 *   - backend/server.js --local        tests/displayCode.relay.test.js (node:test)
 *   - server.js, the Vite dev plugin and the Tauri relay (OV_TAURI_RELAY_BIN):
 *     frontend/src/utils/__tests__/lanRelayProtocol.test.js (vitest)
 *
 * Checked:
 *   - only the room's scorer socket may set a code (display-code-set), the
 *     answer (display-code-state) never echoes the code;
 *   - a board subscribes by the code alone (subscribe-match { code }; a PIN
 *     next to it is ignored): display-code { ok, matchId, endsAt }, then the
 *     summary and every live-state-update, with the public live state only
 *     (no line-ups, substitution details, sanctions, last event data), never
 *     a PIN or a roster; the scorer hears display-presence;
 *   - POST /api/display/lookup and /api/display/live answer the same, with
 *     Cache-Control no-store and CORS *; the preflight is answered; a wrong
 *     code is 404, an ended one 410;
 *   - "New code" ends the old one: its boards get display-code ended and no
 *     more updates, its lookups 410; a revoke and a deleted match the same.
 *
 * Plain node:assert. The caller passes `openClient(url)` ({ ws, send,
 * waitFor, messages, raw }, resolving after 'connected') and the relay's
 * `httpBase` (where /api/display/* is served).
 */
import assert from 'node:assert/strict'

const PINS = Object.freeze({ gamePin: '483921', refereePin: '594032', homeTeamPin: '605143', awayTeamPin: '716254' })
const DEVICE = { id: '9c1e2f74-6f31-4d9a-8c5e-3b4a5f6e7d8c', platform: 'web', claim: 'code-claim-a' }
export const CODE_A = 'ABCD2345'
export const CODE_B = 'WXYZ6789'
export const CODE_C = 'HJKL2345'
const PRIVATE = ['lineup_a', 'lineup_b', 'sanctions_a', 'sanctions_b', 'subs_a', 'subs_b', 'last_event_data', 'scorer_attention_trigger']
const LIVE = Object.freeze({
  current_set: 2, points_a: 11, points_b: 9, sets_won_a: 1, sets_won_b: 0, serving_team: 'left', side_a: 'left',
  team_a_name: 'VBC Musterdorf', team_b_name: 'Volley Beispiel', team_a_color: '#e2001a', team_b_color: '#1d4ed8',
  timeouts_a: 1, timeouts_b: 0, subs_count_a: 2, subs_count_b: 1, match_status: 'live',
  set_results: [{ set: 1, home: 25, away: 21, a: 25, b: 21 }],
  lineup_a: [{ position: 1, number: 77 }], lineup_b: [{ position: 1, number: 88 }],
  subs_a: [{ playerIn: 61, playerOut: 62 }], subs_b: [], sanctions_a: [{ type: 'warning', player: 63 }], sanctions_b: [],
  last_event_data: { player: 64 }, scorer_attention_trigger: 3
})
// shirt numbers only the private columns carry
const SHIRTS = ['77', '88', '61', '62', '63', '64']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function post(httpBase, endpoint, body, { contentType = 'application/json', raw = null } = {}) {
  const res = await fetch(`${httpBase}/api/display/${endpoint}`, {
    method: 'POST',
    headers: contentType ? { 'Content-Type': contentType } : {},
    body: raw !== null ? raw : JSON.stringify(body)
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers }
}

/**
 * @param {{ wsUrl: string, httpBase: string, openClient: (url: string) => Promise<any>, tag?: string }} opts
 */
export async function runDisplayCodeContract ({ wsUrl, httpBase, openClient, tag = 'relay' }) {
  const clients = []
  const open = async () => {
    const c = await openClient(wsUrl)
    clients.push(c)
    return c
  }
  const settle = async (c) => {
    const before = c.messages.filter((m) => m.type === 'pong').length
    c.send({ type: 'ping' })
    await c.waitFor(() => c.messages.filter((m) => m.type === 'pong').length > before, 5000)
  }
  const count = (c, pred) => c.messages.filter(pred).length
  const nth = async (c, pred, n) => {
    await c.waitFor(() => count(c, pred) >= n, 5000)
    return c.messages.filter(pred)[n - 1]
  }
  const sync = (c, room) => c.send({
    type: 'sync-match-data',
    matchId: 1,
    match: {
      id: 1,
      seed_key: room,
      status: 'live',
      gameNumber: 7602,
      scheduledAt: '2026-11-21T18:00:00.000Z',
      // the referee connection off: on the cloud such a match is listed to its own venue only
      refereeConnectionEnabled: false,
      homeTeamConnectionEnabled: false,
      awayTeamConnectionEnabled: false,
      ...PINS
    },
    homeTeam: { id: 1, name: 'VBC Musterdorf', color: '#e2001a' },
    awayTeam: { id: 2, name: 'Volley Beispiel', color: '#1d4ed8' },
    homePlayers: [{ id: 11, teamId: 1, number: 77, firstName: 'Anna', lastName: 'Muster' }],
    awayPlayers: [{ id: 21, teamId: 2, number: 88, firstName: 'Bea', lastName: 'Beispiel' }],
    sets: [{ id: 1, index: 1, homePoints: 25, awayPoints: 21, finished: true }, { id: 2, index: 2, homePoints: 11, awayPoints: 9, finished: false }],
    events: [],
    device: DEVICE,
    _timestamp: Date.now()
  })
  const isState = (room) => (m) => m.type === 'display-code-state' && m.matchId === room
  const isCode = (m) => m.type === 'display-code'
  const isLive = (room) => (m) => m.type === 'live-state-update' && String(m.matchId) === room
  const noPrivate = (what, value) => {
    for (const k of PRIVATE) assert.ok(!(value && typeof value === 'object' && k in value), `${tag}: ${what} carries ${k}`)
  }
  const cleanText = (what, text) => {
    for (const p of Object.values(PINS)) assert.ok(!text.includes(p), `${tag}: a PIN in ${what}: ${text.slice(0, 200)}`)
    // shirt numbers: in what carries match data (ids and timestamps are digits too)
    let m = null
    try { m = JSON.parse(text) } catch { m = null }
    const data = m && typeof m === 'object' ? JSON.stringify([m.liveState, m.data, m.homePlayers, m.awayPlayers, m.events, m.sets, m.match, m.homeTeam, m.awayTeam]) : text
    for (const s of SHIRTS) assert.ok(!new RegExp(`[^0-9.]${s}[^0-9]`).test(data), `${tag}: a private shirt number ${s} in ${what}: ${data.slice(0, 300)}`)
    for (const name of ['Anna', 'Muster"', 'Bea"']) assert.ok(!text.includes(name), `${tag}: a player's name in ${what}`)
  }

  try {
    // letters only: a digit run in the key could look like a shirt number to cleanText
    const room = `code-${tag}-${Date.now().toString(36).replace(/[0-9]/g, (d) => 'abcdefghij'[d])}`

    // --- the scorer proves the room and sets a code --------------------------
    const scorer = await open()
    sync(scorer, room)
    await scorer.waitFor((m) => m.type === 'display-presence' && m.matchId === room, 5000)
    const issuedAt = Date.now() - 60 * 1000
    scorer.send({ type: 'display-code-set', matchId: room, code: CODE_A, issuedAt })
    const st = await nth(scorer, isState(room), 1)
    assert.equal(st.active, true, `${tag}: the code is set: ${JSON.stringify(st)}`)
    assert.equal(st.endsAt, issuedAt + 12 * 60 * 60 * 1000, `${tag}: 12 h from issuedAt`)
    assert.deepEqual(Object.keys(st).sort(), ['active', 'endsAt', 'matchId', 'type'], `${tag}: the state names no code`)
    scorer.send({ type: 'live-state-update', matchId: room, liveState: LIVE })
    await settle(scorer)

    // --- a socket that does not own the room may not -------------------------
    const referee = await open()
    referee.send({ type: 'subscribe-match', matchId: room, device: 'referee', pin: PINS.refereePin })
    await settle(referee)
    referee.send({ type: 'display-code-set', matchId: room, code: CODE_C, issuedAt: Date.now() })
    const refused = await nth(referee, isState(room), 1)
    assert.deepEqual([refused.active, refused.reason], [false, 'not-match-owner'], `${tag}: only the scorer sets a code`)
    const stranger = await open()
    stranger.send({ type: 'display-code-set', matchId: room, code: null })
    assert.equal((await nth(stranger, isState(room), 1)).reason, 'not-match-owner', `${tag}: nor revokes it`)

    // --- a board by the code alone ------------------------------------------
    const board = await open()
    board.send({ type: 'subscribe-match', code: 'abcd-2345', device: 'display', pin: PINS.gamePin })
    const joined = await nth(board, isCode, 1)
    assert.deepEqual(joined, { type: 'display-code', ok: true, matchId: room, endsAt: st.endsAt }, `${tag}: the code names the room`)
    const full = await board.waitFor((m) => m.type === 'match-full-data' && String(m.matchId) === room, 5000)
    assert.equal(full.access, 'summary', `${tag}: the summary only, a PIN next to a code is ignored`)
    assert.deepEqual(full.homePlayers, [], `${tag}: no roster`)
    noPrivate('the summary live state', full.liveState)
    noPrivate('the summary data.liveState', full.data?.liveState)
    assert.equal(full.liveState?.points_a, 11, `${tag}: the public live state is there`)
    assert.equal(full.liveState?.subs_count_a, 2, `${tag}: the substitution count is public`)
    // the scorer hears that a display follows
    await scorer.waitFor((m) => m.type === 'display-presence' && m.matchId === room && m.present === true, 5000)
    // the next push reaches the board, public
    scorer.send({ type: 'live-state-update', matchId: room, liveState: { ...LIVE, points_a: 12 } })
    const upd = await nth(board, isLive(room), 1)
    assert.equal(upd.liveState.points_a, 12, `${tag}: the board follows`)
    noPrivate('live-state-update', upd.liveState)
    // a sync reaches it as the summary
    sync(scorer, room)
    const mdu = await board.waitFor((m) => m.type === 'match-data-update' && String(m.matchId) === room, 5000)
    assert.equal(mdu.access, 'summary', `${tag}: a sync reaches the board as the summary`)
    noPrivate('match-data-update live state', mdu.liveState)
    noPrivate('match-data-update data.liveState', mdu.data?.liveState)

    // --- wrong codes ---------------------------------------------------------
    const lost = await open()
    lost.send({ type: 'subscribe-match', code: 'ZZZZ-ZZZZ', device: 'display' })
    assert.deepEqual(await nth(lost, isCode, 1), { type: 'display-code', ok: false, reason: 'not-found' }, `${tag}: a wrong code`)
    lost.send({ type: 'subscribe-match', code: 'nonsense', device: 'display' })
    assert.deepEqual(await nth(lost, isCode, 2), { type: 'display-code', ok: false, reason: 'not-found' }, `${tag}: no code at all`)
    await settle(lost)
    assert.equal(count(lost, (m) => m.type === 'match-full-data'), 0, `${tag}: a wrong code subscribes nothing`)

    // --- HTTP ----------------------------------------------------------------
    const look = await post(httpBase, 'lookup', { code: 'ABCD 2345' })
    assert.equal(look.status, 200, `${tag}: lookup ${look.text}`)
    assert.deepEqual(look.json, { ok: true, matchId: room, endsAt: st.endsAt }, `${tag}: lookup`)
    assert.match(look.headers.get('cache-control') || '', /no-store/, `${tag}: lookup no-store`)
    assert.equal(look.headers.get('access-control-allow-origin'), '*', `${tag}: lookup CORS`)
    const plain = await post(httpBase, 'lookup', { code: CODE_A }, { contentType: 'text/plain;charset=UTF-8' })
    assert.equal(plain.status, 200, `${tag}: a text/plain body (no preflight): ${plain.text}`)
    const live = await post(httpBase, 'live', { code: CODE_A })
    assert.equal(live.status, 200, `${tag}: live ${live.text}`)
    assert.deepEqual(Object.keys(live.json).sort(), ['awayTeam', 'endsAt', 'homeTeam', 'liveState', 'match', 'matchId', 'ok', 'sets'], `${tag}: live keys`)
    assert.equal(live.json.matchId, room)
    assert.equal(live.json.liveState?.points_a, 12, `${tag}: live: the last push`)
    assert.equal(live.json.match?.status, 'live', `${tag}: live: the summary's match`)
    assert.ok(Array.isArray(live.json.sets) && live.json.sets.length === 2, `${tag}: live: the sets`)
    noPrivate('/api/display/live', live.json.liveState)
    cleanText('/api/display/live', live.text)
    const pre = await fetch(`${httpBase}/api/display/live`, { method: 'OPTIONS', headers: { Origin: 'https://board.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } })
    assert.ok(pre.status === 204 || pre.status === 200, `${tag}: preflight ${pre.status}`)
    assert.equal(pre.headers.get('access-control-allow-origin'), '*', `${tag}: preflight origin`)
    assert.match(pre.headers.get('access-control-allow-methods') || '', /POST/, `${tag}: preflight methods`)
    const wrong = await post(httpBase, 'lookup', { code: 'ZZZZZZZY' })
    assert.deepEqual([wrong.status, wrong.json?.code], [404, 'OV_DISPLAY_NOT_FOUND'], `${tag}: a wrong code over HTTP`)
    const bad = await post(httpBase, 'lookup', null, { raw: '{"code":' })
    assert.deepEqual([bad.status, bad.json?.code], [400, 'OV_DISPLAY_BAD_REQUEST'], `${tag}: broken JSON`)
    const huge = await post(httpBase, 'lookup', { code: 'x'.repeat(4000) })
    assert.equal(huge.status, 413, `${tag}: over 1 KB`)

    // everything the board was sent: public only
    for (const text of board.raw) cleanText('the board\'s messages', text)

    // --- New code: the old one ends, its board with it ----------------------
    scorer.send({ type: 'display-code-set', matchId: room, code: CODE_B, issuedAt: Date.now() })
    assert.equal((await nth(scorer, isState(room), 2)).active, true, `${tag}: the new code`)
    const ended = await nth(board, isCode, 2)
    assert.deepEqual(ended, { type: 'display-code', ok: false, reason: 'ended', matchId: room }, `${tag}: the old code's board is told`)
    const seen = count(board, isLive(room))
    scorer.send({ type: 'live-state-update', matchId: room, liveState: { ...LIVE, points_a: 13 } })
    await settle(scorer)
    await sleep(150)
    await settle(board)
    assert.equal(count(board, isLive(room)), seen, `${tag}: the old code's board gets nothing more`)
    const old = await post(httpBase, 'lookup', { code: CODE_A })
    assert.deepEqual([old.status, old.json?.code], [410, 'OV_DISPLAY_ENDED'], `${tag}: the old code has ended`)
    board.send({ type: 'subscribe-match', code: CODE_A, device: 'display' })
    assert.deepEqual(await nth(board, isCode, 3), { type: 'display-code', ok: false, reason: 'ended' }, `${tag}: and cannot follow again`)
    const fresh = await post(httpBase, 'live', { code: CODE_B })
    assert.equal(fresh.json?.liveState?.points_a, 13, `${tag}: the new code follows`)

    // --- revoke ---------------------------------------------------------------
    const board2 = await open()
    board2.send({ type: 'subscribe-match', code: CODE_B, device: 'display' })
    assert.equal((await nth(board2, isCode, 1)).ok, true, `${tag}: the new code`)
    scorer.send({ type: 'display-code-set', matchId: room, code: null })
    const off = await nth(scorer, isState(room), 3)
    assert.deepEqual([off.active, off.reason], [false, 'revoked'], `${tag}: revoked`)
    assert.deepEqual(await nth(board2, isCode, 2), { type: 'display-code', ok: false, reason: 'ended', matchId: room }, `${tag}: its board is told`)

    // --- a deleted match ends its code ---------------------------------------
    scorer.send({ type: 'display-code-set', matchId: room, code: CODE_C, issuedAt: Date.now() })
    assert.equal((await nth(scorer, isState(room), 4)).active, true)
    const board3 = await open()
    board3.send({ type: 'subscribe-match', code: CODE_C, device: 'display' })
    assert.equal((await nth(board3, isCode, 1)).ok, true)
    scorer.send({ type: 'delete-match', matchId: room })
    await board3.waitFor((m) => (isCode(m) && m.ok === false) || m.type === 'match-deleted', 5000)
    let gone = null
    for (let i = 0; i < 20; i++) {
      gone = await post(httpBase, 'lookup', { code: CODE_C })
      if (gone.status === 410) break
      await sleep(100)
    }
    assert.deepEqual([gone.status, gone.json?.code], [410, 'OV_DISPLAY_ENDED'], `${tag}: a deleted match's code has ended`)

    // no message to anyone ever carried a code
    for (const c of clients) {
      for (const text of c.raw) {
        for (const code of [CODE_A, CODE_B, CODE_C, 'ABCD-2345']) assert.ok(!text.includes(code), `${tag}: a code in ${text.slice(0, 200)}`)
      }
    }
  } finally {
    for (const c of clients) { try { c.ws.terminate() } catch { /* gone */ } }
  }
}
