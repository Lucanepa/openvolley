/**
 * Pure helpers of the phone scoring view (PhoneScoreboard.jsx): when the
 * phone layout is on, where each rotation position sits on its stylised
 * court, and which events make the "last actions" list. Display only: no
 * scoring rule lives here.
 */

/** Viewports narrower than this, held upright, get the phone layout (CSS px). */
export const PHONE_MAX_WIDTH = 600

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

/**
 * The newest `count` actions of the current set, newest first, as the
 * scoring screen's "Last action" line picks them: main events only (no N.1
 * sub-events), no rally start or replay, line-ups only when initial or from a
 * substitution, and only events `describe` can word.
 * @param {Array<object>} events every event of the match
 * @param {number} setIndex the current set
 * @param {(event: object) => string|null} describe the screen's getActionDescription
 * @param {number} [count]
 * @returns {Array<{ id: any, seq: number, text: string }>}
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
    out.push({ id: e.id ?? `${e.type}-${e.seq}`, seq: e.seq, text })
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
