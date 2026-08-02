// ─────────────────────────────────────────────────────────────────────────────
// PROPOSAL — NOT WIRED IN. Nothing imports this file.
//
// A board-side hook that PUBLISHES manualSource.getState() to a Directus
// `live_scores` item on every scoring change, so club members (and anyone) can
// follow the match live in the wiedisync app. This replaces the earlier
// Cloudflare Durable-Object relay design (which needed a PAID Workers plan) with
// the club's EXISTING free Directus. Full design:
//   wiedisync/.planning/live-scoring-DESIGN.md
//   wiedisync/src/modules/live/DIRECTUS-SETUP.md   (collection + token + perms)
//
// It is deliberately standalone and side-effect-free so it can sit in the repo
// without touching the scoring path. When ready, wire it in from bridge.js with:
//
//     import { livePushFromEnv } from './livePush.proposal.js'
//     const livePush = livePushFromEnv()      // no-op unless DIRECTUS_URL + token set
//     livePush.attach(manualSource)           // mirror every state change
//
// (Or add a single `livePush.push(newState, manualSource.lastEvent)` line after
// `manualSource.apply(action)` in controlServer.js's /api/action handler.)
// Do NOT import it into controlServer.js — keep it isolated.
//
// ── Config — env vars ────────────────────────────────────────────────────────
//     DIRECTUS_URL         https base of the club's Directus
//                          (e.g. https://directus.kscw.ch — dev: https://directus-dev.kscw.ch)
//     LIVE_PUBLISH_TOKEN   Directus STATIC TOKEN of a dedicated "LedBox publisher"
//                          user whose role has create+update on `live_scores` ONLY.
//                          Sent as `Authorization: Bearer <token>`.
//     LIVE_CHANNEL         channel id = the row's primary key (default 'kscw' —
//                          one board, one row it keeps overwriting)
//     LIVE_COLLECTION      Directus collection (default 'live_scores')
//
// These are DISTINCT from the LAN relay vars (RELAY_URL / RELAY_HTTP_URL, which
// point at the OpenVolley eScoresheet server the board SUBSCRIBES to). This cloud
// PUSH is a different direction + endpoint and can never clobber the LAN config.
//
// Everything here is best-effort: a Directus outage, a slow network or a bad
// token must NEVER affect the physical scoreboard, so every failure is swallowed
// (logged only when debug is on), exactly like historyStore is isolated today.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULTS = { channel: 'kscw', collection: 'live_scores', timeoutMs: 2000, debounceMs: 150, debug: false }

const num = (v) => (Array.isArray(v) ? v.length : Number(v) || 0)

// A neutral board (no names, no points, no completed sets) reads as 'idle' so the
// app shows its empty state instead of a blank 0:0 scoreboard.
function isBlank(s) {
  return (
    !s.team_a_name && !s.team_b_name &&
    !num(s.points_a) && !num(s.points_b) &&
    !num(s.sets_won_a) && !num(s.sets_won_b) &&
    (!Array.isArray(s.set_results) || s.set_results.length === 0)
  )
}

// Map manualSource.getState() (+ the transient lastEvent) to a flat live_scores
// row. `status`: 'final' the moment a match is won, 'idle' on a blank board,
// otherwise 'live'. `ts` (ms epoch) doubles as the app's ordering/seq key.
function toRow(state, event) {
  const status = event === 'match-end' ? 'final' : isBlank(state) ? 'idle' : 'live'
  return {
    status,
    event: event ?? null,
    ts: Date.now(),
    side_a: 'left',
    team_a_name: state.team_a_name ?? '',
    team_a_short: state.team_a_short ?? '',
    team_a_color: state.team_a_color ?? '',
    team_b_name: state.team_b_name ?? '',
    team_b_short: state.team_b_short ?? '',
    team_b_color: state.team_b_color ?? '',
    points_a: num(state.points_a),
    points_b: num(state.points_b),
    sets_won_a: num(state.sets_won_a),
    sets_won_b: num(state.sets_won_b),
    timeouts_a: num(state.timeouts_a),
    timeouts_b: num(state.timeouts_b),
    subs_a: num(state.subs_a),
    subs_b: num(state.subs_b),
    serving_team: state.serving_team ?? null,
    set_results: Array.isArray(state.set_results) ? state.set_results : [],
  }
}

export function createLivePush(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts }
  const base = String(cfg.url || '').replace(/\/$/, '')
  const enabled = !!(base && cfg.token)

  let pending = null // latest { state, event } waiting to be flushed
  let timer = null
  let attached = null // { source, handler } when attach() is active

  function log(...a) { if (cfg.debug) console.log('[livePush]', ...a) }

  // Coalesce a burst of rapid changes (typed corrections, next-set) into one
  // write carrying the LATEST state — the board only ever cares about "now".
  function push(state, event = null) {
    if (!enabled || !state) return
    pending = { state, event }
    if (timer) return
    timer = setTimeout(flush, cfg.debounceMs)
    if (timer.unref) timer.unref() // don't keep the process alive for a ping
  }

  async function flush() {
    timer = null
    const payload = pending
    pending = null
    if (!payload) return

    const row = toRow(payload.state, payload.event)
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.token}`,
    }
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), cfg.timeoutMs)
    try {
      // The row's primary key IS the channel, so PATCH the known item. If it was
      // never seeded (setup step skipped), Directus 404s → create it (POST) so
      // the board self-heals. update+create is exactly the publisher role's grant.
      const itemUrl = `${base}/items/${encodeURIComponent(cfg.collection)}/${encodeURIComponent(cfg.channel)}`
      let res = await fetch(itemUrl, { method: 'PATCH', headers, body: JSON.stringify(row), signal: ctrl.signal })
      if (res.status === 404) {
        res = await fetch(`${base}/items/${encodeURIComponent(cfg.collection)}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ channel: cfg.channel, ...row }),
          signal: ctrl.signal,
        })
      }
      if (!res.ok) log('directus responded', res.status)
      else log('published', row.status, 'event', row.event, 'ts', row.ts)
    } catch (err) {
      log('publish failed:', err && err.message) // swallow — scoring must not care
    } finally {
      clearTimeout(t)
    }
  }

  // Subscribe to a ManualSource: it emits 'state' AFTER apply() has set
  // `lastEvent`, so reading source.lastEvent inside the handler is correct.
  function attach(source) {
    if (!enabled || !source || attached) return
    const handler = (state) => push(state, source.lastEvent)
    source.on('state', handler)
    attached = { source, handler }
    // Seed Directus with the current board immediately.
    if (typeof source.getState === 'function') push(source.getState(), source.lastEvent)
    log('attached to ManualSource')
  }

  function detach() {
    if (attached) { attached.source.off('state', attached.handler); attached = null }
    if (timer) { clearTimeout(timer); timer = null }
    pending = null
  }

  return { enabled, push, attach, detach }
}

// Convenience: build from the environment. Returns a disabled stub (all no-ops)
// when DIRECTUS_URL / LIVE_PUBLISH_TOKEN are unset, so wiring it in is always safe.
export function livePushFromEnv(env = process.env) {
  return createLivePush({
    url: env.DIRECTUS_URL,
    token: env.LIVE_PUBLISH_TOKEN,
    channel: env.LIVE_CHANNEL || DEFAULTS.channel,
    collection: env.LIVE_COLLECTION || DEFAULTS.collection,
    debug: /^(1|true|yes|on)$/i.test(String(env.DEBUG || '')),
  })
}
