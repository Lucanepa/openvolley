// Where a walkthrough step points (walkthroughSteps.js): the controls of the
// real screens, found the way the help's "Show me" finds them (data-help-id),
// by their test id, or by role and name (the label the app shows, from the
// locale). Nothing here changes a screen: it reads the page, and the steps'
// prepare functions click what a scorer would click.
//
// A target spec is one of:
//   { helpId }                  [data-help-id="..."]
//   { testId }                  [data-testid="..."]
//   { selector }                any CSS selector
//   { role, name, within? }     a button/radio/menuitem whose label is `name`
//                               (string: exact; RegExp; (t) => string|RegExp)
//   { dialog: { title?, has? } } the panel of an open dialog: by its title
//                               (string, RegExp or (t) => ...) or a selector
//                               inside it
//   { any: [spec, ...] }        the first one found
//   { union: [spec, ...] }      every one found (one box around them)
//   { tablet: spec, phone: spec } the layout's own (ctx.phone)
// `within` limits a spec to the inside of another one.

// jsdom (the tests) lays nothing out: every element is 0 x 0 there, so a
// target counts as shown when it is in the page and not hidden by a style
const LAYOUTLESS = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || '')

export const WALKTHROUGH_ROOT_ATTR = 'data-walkthrough-root'

const ROLE_SELECTORS = {
  button: 'button, [role="button"]',
  radio: '[role="radio"], input[type="radio"]',
  menuitem: '[role="menuitem"], [role="menuitemradio"]',
  switch: '[role="switch"]',
  any: 'button, [role="button"], [role="radio"], [role="menuitem"], a[href]'
}

/** The label a control shows: aria-label, else its text (soft hyphens and runs of spaces out). */
export function accessibleName(el) {
  if (!el) return ''
  const raw = el.getAttribute?.('aria-label') || el.textContent || ''
  return raw.replace(/­/g, '').replace(/\s+/g, ' ').trim()
}

function inWalkthrough(el) {
  return !!el?.closest?.(`[${WALKTHROUGH_ROOT_ATTR}]`)
}

/** Shown on screen: in the page, not hidden, not inert, with a size (a browser). */
export function isShown(el) {
  if (!el || !el.isConnected || inWalkthrough(el)) return false
  if (el.closest?.('[inert], [aria-hidden="true"]')) return false
  const win = el.ownerDocument?.defaultView
  const style = win?.getComputedStyle ? win.getComputedStyle(el) : null
  if (style && (style.visibility === 'hidden' || style.display === 'none')) return false
  // a closed side panel (the help panel) is hidden by its own visibility
  for (let p = el.parentElement; p; p = p.parentElement) {
    const s = win?.getComputedStyle ? win.getComputedStyle(p) : null
    if (s && (s.display === 'none' || s.visibility === 'hidden')) return false
  }
  if (LAYOUTLESS) return true
  const r = el.getBoundingClientRect()
  return r.width > 1 && r.height > 1
}

function textMatches(value, want, t) {
  const w = typeof want === 'function' ? want(t) : want
  if (w == null) return false
  if (w instanceof RegExp) return w.test(value)
  return value === String(w).replace(/­/g, '').replace(/\s+/g, ' ').trim()
}

function rootsOf(within, ctx) {
  if (!within) return [document]
  return resolveTarget(within, ctx)
}

function queryAll(roots, selector) {
  const out = []
  for (const r of roots) {
    if (r.matches?.(selector)) out.push(r)
    for (const el of r.querySelectorAll(selector)) out.push(el)
  }
  return out
}

/** The open dialogs on screen (the walkthrough's own card left out). */
export function openDialogs() {
  return [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
    .filter(d => isShown(d) && d.getAttribute('aria-modal') !== 'false')
    // the help panel is a dialog only while it is open
    .filter(d => !(d.dataset?.testid === 'help-panel' && d.getAttribute('aria-modal') !== 'true'))
}

function dialogTitle(d) {
  const h = d.querySelector('h1, h2, h3, [id$="-title"]')
  return accessibleName(h)
}

/**
 * The elements of a spec that are shown now (none: []). A union gives each
 * one found; every other form gives one element at most.
 */
export function resolveTarget(spec, ctx = {}) {
  if (!spec || typeof document === 'undefined') return []
  const t = ctx.t || ((k) => k)
  if (spec.tablet || spec.phone) return resolveTarget(ctx.phone ? (spec.phone ?? spec.tablet) : (spec.tablet ?? spec.phone), ctx)
  if (spec.any) {
    for (const s of spec.any) {
      const found = resolveTarget(s, ctx)
      if (found.length) return found
    }
    return []
  }
  if (spec.union) return spec.union.flatMap(s => resolveTarget(s, ctx))
  const roots = rootsOf(spec.within, ctx)
  if (spec.within && roots.length === 0) return []
  let candidates = []
  if (spec.helpId) candidates = queryAll(roots, `[data-help-id="${spec.helpId}"]`)
  else if (spec.testId) candidates = queryAll(roots, `[data-testid="${spec.testId}"]`)
  else if (spec.selector) candidates = queryAll(roots, spec.selector)
  else if (spec.role) {
    candidates = queryAll(roots, ROLE_SELECTORS[spec.role] || spec.role)
      .filter(el => textMatches(accessibleName(el), spec.name, t))
  } else if (spec.dialog) {
    candidates = openDialogs().filter(d => {
      if (spec.dialog.title && !textMatches(dialogTitle(d), spec.dialog.title, t)) return false
      if (spec.dialog.has && !d.querySelector(spec.dialog.has)) return false
      return true
    })
  }
  const shown = candidates.filter(isShown)
  if (spec.last) return shown.length ? [shown[shown.length - 1]] : []
  return shown.length ? [shown[0]] : []
}

/** One box around the elements, padded (null: nothing to box). */
export function boxOf(elements, pad = 8) {
  const rects = elements.map(el => el.getBoundingClientRect()).filter(r => r.width > 0 || r.height > 0)
  if (!rects.length) return null
  const top = Math.min(...rects.map(r => r.top)) - pad
  const left = Math.min(...rects.map(r => r.left)) - pad
  const bottom = Math.max(...rects.map(r => r.bottom)) + pad
  const right = Math.max(...rects.map(r => r.right)) + pad
  return { top, left, bottom, right, width: right - left, height: bottom - top }
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * Wait until `test()` returns something truthy (polled), or the time is up:
 * then null. Never throws.
 */
export async function waitUntil(test, { timeoutMs = 8000, everyMs = 120 } = {}) {
  const end = Date.now() + timeoutMs
  for (;;) {
    let v = null
    try { v = await test() } catch { v = null }
    if (v) return v
    if (Date.now() > end) return null
    await sleep(everyMs)
  }
}

/** The first element of a spec, once it is shown (null after the wait). */
export async function waitForTarget(spec, ctx, opts) {
  const found = await waitUntil(() => resolveTarget(spec, ctx)[0] || null, opts)
  return found || null
}

/** Clicks the spec's element when it is shown and enabled; true when clicked. */
export async function clickTarget(spec, ctx, { timeoutMs = 6000 } = {}) {
  const el = await waitUntil(() => {
    const e = resolveTarget(spec, ctx)[0]
    return e && !e.disabled && e.getAttribute('aria-disabled') !== 'true' ? e : null
  }, { timeoutMs })
  if (!el) return false
  el.scrollIntoView?.({ block: 'center' })
  el.click()
  return true
}

/**
 * Closes the open dialogs, top first: a kit dialog by Escape, a legacy one
 * by its close button. Leaves the ones it cannot close. `keep(dialog)`
 * spares a dialog.
 */
export async function closeDialogs({ keep = null, tries = 4 } = {}) {
  for (let i = 0; i < tries; i++) {
    const open = openDialogs().filter(d => !(keep && keep(d)))
    if (!open.length) return true
    const top = open[open.length - 1]
    const close = top.querySelector('[data-modal-close]')
    if (close) close.click()
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await sleep(250)
  }
  return openDialogs().filter(d => !(keep && keep(d))).length === 0
}
