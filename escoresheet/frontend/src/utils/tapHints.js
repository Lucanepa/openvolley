// The tap hint (the pointing finger on every button of the scoring screen,
// styles.css .tap-hint): on by default; Options › Show tap hints turns it off
// for a scorer who finds the screen too cramped (owner 22.11.2026). Kept per
// device; <html data-no-tap-hints> hides every finger, the time-out box's too.

const KEY = 'showTapHints'
const ATTR = 'data-no-tap-hints'

export function readShowTapHints(storage = globalThis.localStorage) {
  try {
    return storage?.getItem(KEY) !== 'false'
  } catch {
    return true
  }
}

export function applyTapHints(on, doc = globalThis.document) {
  doc?.documentElement?.toggleAttribute(ATTR, !on)
}

export function setShowTapHints(on, { storage = globalThis.localStorage, doc = globalThis.document } = {}) {
  try {
    storage?.setItem(KEY, String(!!on))
  } catch {
    // private mode / full storage: the choice still applies to this page
  }
  applyTapHints(!!on, doc)
}

applyTapHints(readShowTapHints())
