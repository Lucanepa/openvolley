// The device check (owner 22.11.2026: "have the app run a check at the
// beginning that checks the device (android, apple, desktop) performance and
// recommends this or that on/off"). It measures how fast this device runs
// work like the app's, sorts it into a tier and recommends the four look
// switches of utils/lookSettings; the scorer applies them with one tap on Home
// (DeviceCheckCard) or keeps the look as it is. Options › Effects and speed
// shows the result and checks again on demand.
//
// When: once per device, on Home, after Home has painted and the main thread
// is idle (useAutoDeviceCheck in App.jsx), and again whenever CHECK_VERSION
// changes. Never while a match is open (scored, set up, at its end, being
// opened) or under a first-start dialog: it stops at its next step when that
// changes, and nothing is kept. It never blocks the screen: it pauses after
// every step (about 40 steps of a few ms on a computer, at most about 75 ms
// on the hall tablet's stand-in), 0.5 s in all on this computer and 0.9 s on
// the stand-in; past CHECK_BUDGET_MS it starts no further measured run.
// Offline: nothing is sent anywhere. The result stays in localStorage
// (CHECK_KEY); storage blocked, it holds for this page only.
//
// What:
//  (a) work: a synthetic match of 400 events (330 KB of JSON; a real match
//      after set 1 and 80 rallies of set 2 had 387 events, 412 KB) written
//      and read as JSON, cloned as IndexedDB reads clone it, sorted and
//      folded into the score and the line-ups as the scoring screen does,
//      WORK_REPEAT times per step. One run of the four steps is warm-up,
//      then the median of WORK_RUNS.
//  (b) layout: style and layout of a roster-like table (240 cells) in a box
//      off the screen and invisible (visibility: hidden, nothing painted, so
//      nothing flickers), laid out LAYOUT_PASSES times at alternating widths
//      and text sizes; median of LAYOUT_RUNS. It runs against the app's whole
//      stylesheet, as the app's own screens do, with no transition or
//      animation of its own (PROBE_STILL). No paint or frame probe: the
//      GPU cannot be measured without drawing something on the screen, and
//      idle frames only tell the screen's refresh rate.
//  (c) hints: the platform (Android app, iOS app, desktop app, web), cores
//      (navigator.hardwareConcurrency), memory (navigator.deviceMemory,
//      Chromium only), devicePixelRatio, screen size and reduced motion.
//
// The tier is set by score = work + layout (both medians, ms):
// score < TIER_LIMITS.fast: fast; < TIER_LIMITS.ok: ok; else slow. A device
// that reports at most 1 GB of memory or at most 2 cores is one tier slower.
//
// Calibration (22.11.2026): this machine (Ryzen 7 PRO 8700GE, 16 cores),
// Chromium headless shell 153 through Playwright, the app's Home on the Vite
// dev server (offline, its own timers running), runDeviceCheck in the page
// under CDP Emulation.setCPUThrottlingRate; 6x is the stand-in for the hall
// tablet (Galaxy Tab A7 Lite), as in the performance pass. Score in ms over
// three browser sessions of 10-15 checks per rate (medians of the sessions,
// then the whole range), wall time of a check and its longest task:
//   1x   26.4 / 27.7 / 26.9   (23.9 - 29.6)    0.48 s   no task over 50 ms
//   2x   48.5 / 48.2 / 45.2   (43.3 - 57.6)    0.55 s   no task over 50 ms
//   3x   74.4                 (66.8 - 78.1)    0.66 s   no task over 50 ms
//   4x   96.6 / 91.8 / 90.4   (82.8 - 100.7)   0.74 s   no task over 50 ms
//   5x   109.5                (108.0 - 115.3)  0.82 s   61 ms
//   6x   136.5 / 126.3 / 134.5 (122.5 - 153.0) 0.90 s   75 ms
//   8x   186.8                (170.3 - 194.8)  1.12 s   58 ms
// (An earlier session, before each step was split in two, had 4x up to 110
// and 6x from 130.9.) Limits: fast below 66 (1x and 2x: computers, recent
// tablets and phones), ok below 112 (3x and 4x; 5x falls on either side),
// slow from 112 (6x, the stand-in, at least 9 % above the limit in every
// check, and anything slower). The ok tier
// keeps the owner's recommendation (no blur, the rest on, the sharp PDF):
// the calibration gives no reason to change it.
// Version 2 (22.11.2026, the probe without transitions, PROBE_STILL): under
// reduced motion the kit's 0.01 ms transitions had made the layout 4-5 times
// slower (2x: ok at 92-106, 6x: 286-296). Again 6 checks per rate, reduced
// motion off / on:
//   1x   25.7 - 27.7  / 25.7 - 29.0     4x   89.2 - 93.0  / 86.3 - 95.3
//   2x   44.3 - 48.5  / 40.8 - 45.0     5x   109.3 - 121.9 / 108.5 - 113.7
//   3x   65.3 - 67.7  / 65.9 - 72.0     6x   128.5 - 141.7 / 132.3 - 135.3
//   8x   176.7 - 183.4 / 175.7 - 185.3
// The same with reduced motion as without; the limits stay.
import { useEffect, useSyncExternalStore } from 'react'
import { detectAppPlatform } from './openAppWindow'

/**
 * Raise when the work, the limits or the recommendations change: every device
 * checks again. 2: the layout probe without transitions (a device with reduced
 * motion was measured too slow by version 1).
 */
export const CHECK_VERSION = 2
export const CHECK_KEY = 'ov.deviceCheck'

export const TIERS = Object.freeze(['fast', 'ok', 'slow'])
/** Score (work + layout medians, ms) below which a device is fast / ok; see the calibration above. */
export const TIER_LIMITS = Object.freeze({ fast: 66, ok: 112 })

export const WORK_EVENTS = 400
export const WORK_REPEAT = 8
/** Each step of a run in this many parts, a pause between them. */
export const WORK_SPLIT = 2
export const WORK_RUNS = 3
export const LAYOUT_ROWS = 30
export const LAYOUT_COLUMNS = 8
export const LAYOUT_PASSES = 6
export const LAYOUT_RUNS = 3
/** Between two steps: a frame and any tap get their turn. */
export const STEP_PAUSE_MS = 8
/**
 * Past this much time from its start, the check starts no further measured
 * run (one of each is always measured): a device far slower than the hall
 * tablet's stand-in is not kept busy for long, and it is slow either way.
 */
export const CHECK_BUDGET_MS = 1500

/**
 * The switches each tier recommends (owner 22.11.2026): slow: no blur, no
 * animations, the clock without seconds, the lighter PDF; ok: no blur, the
 * rest on; fast: all on. Reduced motion asked for by the device: no
 * animations, whatever the tier.
 */
export const RECOMMENDED = Object.freeze({
  fast: Object.freeze({ blur: true, motion: true, clockSeconds: true, pdfSharp: true }),
  ok: Object.freeze({ blur: false, motion: true, clockSeconds: true, pdfSharp: true }),
  slow: Object.freeze({ blur: false, motion: false, clockSeconds: false, pdfSharp: false })
})

const pad2 = (n) => String(n).padStart(2, '0')

/** The same synthetic match on every device: the same work everywhere. */
export function syntheticMatch(count = WORK_EVENTS) {
  const roster = (team) => Array.from({ length: 14 }, (_, i) => ({
    id: `${team}${pad2(i)}-5b1e-4c7a-9f3d-${String(i).padStart(12, '0')}`,
    number: i + 1,
    firstName: `First${team}${i}`,
    lastName: `Lastname${team}${i}`,
    isLibero: i >= 12,
    isCaptain: i === 0,
    licence: null
  }))
  const home = roster('a')
  const away = roster('b')
  const court = () => ({ home: home.slice(0, 6).map((p) => p.number), away: away.slice(0, 6).map((p) => p.number) })
  const events = []
  let a = 0
  let b = 0
  let setIndex = 1
  const t0 = Date.UTC(2026, 10, 22, 19, 0, 0)
  for (let seq = 1; seq <= count; seq++) {
    const team = (seq * 7) % 5 < 3 ? 'home' : 'away'
    const base = {
      id: seq,
      matchId: 1,
      uid: `e${String(seq).padStart(7, '0')}-1a2b-4c3d-8e9f-0a1b2c3d4e5f`,
      setIndex,
      seq,
      ts: new Date(t0 + seq * 9500).toISOString(),
      deviceId: 'd0000000-1111-4222-8333-444455556666'
    }
    if (seq % 3 === 0) {
      const side = team === 'home' ? home : away
      const lineup = {}
      for (const [p, pos] of ['I', 'II', 'III', 'IV', 'V', 'VI'].entries()) {
        const pl = side[(p + seq) % 12]
        lineup[pos] = { number: pl.number, playerId: pl.id, isLibero: false, replaced: null, captain: pl.isCaptain }
      }
      events.push({ ...base, type: 'lineup', payload: { team, lineup, previous: { ...lineup }, rotation: seq % 6, reason: 'rotation', scoreA: a, scoreB: b } })
    } else if (seq % 3 === 1) {
      events.push({ ...base, type: 'rally_start', payload: { serving: team, scoreA: a, scoreB: b, server: (seq % 12) + 1, court: court(), liberoIn: null, clock: base.ts, note: `Rally ${seq} of set ${setIndex}, ${team} serves` } })
    } else {
      if (team === 'home') a++
      else b++
      events.push({ ...base, type: 'point', payload: { team, scoreA: a, scoreB: b, by: 'tap', note: null, court: court(), serving: team, rallyMs: 9000 + (seq % 7) * 250, clock: base.ts, text: `Point ${team} ${a}:${b} in set ${setIndex}` } })
      if (a >= 25 || b >= 25) {
        setIndex++
        a = 0
        b = 0
      }
    }
  }
  return { id: 1, seed_key: 'synthetic-0000', status: 'live', home: { name: 'Home team', players: home }, away: { name: 'Away team', players: away }, events }
}

const cloneOf = (value) => (typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)))

/**
 * The four steps of one run, each repeated `repeat` times. `state` carries
 * the match and what a step leaves for the next; each returns a number, so
 * no engine can skip the work.
 */
export const WORK_STEPS = Object.freeze([
  // the match row written: Dexie put, a backup, a sync payload
  (state, repeat) => {
    let n = 0
    for (let i = 0; i < repeat; i++) {
      state.text = JSON.stringify(state.match)
      n += state.text.length
    }
    return n
  },
  // ... and read back
  (state, repeat) => {
    let n = 0
    for (let i = 0; i < repeat; i++) {
      state.copy = JSON.parse(state.text)
      n += state.copy.events.length
    }
    return n
  },
  // the events of the match read from IndexedDB (a structured clone each)
  (state, repeat) => {
    let n = 0
    for (let i = 0; i < repeat; i++) n += cloneOf(state.match.events).length
    return n
  },
  // sorted and folded into the score per set and the line-ups on court
  (state, repeat) => {
    let check = 0
    const players = new Map()
    for (const p of state.copy.home.players) players.set(p.id, p)
    for (const p of state.copy.away.players) players.set(p.id, p)
    for (let i = 0; i < repeat; i++) {
      const sorted = state.copy.events.slice()
        .sort((x, y) => (y.ts < x.ts ? -1 : y.ts > x.ts ? 1 : 0))
        .sort((x, y) => x.setIndex - y.setIndex || x.seq - y.seq)
      const sets = new Map()
      const byType = Object.create(null)
      for (const e of sorted) {
        byType[e.type] = (byType[e.type] || 0) + 1
        if (e.type === 'lineup') {
          for (const pos of Object.keys(e.payload.lineup)) check += players.get(e.payload.lineup[pos].playerId)?.number || 0
        } else if (e.type === 'point') {
          const s = sets.get(e.setIndex) || { home: 0, away: 0, lines: [] }
          s[e.payload.team]++
          s.lines.push(`${s.home}:${s.away}`)
          sets.set(e.setIndex, s)
        }
      }
      for (const s of sets.values()) check += s.lines.join(' ').length
      check += Object.keys(byType).length
    }
    return check
  }
])

export const median = (values) => {
  const v = values.filter((x) => Number.isFinite(x)).sort((x, y) => x - y)
  if (!v.length) return null
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

const round1 = (ms) => Math.round(ms * 10) / 10

/** A pause between two steps (a macrotask: input and a frame get their turn). */
export const pauseBetweenSteps = (ms = STEP_PAUSE_MS) => new Promise((resolve) => setTimeout(resolve, ms))

const clock = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())

/**
 * (a) The work: a warm-up run, then `runs` measured ones; the time of a run
 * is the sum of its steps' (the pauses do not count). Each step runs in
 * WORK_SPLIT parts with a pause between them. Past the budget
 * (overBudget()), no further run starts once one is measured.
 * @returns {Promise<{ runsMs: number[], medianMs: number }|null>} null: stopped (keepGoing false)
 */
export async function measureWork({ runs = WORK_RUNS, repeat = WORK_REPEAT, events = WORK_EVENTS, keepGoing = () => true, overBudget = () => false, pause = pauseBetweenSteps, now = clock } = {}) {
  const match = syntheticMatch(events)
  const part = Math.max(1, Math.ceil(repeat / WORK_SPLIT))
  const runsMs = []
  let sink = 0
  for (let r = 0; r <= runs; r++) {
    const state = { match }
    let total = 0
    for (const step of WORK_STEPS) {
      for (let done = 0; done < repeat; done += part) {
        await pause()
        if (!keepGoing()) return null
        const t0 = now()
        sink += step(state, Math.min(part, repeat - done))
        total += now() - t0
      }
    }
    if (r > 0) runsMs.push(round1(total)) // run 0: warm-up
    if (runsMs.length > 0 && overBudget()) break
  }
  if (!Number.isFinite(sink)) return null
  return { runsMs, medianMs: median(runsMs) }
}

/**
 * On the probe's box, rows and cells: no transition, no animation. The kit
 * gives every element a 0.01 ms transition under reduced motion (tokens.css),
 * so each pass started a transition of the new text size on every cell: the
 * layout took 4-5 times as long and a device asking for less motion was
 * called one or two tiers slower (22.11.2026: 6x 290 instead of 140). Inline
 * !important beats every stylesheet's !important, layered or not.
 */
export const PROBE_STILL = 'transition:none!important;animation:none!important;'

/**
 * (b) Style and layout of a roster-like table in an invisible box off the
 * screen (nothing is painted). Without a document (a worker, a test that
 * passes none): null.
 * @returns {Promise<{ runsMs: number[], medianMs: number }|null|false>} false: stopped
 */
export async function measureLayout({ doc = typeof document !== 'undefined' ? document : null, runs = LAYOUT_RUNS, passes = LAYOUT_PASSES, keepGoing = () => true, overBudget = () => false, pause = pauseBetweenSteps, now = clock } = {}) {
  const body = doc?.body
  if (!body || typeof doc.createElement !== 'function') return null
  const box = doc.createElement('div')
  box.setAttribute('aria-hidden', 'true')
  box.setAttribute('data-device-check', '')
  box.style.cssText = `position:fixed;left:-20000px;top:0;width:900px;visibility:hidden;pointer-events:none;contain:layout style;${PROBE_STILL}`
  let html = ''
  for (let r = 0; r < LAYOUT_ROWS; r++) {
    html += `<div style="display:flex;gap:4px;align-items:center;border-bottom:1px solid #e7e5e4;padding:2px 4px;${PROBE_STILL}">`
    for (let c = 0; c < LAYOUT_COLUMNS; c++) {
      html += `<div style="flex:${c === 2 ? 3 : 1} 1 0;min-width:0;padding:2px;font:600 1em/1.3 sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${PROBE_STILL}">${c === 2 ? `Lastname${r} Firstname${r}` : r * LAYOUT_COLUMNS + c}</div>`
    }
    html += '</div>'
  }
  // `passes` layouts at alternating widths and text sizes
  const layOut = (count, from) => {
    let sink = 0
    for (let p = from; p < from + count; p++) {
      box.style.width = `${p % 2 ? 640 : 900}px`
      box.style.fontSize = `${p % 2 ? 12 : 13}px`
      sink += box.offsetHeight + box.firstChild.offsetWidth
    }
    return sink
  }
  const runsMs = []
  try {
    // the table built and laid out once: warm-up, not measured
    await pause()
    if (!keepGoing()) return false
    box.innerHTML = html
    body.appendChild(box)
    layOut(1, 1)
    // each run in two steps (half the passes each), its time their sum
    const half = Math.ceil(passes / 2)
    for (let r = 0; r < runs; r++) {
      let ms = 0
      let sink = 0
      for (const [count, from] of [[half, 0], [passes - half, half]]) {
        await pause()
        if (!keepGoing()) return false
        const t0 = now()
        sink += layOut(count, from)
        ms += now() - t0
      }
      if (Number.isFinite(sink)) runsMs.push(round1(ms))
      if (runsMs.length > 0 && overBudget()) break
    }
  } finally {
    box.remove()
  }
  return { runsMs, medianMs: median(runsMs) }
}

/** 'android-app' | 'ios-app' | 'desktop-app' | 'web' */
export function appPlatformOf(win = typeof window !== 'undefined' ? window : undefined) {
  const platform = detectAppPlatform(win)
  if (platform === 'tauri' || win?.electronAPI) return 'desktop-app'
  if (platform === 'capacitor') return /Android/i.test(win?.navigator?.userAgent || '') ? 'android-app' : 'ios-app'
  return 'web'
}

/** (c) What the device says about itself (numbers and booleans only). */
export function readHints(win = typeof window !== 'undefined' ? window : undefined) {
  const nav = win?.navigator
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null)
  let reducedMotion = false
  try {
    reducedMotion = !!win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
  } catch {
    reducedMotion = false
  }
  return {
    platform: appPlatformOf(win),
    cores: num(nav?.hardwareConcurrency),
    memoryGb: num(nav?.deviceMemory),
    dpr: num(win?.devicePixelRatio) || 1,
    screen: win?.screen && num(win.screen.width) ? `${win.screen.width}x${win.screen.height}` : null,
    reducedMotion
  }
}

const slower = (tier) => TIERS[Math.min(TIERS.indexOf(tier) + 1, TIERS.length - 1)]

/** The tier of a device from its measures (ms) and hints. */
export function classify({ workMs, layoutMs = null, hints = {} } = {}) {
  if (!Number.isFinite(workMs)) return null
  const score = workMs + (Number.isFinite(layoutMs) ? layoutMs : 0)
  let tier = score < TIER_LIMITS.fast ? 'fast' : score < TIER_LIMITS.ok ? 'ok' : 'slow'
  const { memoryGb = null, cores = null } = hints || {}
  if ((memoryGb != null && memoryGb <= 1) || (cores != null && cores <= 2)) tier = slower(tier)
  return tier
}

/** The four switches a tier recommends; reduced motion: no animations whatever the tier. */
export function recommend(tier, { reducedMotion = false } = {}) {
  const base = RECOMMENDED[tier]
  if (!base) return null
  return reducedMotion ? { ...base, motion: false } : { ...base }
}

/**
 * Runs the whole check. keepGoing() is asked before every step: false (a
 * match opened, the page hidden) stops it, and it resolves null.
 * @returns {Promise<object|null>} the result: { v, at, tier, score, workMs,
 *   workRunsMs, layoutMs, layoutRunsMs, hints, recommended, answer: null }
 */
export async function runDeviceCheck({ win = typeof window !== 'undefined' ? window : undefined, keepGoing = () => true, pause = pauseBetweenSteps, now = clock, wallClock = Date.now, budgetMs = CHECK_BUDGET_MS } = {}) {
  mark('ov-device-check:start')
  try {
    return await checkOnce({ win, keepGoing, pause, now, wallClock, budgetMs })
  } finally {
    mark('ov-device-check:end')
  }
}

// A performance mark at the check's start and end, for a trace (diagnostics, the calibration)
const mark = (name) => {
  try { performance.mark?.(name) } catch { /* no performance timeline */ }
}

async function checkOnce({ win, keepGoing, pause, now, wallClock, budgetMs }) {
  const started = now()
  const overBudget = () => now() - started > budgetMs
  const hints = readHints(win)
  const work = await measureWork({ keepGoing, overBudget, pause, now })
  if (!work) return null
  const layout = await measureLayout({ doc: win?.document ?? null, keepGoing, overBudget, pause, now })
  if (layout === false) return null
  const layoutMs = layout?.medianMs ?? null
  const tier = classify({ workMs: work.medianMs, layoutMs, hints })
  if (!tier) return null
  return {
    v: CHECK_VERSION,
    at: wallClock(),
    tier,
    score: round1(work.medianMs + (layoutMs ?? 0)),
    workMs: work.medianMs,
    workRunsMs: work.runsMs,
    layoutMs,
    layoutRunsMs: layout?.runsMs ?? null,
    hints,
    recommended: recommend(tier, { reducedMotion: hints.reducedMotion }),
    answer: null
  }
}

// ---------------------------------------------------------------------------
// The result on this device
// ---------------------------------------------------------------------------

const localStore = () => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

const isResult = (r) => !!r && typeof r === 'object' && Number.isFinite(r.v) && TIERS.includes(r.tier) && Number.isFinite(r.at)

/** The stored result (null: none, unreadable or not a result). */
export function readCheck(storage = localStore()) {
  try {
    const raw = storage?.getItem(CHECK_KEY)
    if (!raw) return null
    const r = JSON.parse(raw)
    return isResult(r) ? r : null
  } catch {
    return null
  }
}

/** Keeps a result; false when storage refused it (it then holds for this page). */
export function saveCheck(result, storage = localStore()) {
  try {
    storage?.setItem(CHECK_KEY, JSON.stringify(result))
    return !!storage
  } catch {
    return false
  }
}

/** Whether the check is due: never run on this device, or run by another CHECK_VERSION. */
export const checkDue = (result) => !isResult(result) || result.v !== CHECK_VERSION

/** The switches the result recommends (its own list, else from its tier and hints). */
export function recommendationOf(result) {
  if (!isResult(result)) return null
  return result.recommended && typeof result.recommended === 'object'
    ? { ...recommend(result.tier, { reducedMotion: !!result.hints?.reducedMotion }), ...result.recommended }
    : recommend(result.tier, { reducedMotion: !!result.hints?.reducedMotion })
}

/** The switches the result would change on this device: [{ name, value }], in the switches' order. */
export function changesFor(result, look) {
  const rec = recommendationOf(result)
  if (!rec || !look) return []
  return ['blur', 'motion', 'clockSeconds', 'pdfSharp']
    .filter((name) => typeof rec[name] === 'boolean' && rec[name] !== look[name])
    .map((name) => ({ name, value: rec[name] }))
}

/**
 * What the Home card offers: the changes of a result of this CHECK_VERSION
 * that was not answered yet (Apply or Keep as is); [] when it is not shown.
 */
export function cardChanges(result, look) {
  if (!isResult(result) || result.v !== CHECK_VERSION || result.answer) return []
  return changesFor(result, look)
}

// The result of this page (useDeviceCheck): read once, then kept in step
let current
let ranHere = false
const listeners = new Set()
function notify() {
  for (const fn of listeners) {
    try { fn() } catch { /* never breaks the check */ }
  }
}

/** The result on this device (null: none yet). */
export function getDeviceCheck() {
  if (current === undefined) current = readCheck()
  return current
}

/** Keeps a new result for this device and tells useDeviceCheck. */
export function setDeviceCheck(result) {
  current = isResult(result) ? result : null
  if (current) saveCheck(current)
  notify()
  return current
}

/** Apply or Keep as is: the result answered ('applied' | 'kept'); the card goes. */
export function answerDeviceCheck(answer, { wallClock = Date.now } = {}) {
  const r = getDeviceCheck()
  if (!r) return null
  return setDeviceCheck({ ...r, answer: answer === 'applied' ? 'applied' : 'kept', answeredAt: wallClock() })
}

/** Tests: forget the page's result. */
export function resetDeviceCheckForTests() {
  current = undefined
  ranHere = false
  running = null
}

function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** The result on this device; renders again when a check ends or is answered. */
export function useDeviceCheck() {
  return useSyncExternalStore(subscribe, getDeviceCheck, () => null)
}

// One check at a time on this page
let running = null

/**
 * Checks this device now and keeps the result (Options › Check this device,
 * and the automatic check). A check already running is the one returned.
 * keepGoing() is asked before every step (false: it stops and keeps
 * nothing); without one, a hidden page stops it. Its start and its end tell
 * useDeviceCheckRunning.
 * @returns {Promise<object|null>} null: stopped
 */
export function checkDeviceNow({ keepGoing, win = typeof window !== 'undefined' ? window : undefined, run = runDeviceCheck, onResult = null } = {}) {
  if (running) return running
  const goOn = typeof keepGoing === 'function' ? keepGoing : () => !win?.document?.hidden
  running = Promise.resolve()
    .then(() => run({ win, keepGoing: goOn }))
    .then((result) => {
      if (!result) return null
      ranHere = true
      const kept = setDeviceCheck(result)
      try { onResult?.(kept) } catch { /* a log never breaks the check */ }
      return kept
    })
    .catch(() => null)
    .finally(() => {
      running = null
      notify()
    })
  notify()
  return running
}

/** Whether a check runs on this page now. */
export const deviceCheckRunning = () => !!running

/**
 * Whether a check runs on this page now; renders again when one starts or
 * ends (Options' Check this device: "Checking..." also while the automatic
 * check runs, and back when it stops).
 */
export function useDeviceCheckRunning() {
  return useSyncExternalStore(subscribe, deviceCheckRunning, () => false)
}

/**
 * Whether Home is quiet enough for the automatic check and its card (App.jsx):
 * Home on show (no match id, its reads done), no first-start dialog ("How do
 * you use...", "Connecting..."), no match being opened, nothing covering
 * Home (the Scoreboard, the Manage console, the size gate, Home's own match
 * set-up dialogs: the Easy match form, today's games, the confirms, restore,
 * a test match being prepared), and no "Your first match" walkthrough
 * running (`tour`: its spotlight and card stay alone on Home; the check and
 * its card come once it ends, owner follow-up 26.11.2026).
 */
export function homeQuietForCheck({ matchId = null, homeVisible = false, firstStartDialog = false, openingMatch = false, covered = false, tour = false } = {}) {
  return matchId == null && !!homeVisible && !firstStartDialog && !openingMatch && !covered && !tour
}

/** Home waits this long after it shows, then for an idle moment, before the automatic check. */
export const AUTO_CHECK_DELAY_MS = 2500
export const AUTO_CHECK_IDLE_TIMEOUT_MS = 3000

/**
 * The automatic check (App.jsx): while `ready` (Home on show, no match open,
 * no first-start dialog), once per device and CHECK_VERSION. It starts
 * AUTO_CHECK_DELAY_MS after `ready`, at an idle moment, and stops at its next
 * step when `ready` goes false, the page is hidden or matchOpen() says a
 * match screen is open (App: deviceSelfCheck readOpenMatch). onResult gets
 * the kept result (App: a line in the local interaction log).
 */
export function useAutoDeviceCheck(ready, { matchOpen = () => false, onResult = null, win = typeof window !== 'undefined' ? window : undefined, run = runDeviceCheck } = {}) {
  useEffect(() => {
    if (!ready || ranHere || !checkDue(getDeviceCheck())) return undefined
    let stopped = false
    let idle = null
    const keepGoing = () => !stopped && !win?.document?.hidden && !matchOpen()
    const start = () => {
      idle = null
      if (keepGoing()) checkDeviceNow({ keepGoing, win, run, onResult })
    }
    const timer = setTimeout(() => {
      if (typeof win?.requestIdleCallback === 'function') idle = win.requestIdleCallback(start, { timeout: AUTO_CHECK_IDLE_TIMEOUT_MS })
      else start()
    }, AUTO_CHECK_DELAY_MS)
    return () => {
      stopped = true
      clearTimeout(timer)
      if (idle != null) win?.cancelIdleCallback?.(idle)
    }
  }, [ready, matchOpen, onResult, win, run])
}
