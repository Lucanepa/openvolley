/**
 * Pure helpers of the phone scoring view (PhoneScoreboard.jsx): when the
 * phone layout is on, where each rotation position sits on its stylised
 * court, and which events make the "last actions" list. Display only: no
 * scoring rule lives here.
 */
import { timeLabel } from '../../ui/format'

/** Viewports narrower than this, held upright, get the phone layout (CSS px). */
export const PHONE_MAX_WIDTH = 600

// The phone view's heights (PhoneScoreboard.jsx, .phone-court and
// .phone-square in styles.css). The point buttons are squares and the court
// is 2:1 where the screen is tall enough; on a short one (a browser's bars,
// the Android app's system bars) the point buttons get lower down to
// PHONE_SQUARE_MIN_PX, then the court gets lower down to PHONE_COURT_MIN_PX,
// and only then the view scrolls.

/**
 * The last actions at their lowest: three 15px lines, two 3px gaps, 6px
 * padding top and bottom. They take the height left over (the screen is
 * filled), showing as many whole lines as fit, up to PHONE_RECENT_MAX_LINES.
 */
export const PHONE_RECENT_HEIGHT_PX = 63
/**
 * Lower still (two lines) only where the rest is taller than the height
 * budget counts: Android's larger text (font scale 1.3 on a 360px phone made
 * the counters' labels take two lines and the view scrolled).
 */
export const PHONE_RECENT_MIN_PX = 45
/** One line of the last actions with the gap before it (15 + 3). */
export const PHONE_RECENT_LINE_PX = 18
/** The most last actions the phone shows. */
export const PHONE_RECENT_MAX_LINES = 8
/**
 * How many whole lines of last actions a box of `height` px shows (6px
 * padding top and bottom), at least 1, at most PHONE_RECENT_MAX_LINES.
 */
export function recentLinesFor(height) {
  const h = Number(height) || 0
  const lines = Math.floor((h - 12 + 3) / PHONE_RECENT_LINE_PX)
  return Math.max(1, Math.min(PHONE_RECENT_MAX_LINES, lines))
}
/**
 * The time-out and substitution counters: this high (no longer growing into
 * the height left over, which made them about 280px tall on a 412x915
 * phone, 2026-10-20); taller only when Android's larger text needs it.
 */
export const PHONE_COUNTER_HEIGHT_PX = 56
/**
 * Everything but the court and the point buttons, top to bottom: header 52,
 * score cards 89, court padding 10, last actions at their lowest 63 + 12,
 * team actions 56 + 8, 8 more the court takes beyond its height (its 2px
 * border and rounding; measured at 360x640), point-button padding 8, action
 * grid 108.
 */
export const PHONE_SQUARE_RESERVE_PX = 52 + 89 + 10 + PHONE_RECENT_HEIGHT_PX + 12 + PHONE_COUNTER_HEIGHT_PX + 8 + 8 + 8 + 108
/** Below this height the point buttons stop getting lower. */
export const PHONE_SQUARE_MIN_PX = 56
/** Below this height the court stops getting lower (three rows of shirt numbers still fit). */
export const PHONE_COURT_MIN_PX = 132

/**
 * The display mode the screen size asks for (the "auto" choice of the
 * display-mode option):
 * - 'phone': a portrait viewport narrower than PHONE_MAX_WIDTH;
 * - 'tablet': up to 900px wide with touch (as before);
 * - 'desktop': everything else (a laptop stays desktop even when narrow).
 * @param {{ width: number, height: number, hasTouch?: boolean }} size
 * @returns {'phone'|'tablet'|'desktop'}
 */
export function detectDisplayMode({ width, height, hasTouch = false }) {
  if (height > width && width < PHONE_MAX_WIDTH) return 'phone'
  if (width <= 900 && hasTouch) return 'tablet'
  return 'desktop'
}

/**
 * True when the scoring screen shows the phone layout: the Phone display
 * mode, or the automatic mode on a portrait viewport under PHONE_MAX_WIDTH.
 * @param {string|null} displayMode 'auto' | 'desktop' | 'tablet' | 'phone' (null: 'auto')
 * @param {{ width: number, height: number }} size the viewport (CSS px)
 */
export function phoneLayoutActive(displayMode, size) {
  const mode = displayMode || 'auto'
  if (mode === 'phone') return true
  return mode === 'auto' && detectDisplayMode(size) === 'phone'
}

/**
 * True for a phone-sized screen (its short side under PHONE_MAX_WIDTH),
 * whichever way it is held: such a device is not locked to landscape on the
 * scoring screen in the automatic mode, so it can be turned upright for the
 * phone layout.
 * @param {{ width?: number, height?: number }} [screenSize] window.screen
 */
export function isPhoneScreen(screenSize = (typeof window !== 'undefined' ? window.screen : null)) {
  const w = Number(screenSize?.width) || 0
  const h = Number(screenSize?.height) || 0
  if (!w || !h) return false
  return Math.min(w, h) < PHONE_MAX_WIDTH
}

/**
 * True while the scoring screen keeps its phone layout: whenever it shows it
 * (phoneLayoutActive), and on a phone in the automatic mode turned sideways.
 * Turning the phone must not take the scoring screen down (it would lose a
 * running time-out countdown or an open dialog): it stays, under a notice to
 * hold the phone upright.
 * @param {string|null} displayMode 'auto' | 'desktop' | 'tablet' | 'phone' (null: 'auto')
 * @param {{ width: number, height: number }} size the viewport (CSS px)
 * @param {{ width?: number, height?: number }} [screenSize] window.screen
 */
export function phoneLayoutKept(displayMode, size, screenSize) {
  if (phoneLayoutActive(displayMode, size)) return true
  return (displayMode || 'auto') === 'auto' && isPhoneScreen(screenSize)
}

/**
 * True when the phone layout is kept but the phone is held sideways: the
 * scoring screen shows a notice to turn it upright over the phone layout.
 * @param {string|null} displayMode
 * @param {{ width: number, height: number }} size the viewport (CSS px)
 * @param {{ width?: number, height?: number }} [screenSize] window.screen
 */
export function phoneHeldSideways(displayMode, size, screenSize) {
  return !phoneLayoutActive(displayMode, size) && phoneLayoutKept(displayMode, size, screenSize)
}

/**
 * Screens smaller than this (CSS px, short side x long side) get the scoring
 * screen's court-anchored dialogs and menus centred: phones either way
 * round, and small tablets (an 8" tablet held sideways is 962x601). A 10"
 * tablet (1280x800) and a laptop, even in a short browser window
 * (1366x650), keep them next to the tapped player.
 */
export const CENTRED_DIALOGS_BELOW = { short: 700, long: 1100 }

/**
 * True when the scoring screen centres its court-anchored dialogs and menus
 * (player, substitution, libero and sanction menus, the libero dialogs):
 * always in the phone layout, and on any screen smaller than
 * CENTRED_DIALOGS_BELOW.
 * @param {{ phoneView?: boolean, width: number, height: number }} opts
 */
export function dialogsCentred({ phoneView = false, width, height }) {
  if (phoneView) return true
  const w = Number(width) || 0
  const h = Number(height) || 0
  if (!w || !h) return false
  return Math.min(w, h) < CENTRED_DIALOGS_BELOW.short && Math.max(w, h) < CENTRED_DIALOGS_BELOW.long
}

/**
 * The rotation positions of one half of the court in reading order of its
 * 2 x 3 grid (row by row, top to bottom). The left team faces right: its
 * back row is the outer (left) column, position IV top front, II bottom
 * front, I (the server) bottom back. The right team faces left: II top front,
 * I top back (outer column), IV bottom front.
 */
export const COURT_CELLS = {
  left: ['V', 'IV', 'VI', 'III', 'I', 'II'],
  right: ['II', 'I', 'III', 'VI', 'IV', 'V']
}

/** Rotation positions in their numeric order (the substitution picker). */
export const POSITIONS = ['I', 'II', 'III', 'IV', 'V', 'VI']

const isSubEvent = (event) => {
  const seq = event.seq || 0
  return seq !== Math.floor(seq)
}

const eventTime = (event) => (typeof event.ts === 'number' ? event.ts : new Date(event.ts).getTime())

/** An event's Zürich time as HH:MM (the log's lines), null without a usable ts. */
export function clockTime(event) {
  if (event?.ts === undefined || event?.ts === null || event?.ts === '') return null
  return timeLabel(eventTime(event)) || null
}

/**
 * The newest `count` actions of the current set, newest first, as the
 * scoring screen's "Last action" line picks them: main events only (no N.1
 * sub-events), no rally start or replay, line-ups only when initial or from a
 * substitution, and only events `describe` can word.
 * @param {Array<object>} events every event of the match
 * @param {number} setIndex the current set
 * @param {(event: object) => string|null} describe the screen's getActionDescription
 * @param {number} [count]
 * @returns {Array<{ id: any, seq: number, text: string, time: string|null }>} time: HH:MM
 */
export function recentActions(events, setIndex, describe, count = 3) {
  if (!Array.isArray(events) || !setIndex) return []
  const sorted = events
    .filter(e => e.setIndex === setIndex)
    .sort((a, b) => {
      const aSeq = a.seq || 0
      const bSeq = b.seq || 0
      if (aSeq !== 0 || bSeq !== 0) return bSeq - aSeq
      return eventTime(b) - eventTime(a)
    })
  const out = []
  for (const e of sorted) {
    if (out.length >= count) break
    if (isSubEvent(e)) continue
    if (e.type === 'rally_start' || e.type === 'replay') continue
    if (e.type === 'lineup' && e.payload?.isInitial !== true && e.payload?.fromSubstitution !== true) continue
    const text = describe(e)
    if (!text || text === 'Unknown action') continue
    out.push({ id: e.id ?? `${e.type}-${e.seq}`, seq: e.seq, text, time: clockTime(e) })
  }
  return out
}

/** Abbreviation of a bench official's role, as the sanction menu writes it. */
export function officialRoleShort(role) {
  switch (role) {
    case 'Coach': return 'C'
    case 'Assistant Coach 1': return 'AC1'
    case 'Assistant Coach 2': return 'AC2'
    case 'Physiotherapist': return 'P'
    case 'Medic': return 'M'
    default: return role || '?'
  }
}

/**
 * A light tint of a colour on white ('#rrggbb' in, '#rrggbb' out), for the
 * serving team's score card. Anything unreadable gives null.
 * @param {string} hex
 * @param {number} amount 0..1, share of the colour
 */
export function tintOf(hex, amount = 0.1) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  const mix = (c) => Math.round(255 + (c - 255) * amount)
  const r = mix((n >> 16) & 255)
  const g = mix((n >> 8) & 255)
  const b = mix(n & 255)
  return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`
}
