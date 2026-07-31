// HTTP control server for the LedBox appliance — serves the web UI and a small JSON API
// to drive the board manually or link it to a live LAN match. Zero dependencies (node:http/fs).
//
//   web UI --fetch--> controlServer --> SourceManager --state--> LedboxClient --> LedBox

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { LanSource } from './lanSource.js'
import { toSections, toLeftRight } from './volleyballMapper.js'

// Board shown when the operator picks "Blank" (all short names + serve cleared).
const BLANK = {
  side_a: 'left', team_a_name: '', team_a_short: '', team_a_color: '#2563eb',
  team_b_name: '', team_b_short: '', team_b_color: '#ef4444',
  points_a: 0, points_b: 0, sets_won_a: 0, sets_won_b: 0,
  timeouts_a: 0, timeouts_b: 0, subs_a: 0, subs_b: 0, serving_team: null,
}

const ACTION_TYPES = new Set(['point', 'set', 'timeout', 'sub', 'serve', 'swap', 'team', 'next-set', 'remove-set', 'reset', 'set-state'])

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

// Max accepted request body — one bad/slow-drip POST must not exhaust the heap.
const MAX_BODY = 1 << 20 // 1 MiB

// A trivial idle source so /api/blank can put the SourceManager into an idle meta via the
// uniform Source interface (stops the previous source). It carries the state it was seeded
// with so the SourceManager caches it — keeping /api/status in sync with the blanked board.
class IdleSource extends EventEmitter {
  constructor(state = null) { super(); this._state = state }
  getState() { return this._state }
  start() {}
  stop() {}
}

export function createControlServer({ sourceManager, manualSource, ledbox, relayHttpUrl, relayUrl, webDir, reconnectMs, settings }) {
  const opt = (k) => (settings ? settings.values[k] : undefined)
  // Ephemeral display countdown (timeout 30s / set interval / side switch). Owned here
  // so it reaches every surface from ONE source: the control UI banner, the
  // /mockledbox mirror (via /api/board), AND the physical LedBox (pushed once a second
  // by the ticker below). Not part of the board liveState — a transient overlay.
  let countdown = null // { label, endsAt } | null
  let cdTicker = null
  function countdownView() {
    if (!countdown) return null
    const remainingMs = countdown.endsAt - Date.now()
    if (remainingMs <= 0) { stopCountdown(); return null }
    return { label: countdown.label, remainingMs }
  }
  function startCountdown(seconds, label, content = 'full') {
    countdown = { label: String(label || ''), content, endsAt: Date.now() + seconds * 1000 }
    if (cdTicker) clearInterval(cdTicker)
    const tick = () => {
      const remainingMs = countdown ? countdown.endsAt - Date.now() : -1
      if (remainingMs <= 0) return stopCountdown({ expired: true })
      // Best-effort push to the physical board (no-op when not ready / no method).
      if (ledbox && typeof ledbox.pushCountdown === 'function') {
        ledbox.pushCountdown(Math.ceil(remainingMs / 1000), countdown.label, { content: countdown.content }).catch(() => {})
      }
    }
    tick()
    cdTicker = setInterval(tick, 1000)
    // Don't let this daemon-side timer keep the process (or a test) alive.
    if (cdTicker.unref) cdTicker.unref()
  }
  // expired=true means the clock reached zero (time's up); false is a manual skip. Guarded so
  // that whichever of {server tick, client /stop} fires first wins — the other is a no-op, so
  // the horn sounds exactly once.
  function stopCountdown({ expired = false } = {}) {
    if (!countdown) return
    countdown = null
    if (cdTicker) { clearInterval(cdTicker); cdTicker = null }
    if (ledbox && typeof ledbox.pushCountdown === 'function') ledbox.pushCountdown(null).catch(() => {})
    if (expired && opt('hornOnCountdownEnd') && ledbox && typeof ledbox.horn === 'function') {
      ledbox.horn().catch(() => {})
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      const { pathname } = url

      if (req.method === 'OPTIONS') return send(res, 204, null)

      if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname)

      // Pretty route for the virtual-board mirror (both the correct + user-typed spelling).
      if (pathname === '/mockledbox' || pathname === '/mochledbox') {
        return serveStatic(res, '/mockledbox.html', webDir)
      }

      // Static web UI.
      return serveStatic(res, pathname, webDir)
    } catch (err) {
      // Malformed JSON bodies are a client error, not a server crash.
      if (err instanceof SyntaxError) return sendJson(res, 400, { error: 'invalid JSON body' })
      // A tagged client error (e.g. body too large) carries its own status code.
      if (err && err.statusCode) return sendJson(res, err.statusCode, { error: err.message })
      // Don't leak internal error detail to clients; log it server-side instead.
      console.error('[control] request error:', err)
      return sendJson(res, 500, { error: 'internal error' })
    }
  })

  async function handleApi(req, res, pathname) {
    // GET /api/status
    if (pathname === '/api/status' && req.method === 'GET') {
      return sendJson(res, 200, status())
    }
    // GET /api/board — the exact section map pushed to the LedBox (1:1 mirror for the web view)
    if (pathname === '/api/board' && req.method === 'GET') {
      return sendJson(res, 200, board())
    }
    // GET /api/matches
    if (pathname === '/api/matches' && req.method === 'GET') {
      return sendJson(res, 200, await listMatches())
    }
    // POST /api/manual
    if (pathname === '/api/manual' && req.method === 'POST') {
      await readJson(req) // drain
      sourceManager.setSource(manualSource, { mode: 'manual' })
      return sendJson(res, 200, status())
    }
    // POST /api/action { action }
    if (pathname === '/api/action' && req.method === 'POST') {
      const body = await readJson(req)
      const action = body && body.action
      if (!action || !ACTION_TYPES.has(action.type)) {
        return sendJson(res, 400, { error: 'unknown or missing action.type' })
      }
      if (sourceManager.status.mode !== 'manual') {
        sourceManager.setSource(manualSource, { mode: 'manual' })
      }
      // Any live action (point, serve, …) means the match is on — drop the idle screen so
      // the state push below actually paints the scoreboard.
      if (ledbox && ledbox._idle && typeof ledbox.showIdle === 'function') ledbox.showIdle(false)
      manualSource.apply(action)
      pulseForAction(ledbox, action, settings, manualSource.getState())
      return sendJson(res, 200, { ok: true, state: manualSource.getState(), event: manualSource.lastEvent })
    }
    // GET /api/settings — operator preferences (persisted on the Pi)
    if (pathname === '/api/settings' && req.method === 'GET') {
      return sendJson(res, 200, settings ? settings.values : {})
    }
    // POST /api/settings — partial update; unknown keys are dropped and numbers clamped
    if (pathname === '/api/settings' && req.method === 'POST') {
      const body = await readJson(req)
      if (!settings) return sendJson(res, 501, { error: 'settings unavailable' })
      const updated = settings.update(body || {})
      // The counter-colour thresholds live on the client; push the new totals so the board
      // recolours immediately.
      if (ledbox && typeof ledbox.setLimits === 'function') {
        ledbox.setLimits({
          totalTimeouts: updated.totalTimeouts,
          totalSubs: updated.totalSubs,
          idleFullNames: updated.idleFullNames,
          idleFontMax: updated.idleFontMax,
        })
      }
      return sendJson(res, 200, updated)
    }
    // POST /api/link { source, matchId }
    if (pathname === '/api/link' && req.method === 'POST') {
      const body = await readJson(req)
      const source = body && body.source
      if (source === 'cloud') return sendJson(res, 501, { error: 'cloud not implemented' })
      if (source !== 'lan') return sendJson(res, 400, { error: 'unknown source' })
      if (body.matchId == null) return sendJson(res, 400, { error: 'matchId required' })
      const lan = new LanSource({ relayUrl, matchId: String(body.matchId), reconnectMs })
      sourceManager.setSource(lan, { mode: 'lan', matchId: String(body.matchId) })
      return sendJson(res, 200, status())
    }
    // POST /api/countdown { seconds, label, content, swapFirst } — start the shared timer.
    // swapFirst (the set interval) applies next-set FIRST — swap ends + reset points — with the
    // board paint suppressed, so we go straight from the final score to the interval screen with
    // the swapped sets. One atomic sequence, no match-layout repaint to race the layout switch.
    if (pathname === '/api/countdown' && req.method === 'POST') {
      const body = await readJson(req)
      const seconds = Number(body && body.seconds)
      if (!Number.isFinite(seconds) || seconds <= 0) {
        return sendJson(res, 400, { error: 'seconds must be a positive number' })
      }
      const content = ['full', 'sets', 'none'].includes(body && body.content) ? body.content : 'full'
      let state
      if (body && body.swapFirst) {
        ledbox._suppressPaint = true // update the state (+ _lastState) without painting the match
        manualSource.apply({ type: 'next-set' })
        ledbox._suppressPaint = false
        state = manualSource.getState()
      }
      startCountdown(seconds, body && body.label, content)
      return sendJson(res, 200, { ok: true, state })
    }
    // POST /api/countdown/stop { expired } — clear the display timer. The UI-driven clock
    // reaches zero before the server tick does, so the client tells us WHY it stopped:
    // expired=true fires the end horn, a manual skip does not.
    if (pathname === '/api/countdown/stop' && req.method === 'POST') {
      const body = await readJson(req)
      stopCountdown({ expired: !!(body && body.expired) })
      return sendJson(res, 200, { ok: true })
    }
    // POST /api/idle { on } — show the names+VS pre-match screen (on=false returns to scoring)
    if (pathname === '/api/idle' && req.method === 'POST') {
      const body = await readJson(req)
      const on = body ? body.on !== false : true
      if (ledbox && typeof ledbox.showIdle === 'function') await ledbox.showIdle(on)
      return sendJson(res, 200, { ok: true, idle: on })
    }
    // POST /api/blank
    if (pathname === '/api/blank' && req.method === 'POST') {
      await readJson(req) // drain
      // Seed the idle source with BLANK so SourceManager caches it and pushes it to the
      // board — /api/status.state then matches the physical (blanked) board.
      sourceManager.setSource(new IdleSource(BLANK), { mode: 'idle', matchId: null })
      await ledbox.pushState(BLANK)
      return sendJson(res, 200, status())
    }
    return sendJson(res, 404, { error: 'not found' })
  }

  function status() {
    const { mode, matchId } = sourceManager.status
    return {
      mode, matchId,
      ledbox: { connected: ledbox.ready === true, host: ledbox.host, port: ledbox.port, layout: ledbox.currentLayout },
      state: sourceManager.getState(),
    }
  }

  // The exact SetSections payload the LedBox is showing right now, folded into a
  // { sectionName: {text,color} } map so a browser can render a 1:1 mirror of the
  // physical board. Works with or without hardware (it maps the live liveState the
  // same way the LedboxClient does before pushing).
  function board() {
    const state = sourceManager.getState() || {}
    return {
      layout: ledbox.layout,
      connected: ledbox.ready === true,
      mode: sourceManager.status.mode,
      countdown: countdownView(),
      screen: sectionsToScreen(toSections(state)),
    }
  }

  // Query the OpenVolley relay for its match list; never throws (failures land in errors[]).
  async function listMatches() {
    const errors = []
    const matches = []
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 2000)
      let data
      try {
        const resp = await fetch(`${relayHttpUrl}/api/match/list`, { signal: ctrl.signal })
        if (!resp.ok) throw new Error(`relay responded ${resp.status}`)
        data = await resp.json()
      } finally {
        clearTimeout(timer)
      }
      const list = Array.isArray(data) ? data : (data.matches || data.list || [])
      for (const m of list) {
        const num = m.gameNumber || m.game_n || m.id
        const home = m.homeShort || m.home_short || m.homeTeam || m.home || ''
        const away = m.awayShort || m.away_short || m.awayTeam || m.away || ''
        const teams = home || away ? ` ${home}-${away}` : ''
        matches.push({ source: 'lan', id: String(m.id), label: `${num}${teams}`, live: m.status === 'live' })
      }
    } catch (err) {
      errors.push(`lan: ${err.message}`)
    }
    return { matches, errors }
  }

  return server
}

// Acknowledge an entry ON THE BOARD, not just in the operator's app: the scored point (or
// the substitution just used up) blinks for a couple of seconds. The mapper always paints
// physical left -> section 1, so the action's side maps straight onto the section number.
// Only additions blink — correcting a mistake downward should be quiet.
function pulseForAction(ledbox, action = {}, settings = null, state = null) {
  if (!ledbox || typeof ledbox.pulse !== 'function') return
  if (!(Number(action.delta) > 0)) return // only a real +1 blinks — not a typed correction
  const s = settings ? settings.values : {}
  const ms = s.blinkMs
  const n = action.side === 'right' ? '2' : '1'
  // Blink in the team's own colour (the board would otherwise use the layout default).
  const v = state ? toLeftRight(state) : null
  const color = v ? (action.side === 'right' ? v.rightColor : v.leftColor) : null
  if (action.type === 'point' && s.blinkPoint !== false) ledbox.pulse(`score${n}`, ms, color)
  else if (action.type === 'sub' && s.blinkSub !== false) ledbox.pulse(`sub${n}`, ms, color)
}

// --- helpers ---

// Fold a SetSections `value` array into { sectionName: { text, color } } — mirrors
// MockLedbox._applySections so the web view shows exactly what the device holds.
function sectionsToScreen(sections) {
  const screen = {}
  for (const s of sections) {
    // The WRITE shape carries ONE attribute per entry, so a section appears once per
    // attribute. Accumulate into the existing entry — replacing it lets the `color`
    // entry wipe the `text` the same section set a moment earlier.
    const cur = screen[s.name] || (screen[s.name] = {})
    const attrs = Array.isArray(s.value) ? s.value : [s.value]
    for (const a of attrs) {
      if (a.attrib === 'text') cur.text = a.value
      if (a.attrib === 'color') cur.color = a.value
    }
  }
  return screen
}

// Serve a file from webDir (or index.html for "/"), rejecting any path escaping webDir.
function serveStatic(res, pathname, webDir) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const full = path.resolve(webDir, rel)
  const root = path.resolve(webDir)
  if (full !== root && !full.startsWith(root + path.sep)) return send(res, 403, 'forbidden')
  fs.readFile(full, (err, buf) => {
    if (err) return send(res, 404, 'not found')
    const type = CONTENT_TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream'
    // The whole UI is one self-contained file that we redeploy often; never let a phone serve a
    // stale cached copy (that surfaced as "the board doesn't switch" after a fix was deployed).
    send(res, 200, buf, { 'Content-Type': type, 'Cache-Control': 'no-cache, no-store, must-revalidate' })
  })
}

// Read + JSON-parse a request body. Empty body -> {}. Invalid JSON throws SyntaxError.
function readJson(req) {
  return new Promise((resolve, reject) => {
    // Reject an oversized Content-Length up front so a well-behaved client still gets
    // a clean 413 (leave the socket alive to carry the response).
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > MAX_BODY) {
      const e = new Error('request body too large'); e.statusCode = 413
      return reject(e)
    }
    let raw = ''
    let size = 0
    let done = false
    req.on('data', (c) => {
      if (done) return
      size += c.length
      // Cap accumulation so a slow-drip / chunked body can't exhaust the heap; a client
      // that lies about its length gets the connection torn down.
      if (size > MAX_BODY) {
        done = true
        const e = new Error('request body too large'); e.statusCode = 413
        req.destroy()
        return reject(e)
      }
      raw += c
    })
    req.on('end', () => {
      if (!raw.trim()) return resolve({})
      try { resolve(JSON.parse(raw)) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

function sendJson(res, code, obj) {
  send(res, code, obj == null ? '' : JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' })
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, { ...CORS, ...headers })
  res.end(body == null ? undefined : body)
}
