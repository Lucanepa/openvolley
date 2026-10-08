/**
 * The page observers of diagnostics mode, installed only while it is on:
 *   page.*    load (navigation type, the reason of an app reload), pagehide,
 *             pageshow, beforeunload, visibility, freeze/resume, online/offline,
 *             uncaught errors and rejections
 *   sw.*      service worker registration, updatefound, statechange, controllerchange
 *   geo.*     window / visual viewport size, devicePixelRatio, zoom, fullscreen;
 *             the key layout boxes (ResizeObserver): geo.box on every size
 *             change, geo.jump when a size comes back within 500 ms (jumps.js)
 *   css.vars  the app's scale variables on <html> (--scale-factor, --vmin-base,
 *             any other inline --var), the root font size, <body>'s classes
 *   dialog.*  open / close / content change of every [role=dialog|alertdialog]
 *             with a title key and a hash of its text (never the text itself)
 *   ui.*      clicks and keys (an element's id / data-testid / data-help-id,
 *             never its text; keys typed into a field are not recorded)
 *   perf.*    long tasks and layout shifts where the engine has them
 *             (WebKitGTK has neither: geo.jump is the measure there)
 * Returns the cleanup.
 */
import { diag, noteAction, sinceAction, sinceState, stashAndFlush, diagSessionId } from './recorder'
import { createJumpDetector } from './jumps'
import { takeReloadReason } from './reload'
import { redactDiagText } from './redact'

// [name, selector]: the boxes whose size changes are recorded. An element
// with data-diag="<name>" is watched too.
export const WATCHED_BOXES = Object.freeze([
  ['root', '#root'],
  ['scoreboard', '.match-record'],
  ['content', '.match-content'],
  ['court', '.court'],
  ['rally', '.rally-controls'],
  ['toolbar', '.match-toolbar'],
  ['dialog', '[role="dialog"], [role="alertdialog"]'],
  ['tagged', '[data-diag]']
])
const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"]'
const ROOT_VARS = ['--scale-factor', '--vmin-base']
const FLASH_MS = 400
// a dialog's text changing without its title (a countdown) is recorded only
// this soon after it opened: where a wrong first content shows
const CONTENT_EARLY_MS = 1500

const r1 = (n) => Math.round(n * 10) / 10

/** FNV-1a of a string, 8 hex digits: tells contents apart without logging them. */
export function textHash(text) {
  let h = 0x811c9dc5
  const s = String(text || '')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** A dialog's title key: aria-label, its labelling element or first heading (redacted, short). */
export function dialogTitle(el) {
  try {
    const doc = el.ownerDocument
    const byId = el.getAttribute('aria-labelledby')
    const label = el.getAttribute('aria-label') ||
      (byId && doc?.getElementById(byId.split(' ')[0])?.textContent) ||
      el.querySelector('h1, h2, h3, h4, [data-dialog-title]')?.textContent ||
      ''
    return redactDiagText(label.replace(/\s+/g, ' ').trim()).slice(0, 60)
  } catch {
    return ''
  }
}

/** The id a click or key is recorded under: never the element's text. */
export function elementId(el) {
  if (!el || el.nodeType !== 1) return null
  const pick = el.closest?.('[data-testid], [data-help-id], button, a, [role="button"], [role="switch"], [role="tab"], [role="menuitem"], input, select, textarea, label, [id]') || el
  const attr = (n) => pick.getAttribute?.(n)
  // a label with a digit (a keypad's "7") could spell a PIN over several clicks
  const label = (v) => (v && !/\d/.test(v) ? redactDiagText(v).slice(0, 40) : null)
  const cls = typeof pick.className === 'string' ? pick.className.trim().split(/\s+/)[0] : ''
  return {
    tag: pick.tagName?.toLowerCase() || null,
    id: attr('data-testid') || attr('data-help-id') || attr('data-diag') || (pick.id ? redactDiagText(pick.id) : null) ||
      label(attr('aria-label')) || label(attr('title')) || (cls ? `.${cls}` : null),
    role: attr('role') || null,
    type: pick.tagName === 'INPUT' ? attr('type') || 'text' : null,
    dialog: !!pick.closest?.(DIALOG_SELECTOR)
  }
}

const isEditable = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))

/** What is known about the engine: WebKitGTK / WebView2 / WKWebView / Chrome ... from the UA. */
export function engineInfo(ua = '') {
  const s = String(ua)
  const pick = (re) => (s.match(re) || [])[1] || null
  return {
    webkit: pick(/AppleWebKit\/([\d.]+)/),
    chrome: pick(/Chrom(?:e|ium)\/([\d.]+)/),
    edge: pick(/Edg\/([\d.]+)/),
    firefox: pick(/Firefox\/([\d.]+)/),
    safari: pick(/Version\/([\d.]+).*Safari/),
    android: pick(/Android ([\d.]+)/),
    linux: /Linux/.test(s) && !/Android/.test(s),
    wv: /\bwv\b/.test(s)
  }
}

export function installWatchers({ win = window, appVersion = null, platform = null, source = null } = {}) {
  const doc = win.document
  const cleanups = []
  const on = (target, type, fn, opts) => {
    if (!target?.addEventListener) return
    target.addEventListener(type, fn, opts)
    cleanups.push(() => target.removeEventListener(type, fn, opts))
  }

  // ---- page lifecycle -------------------------------------------------------
  const nav = (() => {
    try { return win.performance?.getEntriesByType?.('navigation')?.[0] || null } catch { return null }
  })()
  const screenInfo = win.screen ? { w: win.screen.width, h: win.screen.height, aw: win.screen.availWidth, ah: win.screen.availHeight, orient: win.screen.orientation?.type || null } : null
  diag('page.load', {
    nav: nav?.type || null,
    prev: takeReloadReason(),
    url: win.location?.pathname || null,
    version: appVersion,
    platform,
    switch: source,
    engine: engineInfo(win.navigator?.userAgent),
    ua: String(win.navigator?.userAgent || '').slice(0, 200),
    screen: screenInfo,
    win: { w: win.innerWidth, h: win.innerHeight, ow: win.outerWidth, oh: win.outerHeight, dpr: win.devicePixelRatio },
    lang: win.navigator?.language || null,
    visible: doc.visibilityState,
    timeOrigin: Math.round(win.performance?.timeOrigin || 0),
    domMs: nav ? r1(nav.domContentLoadedEventEnd || 0) : null,
    sw: !!win.navigator?.serviceWorker?.controller
  })

  on(win, 'pagehide', (e) => { diag('page.hide', { persisted: !!e?.persisted }); stashAndFlush() })
  on(win, 'pageshow', (e) => { if (e?.persisted) diag('page.show', { persisted: true }) })
  on(win, 'beforeunload', () => { diag('page.beforeunload', {}); stashAndFlush() })
  on(doc, 'visibilitychange', () => {
    diag('page.visibility', { state: doc.visibilityState })
    if (doc.visibilityState === 'hidden') stashAndFlush()
  })
  on(doc, 'freeze', () => { diag('page.freeze', {}); stashAndFlush() })
  on(doc, 'resume', () => diag('page.resume', {}))
  on(win, 'online', () => diag('page.online', { online: true }))
  on(win, 'offline', () => diag('page.online', { online: false }))
  on(win, 'focus', () => diag('page.focus', { focused: true }))
  on(win, 'blur', () => diag('page.focus', { focused: false }))
  on(win, 'error', (e) => {
    // a resource that failed to load (img, script) has no message
    if (!e?.message && e?.target && e.target !== win) {
      diag('page.resource_error', { tag: e.target.tagName?.toLowerCase() || null, src: e.target.src || e.target.href || null })
      return
    }
    diag('page.error', { message: e?.message || String(e?.error || ''), file: e?.filename || null, line: e?.lineno ?? null, col: e?.colno ?? null })
  }, true)
  on(win, 'unhandledrejection', (e) => {
    const r = e?.reason
    diag('page.rejection', { message: r?.message || String(r ?? ''), name: r?.name || null })
  })

  // ---- service worker -------------------------------------------------------
  const swc = win.navigator?.serviceWorker
  if (swc) {
    const state = (w) => (w ? w.state : null)
    const watchWorker = (w, role) => {
      if (!w) return
      on(w, 'statechange', () => diag('sw.state', { role, state: w.state, controller: !!swc.controller }))
    }
    on(swc, 'controllerchange', () => diag('sw.controllerchange', { controller: !!swc.controller, state: state(swc.controller) }))
    swc.getRegistration?.().then((reg) => {
      diag('sw.registration', { has: !!reg, active: state(reg?.active), waiting: state(reg?.waiting), installing: state(reg?.installing), controller: !!swc.controller })
      if (!reg) return
      watchWorker(reg.installing, 'installing')
      watchWorker(reg.waiting, 'waiting')
      on(reg, 'updatefound', () => {
        diag('sw.updatefound', { installing: state(reg.installing) })
        watchWorker(reg.installing, 'installing')
      })
    }).catch(() => {})
  }

  // ---- geometry: window, viewport, zoom, fullscreen ------------------------
  let lastWin = null
  let winFrame = 0
  const readWin = () => {
    const vv = win.visualViewport
    return {
      w: win.innerWidth,
      h: win.innerHeight,
      ow: win.outerWidth,
      oh: win.outerHeight,
      dpr: win.devicePixelRatio,
      vv: vv ? { w: r1(vv.width), h: r1(vv.height), s: r1(vv.scale * 100) / 100, x: r1(vv.offsetLeft), y: r1(vv.offsetTop) } : null
    }
  }
  const checkWin = (why) => {
    winFrame = 0
    const next = readWin()
    const key = JSON.stringify(next)
    if (key === lastWin) return
    lastWin = key
    diag('geo.window', { why, ...next, after: sinceAction() })
  }
  const scheduleWin = (why) => () => {
    if (winFrame) return
    winFrame = (win.requestAnimationFrame || ((f) => setTimeout(f, 16)))(() => checkWin(why))
  }
  lastWin = JSON.stringify(readWin())
  on(win, 'resize', scheduleWin('resize'))
  on(win.visualViewport, 'resize', scheduleWin('vv'))
  on(win.visualViewport, 'scroll', scheduleWin('vv-scroll'))
  on(win, 'orientationchange', () => diag('geo.orientation', { type: win.screen?.orientation?.type || null }))
  const onFullscreen = () => diag('geo.fullscreen', { on: !!(doc.fullscreenElement || doc.webkitFullscreenElement) })
  on(doc, 'fullscreenchange', onFullscreen)
  on(doc, 'webkitfullscreenchange', onFullscreen)
  // devicePixelRatio (zoom, a move to another screen): a media query per value
  let dprQuery = null
  const watchDpr = () => {
    try {
      dprQuery?.removeEventListener?.('change', onDpr)
      dprQuery = win.matchMedia?.(`(resolution: ${win.devicePixelRatio}dppx)`) || null
      dprQuery?.addEventListener?.('change', onDpr)
    } catch { /* old engine */ }
  }
  function onDpr() {
    diag('geo.dpr', { dpr: win.devicePixelRatio, after: sinceAction() })
    watchDpr()
  }
  watchDpr()
  cleanups.push(() => dprQuery?.removeEventListener?.('change', onDpr))

  // ---- the app's scale variables -------------------------------------------
  const html = doc.documentElement
  let lastVars = null
  const readVars = () => {
    const out = {}
    try {
      const st = html.style
      for (let i = 0; i < st.length; i++) {
        const name = st[i]
        if (name.startsWith('--')) out[name] = st.getPropertyValue(name).trim().slice(0, 40)
      }
      for (const v of ROOT_VARS) if (!(v in out)) out[v] = win.getComputedStyle(html).getPropertyValue(v).trim() || null
      out.rootFont = win.getComputedStyle(html).fontSize || null
      out.bodyClass = typeof doc.body?.className === 'string' ? doc.body.className.slice(0, 80) : null
    } catch { /* detached */ }
    return out
  }
  const checkVars = () => {
    const next = readVars()
    const key = JSON.stringify(next)
    if (key === lastVars) return
    const prev = lastVars ? JSON.parse(lastVars) : null
    lastVars = key
    const changed = {}
    for (const [k, v] of Object.entries(next)) if (!prev || prev[k] !== v) changed[k] = v
    diag('css.vars', { changed, after: sinceAction() })
  }
  checkVars()
  if (win.MutationObserver) {
    const mo = new win.MutationObserver(checkVars)
    mo.observe(html, { attributes: true, attributeFilter: ['style', 'class'] })
    if (doc.body) mo.observe(doc.body, { attributes: true, attributeFilter: ['class', 'style'] })
    cleanups.push(() => mo.disconnect())
  }

  // ---- boxes: ResizeObserver + jumps ---------------------------------------
  const jumps = createJumpDetector()
  const names = new WeakMap() // element -> name#n
  const sizes = new WeakMap() // element -> [w, h]
  let boxSeq = 0
  const nameOf = (el) => names.get(el)
  const ro = win.ResizeObserver
    ? new win.ResizeObserver((entries) => {
      const t = win.performance?.now?.() ?? Date.now()
      for (const entry of entries) {
        const el = entry.target
        const name = nameOf(el)
        if (!name) continue
        const box = entry.borderBoxSize?.[0]
        const w = r1(box ? box.inlineSize : entry.contentRect.width)
        const h = r1(box ? box.blockSize : entry.contentRect.height)
        const prev = sizes.get(el)
        sizes.set(el, [w, h])
        if (prev && Math.abs(prev[0] - w) < 0.5 && Math.abs(prev[1] - h) < 0.5) continue
        diag('geo.box', { el: name, w, h, from: prev || null, after: sinceAction(), state: sinceState() })
        const jump = jumps.observe(name, w, h, t)
        if (jump) diag('geo.jump', { el: name, size: jump.size, via: jump.via, ms: jump.ms, after: sinceAction(), state: sinceState() })
      }
    })
    : null
  const watched = new Set()
  const watchBoxes = () => {
    if (!ro) return
    for (const [name, selector] of WATCHED_BOXES) {
      let list
      try { list = doc.querySelectorAll(selector) } catch { continue }
      for (const el of list) {
        if (watched.has(el)) continue
        watched.add(el)
        const base = name === 'tagged' ? el.getAttribute('data-diag') || 'tagged' : name
        names.set(el, `${base}#${++boxSeq}`)
        ro.observe(el)
      }
    }
    for (const el of watched) {
      if (!el.isConnected) {
        ro.unobserve(el)
        watched.delete(el)
        jumps.forget(nameOf(el))
      }
    }
  }
  if (ro) cleanups.push(() => ro.disconnect())

  // ---- dialogs ---------------------------------------------------------------
  const dialogs = new Map() // element -> { id, title, hash, at }
  let dialogSeq = 0
  const now = () => win.performance?.now?.() ?? Date.now()
  const scanDialogs = () => {
    const present = new Set(doc.querySelectorAll(DIALOG_SELECTOR))
    for (const el of present) {
      if (dialogs.has(el)) continue
      const info = { id: ++dialogSeq, title: dialogTitle(el), hash: textHash(el.textContent), at: now() }
      dialogs.set(el, info)
      diag('dialog.open', { id: info.id, title: info.title, hash: info.hash, testid: el.getAttribute('data-testid') || null, open: dialogs.size, after: sinceAction() })
    }
    for (const [el, info] of dialogs) {
      if (present.has(el) && el.isConnected) continue
      dialogs.delete(el)
      const ms = r1(now() - info.at)
      diag('dialog.close', { id: info.id, title: info.title, ms, flash: ms < FLASH_MS, open: dialogs.size, after: sinceAction() })
    }
  }
  const checkDialogContent = () => {
    for (const [el, info] of dialogs) {
      if (!el.isConnected) continue
      const title = dialogTitle(el)
      const hash = textHash(el.textContent)
      if (title === info.title && hash === info.hash) continue
      const ms = r1(now() - info.at)
      if (title !== info.title || ms < CONTENT_EARLY_MS) {
        diag('dialog.content', { id: info.id, from: info.title, to: title, hash, ms, after: sinceAction() })
      }
      info.title = title
      info.hash = hash
    }
  }

  // one DOM observer: new / gone boxes and dialogs, text changes inside dialogs
  let domFrame = 0
  let contentDirty = false
  const onDom = () => {
    domFrame = 0
    watchBoxes()
    scanDialogs()
    if (contentDirty) {
      contentDirty = false
      checkDialogContent()
    }
  }
  if (win.MutationObserver && doc.body) {
    const mo = new win.MutationObserver((records) => {
      if (dialogs.size && !contentDirty) {
        for (const r of records) {
          for (const el of dialogs.keys()) {
            if (el.contains(r.target)) { contentDirty = true; break }
          }
          if (contentDirty) break
        }
      }
      if (!domFrame) domFrame = (win.requestAnimationFrame || ((f) => setTimeout(f, 16)))(onDom)
    })
    mo.observe(doc.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['role', 'aria-label', 'data-diag'] })
    cleanups.push(() => mo.disconnect())
  }
  onDom()

  // ---- user actions -----------------------------------------------------------
  on(doc, 'click', (e) => {
    const t = elementId(e.target)
    noteAction('ui.click', { ...t, pointer: e.pointerType || null })
  }, true)
  on(doc, 'keydown', (e) => {
    // never what is typed into a field
    if (isEditable(e.target)) return
    if (e.repeat) return
    const named = e.key && e.key.length > 1 ? e.key : null
    noteAction('ui.key', { key: named || (e.code || null), mods: [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.metaKey && 'meta', e.shiftKey && 'shift'].filter(Boolean) })
  }, true)

  // ---- engine timing ------------------------------------------------------------
  const PO = win.PerformanceObserver
  const types = PO?.supportedEntryTypes || []
  if (PO && types.includes('longtask')) {
    try {
      const po = new PO((list) => {
        for (const e of list.getEntries()) diag('perf.longtask', { ms: r1(e.duration), start: r1(e.startTime), after: sinceAction() })
      })
      po.observe({ type: 'longtask', buffered: true })
      cleanups.push(() => po.disconnect())
    } catch { /* not supported after all */ }
  }
  if (PO && types.includes('layout-shift')) {
    try {
      const po = new PO((list) => {
        for (const e of list.getEntries()) {
          if (e.value < 0.001) continue
          diag('perf.layoutshift', { value: Math.round(e.value * 10000) / 10000, input: !!e.hadRecentInput, after: sinceAction() })
        }
      })
      po.observe({ type: 'layout-shift', buffered: true })
      cleanups.push(() => po.disconnect())
    } catch { /* not supported after all */ }
  }
  diag('diag.capabilities', {
    resizeObserver: !!ro,
    longtask: types.includes('longtask'),
    layoutShift: types.includes('layout-shift'),
    visualViewport: !!win.visualViewport,
    sid: diagSessionId()
  })

  return () => {
    for (const c of cleanups.splice(0)) {
      try { c() } catch { /* ignore */ }
    }
    if (winFrame) (win.cancelAnimationFrame || clearTimeout)(winFrame)
    if (domFrame) (win.cancelAnimationFrame || clearTimeout)(domFrame)
  }
}
