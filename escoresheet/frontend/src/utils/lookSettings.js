// The look of the app on this device, four switches (owner 22.11.2026; the
// device check, utils/deviceCheck, can recommend them, Options › Effects and
// speed changes them). They change only how the app looks, never what a
// match records, sends or backs up, or when.
//   blur          the backdrop blur behind dialogs, and the frosted line-up
//                 cover on the court. Off: <html class="ov-lite">
//                 (utils/liteGraphics: dialog scrims only dim, the cover is a
//                 near-opaque panel).
//   motion        animations: the flashing Line-up and Missing signature
//                 buttons, the recently substituted player, sliding menus and
//                 bars, transitions. Off: <html data-no-motion> (tailwind.css,
//                 at the end): nothing moves, the state cues keep a still
//                 look; spinners still turn.
//   clockSeconds  the scoring screen's toolbar clock with seconds. Off: HH:MM,
//                 one tick a minute (scoreboard/ToolbarClock).
//   pdfSharp      the PDF made on this device at pixel ratio 2. Off: 1.5
//                 (scoresheet_pdf/utils/pdfCapture capturePixelRatio).
// Kept per device in localStorage, one key each ('true' / 'false'); a switch
// never set keeps today's look: blur and the sharp PDF are off in the Android
// app (the hall tablet; LITE_GRAPHICS_ON_ANDROID, commit 7d97b5c65) and on
// everywhere else, the animations and the seconds are on everywhere.
// Applied at once, without a reload, in this page and in the app's other
// tabs (the storage event). Storage blocked: the choice still applies to this
// page.
import { useSyncExternalStore } from 'react'
import { LITE_GRAPHICS_CLASS, LITE_GRAPHICS_ON_ANDROID, applyLiteGraphics, inAndroidApp, isAndroidApp } from './liteGraphics'

export const LOOK_SWITCHES = Object.freeze(['blur', 'motion', 'clockSeconds', 'pdfSharp'])

export const LOOK_KEYS = Object.freeze({
  blur: 'ov.look.blur',
  motion: 'ov.look.motion',
  clockSeconds: 'ov.look.clockSeconds',
  pdfSharp: 'ov.look.pdfSharp'
})

/** On <html> while the animations are off (styles in tailwind.css). */
export const NO_MOTION_ATTR = 'data-no-motion'

/** The PDF's pixel ratio with pdfSharp on and off. */
export const SHARP_PDF_PIXEL_RATIO = 2
export const LIGHT_PDF_PIXEL_RATIO = 1.5

const localStore = () => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** Today's look: what a switch never set shows. */
export function lookDefaults({ androidApp = isAndroidApp() } = {}) {
  return {
    blur: !(LITE_GRAPHICS_ON_ANDROID && androidApp),
    motion: true,
    clockSeconds: true,
    pdfSharp: !androidApp
  }
}

/** One stored switch: true, false, or null (never set, or storage blocked). */
export function readStoredSwitch(name, storage = localStore()) {
  try {
    const v = storage?.getItem(LOOK_KEYS[name])
    return v === 'true' ? true : v === 'false' ? false : null
  } catch {
    return null
  }
}

/** The four switches as they are on this device. */
export function readLook({ storage = localStore(), androidApp = isAndroidApp() } = {}) {
  const look = lookDefaults({ androidApp })
  for (const name of LOOK_SWITCHES) {
    const v = readStoredSwitch(name, storage)
    if (v !== null) look[name] = v
  }
  return look
}

/** The page's <html>: ov-lite without the blur, data-no-motion without the animations. */
export function applyLook(look, doc = globalThis.document) {
  const root = doc?.documentElement
  if (!root || !look) return
  applyLiteGraphics(!look.blur, doc)
  root.toggleAttribute(NO_MOTION_ATTR, !look.motion)
}

const listeners = new Set()
// The page's look (useLook's snapshot): one object until a switch changes
let snapshot = null
// The switches set on this page: they hold while storage is blocked
let setHere = {}

function notify() {
  for (const fn of listeners) {
    try { fn() } catch { /* a listener never breaks the switch */ }
  }
}

/** The look of this page: the stored switches, else the ones set here, else today's. */
export function getLook() {
  if (!snapshot) {
    const storage = localStore()
    const look = readLook({ storage })
    for (const name of LOOK_SWITCHES) {
      if (name in setHere && readStoredSwitch(name, storage) === null) look[name] = setHere[name]
    }
    snapshot = look
  }
  return snapshot
}

/**
 * Sets the switches named in `changes` (the others stay), applies them to the
 * page at once and tells useLook. Returns the look now.
 */
export function setLook(changes, { doc = globalThis.document } = {}) {
  const storage = localStore()
  for (const name of LOOK_SWITCHES) {
    if (typeof changes?.[name] !== 'boolean') continue
    setHere = { ...setHere, [name]: changes[name] }
    try {
      storage?.setItem(LOOK_KEYS[name], String(changes[name]))
    } catch {
      // private mode / full storage: setHere keeps it for this page
    }
  }
  snapshot = null
  const look = getLook()
  applyLook(look, doc)
  notify()
  return look
}

/** Tests: forget what this page set. */
export function resetLookForTests() {
  setHere = {}
  snapshot = null
}

function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

const SERVER_LOOK = Object.freeze(lookDefaults({ androidApp: false }))

/** The four switches; renders again when one changes, here or in another tab. */
export function useLook() {
  return useSyncExternalStore(subscribe, getLook, () => SERVER_LOOK)
}

let started = false
/**
 * At start (main.jsx): the stored look on <html>, and a change made in
 * another tab of the app applied here too.
 */
export function initLook({ win = typeof window !== 'undefined' ? window : undefined } = {}) {
  snapshot = null
  applyLook(getLook(), win?.document)
  if (started || !win?.addEventListener) return
  started = true
  win.addEventListener('storage', (e) => {
    if (e.key !== null && !Object.values(LOOK_KEYS).includes(e.key)) return
    snapshot = null
    applyLook(getLook(), win.document)
    notify()
  })
}

/**
 * pdfSharp for the page that makes the PDF: the scoresheet, in a popup or a
 * desktop app window of the app, or in the Android app's in-app view (a
 * same-origin iframe): the same localStorage as the app, read when the PDF is
 * made; never set, today's default (1.5 only in the Android app). A window
 * whose storage cannot be read (the server render, the pixel check: a fresh
 * browser) takes the default.
 */
export function pdfSharpFor(win = typeof window !== 'undefined' ? window : undefined) {
  let storage = null
  try {
    storage = win?.localStorage ?? null
  } catch {
    storage = null
  }
  const stored = readStoredSwitch('pdfSharp', storage)
  return stored ?? !inAndroidApp(win)
}

export { LITE_GRAPHICS_CLASS }
