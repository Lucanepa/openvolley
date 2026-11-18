/**
 * Pair a phone: the text fields of THIS page a paired phone may type into
 * (docs/phone-keyboard-spec.md 5). Plain DOM, no React: any focused text
 * field anywhere in the app, found by focus, written the way a keyboard would
 * (the native value setter, then a bubbling input event, which React's
 * controlled inputs read like a key press).
 *
 * Never typed into from a phone, and never shown on it: password fields,
 * one-time codes and PINs (by type, autocomplete, or a name / id / label /
 * test id word such as pin, password, token, secret), and anything marked
 * data-ov-phone="off". data-ov-phone="official" marks a field of the official
 * sheet (the remarks): the scoring device shows what arrived there.
 */

const TEXT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', ''])
const SENSITIVE_WORDS = new Set(['pin', 'pins', 'password', 'passwort', 'passcode', 'passkey', 'pwd', 'token', 'secret', 'otp', 'totp'])
const TEXT_MAX = 8000

/** Words of an attribute value: camelCase, snake, kebab and spaces split, lower case. */
export function wordsOf(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9äöüéèàç]+/)
    .filter(Boolean)
}

function labelTextFor(el) {
  const doc = el.ownerDocument
  const byAria = el.getAttribute('aria-label')
  if (byAria && byAria.trim()) return byAria.trim()
  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy) {
    const text = labelledBy.split(/\s+/).map((id) => doc.getElementById(id)?.textContent || '').join(' ').trim()
    if (text) return text
  }
  if (el.id) {
    const forLabel = Array.from(doc.querySelectorAll('label')).find((l) => l.htmlFor === el.id)
    if (forLabel?.textContent?.trim()) return forLabel.textContent.trim()
  }
  const wrapping = el.closest('label')
  if (wrapping?.textContent?.trim()) return wrapping.textContent.trim()
  return (el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '').trim()
}

/** A field whose text a phone must never see or write. */
export function isSensitiveField(el) {
  if (!el || el.nodeType !== 1) return false
  if (el.getAttribute('data-ov-phone') === 'off') return true
  const type = String(el.getAttribute('type') || '').toLowerCase()
  if (type === 'password') return true
  const auto = String(el.getAttribute('autocomplete') || '').toLowerCase()
  if (/password|one-time-code|cc-/.test(auto)) return true
  const words = [
    el.getAttribute('name'), el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder'),
    el.getAttribute('data-testid'), labelTextFor(el),
  ].flatMap(wordsOf)
  return words.some((w) => SENSITIVE_WORDS.has(w))
}

/** A text field a phone can type into (sensitive ones excluded). */
export function isTypableField(el) {
  if (!el || el.nodeType !== 1 || !el.isConnected) return false
  const tag = el.tagName
  if (tag === 'TEXTAREA') {
    // fall through to the common checks
  } else if (tag === 'INPUT') {
    const type = String(el.getAttribute('type') || '').toLowerCase()
    if (!TEXT_TYPES.has(type)) return false
  } else {
    return false
  }
  if (el.disabled || el.readOnly) return false
  return !isSensitiveField(el)
}

const ids = new WeakMap()
let nextId = 1

/** A stable id of this element for the protocol ([A-Za-z0-9_.:-], 64 at most). */
export function fieldIdOf(el) {
  let id = ids.get(el)
  if (!id) {
    id = `f${nextId++}`
    ids.set(el, id)
  }
  return id
}

/** The field as the phone sees it: { id, label, kind, text, maxLength }. */
export function describeField(el, fallbackLabel = '') {
  const max = el.maxLength > 0 ? Math.min(el.maxLength, TEXT_MAX) : TEXT_MAX
  const label = labelTextFor(el).replace(/\s+/g, ' ').slice(0, 80) || fallbackLabel
  return {
    id: fieldIdOf(el),
    label,
    kind: el.tagName === 'TEXTAREA' ? 'multiline' : 'line',
    text: String(el.value || '').slice(0, TEXT_MAX),
    maxLength: max,
  }
}

/** Is this a field of the official sheet (the remarks)? */
export const isOfficialField = (el) => !!el && el.getAttribute('data-ov-phone') === 'official'

/**
 * Write `text` into the field as typing would: the native setter (so React's
 * own value tracker sees a change) and a bubbling input event. The field's
 * maxlength is respected. Returns true when the value changed.
 */
export function setFieldValue(el, text) {
  const value = el.maxLength > 0 ? Array.from(String(text)).slice(0, el.maxLength).join('') : String(text)
  if (el.value === value) return false
  const proto = el.tagName === 'TEXTAREA' ? el.ownerDocument.defaultView.HTMLTextAreaElement.prototype : el.ownerDocument.defaultView.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter) setter.call(el, value)
  else el.value = value
  try { el.setSelectionRange(value.length, value.length) } catch { /* not a text control */ }
  el.dispatchEvent(new el.ownerDocument.defaultView.Event('input', { bubbles: true }))
  return true
}

function isShown(el) {
  if (el.closest('[hidden]')) return false
  const cs = el.ownerDocument.defaultView.getComputedStyle(el)
  if (cs.display === 'none' || cs.visibility === 'hidden') return false
  // a page without layout (a test DOM) has no boxes at all
  return el.getClientRects().length > 0 || el.ownerDocument.documentElement.getClientRects().length === 0
}

/**
 * The typable fields around `el` in page order: inside its dialog when it is
 * in one (the topmost layer the scorer works in), else the whole page.
 */
export function fieldsAround(el) {
  const scope = el.closest('[role="dialog"], .ov-modal-panel') || el.ownerDocument.body
  return Array.from(scope.querySelectorAll('input, textarea')).filter((f) => isTypableField(f) && isShown(f))
}

/** Next / previous field (Tab / Shift+Tab). Returns the field that has the focus. */
export function moveFocus(el, dir) {
  const list = fieldsAround(el)
  const i = list.indexOf(el)
  if (i === -1 || list.length < 2) return el
  const next = list[(i + (dir === 'prev' ? list.length - 1 : 1)) % list.length]
  next.focus()
  return next
}

/**
 * Enter on a one-line field: the key event (a handler may act on it), then
 * the form's own submit when nothing took it: what a keyboard's Enter does.
 */
export function pressEnter(el) {
  const win = el.ownerDocument.defaultView
  const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }
  const down = new win.KeyboardEvent('keydown', init)
  const taken = !el.dispatchEvent(down)
  el.dispatchEvent(new win.KeyboardEvent('keyup', init))
  if (!taken && el.tagName === 'INPUT' && el.form && typeof el.form.requestSubmit === 'function') el.form.requestSubmit()
}
