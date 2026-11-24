/**
 * Pair a phone: what the scoring device does with a text the phone typed
 * (docs/phone-keyboard-spec.md 5.3). The phone sends the field's whole text
 * and `base`, the hash of the text it typed on. When this device's text
 * changed meanwhile (the scorer typed here, an automatic remark line), the
 * two are merged, or THIS device's text wins: a phone never overwrites what
 * it was not shown.
 */

/** FNV-1a (32 bit) over the UTF-16 code units, 8 hex digits (the phone page computes the same). */
export function textHash(text) {
  let h = 0x811c9dc5
  const s = String(text)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * Three-way: `base` (what the phone typed on; null when unknown), `mine`
 * (this field now), `theirs` (the phone's text). The text to put in the
 * field, or null for a conflict (keep `mine`, tell the phone).
 */
export function mergeText(base, mine, theirs) {
  if (mine === theirs) return mine
  if (base == null) return mine === '' || theirs.startsWith(mine) ? theirs : null
  if (mine === base) return theirs
  if (theirs === base) return mine
  // both added at the end (the scorer on the tablet, the phone at the same time)
  if (mine.startsWith(base) && theirs.startsWith(base)) return mine + theirs.slice(base.length)
  return null
}

/** The texts a field had lately, by hash (what a phone may have typed on). */
export function createTextHistory(max = 32) {
  const byField = new Map()
  return {
    note(fieldId, text) {
      let m = byField.get(fieldId)
      if (!m) byField.set(fieldId, (m = new Map()))
      const h = textHash(text)
      m.delete(h)
      m.set(h, String(text))
      while (m.size > max) m.delete(m.keys().next().value)
    },
    get(fieldId, hash) {
      const m = byField.get(fieldId)
      return m && m.has(hash) ? m.get(hash) : null
    },
    clear: () => byField.clear(),
  }
}
