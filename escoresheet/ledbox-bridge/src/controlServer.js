// HTTP control server for the LedBox appliance — serves the web UI and a small JSON API
// to drive the board manually or link it to a live LAN match. Zero dependencies (node:http/fs).
//
//   web UI --fetch--> controlServer --> SourceManager --state--> LedboxClient --> LedBox

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { LanSource } from './lanSource.js'
import { toLeftRight } from './volleyballMapper.js'
import { execFile } from 'node:child_process'
import { HistoryStore } from './historyStore.js'
import { ResumeStore } from './resumeStore.js'
import { SPORT_LIST } from './sports.js'
import { PER_SPORT_KEYS } from './settings.js'
import { log, LEVELS } from './logStore.js'

const clog = log.child('control')
const alog = log.child('action')

// The browser can post its own errors to /api/logs. That endpoint is deliberately open (a
// spectator's phone hitting a bug is exactly what we want to see, and it has no PIN), so it is
// rate-limited instead — one misbehaving tab in a reload loop must not fill the card.
const UI_LOG_PER_MIN = 60
const uiRate = { windowStart: 0, count: 0 }

// Board shown when the operator picks "Blank" (all short names + serve cleared).
const BLANK = {
  side_a: 'left', team_a_name: '', team_a_short: '', team_a_color: '#2563eb',
  team_b_name: '', team_b_short: '', team_b_color: '#ef4444',
  points_a: 0, points_b: 0, sets_won_a: 0, sets_won_b: 0,
  timeouts_a: 0, timeouts_b: 0, subs_a: 0, subs_b: 0, serving_team: null,
}

const ACTION_TYPES = new Set(['point', 'set', 'timeout', 'sub', 'serve', 'serve-order', 'serve-player', 'swap', 'team', 'next-set', 'remove-set', 'reset', 'set-state'])

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

// Push a new LED brightness to the panel. `startled` reads [DISPLAY] brightness from setting.ini
// and passes it to flushBuffer2 at launch, so we rewrite that key and bounce the driver. The
// bridge runs as pi (passwordless sudo); setting.ini is world-writable. Best-effort — any failure
// is logged, never thrown, and off the board (dev, no setting.ini) it simply no-ops.
const SETTING_INI = '/home/pi/ledbox/setting.ini'
// Brightness 0 = panel off. This flag file (checked by the board watchdog) is what keeps the
// panel dark: without it the watchdog would relight the driver within 30s. Removing it lets the
// watchdog keep the panel alive again.
const PANEL_OFF_FLAG = '/home/pi/ledbox/PANEL_OFF'
// Restart the panel driver at the current setting.ini brightness: SIGTERM the running driver,
// then — under a lock the watchdog shares — WAIT for it to actually exit before starting exactly
// one. Both halves matter: flushBuffer2 can take up to ~1s to release the GPIO on SIGTERM, so
// starting on a fixed timer would either be skipped (guard still sees the dying process) or spawn
// a second driver that fights it — which shows as vertical flicker on the panel. The shared lock
// stops the watchdog racing this start. Process match is `-x flushBuffer2` (exact comm) so the
// transient `sudo` wrapper never counts as a live driver.
const PANEL_RESTART =
  'sudo pkill -x flushBuffer2; ' +
  "flock /home/pi/ledbox/panel.lock -c 'for i in $(seq 25); do pgrep -x flushBuffer2 >/dev/null 2>&1 || break; sleep 0.2; done; " +
  "pgrep -x flushBuffer2 >/dev/null 2>&1 || ( cd /home/pi/ledbox/bin && ./startled >/dev/null 2>&1 & )'"

function applyBrightness(value) {
  if (value <= 0) {
    // Off: raise the flag first (so the watchdog leaves it dark), then stop the driver. The
    // scoreboard app keeps running, so the controller UI stays reachable to switch it back on.
    try { fs.writeFileSync(PANEL_OFF_FLAG, '') } catch (err) { clog.error(`brightness off-flag write failed: ${err.message}`, { file: PANEL_OFF_FLAG, error: err.message }) }
    clog.info('panel driver stopped (brightness 0)')
    execFile('sudo', ['pkill', '-x', 'flushBuffer2'], (err) => {
      if (err) clog.warn(`pkill flushBuffer2 failed: ${err.message}`, { error: err.message })
    })
    return
  }
  // On (or level change): clear the off-flag so the watchdog keeps the panel alive.
  try { fs.rmSync(PANEL_OFF_FLAG, { force: true }) } catch { /* not off, nothing to clear */ }
  try {
    let ini = fs.readFileSync(SETTING_INI, 'utf8')
    ini = /^brightness=.*$/m.test(ini)
      ? ini.replace(/^brightness=.*$/m, `brightness=${value}`)
      : ini.replace(/^\[DISPLAY\][^\n]*$/m, (m) => `${m}\nbrightness=${value}`)
    try {
      const tmp = `${SETTING_INI}.tmp`
      fs.writeFileSync(tmp, ini)
      fs.renameSync(tmp, SETTING_INI)
    } catch {
      fs.writeFileSync(SETTING_INI, ini) // world-writable file; write in place if staging a tmp fails
    }
  } catch (err) {
    // Off the board (dev, no setting.ini) this is the expected path, not a fault.
    clog.debug(`setting.ini update skipped: ${err.message}`, { file: SETTING_INI, error: err.message })
    return
  }
  // setting.ini now holds the new level, so whichever starter wins the lock launches at it.
  clog.info(`restarting the panel driver at brightness ${value}`, { brightness: value })
  execFile('bash', ['-c', PANEL_RESTART], (err) => {
    if (err) clog.warn(`panel driver restart reported an error: ${err.message}`, { error: err.message })
  })
}

export function createControlServer({ sourceManager, manualSource, ledbox, relayHttpUrl, relayUrl, webDir, reconnectMs, settings }) {
  const opt = (k) => (settings ? settings.values[k] : undefined)
  // Completed-match log (History tab + CSV/JSON export). Persisted beside the bridge.
  const history = new HistoryStore({ file: path.resolve(webDir, '..', 'data', 'history.json') })
  // The per-sport "last game" slot behind the New / Continue / Delete menu (see resumeStore.js).
  const resume = new ResumeStore({ file: path.resolve(webDir, '..', 'data', 'resume.json') })
  const activeSport = () => (settings ? settings.values.sport : 'volleyball')
  // Scorer lock: with a PIN set, mutating requests must carry it (X-Scorer-Pin header) — a
  // spectator who scanned the QR can watch but not score. GET reads stay open.
  const pinOk = (req) => {
    const need = settings ? settings.values.scorerPin : ''
    const ok = !need || String(req.headers['x-scorer-pin'] || '') === String(need)
    // A locked board rejecting a phone is normally a spectator poking at it, but it is also
    // what a scorer sees when they mistype — either way it belongs in the record.
    if (!ok) clog.warn(`rejected ${req.method} ${req.url} — wrong or missing scorer PIN`, { path: req.url, ip: clientIp(req) })
    return ok
  }
  const denyPin = (res) => sendJson(res, 403, { error: 'scorer PIN required' })
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
  function startCountdown(seconds, label, content = 'full', team = '') {
    clog.info(`countdown started: ${label || '(no label)'} ${seconds}s`, { seconds, label: String(label || ''), content, team: String(team || '') })
    countdown = { label: String(label || ''), content, team: String(team || ''), endsAt: Date.now() + seconds * 1000 }
    if (cdTicker) clearInterval(cdTicker)
    const tick = () => {
      const remainingMs = countdown ? countdown.endsAt - Date.now() : -1
      if (remainingMs <= 0) return stopCountdown({ expired: true })
      // Best-effort push to the physical board (no-op when not ready / no method).
      if (ledbox && typeof ledbox.pushCountdown === 'function') {
        ledbox.pushCountdown(Math.ceil(remainingMs / 1000), countdown.label, { content: countdown.content, team: countdown.team }).catch(() => {})
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
    clog.info(expired ? 'countdown reached zero' : 'countdown skipped', {
      expired, label: countdown.label, horn: !!(expired && opt('hornOnCountdownEnd')),
    })
    countdown = null
    if (cdTicker) { clearInterval(cdTicker); cdTicker = null }
    if (ledbox && typeof ledbox.pushCountdown === 'function') ledbox.pushCountdown(null).catch(() => {})
    if (expired && opt('hornOnCountdownEnd') && ledbox && typeof ledbox.horn === 'function') {
      ledbox.horn().catch(() => {})
    }
  }

  const server = http.createServer(async (req, res) => {
    // Every request is timed and recorded once it completes. GETs are polled about once a
    // second by every open tab, so they sit at `debug`; anything that mutates the board, and
    // anything that failed, is `info` or louder.
    const started = Date.now()
    res.on('finish', () => {
      const ms = Date.now() - started
      const line = `${req.method} ${req.url} → ${res.statusCode} (${ms}ms)`
      const data = { method: req.method, path: req.url, status: res.statusCode, ms, ip: clientIp(req) }
      if (res.statusCode >= 500) clog.error(line, data)
      else if (res.statusCode >= 400) clog.warn(line, data)
      else if (req.method === 'GET') clog.debug(line, data)
      else clog.info(line, data)
    })
    try {
      const url = new URL(req.url, 'http://localhost')
      const { pathname } = url

      if (req.method === 'OPTIONS') return send(res, 204, null)

      if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname)

      // Pretty route for the virtual-board mirror (both the correct + user-typed spelling).
      if (pathname === '/mockledbox' || pathname === '/mochledbox') {
        return serveStatic(res, '/mockledbox.html', webDir)
      }

      // Pretty route for the log viewer.
      if (pathname === '/logs') return serveStatic(res, '/logs.html', webDir)

      // Static web UI.
      return serveStatic(res, pathname, webDir)
    } catch (err) {
      // Malformed JSON bodies are a client error, not a server crash.
      if (err instanceof SyntaxError) return sendJson(res, 400, { error: 'invalid JSON body' })
      // A tagged client error (e.g. body too large) carries its own status code.
      if (err && err.statusCode) return sendJson(res, err.statusCode, { error: err.message })
      // Don't leak internal error detail to clients; log it server-side instead.
      clog.error(`request error: ${err && err.message}`, { method: req.method, path: req.url, error: err })
      return sendJson(res, 500, { error: 'internal error' })
    }
  })

  async function handleApi(req, res, pathname) {
    // Any API traffic means an operator has the control UI open (it polls /api/status every
    // 1.5s). The board uses this to drop the "how do I connect" QR codes for a wall clock.
    if (ledbox && typeof ledbox.noteViewer === 'function') ledbox.noteViewer()
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
      if (!pinOk(req)) return denyPin(res)
      await readJson(req) // drain
      // Leave the crest/idle screen so the manual scoreboard paints.
      if (ledbox && ledbox._idle && typeof ledbox.showIdle === 'function') await ledbox.showIdle(false)
      sourceManager.setSource(manualSource, { mode: 'manual' })
      return sendJson(res, 200, status())
    }
    // POST /api/action { action }
    if (pathname === '/api/action' && req.method === 'POST') {
      if (!pinOk(req)) return denyPin(res)
      const body = await readJson(req)
      const action = body && body.action
      if (!action || !ACTION_TYPES.has(action.type)) {
        alog.warn('rejected an unknown action', { action, ip: clientIp(req) })
        return sendJson(res, 400, { error: 'unknown or missing action.type' })
      }
      if (sourceManager.status.mode !== 'manual') {
        sourceManager.setSource(manualSource, { mode: 'manual' })
      }
      // Any live action (point, serve, …) means the match is on — drop the idle screen so
      // the state push below actually paints the scoreboard.
      if (ledbox && ledbox._idle && typeof ledbox.showIdle === 'function') ledbox.showIdle(false)
      manualSource.apply(action)
      const newState = manualSource.getState()
      // The scoring trail: every hand-entered action with the score it produced. This is what
      // answers "the away team says the score was wrong at 18-17" after the fact.
      alog.info(actionLine(action, newState), {
        ...action,
        score: `${count(newState.points_a)}-${count(newState.points_b)}`,
        sets: `${count(newState.sets_won_a)}-${count(newState.sets_won_b)}`,
        event: manualSource.lastEvent || null,
        ip: clientIp(req),
      })
      pulseForAction(ledbox, action, settings, newState)
      // Log to the match history — wrapped so a fault here can never break scoring.
      try { history.record(action, newState, manualSource.lastEvent, nowStamp()) } catch (e) { log.error('history', `record failed: ${e && e.message}`, e) }
      // Keep the resume slot in step with the board, so a power cut mid-set loses nothing.
      // A decided match is dropped instead: it is already archived in the history above, and
      // offering to "continue" a match that is over is worse than offering nothing. Same
      // try/catch reasoning as history — persistence must never break scoring.
      try {
        const ev = manualSource.lastEvent
        if (ev === 'match-end' || ev === 'game-end') resume.clear(activeSport())
        else resume.save(activeSport(), newState, nowStamp())
      } catch (e) { console.error('[resume]', e && e.message) }
      return sendJson(res, 200, { ok: true, state: newState, event: manualSource.lastEvent })
    }
    // GET /api/settings — operator preferences (persisted on the Pi)
    if (pathname === '/api/settings' && req.method === 'GET') {
      if (!settings) return sendJson(res, 200, {})
      // Never hand the PIN to a client — expose only whether one is set.
      // perSportKeys tells the UI which fields belong to the active sport (settings.values already
      // carries the active sport's values, since it's a flat merged view).
      return sendJson(res, 200, { ...settings.values, scorerPin: '', pinSet: !!settings.values.scorerPin, perSportKeys: PER_SPORT_KEYS })
    }
    // POST /api/settings — partial update; unknown keys are dropped and numbers clamped
    if (pathname === '/api/settings' && req.method === 'POST') {
      const body = await readJson(req)
      if (!settings) return sendJson(res, 501, { error: 'settings unavailable' })
      if (!pinOk(req)) return denyPin(res)
      const patch = { ...(body || {}) }
      // Empty PIN field = leave the current PIN unchanged (else a normal save wipes the lock).
      if (!patch.scorerPin) delete patch.scorerPin
      const before = { ...settings.values }
      const prevBrightness = settings.values.brightness
      const updated = settings.update(patch)
      // Only what actually CHANGED, so the trail reads as a history of decisions rather than a
      // wall of unchanged preferences. Values are redacted by key name in the log store.
      const changes = {}
      for (const k of Object.keys(updated)) {
        if (JSON.stringify(before[k]) !== JSON.stringify(updated[k])) changes[k] = { from: before[k], to: updated[k] }
      }
      if (Object.keys(changes).length) clog.info(`settings changed: ${Object.keys(changes).join(', ')}`, changes)
      else clog.debug('settings saved with no change', { requested: Object.keys(patch) })
      // Brightness change → rewrite setting.ini + bounce the panel driver. Only when it actually
      // changed, so an unrelated settings save never blinks the panel.
      if ('brightness' in patch && updated.brightness !== prevBrightness) {
        clog.info(`panel brightness ${prevBrightness} → ${updated.brightness}${updated.brightness <= 0 ? ' (panel OFF)' : ''}`, {
          from: prevBrightness, to: updated.brightness, panelOff: updated.brightness <= 0,
        })
        applyBrightness(updated.brightness)
      }
      // The counter-colour thresholds live on the client; push the new totals so the board
      // recolours immediately.
      if (ledbox && typeof ledbox.setLimits === 'function') {
        ledbox.setLimits({
          totalTimeouts: updated.totalTimeouts,
          totalSubs: updated.totalSubs,
          idleFullNames: updated.idleFullNames,
          idleFontMax: updated.idleFontMax,
          clubName: updated.clubName,
        })
      }
      return sendJson(res, 200, { ...updated, scorerPin: '', pinSet: !!updated.scorerPin })
    }
    // GET /api/sport — the active sport + the pickable list (drives the UI's sport selector).
    if (pathname === '/api/sport' && req.method === 'GET') {
      return sendJson(res, 200, { sport: settings ? settings.values.sport : 'volleyball', sports: SPORT_LIST })
    }
    // POST /api/sport { sport } — switch sport. Persists the choice and restarts the appliance so
    // the new scoring rules, match layout and mapper are built cleanly at boot. Sport changes are
    // rare (once per event), so a ~6s restart beats the edge cases of a live hot-swap.
    if (pathname === '/api/sport' && req.method === 'POST') {
      const body = await readJson(req)
      if (!settings) return sendJson(res, 501, { error: 'settings unavailable' })
      if (!pinOk(req)) return denyPin(res)
      const wanted = String((body && body.sport) || '')
      if (!SPORT_LIST.some((s) => s.key === wanted)) {
        clog.warn(`rejected an unknown sport: ${wanted}`, { requested: wanted, known: SPORT_LIST.map((s) => s.key) })
        return sendJson(res, 400, { error: 'unknown sport' })
      }
      const prev = settings.values.sport
      const updated = settings.update({ sport: wanted })
      const changed = updated.sport !== prev
      // A sport change restarts the service, so this is the last line before a gap in the log —
      // worth being explicit about, or the restart reads as a crash.
      if (changed) clog.info(`sport ${prev} → ${updated.sport}; restarting the appliance`, { from: prev, to: updated.sport })
      else clog.debug('sport unchanged', { sport: updated.sport })
      // Leave a one-shot marker for the next boot to announce the new sport on the panel. The
      // idle screens are sport-neutral, so without it the switch is invisible on the board.
      // Best-effort: a failed write must never block the switch itself.
      if (changed && settings.file) {
        try {
          fs.writeFileSync(path.join(path.dirname(settings.file), '.sport-switch'), updated.sport)
        } catch (err) { console.error('[sport] could not mark switch:', err.message) }
      }
      sendJson(res, 200, { ok: true, sport: updated.sport, changed, restarting: changed })
      // Restart after the response flushes. On dev (no systemd unit) execFile just errors into the
      // ignored callback; the choice is persisted either way and applied on the next boot.
      if (changed) setTimeout(() => { execFile('sudo', ['systemctl', 'restart', 'ledbox-bridge'], () => {}) }, 700)
      return
    }
    // POST /api/link { source, matchId }
    if (pathname === '/api/link' && req.method === 'POST') {
      if (!pinOk(req)) return denyPin(res)
      const body = await readJson(req)
      const source = body && body.source
      if (source === 'cloud') return sendJson(res, 501, { error: 'cloud not implemented' })
      if (source !== 'lan') return sendJson(res, 400, { error: 'unknown source' })
      if (body.matchId == null) return sendJson(res, 400, { error: 'matchId required' })
      // Linking a live match leaves the crest/idle screen so the scoreboard paints.
      if (ledbox && ledbox._idle && typeof ledbox.showIdle === 'function') await ledbox.showIdle(false)
      clog.info(`linking to LAN match ${body.matchId}`, { matchId: String(body.matchId), relayUrl, ip: clientIp(req) })
      const lan = new LanSource({ relayUrl, matchId: String(body.matchId), reconnectMs })
      sourceManager.setSource(lan, { mode: 'lan', matchId: String(body.matchId) })
      return sendJson(res, 200, status())
    }
    // POST /api/countdown { seconds, label, content, swapFirst } — start the shared timer.
    // swapFirst (the set interval) applies next-set FIRST — swap ends + reset points — with the
    // board paint suppressed, so we go straight from the final score to the interval screen with
    // the swapped sets. One atomic sequence, no match-layout repaint to race the layout switch.
    if (pathname === '/api/countdown' && req.method === 'POST') {
      if (!pinOk(req)) return denyPin(res)
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
      // `side` names the team that called the timeout; the board shows its short code so
      // the hall can see whose break it is. Resolved here rather than client-side so the
      // name always matches the state the board is painted from.
      let team = ''
      if (body && (body.side === 'left' || body.side === 'right')) {
        const v = toLeftRight(manualSource.getState())
        team = body.side === 'left' ? v.leftName : v.rightName
      }
      startCountdown(seconds, body && body.label, content, team)
      return sendJson(res, 200, { ok: true, state })
    }
    // POST /api/countdown/stop { expired } — clear the display timer. The UI-driven clock
    // reaches zero before the server tick does, so the client tells us WHY it stopped:
    // expired=true fires the end horn, a manual skip does not.
    if (pathname === '/api/countdown/stop' && req.method === 'POST') {
      if (!pinOk(req)) return denyPin(res)
      const body = await readJson(req)
      stopCountdown({ expired: !!(body && body.expired) })
      return sendJson(res, 200, { ok: true })
    }
    // POST /api/idle { on } — show the names+VS pre-match screen (on=false returns to scoring)
    if (pathname === '/api/idle' && req.method === 'POST') {
      if (!pinOk(req)) return denyPin(res)
      const body = await readJson(req)
      const on = body ? body.on !== false : true
      clog.info(on ? 'operator switched to the idle screen' : 'operator returned to scoring', { idle: on, ip: clientIp(req) })
      if (ledbox && typeof ledbox.showIdle === 'function') await ledbox.showIdle(on)
      return sendJson(res, 200, { ok: true, idle: on })
    }
    // POST /api/blank
    if (pathname === '/api/blank' && req.method === 'POST') {
      if (!pinOk(req)) return denyPin(res)
      await readJson(req) // drain
      clog.info('board blanked', { ip: clientIp(req) })
      // Seed the idle source with BLANK so SourceManager caches it and pushes it to the
      // board — /api/status.state then matches the physical (blanked) board.
      sourceManager.setSource(new IdleSource(BLANK), { mode: 'idle', matchId: null })
      await ledbox.pushState(BLANK)
      return sendJson(res, 200, status())
    }
    // POST /api/unlock { pin } — verify a scorer PIN without performing an action.
    if (pathname === '/api/unlock' && req.method === 'POST') {
      const body = await readJson(req)
      const need = settings ? settings.values.scorerPin : ''
      return sendJson(res, 200, { ok: !need || String(body && body.pin) === String(need) })
    }
    // GET /api/game — what the New / Continue / Delete / Clock menu needs for the active sport.
    if (pathname === '/api/game' && req.method === 'GET') {
      return sendJson(res, 200, { sport: activeSport(), saved: resume.summary(activeSport()) })
    }
    // POST /api/game { choice: 'new' | 'continue' | 'delete' | 'clock' }
    if (pathname === '/api/game' && req.method === 'POST') {
      if (!pinOk(req)) return denyPin(res)
      const body = await readJson(req)
      const choice = body && body.choice
      const sport = activeSport()

      // Housekeeping only — the board keeps showing whatever it was showing.
      if (choice === 'delete') {
        resume.clear(sport)
        return sendJson(res, 200, { ok: true, saved: null, ...status() })
      }
      // "Just show the clock": park the panel on the idle screen without touching the score.
      if (choice === 'clock') {
        if (ledbox && typeof ledbox.showIdle === 'function') await ledbox.showIdle(true)
        return sendJson(res, 200, { ok: true, saved: resume.summary(sport), ...status() })
      }
      if (choice === 'new' || choice === 'continue') {
        const saved = choice === 'continue' ? resume.get(sport) : null
        if (choice === 'continue' && !saved) return sendJson(res, 404, { error: 'no saved game for this sport' })
        // Lift idle FIRST: pushState is deliberately suppressed while an idle screen is up, so
        // restoring the state before this would leave the crest on the panel and the scoreboard
        // unpainted until the next point.
        if (ledbox && ledbox._idle && typeof ledbox.showIdle === 'function') await ledbox.showIdle(false)
        sourceManager.setSource(manualSource, { mode: 'manual' })
        manualSource.apply(saved ? { type: 'set-state', state: saved } : { type: 'reset' })
        // Starting fresh discards the old slot; it refills from the first point of the new match.
        if (choice === 'new') resume.clear(sport)
        return sendJson(res, 200, { ok: true, saved: resume.summary(sport), ...status() })
      }
      return sendJson(res, 400, { error: 'choice must be new, continue, delete or clock' })
    }
    // GET /api/history — completed matches (newest first) for the History tab + export
    if (pathname === '/api/history' && req.method === 'GET') {
      return sendJson(res, 200, history.list())
    }
    // POST /api/history/clear — wipe the log
    if (pathname === '/api/history/clear' && req.method === 'POST') {
      if (!pinOk(req)) return denyPin(res)
      await readJson(req) // drain
      clog.warn('match history cleared', { matches: history.list().matches.length, ip: clientIp(req) })
      history.clear()
      return sendJson(res, 200, { ok: true })
    }
    // POST /api/shutdown — halt the board cleanly (protects the SD card). Fires after the
    // response flushes; the bridge runs as pi with passwordless sudo for systemctl.
    if (pathname === '/api/shutdown' && req.method === 'POST') {
      if (!pinOk(req)) return denyPin(res)
      await readJson(req) // drain
      // The last line before the card goes quiet. Flushed immediately so it survives the halt.
      clog.warn('shutdown requested — halting the board', { ip: clientIp(req) })
      log.flush()
      sendJson(res, 200, { ok: true })
      setTimeout(() => { execFile('sudo', ['systemctl', 'poweroff'], () => {}) }, 700)
      return
    }

    // ── /logs ────────────────────────────────────────────────────────────────
    // GET /api/logs?level=&scope=&q=&sinceId=&limit= — filtered slice of the ring buffer,
    // plus the stats the page needs to render its filter chips and counters.
    if (pathname === '/api/logs' && req.method === 'GET') {
      const p = new URL(req.url, 'http://localhost').searchParams
      return sendJson(res, 200, {
        entries: log.query({
          level: p.get('level') || undefined,
          scope: p.get('scope') || undefined,
          q: p.get('q') || undefined,
          sinceId: p.get('sinceId') || undefined,
          limit: p.get('limit') || undefined,
        }),
        stats: log.stats(),
      })
    }
    // GET /api/logs/stream — Server-Sent Events live tail. Chosen over a WebSocket because
    // the appliance has no ws dependency in production and SSE reconnects on its own.
    if (pathname === '/api/logs/stream' && req.method === 'GET') {
      const p = new URL(req.url, 'http://localhost').searchParams
      const level = p.get('level') || undefined
      const scope = p.get('scope') || undefined
      res.writeHead(200, {
        ...CORS,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      // Catch up on what the client missed (a reconnect passes its last id), then stream.
      for (const e of log.query({ level, scope, sinceId: p.get('sinceId') || undefined, limit: 200 })) {
        res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`)
      }
      const matches = (e) => {
        if (level && LEVELS[level] && LEVELS[e.level] < LEVELS[level]) return false
        if (scope && !scope.split(',').map((s) => s.trim()).includes(e.scope)) return false
        return true
      }
      const unsubscribe = log.subscribe((e) => {
        if (!matches(e)) return
        try { res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`) } catch { /* client went away */ }
      })
      // Proxies and phones drop an idle connection; a comment frame every 20s keeps it up.
      const keepAlive = setInterval(() => { try { res.write(': keep-alive\n\n') } catch { /* ignore */ } }, 20000)
      if (keepAlive.unref) keepAlive.unref()
      const done = () => { clearInterval(keepAlive); unsubscribe() }
      req.on('close', done)
      req.on('error', done)
      return
    }
    // POST /api/logs { level, msg, data } — the browser's own errors. Deliberately open (no
    // PIN): a spectator's phone hitting a bug is exactly what this is for. Rate-limited above.
    if (pathname === '/api/logs' && req.method === 'POST') {
      const body = await readJson(req)
      const now = Date.now()
      if (now - uiRate.windowStart > 60000) { uiRate.windowStart = now; uiRate.count = 0 }
      if (++uiRate.count > UI_LOG_PER_MIN) return sendJson(res, 429, { error: 'too many log posts' })
      const level = LEVELS[body && body.level] ? body.level : 'error'
      log.log(level, 'ui', String((body && body.msg) || 'ui event'), {
        ...(body && typeof body.data === 'object' ? body.data : { detail: body && body.data }),
        ua: String(req.headers['user-agent'] || '').slice(0, 120),
        ip: clientIp(req),
      })
      return sendJson(res, 200, { ok: true })
    }
    // POST /api/logs/level { level } — turn the firehose on for a match without a restart.
    if (pathname === '/api/logs/level' && req.method === 'POST') {
      const body = await readJson(req)
      if (!pinOk(req)) return denyPin(res)
      const wanted = String((body && body.level) || '')
      if (!LEVELS[wanted]) return sendJson(res, 400, { error: 'unknown level' })
      const prev = log.level
      log.setLevel(wanted)
      clog.info(`log level ${prev} → ${wanted}`, { from: prev, to: wanted, ip: clientIp(req) })
      return sendJson(res, 200, { ok: true, level: wanted })
    }
    // POST /api/logs/clear — wipe memory + the files on disk.
    if (pathname === '/api/logs/clear' && req.method === 'POST') {
      if (!pinOk(req)) return denyPin(res)
      await readJson(req) // drain
      log.clear()
      clog.warn('logs cleared', { ip: clientIp(req) })
      return sendJson(res, 200, { ok: true, stats: log.stats() })
    }
    // GET /api/logs/export — the whole trail as JSONL, oldest rotation first, for an email
    // or a bug report. Falls back to the memory ring when nothing was persisted.
    if (pathname === '/api/logs/export' && req.method === 'GET') {
      log.flush()
      const files = log.files().reverse() // .2 → .1 → active, so the download reads forward in time
      let out = ''
      for (const f of files) {
        try { out += fs.readFileSync(f.path, 'utf8') } catch { /* skip an unreadable rotation */ }
      }
      if (!out) out = log.query({ limit: log.stats().maxEntries }).map((e) => JSON.stringify(e)).join('\n')
      return send(res, 200, out, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Content-Disposition': `attachment; filename="ledbox-logs-${new Date().toISOString().slice(0, 10)}.jsonl"`,
      })
    }
    return sendJson(res, 404, { error: 'not found' })
  }

  function status() {
    const { mode, matchId } = sourceManager.status
    return {
      mode, matchId,
      sport: settings ? settings.values.sport : 'volleyball',
      pinRequired: !!(settings && settings.values.scorerPin),
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
      screen: sectionsToScreen(ledbox.mapper.toSections(state)),
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
      clog.debug(`relay listed ${matches.length} match(es)`, { count: matches.length, relayHttpUrl })
    } catch (err) {
      // The Link tab shows "no matches" either way; only the log distinguishes "the relay is
      // unreachable" from "the relay has nothing".
      clog.warn(`could not list matches from the relay: ${err.message}`, { relayHttpUrl, error: err.message })
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

// Who sent this — enough to tell the scorer's tablet from a spectator's phone on the venue LAN.
function clientIp(req) {
  const raw = (req.socket && req.socket.remoteAddress) || ''
  return raw.replace(/^::ffff:/, '') // unwrap the IPv4-mapped IPv6 form
}

// Counters arrive either as a number or as an array of entries (timeouts/subs carry detail in
// some sources); both mean "how many".
const count = (v) => (Array.isArray(v) ? v.length : Number(v) || 0)

// One readable sentence per action for the log's message column. The structured payload
// logged alongside carries the raw action, so this only has to be scannable.
function actionLine(action, state) {
  const score = `${count(state.points_a)}-${count(state.points_b)}`
  const side = action.side === 'right' ? 'right' : 'left'
  const d = Number(action.delta)
  const delta = Number.isFinite(d) ? `${d > 0 ? '+' : ''}${d}` : ''
  switch (action.type) {
    case 'point': return `point ${side} ${delta} → ${score}`
    case 'set': return `set ${side} ${delta}`
    case 'timeout': return `timeout ${side} ${delta}`
    case 'sub': return `sub ${side} ${delta}`
    case 'serve': return `serve → ${action.side || action.value || '?'}`
    case 'serve-order': return 'beach serve order set'
    case 'serve-player': return `serving player → ${action.player ?? '?'}`
    case 'swap': return 'sides swapped'
    case 'team': return `team ${side} edited`
    case 'next-set': return `next set → ${count(state.sets_won_a)}-${count(state.sets_won_b)}`
    case 'remove-set': return 'set removed'
    case 'reset': return 'match reset'
    case 'set-state': return `state set directly → ${score}`
    default: return `${action.type} ${side}`.trim()
  }
}

// Local wall-clock stamp "YYYY-MM-DD HH:MM" for history entries. (The board clock may be
// off until it gets NTP on the venue LAN; the timeline stays internally consistent.)
function nowStamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

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
