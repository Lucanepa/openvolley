#!/usr/bin/env node
/**
 * Reference client of the scoreboard feed (docs/scoreboard-feed.md): prints
 * the score of the match a scoreboard code names, from the cloud or from a
 * relay in the hall. No dependencies (Node 22+: its built-in WebSocket and
 * fetch).
 *
 *   node scoreboard-client.mjs --code ABCD-2345
 *   node scoreboard-client.mjs --code ABCD-2345 --server http://192.168.1.20:5173
 *   node scoreboard-client.mjs --code ABCD-2345 --poll        # HTTP only, every 2 s
 *   node scoreboard-client.mjs --code ABCD-2345 --once        # one line, then exit
 *   OV_SCOREBOARD_CODE=ABCD-2345 node scoreboard-client.mjs   # the code from the environment
 *
 * --server  the relay's HTTP base: https://backend.openvolley.app (default),
 *           or a hall relay (the desktop app, server.js), e.g. http://192.168.1.20:5173.
 *           The WebSocket is the cloud's own origin, a hall relay's wsPort
 *           (GET /api/server/status).
 * --ws      the WebSocket URL itself, when it is somewhere else.
 *
 * WebSocket mode: subscribe-match { code, device: 'display' }, then every
 * live-state-update; it reconnects with 5, 10, 20, 30 s and subscribes again.
 * Poll mode: POST /api/display/live every 2 s. Exit codes: 0, 2 (bad
 * arguments), 3 (the code is not valid or has ended).
 */

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const opt = (name, fallback = null) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : fallback }

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
/** As the relay compares a code: upper case, spaces and dashes removed, 8 symbols. */
export function normalizeCode(value) {
  if (typeof value !== 'string') return null
  const s = value.toUpperCase().replace(/[\s-]/g, '')
  return s.length === 8 && [...s].every((c) => ALPHABET.includes(c)) ? s : null
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

/**
 * One line for a public live state (match_live_state columns, docs/scoreboard-feed.md):
 * Team A and Team B as the scorer's live state names them.
 */
export function scoreLine(live, { homeTeam = null, awayTeam = null } = {}) {
  if (!live || typeof live !== 'object') return 'Waiting for the scorer…'
  const name = (v, fallback) => (typeof v === 'string' && v.trim() ? v.trim() : fallback)
  const teamName = (t) => (typeof t === 'string' ? t : t?.name)
  const a = name(live.team_a_name, name(teamName(homeTeam), 'Team A'))
  const b = name(live.team_b_name, name(teamName(awayTeam), 'Team B'))
  // serving_team is a court side; side_a is where Team A plays
  const serving = live.serving_team && live.side_a ? (live.serving_team === live.side_a ? 'A' : 'B') : null
  const sets = Array.isArray(live.set_results) ? live.set_results.map((s) => `${num(s.a)}:${num(s.b)}`).join(' ') : ''
  const phase = live.match_status === 'final' || live.match_status === 'ended'
    ? 'final'
    : live.timeout_active ? 'time-out' : live.set_interval_active ? 'set break' : `set ${num(live.current_set) || 1}`
  return [
    `${a}${serving === 'A' ? ' •' : ''} ${num(live.sets_won_a)} | ${num(live.points_a)} : ${num(live.points_b)} | ${num(live.sets_won_b)} ${serving === 'B' ? '• ' : ''}${b}`,
    phase,
    sets ? `sets ${sets}` : null,
    `time-outs ${num(live.timeouts_a)}/${num(live.timeouts_b)}`,
    live.subs_count_a != null || live.subs_count_b != null ? `subs ${num(live.subs_count_a)}/${num(live.subs_count_b)}` : null
  ].filter(Boolean).join(' · ')
}

async function postLive(server, code) {
  const res = await fetch(`${server}/api/display/live`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code })
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body, retryAfter: Number(res.headers.get('retry-after')) || null }
}

async function wsUrlOf(server) {
  const u = new URL(server)
  if (u.protocol === 'https:') return `wss://${u.host}`
  // a hall relay: its WebSocket port from /api/server/status
  try {
    const status = await (await fetch(`${server}/api/server/status`)).json()
    if (status?.wsPort) return `${status.wsProtocol || 'ws'}://${u.hostname}:${status.wsPort}`
  } catch { /* the same origin then */ }
  return `ws://${u.host}`
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function poll(server, code, once) {
  let last = null
  for (;;) {
    let r
    try { r = await postLive(server, code) } catch (err) { r = { status: 0, body: null, error: err.message } }
    if (r.status === 200 && r.body?.ok) {
      const line = scoreLine(r.body.liveState, r.body)
      if (line !== last) console.log(line)
      last = line
      if (once) return 0
      await sleep(2000)
    } else if (r.status === 404 || r.status === 410) {
      console.error(r.status === 410 ? 'This scoreboard code has ended.' : 'This scoreboard code is not valid.')
      return 3
    } else if (r.status === 429) {
      await sleep((r.retryAfter || 60) * 1000)
    } else {
      console.error(`No answer (${r.status || r.error}), trying again…`)
      await sleep(5000)
    }
  }
}

function follow(wsUrl, code, once) {
  return new Promise((resolve) => {
    let attempt = 0
    let last = null
    const state = { live: null, homeTeam: null, awayTeam: null, matchId: null }
    const connect = () => {
      const ws = new WebSocket(wsUrl)
      let ping = null
      ws.onopen = () => {
        attempt = 0
        ws.send(JSON.stringify({ type: 'subscribe-match', code, device: 'display' }))
        ping = setInterval(() => ws.send(JSON.stringify({ type: 'ping' })), 25000)
      }
      ws.onmessage = (event) => {
        let m
        try { m = JSON.parse(event.data) } catch { return }
        if (m.type === 'display-code') {
          if (m.ok) { state.matchId = m.matchId; return }
          if (m.reason === 'rate-limited') { console.error(`Too many tries, waiting ${m.retryAfter} s…`); return }
          console.error(m.reason === 'ended' ? 'This scoreboard code has ended.' : 'This scoreboard code is not valid.')
          clearInterval(ping)
          ws.onclose = null
          ws.close()
          resolve(3)
          return
        }
        if (String(m.matchId) !== String(state.matchId)) return
        if (m.type === 'match-full-data' || m.type === 'match-data-update') {
          state.homeTeam = m.homeTeam ?? state.homeTeam
          state.awayTeam = m.awayTeam ?? state.awayTeam
          if (m.liveState) state.live = m.liveState
        } else if (m.type === 'live-state-update' && m.liveState) {
          state.live = m.liveState
        } else {
          return
        }
        const line = scoreLine(state.live, state)
        if (line !== last) console.log(line)
        last = line
        if (once && state.live) {
          clearInterval(ping)
          ws.onclose = null
          ws.close()
          resolve(0)
        }
      }
      ws.onclose = () => {
        clearInterval(ping)
        const delay = Math.min(5000 * 2 ** attempt++, 30000)
        console.error(`Connection lost, again in ${delay / 1000} s…`)
        setTimeout(connect, delay)
      }
      ws.onerror = () => { /* onclose follows */ }
    }
    connect()
  })
}

async function main() {
  const code = normalizeCode(opt('code', process.env.OV_SCOREBOARD_CODE || ''))
  if (!code) {
    console.error('Usage: node scoreboard-client.mjs --code ABCD-2345 [--server URL] [--ws URL] [--poll] [--once]')
    return 2
  }
  const server = String(opt('server', 'https://backend.openvolley.app')).replace(/\/+$/, '')
  if (flag('poll') || typeof WebSocket !== 'function') return poll(server, code, flag('once'))
  return follow(opt('ws') || await wsUrlOf(server), code, flag('once'))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((codeOut) => process.exit(codeOut), (err) => { console.error(err?.message || err); process.exit(1) })
}
