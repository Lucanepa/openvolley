// Operator settings for the appliance — persisted to disk so a venue's preferences survive
// a restart (and a power cut mid-tournament). Deliberately a tiny flat object: the control
// UI edits it wholesale, and everything unknown is dropped rather than merged, so a typo in
// the file can never grow into a shadow config.

import fs from 'node:fs'
import path from 'node:path'

export const DEFAULTS = {
  // Board feedback. The board blinks the thing that changed so the table can see an entry
  // landed without looking at the phone.
  blinkPoint: true,
  blinkSub: true,
  blinkMs: 2000,

  // Countdown lengths, in seconds. FIVB: 30s timeout, 3min interval between sets.
  timeoutSeconds: 30,
  setIntervalSeconds: 180,
  warmupSeconds: 600,

  // Which breaks put a countdown on the board at all.
  countdownOnTimeout: true,
  countdownOnSetInterval: true,

  // Sound the board's horn when a countdown reaches zero (time's up). Not on a manual skip.
  hornOnCountdownEnd: true,

  // Idle (crest) screen: show the full club name rather than the short code, and the
  // largest font it may use. The name is auto-shrunk to fit the panel, so this is a
  // ceiling for short names, not a fixed size.
  idleFullNames: true,
  idleFontMax: 24,

  // Panel LED brightness (rpi-rgb-led-matrix --led-brightness, clamped 0-100). 0 = panel OFF
  // (driver stopped, near-zero LED power) — a PANEL_OFF flag stops the watchdog relighting it;
  // any value >0 turns it back on at that level. Applied live by rewriting setting.ini's
  // [DISPLAY] brightness and relaunching the panel driver. 40 is the shipped default.
  brightness: 40,

  // Per-set allowances, and the counter-colour thresholds derived from them:
  //   timeouts → dark red once the total is reached (no amber; there are only 2).
  //   subs     → amber one short of the total, dark red at the total.
  totalTimeouts: 2,
  totalSubs: 6,

  // Match format: best of 3 or 5. Decides how many sets win the match and which set is
  // the short deciding one.
  bestOf: 5,

  // Active sport: 'volleyball' | 'beach' | 'basketball'. Picks the scoring rules (Source), the
  // match layout and the state→board mapper at boot (see src/sports.js). Changing it restarts the
  // appliance so the new sport is built cleanly. Volleyball is the default.
  sport: 'volleyball',

  // Idle-screen branding — which club identity shows on the crest/idle screen. 'kscw' = the KSC
  // Wiedikon crest (default); 'plain' = no club logo, neutral. Registry-extensible.
  branding: 'kscw',

  // Live-scoring publish target. 'off' (default) = don't publish; 'kscw' = push match state to the
  // KSCW Directus→wiedisync /live page (see livePush). Registry-extensible.
  liveScoring: 'off',

  // Shown on the set-interval and warm-up countdowns (a timeout shows the requesting team
  // instead). Kept short because it lands in the layout's narrow label box.
  clubName: 'KSC WIEDIKON',

  // Scorer PIN. When set (a short digit string) the board rejects scoring/control actions
  // unless the phone unlocked with it — a spectator who scanned the QR can watch, not touch.
  // Empty = open (no lock). Never returned to clients in the clear.
  scorerPin: '',
}

const SPORTS = ['volleyball', 'beach', 'basketball'] // keys of the src/sports.js registry
const BRANDINGS = ['kscw', 'plain']                  // idle-screen crest identities
const LIVE_SYSTEMS = ['off', 'kscw']                 // live-scoring publish targets
const BOOLS = ['blinkPoint', 'blinkSub', 'countdownOnTimeout', 'countdownOnSetInterval', 'hornOnCountdownEnd', 'idleFullNames']
const NUMS = {
  idleFontMax: [10, 30],
  brightness: [0, 100],
  blinkMs: [200, 10000],
  timeoutSeconds: [5, 600],
  setIntervalSeconds: [10, 1800],
  warmupSeconds: [10, 3600],
  totalTimeouts: [1, 9],
  totalSubs: [1, 15],
}

// Coerce and clamp anything the UI sends. A bad value must not be able to wedge the board
// (a 0ms blink would hammer the panel; a 3-hour timeout would strand the operator).
export function sanitize(patch = {}, base = DEFAULTS) {
  const out = { ...base }
  for (const k of BOOLS) if (k in patch) out[k] = !!patch[k]
  for (const [k, [lo, hi]] of Object.entries(NUMS)) {
    if (!(k in patch)) continue
    const n = Number(patch[k])
    if (Number.isFinite(n)) out[k] = Math.min(hi, Math.max(lo, Math.round(n)))
  }
  if ('bestOf' in patch) out.bestOf = Number(patch.bestOf) === 3 ? 3 : 5
  // Unknown sport keys keep the current value, so a typo can never leave the board sport-less.
  if ('sport' in patch) out.sport = SPORTS.includes(String(patch.sport)) ? String(patch.sport) : out.sport
  if ('branding' in patch) out.branding = BRANDINGS.includes(String(patch.branding)) ? String(patch.branding) : out.branding
  if ('liveScoring' in patch) out.liveScoring = LIVE_SYSTEMS.includes(String(patch.liveScoring)) ? String(patch.liveScoring) : out.liveScoring
  // Keep the club label short and printable; the layout box clips long strings.
  if ('clubName' in patch) out.clubName = String(patch.clubName || '').replace(/[^\x20-\x7E]/g, '').slice(0, 20)
  // Digits only, max 8 — a short unlock code, not a password.
  if ('scorerPin' in patch) out.scorerPin = String(patch.scorerPin || '').replace(/\D/g, '').slice(0, 8)
  return out
}

export class Settings {
  constructor(file) {
    this.file = file
    this.values = { ...DEFAULTS }
    this.load()
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      this.values = sanitize(raw)
    } catch {
      this.values = { ...DEFAULTS } // missing or corrupt: defaults, never a crash at boot
    }
    return this.values
  }

  update(patch) {
    this.values = sanitize(patch, this.values)
    this.save()
    return this.values
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      // Write-then-rename: a power cut mid-write leaves the old file intact rather than
      // a truncated one that would silently reset every preference.
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.values, null, 2))
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
