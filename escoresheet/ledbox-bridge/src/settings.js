// Operator settings for the appliance — persisted to disk so a venue's preferences survive a
// restart (and a power cut mid-tournament).
//
// PER-SPORT vs GLOBAL. Each sport (volleyball/beach/basketball) carries its OWN timing, allowances
// and format — beach runs 1' breaks and best-of-3, indoor runs 30s and best-of-5 — while
// brightness, club name, PIN, the active sport, branding and live-scoring are shared (GLOBAL).
//
//   on disk:   { <global keys…>, perSport: { volleyball:{…}, beach:{…}, basketball:{…} } }
//   in memory: `settings.values` is a FLAT view = the global keys merged with the ACTIVE sport's
//              per-sport keys. Consumers keep reading `settings.values.timeoutSeconds` etc.
//              unchanged; the active sport is fixed at boot (changing it restarts the appliance).
//              `forSport(key)` returns the same flat view for any sport.
//
// The old FLAT settings.json (all keys top-level, pre-multisport) migrates on load into
// perSport.volleyball with every value preserved — a migrated board behaves byte-for-byte as before.

import fs from 'node:fs'
import path from 'node:path'

const SPORTS = ['volleyball', 'beach', 'basketball']
const BRANDINGS = ['kscw', 'plain']
const LIVE_SYSTEMS = ['off', 'kscw']

// Shared across every sport.
export const GLOBAL_DEFAULTS = {
  // Panel LED brightness (rpi-rgb-led-matrix --led-brightness, clamped 0-100). 0 = panel OFF.
  brightness: 40,
  // Idle (crest) screen: full club name vs short code, and the largest font it may use.
  idleFullNames: true,
  idleFontMax: 24,
  // Shown on the set-interval and warm-up countdowns. Short — it lands in a narrow label box.
  clubName: 'KSC WIEDIKON',
  // Scorer PIN. Set = the board rejects scoring/control without it. Empty = open. Digits, max 8.
  scorerPin: '',
  // Active sport — selects the Source, layout and mapper at boot (src/sports.js). A change restarts.
  sport: 'volleyball',
  // Idle-screen crest identity: 'kscw' (KSC Wiedikon) | 'plain' (no logo).
  branding: 'kscw',
  // Live-scoring publish target: 'off' | 'kscw' (Directus → wiedisync /live; see livePush).
  liveScoring: 'off',
}

// Per-sport. Volleyball = the historical flat values (so a migrated board is identical). Beach =
// FIVB with the club's 1' breaks + technical timeout. Basketball = FIBA-ish (fouls reuse `totalSubs`).
export const PER_SPORT_DEFAULTS = {
  volleyball: {
    blinkPoint: true, blinkSub: true, blinkMs: 2000,
    timeoutSeconds: 30, ttoSeconds: 0, setIntervalSeconds: 180, warmupSeconds: 600,
    countdownOnTimeout: true, countdownOnSetInterval: true, hornOnCountdownEnd: true,
    totalTimeouts: 2, totalSubs: 6, bestOf: 5,
  },
  beach: {
    blinkPoint: true, blinkSub: false, blinkMs: 2000,
    timeoutSeconds: 60, ttoSeconds: 60, setIntervalSeconds: 60, warmupSeconds: 600,
    countdownOnTimeout: true, countdownOnSetInterval: true, hornOnCountdownEnd: true,
    totalTimeouts: 1, totalSubs: 0, bestOf: 3,
  },
  basketball: {
    blinkPoint: true, blinkSub: true, blinkMs: 2000,
    timeoutSeconds: 60, ttoSeconds: 0, setIntervalSeconds: 120, warmupSeconds: 600,
    countdownOnTimeout: true, countdownOnSetInterval: true, hornOnCountdownEnd: true,
    totalTimeouts: 5, totalSubs: 5, bestOf: 3,
  },
}

export const GLOBAL_KEYS = Object.keys(GLOBAL_DEFAULTS)
export const PER_SPORT_KEYS = Object.keys(PER_SPORT_DEFAULTS.volleyball)
// Back-compat flat default view (global + volleyball) for anything that still imports DEFAULTS.
export const DEFAULTS = { ...GLOBAL_DEFAULTS, ...PER_SPORT_DEFAULTS.volleyball }

const BOOLS = ['blinkPoint', 'blinkSub', 'countdownOnTimeout', 'countdownOnSetInterval', 'hornOnCountdownEnd', 'idleFullNames']
const NUMS = {
  idleFontMax: [10, 30], brightness: [0, 100], blinkMs: [200, 10000],
  timeoutSeconds: [5, 600], ttoSeconds: [0, 600], setIntervalSeconds: [10, 1800], warmupSeconds: [10, 3600],
  totalTimeouts: [1, 9], totalSubs: [0, 15],
}

// Coerce + clamp the given `keys` from `patch` INTO `out` (mutates + returns it). A bad value is
// dropped (out keeps its prior value), so a typo can never wedge the board.
function sanitizeInto(out, keys, patch = {}) {
  for (const k of keys) {
    if (!(k in patch)) continue
    if (BOOLS.includes(k)) { out[k] = !!patch[k]; continue }
    if (k in NUMS) {
      const n = Number(patch[k])
      if (Number.isFinite(n)) { const [lo, hi] = NUMS[k]; out[k] = Math.min(hi, Math.max(lo, Math.round(n))) }
      continue
    }
    if (k === 'bestOf') { out[k] = Number(patch[k]) === 3 ? 3 : 5; continue }
    if (k === 'clubName') { out[k] = String(patch[k] || '').replace(/[^\x20-\x7E]/g, '').slice(0, 20); continue }
    if (k === 'scorerPin') { out[k] = String(patch[k] || '').replace(/\D/g, '').slice(0, 8); continue }
    if (k === 'sport') { out[k] = SPORTS.includes(String(patch[k])) ? String(patch[k]) : out[k]; continue }
    if (k === 'branding') { out[k] = BRANDINGS.includes(String(patch[k])) ? String(patch[k]) : out[k]; continue }
    if (k === 'liveScoring') { out[k] = LIVE_SYSTEMS.includes(String(patch[k])) ? String(patch[k]) : out[k]; continue }
  }
  return out
}

// Back-compat flat sanitizer (both global + per-sport keys against one flat base).
export function sanitize(patch = {}, base = DEFAULTS) {
  return sanitizeInto({ ...base }, [...GLOBAL_KEYS, ...PER_SPORT_KEYS], patch)
}

// Build the clean on-disk structure from ANYTHING on disk — the new shape, the OLD FLAT shape, or
// junk. Old flat = a volleyball-only board, so its per-sport keys migrate into perSport.volleyball.
function normalize(input) {
  const raw = (input && typeof input === 'object') ? input : {}
  const hasPerSport = raw.perSport && typeof raw.perSport === 'object'
  const out = sanitizeInto({ ...GLOBAL_DEFAULTS }, GLOBAL_KEYS, raw)
  out.perSport = {}
  for (const sp of SPORTS) {
    const src = hasPerSport ? (raw.perSport[sp] || {}) : (sp === 'volleyball' ? raw : {})
    out.perSport[sp] = sanitizeInto({ ...PER_SPORT_DEFAULTS[sp] }, PER_SPORT_KEYS, src)
  }
  return out
}

// The flat view a consumer reads: global keys + the given sport's per-sport keys.
function flatten(raw, sport) {
  const sp = SPORTS.includes(sport) ? sport : 'volleyball'
  const out = {}
  for (const k of GLOBAL_KEYS) out[k] = raw[k]
  return Object.assign(out, raw.perSport[sp])
}

export class Settings {
  constructor(file) {
    this.file = file
    this.raw = normalize(null)
    this.values = flatten(this.raw, this.raw.sport)
    this.load()
  }

  load() {
    let migrated = false
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      migrated = !(parsed && parsed.perSport) // an old flat file gets rewritten in the new shape once
      this.raw = normalize(parsed)
    } catch {
      this.raw = normalize(null) // missing or corrupt: defaults, never a crash at boot (and no write)
    }
    this.values = flatten(this.raw, this.raw.sport)
    if (migrated) this.save() // persist the migrated shape a single time
    return this.values
  }

  // Route a flat patch: global keys → top level, per-sport keys → the ACTIVE sport. Returns the
  // fresh flat view.
  update(patch = {}) {
    sanitizeInto(this.raw, GLOBAL_KEYS, patch)
    const active = SPORTS.includes(this.raw.sport) ? this.raw.sport : 'volleyball'
    sanitizeInto(this.raw.perSport[active], PER_SPORT_KEYS, patch)
    this.save()
    this.values = flatten(this.raw, this.raw.sport)
    return this.values
  }

  // Flat view for any sport (global + that sport's per-sport) without changing the active sport.
  forSport(sport) {
    return flatten(this.raw, sport)
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      // Write-then-rename: a power cut mid-write leaves the old file intact rather than a
      // truncated one that would silently reset every preference.
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.raw, null, 2))
      fs.renameSync(tmp, this.file)
    } catch (err) {
      console.error('[settings] could not save:', err.message)
    }
  }
}

// Sets needed to win, and whether this is the short deciding set (15 instead of 25).
export function formatRules(bestOf, setsA, setsB) {
  const toWin = bestOf === 3 ? 2 : 3
  const deciding = setsA === toWin - 1 && setsB === toWin - 1
  return { toWin, deciding, target: deciding ? 15 : 25 }
}
