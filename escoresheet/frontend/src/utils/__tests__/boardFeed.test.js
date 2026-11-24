import { describe, it, expect, vi } from 'vitest'
import {
  createBoardFeed,
  boardScoreFromCourt,
  boardScoreFromRow,
  normalizeBoardCode,
  formatBoardCode,
  parseBoardTarget,
  boardTargetHash,
  isBoardPath,
  takeBoardTargetFromUrl,
  setBoardTargetInUrl,
  BOARD_NOT_FOUND_RETRY_MS,
  BOARD_ENDED_RETRY_MS
} from '../boardFeed'

const CODE = 'ABCD2345'

// A live state as the scorer pushes it (public fields only)
function liveState(overrides = {}) {
  return {
    current_set: 2,
    best_of: 5,
    match_status: 'live',
    sport_type: 'indoor',
    team_a_name: 'Home VC',
    team_a_short: 'HOM',
    team_a_color: '#e2001a',
    team_b_name: 'Away VC',
    team_b_short: 'AWA',
    team_b_color: '#fde047',
    sets_won_a: 1,
    sets_won_b: 0,
    points_a: 7,
    points_b: 5,
    side_a: 'right',
    serving_team: 'right',
    timeouts_a: 1,
    timeouts_b: 0,
    subs_count_a: 3,
    subs_count_b: 0,
    timeout_active: false,
    set_interval_active: false,
    set_results: [{ set: 1, home: 25, away: 20, a: 25, b: 20 }],
    updated_at: '2026-11-21T18:00:05.000Z',
    ...overrides
  }
}

function summary(type, matchId, extra = {}) {
  return {
    type,
    matchId,
    access: 'summary',
    match: { id: 'm', status: 'live', coinTossTeamA: 'home', homeTeamName: 'Home VC', awayTeamName: 'Away VC' },
    homeTeam: { name: 'Home VC' },
    awayTeam: { name: 'Away VC' },
    sets: [
      { index: 1, homePoints: 25, awayPoints: 20, finished: true },
      { index: 2, homePoints: 7, awayPoints: 5, finished: false }
    ],
    ...extra
  }
}

function fakeSocket() {
  const s = {
    readyState: 0,
    sent: [],
    send(text) { s.sent.push(JSON.parse(text)) },
    close: vi.fn(() => { s.readyState = 3 }),
    open() { s.readyState = 1; s.onopen?.() },
    receive(msg) { s.onmessage?.({ data: JSON.stringify(msg) }) },
    drop() { s.readyState = 3; s.onclose?.({ code: 1006 }) }
  }
  return s
}

const flush = () => new Promise((r) => setTimeout(r, 0))

function harness(opts = {}) {
  const sockets = []
  const timers = []
  const views = []
  let clock = 1_000_000
  const listeners = {}
  const events = {
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn) },
    removeEventListener: (type, fn) => { listeners[type] = (listeners[type] || []).filter((f) => f !== fn) }
  }
  const doc = { visibilityState: 'visible', ...events }
  const feed = createBoardFeed({
    target: { kind: 'code', code: CODE },
    onView: (v) => views.push(v),
    getWsUrl: async () => 'wss://relay.example',
    createSocket: (url) => { const s = fakeSocket(); s.url = url; sockets.push(s); return s },
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t },
    clearTimer: (t) => { const i = timers.indexOf(t); if (i !== -1) timers.splice(i, 1) },
    now: () => clock,
    events,
    doc,
    ...opts
  })
  const fire = (t) => { timers.splice(timers.indexOf(t), 1); return t.fn() }
  const timerOf = (ms) => timers.find((t) => t.ms === ms)
  return {
    feed, sockets, timers, views, fire, timerOf, listeners, doc,
    last: () => views[views.length - 1],
    tick: (ms) => { clock += ms },
    subs: (ws) => ws.sent.filter((m) => m.type === 'subscribe-match')
  }
}

describe('codes and the address', () => {
  it('normalises like the relay and formats ABCD-2345', () => {
    expect(normalizeBoardCode('abcd-2345')).toBe(CODE)
    expect(normalizeBoardCode(' ab cd 23 45 ')).toBe(CODE)
    expect(normalizeBoardCode('ABCD0345')).toBeNull() // 0 is not in the alphabet
    expect(normalizeBoardCode('ABCD234')).toBeNull()
    expect(normalizeBoardCode('ABCDI345')).toBeNull()
    expect(formatBoardCode('abcd2345')).toBe('ABCD-2345')
    expect(formatBoardCode('nope')).toBe('')
  })

  it('reads a code or a game number', () => {
    expect(parseBoardTarget('#ABCD2345')).toEqual({ kind: 'code', code: CODE })
    expect(parseBoardTarget('#code=ABCD-2345')).toEqual({ kind: 'code', code: CODE })
    expect(parseBoardTarget('abcd-2345')).toEqual({ kind: 'code', code: CODE })
    expect(parseBoardTarget('#12345')).toEqual({ kind: 'game', game: '12345' })
    expect(parseBoardTarget('#game=0077')).toEqual({ kind: 'game', game: '77' })
    expect(parseBoardTarget('1234567')).toEqual({ kind: 'game', game: '1234567' })
    // 8 digits of the alphabet are a code, not a game number
    expect(parseBoardTarget('23456789')).toEqual({ kind: 'code', code: '23456789' })
    expect(parseBoardTarget('12345678')).toBeNull() // 1 is not a code symbol, 8 digits not a game
    expect(parseBoardTarget('')).toBeNull()
    expect(parseBoardTarget('%E0%A4%A')).toBeNull()
    expect(boardTargetHash({ kind: 'code', code: CODE })).toBe('#ABCD2345')
    expect(boardTargetHash({ kind: 'game', game: '77' })).toBe('#77')
    expect(boardTargetHash(null)).toBe('')
  })

  it('knows the board paths', () => {
    expect(isBoardPath('/board')).toBe(true)
    expect(isBoardPath('/livescore/board')).toBe(true)
    expect(isBoardPath('/livescore/board/')).toBe(true)
    expect(isBoardPath('/livescore')).toBe(false)
    expect(isBoardPath('/livescore/scoreboard')).toBe(false)
  })

  it('takes the code from the fragment and leaves the address alone', () => {
    const history = { state: null, replaceState: vi.fn() }
    const target = takeBoardTargetFromUrl({ location: { pathname: '/board', search: '', hash: '#ABCD-2345' }, history })
    expect(target).toEqual({ kind: 'code', code: CODE })
    expect(history.replaceState).not.toHaveBeenCalled()
  })

  it('moves ?code= out of the address into the fragment', () => {
    const history = { state: null, replaceState: vi.fn() }
    const target = takeBoardTargetFromUrl({ location: { pathname: '/livescore/board', search: '?code=abcd-2345&server=x', hash: '' }, history })
    expect(target).toEqual({ kind: 'code', code: CODE })
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/livescore/board?server=x#ABCD2345')
    const url = history.replaceState.mock.calls[0][2]
    expect(url.split('#')[0]).not.toMatch(/ABCD/i)
  })

  it('removes a bad ?code= too', () => {
    const history = { state: null, replaceState: vi.fn() }
    expect(takeBoardTargetFromUrl({ location: { pathname: '/board', search: '?code=nope', hash: '' }, history })).toBeNull()
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/board')
  })

  it('writes and clears the fragment', () => {
    const history = { state: null, replaceState: vi.fn() }
    const location = { pathname: '/board', search: '', hash: '' }
    setBoardTargetInUrl({ kind: 'game', game: '42' }, { location, history })
    expect(history.replaceState).toHaveBeenLastCalledWith(null, '', '/board#42')
    setBoardTargetInUrl(null, { location, history })
    expect(history.replaceState).toHaveBeenLastCalledWith(null, '', '/board')
  })
})

describe('board view', () => {
  it('maps a livescore row to left / right as on court', () => {
    const row = { ...liveState(), match_id: 'seed-1', matches: { set_results: [{ set: 1, home: 25, away: 20 }], coin_toss: { team_a: 'home' } } }
    const v = boardScoreFromRow(row)
    // side_a right: team B plays left
    expect(v.left).toMatchObject({ name: 'Away VC', short: 'AWA', color: '#fde047', points: 5, sets: 0, timeoutsUsed: 0, subs: 0, serving: false })
    expect(v.right).toMatchObject({ name: 'Home VC', short: 'HOM', color: '#e2001a', points: 7, sets: 1, timeoutsUsed: 1, subs: 3, serving: true })
    expect(v.setResults).toEqual([{ set: 1, left: 20, right: 25 }])
    expect(v).toMatchObject({ setNumber: 2, bestOf: 5, phase: 'play' })
  })

  it('counts time-outs given as lists and drops a colour that is not one', () => {
    const v = boardScoreFromRow({ ...liveState({ side_a: 'left', timeouts_a: [{ ts: 1 }, { ts: 2 }], team_a_color: 'url(x)', subs_count_a: undefined }), match_id: 's' })
    expect(v.left.timeoutsUsed).toBe(2)
    expect(v.left.color).toBeNull()
    expect(v.left.subs).toBeNull()
  })

  it('maps a game summary, home on the left, no time-outs or substitutions', () => {
    const v = boardScoreFromCourt({
      home: { name: 'Home VC', short: 'HOM', color: '#123456' },
      away: { name: 'Away VC', short: null, color: null },
      setsWon: { home: 2, away: 1 },
      points: { home: 3, away: 8 },
      sets: [{ home: 25, away: 20 }, { home: 18, away: 25 }, { home: 25, away: 23 }],
      currentSet: 5,
      bestOf: 3,
      serving: 'away',
      status: 'live',
      ended: false,
      timeout: true,
      interval: false,
      updatedAt: '2026-11-21T18:00:00.000Z'
    })
    expect(v.left).toMatchObject({ name: 'Home VC', color: '#123456', points: 3, sets: 2, timeoutsUsed: null, subs: null, serving: false })
    expect(v.right).toMatchObject({ name: 'Away VC', points: 8, sets: 1, serving: true })
    expect(v.setResults).toEqual([{ set: 1, left: 25, right: 20 }, { set: 2, left: 18, right: 25 }, { set: 3, left: 25, right: 23 }])
    expect(v).toMatchObject({ setNumber: 3, bestOf: 3, phase: 'timeout' })
    expect(boardScoreFromCourt({ ended: true, interval: true, setsWon: {}, points: {} }).phase).toBe('final')
    expect(boardScoreFromCourt({ interval: true, setsWon: {}, points: {} }).phase).toBe('set_break')
  })
})

describe('createBoardFeed: code', () => {
  it('subscribes with the code only and follows the match it names', async () => {
    const h = harness()
    h.feed.start()
    expect(h.last().state).toBe('connecting')
    await flush()
    const ws = h.sockets[0]
    expect(ws.url).toBe('wss://relay.example')
    ws.open()
    expect(h.subs(ws)).toEqual([{ type: 'subscribe-match', code: CODE, device: 'display' }])
    for (const m of ws.sent) {
      expect(m).not.toHaveProperty('pin')
      expect(m).not.toHaveProperty('matchId')
    }
    expect(h.last().state).toBe('connecting')

    ws.receive({ type: 'display-code', ok: true, matchId: 'seed-1', endsAt: 1763784000000 })
    expect(h.last()).toMatchObject({ state: 'waiting', endsAt: 1763784000000, connected: true, code: 'ABCD-2345' })

    // Another room's messages are not this board's
    ws.receive(summary('match-full-data', 'seed-2', { liveState: liveState({ points_a: 20 }) }))
    expect(h.last().state).toBe('waiting')

    ws.receive(summary('match-full-data', 'seed-1', { liveState: liveState() }))
    expect(h.last()).toMatchObject({ state: 'live', phase: 'play', setNumber: 2 })
    expect(h.last().right).toMatchObject({ name: 'Home VC', points: 7, serving: true, timeoutsUsed: 1, subs: 3 })
    expect(h.last().left).toMatchObject({ name: 'Away VC', points: 5 })

    ws.receive({ type: 'live-state-update', matchId: 'seed-1', access: 'summary', liveState: liveState({ points_b: 6, serving_team: 'left', updated_at: '2026-11-21T18:00:09.000Z' }) })
    expect(h.last().left).toMatchObject({ points: 6, serving: true })
    expect(h.last().right.serving).toBe(false)

    ws.receive({ type: 'live-state-update', matchId: 'seed-1', liveState: liveState({ timeout_active: true, updated_at: '2026-11-21T18:00:20.000Z' }) })
    expect(h.last().phase).toBe('timeout')

    ws.receive({ type: 'scorer-presence', matchId: 'seed-1', present: false })
    expect(h.last().scorerPresent).toBe(false)
    ws.receive({ type: 'scorer-presence', matchId: 'seed-1', present: true })
    expect(h.last().scorerPresent).toBe(true)

    h.feed.stop()
    expect(ws.close).toHaveBeenCalled()
  })

  it('asks again after 15 s, 30 s, then every 60 s while the code is not found', async () => {
    const h = harness()
    h.feed.start()
    await flush()
    const ws = h.sockets[0]
    ws.open()
    ws.receive({ type: 'display-code', ok: false, reason: 'not-found' })
    expect(h.last().state).toBe('not-found')
    const waits = []
    for (let i = 0; i < 4; i++) {
      const t = h.timers.find((x) => BOARD_NOT_FOUND_RETRY_MS.includes(x.ms))
      waits.push(t.ms)
      h.fire(t)
      ws.receive({ type: 'display-code', ok: false, reason: 'not-found' })
    }
    expect(waits).toEqual([15000, 30000, 60000, 60000])
    // the same socket, a subscription per try
    expect(h.sockets).toHaveLength(1)
    expect(h.subs(ws)).toHaveLength(5)

    // Found at last: the retries stop
    ws.receive({ type: 'display-code', ok: true, matchId: 'seed-1', endsAt: 1 })
    expect(h.last().state).toBe('waiting')
    expect(h.timers.some((x) => BOARD_NOT_FOUND_RETRY_MS.includes(x.ms))).toBe(false)
  })

  it('treats an older relay\'s error answer as not found', async () => {
    const h = harness()
    h.feed.start()
    await flush()
    h.sockets[0].open()
    h.sockets[0].receive({ type: 'error', message: 'Match ID required' })
    expect(h.last().state).toBe('not-found')
    expect(h.timerOf(15000)).toBeTruthy()
  })

  it('waits retryAfter seconds when rate-limited', async () => {
    const h = harness()
    h.feed.start()
    await flush()
    const ws = h.sockets[0]
    ws.open()
    ws.receive({ type: 'display-code', ok: false, reason: 'rate-limited', retryAfter: 120 })
    expect(h.last()).toMatchObject({ state: 'rate-limited', retryAfter: 120 })
    const t = h.timerOf(120000)
    expect(t).toBeTruthy()
    h.fire(t)
    expect(h.subs(ws)).toHaveLength(2)
  })

  it('shows ended when the code ends, and keeps asking every 60 s', async () => {
    const h = harness()
    h.feed.start()
    await flush()
    const ws = h.sockets[0]
    ws.open()
    ws.receive({ type: 'display-code', ok: true, matchId: 'seed-1', endsAt: 1 })
    ws.receive(summary('match-full-data', 'seed-1', { liveState: liveState() }))
    expect(h.last().state).toBe('live')
    ws.receive({ type: 'display-code', ok: false, reason: 'ended', matchId: 'seed-1' })
    expect(h.last()).toMatchObject({ state: 'ended', left: null, right: null })
    // messages of the old room no longer count
    ws.receive({ type: 'live-state-update', matchId: 'seed-1', liveState: liveState({ points_a: 9, updated_at: '2026-11-21T18:01:00.000Z' }) })
    expect(h.last().state).toBe('ended')
    const t = h.timerOf(BOARD_ENDED_RETRY_MS)
    expect(t).toBeTruthy()
    h.fire(t)
    expect(h.subs(ws)).toHaveLength(2)
    // The scorer shares it again: back
    ws.receive({ type: 'display-code', ok: true, matchId: 'seed-1', endsAt: 2 })
    expect(h.last().state).toBe('waiting')
  })

  it('shows ended without a matchId and on match-deleted', async () => {
    const h = harness()
    h.feed.start()
    await flush()
    const ws = h.sockets[0]
    ws.open()
    ws.receive({ type: 'display-code', ok: false, reason: 'ended' })
    expect(h.last().state).toBe('ended')
    ws.receive({ type: 'display-code', ok: true, matchId: 'seed-1', endsAt: 1 })
    ws.receive(summary('match-full-data', 'seed-1', { liveState: liveState() }))
    ws.receive({ type: 'match-deleted', matchId: 'seed-1' })
    expect(h.last()).toMatchObject({ state: 'ended', left: null })
    expect(h.timerOf(BOARD_ENDED_RETRY_MS)).toBeTruthy()
  })

  it('keeps the score through a dropped socket and subscribes again on reconnect', async () => {
    const h = harness()
    h.feed.start()
    await flush()
    const ws = h.sockets[0]
    ws.open()
    ws.receive({ type: 'display-code', ok: true, matchId: 'seed-1', endsAt: 1 })
    ws.receive(summary('match-full-data', 'seed-1', { liveState: liveState() }))
    ws.drop()
    expect(h.last()).toMatchObject({ state: 'live', connected: false })
    expect(h.last().right.points).toBe(7)
    const reconnect = h.timerOf(5000)
    expect(reconnect).toBeTruthy()
    await h.fire(reconnect)
    await flush()
    const ws2 = h.sockets[1]
    ws2.open()
    expect(h.subs(ws2)).toEqual([{ type: 'subscribe-match', code: CODE, device: 'display' }])
    expect(h.last()).toMatchObject({ state: 'live', connected: true })
  })

  it('shows offline when the connection is lost with nothing to show', async () => {
    const h = harness()
    h.feed.start()
    await flush()
    h.sockets[0].drop() // never opened
    expect(h.last().state).toBe('offline')
  })

  it('reconnects when a ping gets no answer', async () => {
    const h = harness()
    h.feed.start()
    await flush()
    const ws = h.sockets[0]
    ws.open()
    const ping = h.timerOf(25000)
    expect(ping).toBeTruthy()
    h.tick(25000)
    h.fire(ping)
    expect(ws.sent.some((m) => m.type === 'ping')).toBe(true)
    const pong = h.timerOf(10000)
    h.tick(10000)
    h.fire(pong) // nothing arrived
    expect(ws.close).toHaveBeenCalled()
    expect(h.last().connected).toBe(false)
    const again = h.timerOf(0)
    expect(again).toBeTruthy()
    await h.fire(again)
    await flush()
    expect(h.sockets).toHaveLength(2)
  })

  it('keeps the socket when the pong arrives', async () => {
    const h = harness()
    h.feed.start()
    await flush()
    const ws = h.sockets[0]
    ws.open()
    h.tick(25000)
    h.fire(h.timerOf(25000))
    h.tick(100)
    ws.receive({ type: 'pong' })
    h.fire(h.timerOf(10000))
    expect(ws.close).not.toHaveBeenCalled()
    expect(h.timerOf(25000)).toBeTruthy() // the next ping
  })

  it('reconnects at once when the network is back or the screen is shown again', async () => {
    const h = harness()
    h.feed.start()
    await flush()
    h.sockets[0].open()
    h.sockets[0].drop()
    expect(h.timerOf(5000)).toBeTruthy()
    h.listeners.online.forEach((fn) => fn())
    await flush()
    expect(h.sockets).toHaveLength(2)
    expect(h.timerOf(5000)).toBeFalsy()
    h.sockets[1].open()
    // Visible again with the socket open: the code is asked for again
    h.doc.visibilityState = 'visible'
    h.listeners.visibilitychange.forEach((fn) => fn())
    expect(h.subs(h.sockets[1])).toHaveLength(2)
    h.feed.stop()
    expect(h.listeners.online).toHaveLength(0)
    expect(h.listeners.visibilitychange).toHaveLength(0)
  })
})

describe('createBoardFeed: game number', () => {
  const court = {
    home: { name: 'Home VC', short: 'HOM', color: '#e2001a' },
    away: { name: 'Away VC', short: 'AWA', color: '#1d4ed8' },
    setsWon: { home: 1, away: 0 },
    points: { home: 4, away: 2 },
    sets: [{ home: 25, away: 20 }],
    currentSet: 2,
    bestOf: 5,
    serving: 'home',
    status: 'live',
    ended: false,
    timeout: false,
    interval: false,
    updatedAt: '2026-11-21T18:00:00.000Z'
  }
  const ok = (courts) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: { code: 'game/77', courts }, error: null }) })

  it('polls the game endpoint every 5 s and maps the court', async () => {
    const answers = [ok([]), ok([court]), { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) }, ok([court])]
    const fetchImpl = vi.fn(async () => answers.shift())
    const h = harness({ target: { kind: 'game', game: '77' }, fetchImpl, gameUrl: (n) => `https://api.example/api/global/live/game/${n}` })
    h.feed.start()
    await flush()
    expect(fetchImpl).toHaveBeenCalledWith('https://api.example/api/global/live/game/77', expect.objectContaining({ cache: 'no-store' }))
    expect(h.last()).toMatchObject({ state: 'not-found', mode: 'game', game: '77', code: null })
    expect(h.sockets).toHaveLength(0)

    await h.fire(h.timerOf(5000))
    await flush()
    expect(h.last()).toMatchObject({ state: 'live', connected: true, setNumber: 2 })
    expect(h.last().left).toMatchObject({ name: 'Home VC', points: 4, serving: true, timeoutsUsed: null, subs: null })

    // An error: the score stays, the next try waits longer
    await h.fire(h.timerOf(5000))
    await flush()
    expect(h.last()).toMatchObject({ state: 'live', connected: false })
    const backoff = h.timers[0]
    expect(backoff.ms).toBe(10000)
    await h.fire(backoff)
    await flush()
    expect(h.last()).toMatchObject({ state: 'live', connected: true })
    expect(h.timerOf(5000)).toBeTruthy()
  })

  it('waits Retry-After on 429', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429, headers: { get: (k) => (k === 'Retry-After' ? '30' : null) }, json: async () => ({}) }))
    const h = harness({ target: { kind: 'game', game: '77' }, fetchImpl, gameUrl: () => 'https://api.example/x' })
    h.feed.start()
    await flush()
    expect(h.last()).toMatchObject({ state: 'rate-limited', retryAfter: 30 })
    expect(h.timerOf(30000)).toBeTruthy()
  })

  it('shows offline when the server never answers', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('offline') })
    const h = harness({ target: { kind: 'game', game: '77' }, fetchImpl, gameUrl: () => 'https://api.example/x' })
    h.feed.start()
    await flush()
    expect(h.last()).toMatchObject({ state: 'offline', connected: false })
    // online: asked again at once
    h.listeners.online.forEach((fn) => fn())
    await flush()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
