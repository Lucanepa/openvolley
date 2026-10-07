/**
 * Opens one of the app's own pages (the scoresheet, its print / PDF modes) or
 * an external link, the right way for where the app runs. Every window.open of
 * the app goes through here.
 *
 * - web (a browser, incl. the LAN tablets): a popup, as before. `ok` is false
 *   only when the browser really blocked it (the caller then asks to allow
 *   popups). External links open with noopener.
 * - tauri (the desktop app): window.open as well. The app's new-window
 *   handler (src-tauri/src/popups.rs) opens the app's pages as app windows
 *   that share the match database and window.opener, and hands web / mail
 *   links to the system browser (window.open then returns null: not an error).
 * - capacitor (the Android app): a WebView has no second window, and leaving
 *   the page would unmount the scorer's screen. The page opens in a
 *   full-screen in-app view (an iframe on the same origin, so the same
 *   IndexedDB) with a Back bar; closing it returns to the screen underneath,
 *   untouched. The Android Back button closes it too. External links go to the
 *   system browser (Capacitor hands non-app URLs to Android).
 *
 * The page inside the in-app view talks to it through appWindowGuest.js
 * (close, PDF blob for the opener, save a PDF to Documents). An
 * openAppWindow() made inside the in-app view is handed to the app under it
 * (MSG_OPEN), which shows the page in the same view. Capacitor injects its
 * bridge into the iframe too (checked on the emulator), so on its own the
 * page would open a second in-app view nested inside the first.
 *
 * Capacitor's local server (html5mode) answers a folder path such as
 * /scoresheet/ with the ROOT index.html: the in-app view asks for
 * /scoresheet/index.html (capacitorPageUrl).
 */

import i18n from 'i18next'

export const APP_VIEW_ATTR = 'data-ov-app-window'
export const MSG_CLOSE = 'ov-app-window:close'
export const MSG_SAVE_PDF = 'ov-app-window:save-pdf'
export const MSG_OPEN = 'ov-app-window:open'
export const PDF_SUBDIR = 'OpenVolley/scoresheets'
/** Set on a page's window while it makes / saves a PDF (appWindowGuest.js
 *  setPdfBusy); the desktop app's quit question reads it (pdfBusyInAppWindows). */
export const PDF_BUSY_FLAG = '__ovPdfBusy'

const t = (key, fallback, opts) => {
  try {
    const s = i18n.t(key, { defaultValue: fallback, ...opts })
    return typeof s === 'string' && s ? s : fallback
  } catch {
    return fallback
  }
}

/** 'tauri' | 'capacitor' | 'web' */
export function detectAppPlatform(win = typeof window !== 'undefined' ? window : undefined) {
  if (!win) return 'web'
  try {
    if (win.__TAURI_INTERNALS__ || win.__TAURI__) return 'tauri'
    if (win.Capacitor?.isNativePlatform?.()) return 'capacitor'
  } catch {
    // a half-initialised bridge is treated as a browser
  }
  return 'web'
}

/** True inside the Android app's in-app view (an iframe of the app). */
export function isInAppView(win = typeof window !== 'undefined' ? window : undefined) {
  try {
    return !!win && win.parent !== win && !!win.frameElement?.hasAttribute?.(APP_VIEW_ATTR)
  } catch {
    return false // a cross-origin parent: not ours
  }
}

/** { href, sameOrigin, scheme } for a URL relative to the current page. */
export function resolveAppUrl(url, win = window) {
  try {
    const u = new URL(url, win.location.href)
    return { href: u.href, sameOrigin: u.origin === win.location.origin, scheme: u.protocol }
  } catch {
    return { href: String(url), sameOrigin: false, scheme: '' }
  }
}

/**
 * @param {string} url  e.g. `/scoresheet/?matchId=7`
 * @param {{ features?: string, title?: string, win?: Window, platform?: string }} [opts]
 * @returns {{ ok: boolean, mode: 'popup'|'window'|'in-app'|'external'|'blocked', platform: string, window: Window|null, close?: () => void }}
 */
export function openAppWindow(url, { features = 'width=1200,height=900', title, win = window, platform } = {}) {
  if (!platform && isInAppView(win)) {
    return { ...delegateToApp(url, { title, win }), platform: 'capacitor' }
  }
  platform = platform || detectAppPlatform(win)
  return { ...openOn(platform, url, { features, title, win }), platform }
}

// Inside the in-app view: the app under it opens the page (it replaces the
// page shown in the view) or the external link. The URL is resolved here,
// against this page (e.g. "?date=...&action=save" of the scoresheet list).
function delegateToApp(url, { title, win }) {
  const { href, sameOrigin, scheme } = resolveAppUrl(url, win)
  if (!sameOrigin && !/^(https?|mailto):$/.test(scheme)) {
    return { ok: false, mode: 'blocked', window: null }
  }
  win.parent.postMessage({ type: MSG_OPEN, href, title }, win.location.origin)
  return { ok: true, mode: sameOrigin ? 'in-app' : 'external', window: null }
}

/**
 * The message key for a failed openAppWindow: "allow popups" (the caller's
 * own key) only where a popup blocker exists, i.e. in a browser.
 */
export function openFailedMessageKey(result, popupsKey) {
  return result?.platform === 'web' ? popupsKey : 'appWindow.couldNotOpen'
}

function openOn(platform, url, { features, title, win }) {
  const { href, sameOrigin, scheme } = resolveAppUrl(url, win)
  const external = !sameOrigin

  if (external && !/^(https?|mailto):$/.test(scheme)) {
    return { ok: false, mode: 'blocked', window: null }
  }

  if (platform === 'capacitor') {
    if (external) {
      // Capacitor's WebView hands a navigation to another host (or mailto:)
      // to Android's browser / mail app and stays on this page.
      win.location.assign(href)
      return { ok: true, mode: 'external', window: null }
    }
    const view = showInAppView(capacitorPageUrl(href), { title, win })
    return { ok: true, mode: 'in-app', window: view.frame.contentWindow, close: view.close }
  }

  if (platform === 'tauri') {
    const w = win.open(href, '_blank', features)
    if (external) return { ok: true, mode: 'external', window: null }
    if (w) trackAppWindow(w)
    return { ok: !!w, mode: w ? 'window' : 'blocked', window: w || null }
  }

  // browser
  if (external) {
    const w = win.open(href, '_blank', 'noopener,noreferrer')
    return { ok: true, mode: 'external', window: w || null }
  }
  const w = win.open(href, '_blank', features)
  return { ok: !!w, mode: w ? 'popup' : 'blocked', window: w || null }
}

// ---------------------------------------------------------------------------
// The desktop app's windows opened from this page (the scoresheets): the quit
// question says when one of them is still saving a PDF.

const appWindows = new Set()

function trackAppWindow(w) {
  for (const old of appWindows) {
    try { if (old.closed) appWindows.delete(old) } catch { appWindows.delete(old) }
  }
  appWindows.add(w)
}

/** The app windows this page opened that are still open. */
export function openedAppWindows() {
  const open = []
  for (const w of appWindows) {
    try {
      if (w.closed) appWindows.delete(w)
      else open.push(w)
    } catch {
      appWindows.delete(w)
    }
  }
  return open
}

/** Whether one of `windows` is making or saving a PDF right now. */
export function pdfBusyInAppWindows(windows = openedAppWindows()) {
  return windows.some((w) => {
    try {
      return !w.closed && w[PDF_BUSY_FLAG] === true
    } catch {
      return false // not readable (another origin): unknown, not busy
    }
  })
}

/** Tests: forget the tracked windows. */
export function resetAppWindowsForTests() {
  appWindows.clear()
}

/**
 * The URL of an app page as Capacitor's local server must be asked for it.
 * In html5mode it answers every path whose last segment has no "." with the
 * ROOT index.html (WebViewLocalServer.handleLocalRequest), so /scoresheet/
 * loaded a second scorer app inside the in-app view (seen on the emulator).
 * A folder path gets its index.html: /scoresheet/?matchId=7 ->
 * /scoresheet/index.html?matchId=7.
 */
export function capacitorPageUrl(href) {
  try {
    const u = new URL(href)
    const last = u.pathname.split('/').pop()
    if (u.pathname !== '/' && !last.includes('.')) {
      u.pathname = u.pathname.endsWith('/') ? `${u.pathname}index.html` : `${u.pathname}/index.html`
    }
    return u.href
  } catch {
    return href
  }
}

// ---------------------------------------------------------------------------
// In-app view (Android app)

let current = null // { root, frame, close }

/** The in-app view on screen, if any (tests). */
export const currentInAppView = () => current

function el(doc, tag, style, attrs = {}) {
  const node = doc.createElement(tag)
  Object.assign(node.style, style)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  return node
}

/**
 * A full-screen view of a page of the app over the current screen. One at a
 * time: opening another replaces the page shown.
 */
export function showInAppView(href, { title, win = window } = {}) {
  if (current) {
    current.frame.src = href
    if (title) current.setTitle(title)
    return current
  }
  const doc = win.document

  // volleyui: white bar, stone hairline, dark text, red accent
  const root = el(doc, 'div', {
    position: 'fixed', inset: '0', zIndex: '2147483000', background: '#ffffff',
    display: 'flex', flexDirection: 'column'
  }, { role: 'dialog', 'aria-modal': 'true', 'data-testid': 'app-window' })
  const bar = el(doc, 'div', {
    flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '12px', minHeight: '52px',
    padding: '0 12px', borderBottom: '1px solid #e7e5e4', background: '#ffffff',
    fontFamily: "'Inter', system-ui, sans-serif", color: '#1c1917'
  })
  const back = el(doc, 'button', {
    display: 'inline-flex', alignItems: 'center', gap: '6px', height: '40px', padding: '0 14px',
    border: '1px solid #d6d3d1', borderRadius: '10px', background: '#ffffff', color: '#1c1917',
    fontSize: '15px', fontWeight: '600', cursor: 'pointer'
  }, { type: 'button', 'data-testid': 'app-window-back' })
  back.textContent = `← ${t('common.back', 'Back')}`
  const heading = el(doc, 'div', { fontSize: '15px', fontWeight: '600', flex: '1 1 auto', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })
  // where the PDF went: the whole path, wrapping (never cut off), and Open / Share
  const status = el(doc, 'div', { fontSize: '13px', color: '#57534e', flex: '0 1 auto', minWidth: '0', overflowWrap: 'anywhere', whiteSpace: 'normal', lineHeight: '1.3', padding: '4px 0' }, { role: 'status', 'aria-live': 'polite', 'data-testid': 'app-window-status' })
  const actions = el(doc, 'div', { display: 'none', flex: '0 0 auto', gap: '8px', alignItems: 'center' }, { 'data-testid': 'app-window-actions' })
  const frame = el(doc, 'iframe', { flex: '1 1 auto', width: '100%', border: '0', background: '#ffffff' }, { [APP_VIEW_ATTR]: '', title: title || 'OpenVolley' })
  frame.src = href
  bar.append(back, heading, status, actions)
  root.append(bar, frame)

  const setTitle = (text) => { heading.textContent = text || '' }
  setTitle(title)
  frame.addEventListener('load', () => {
    try {
      if (!title && frame.contentDocument?.title) setTitle(frame.contentDocument.title)
    } catch { /* not same-origin: keep the title */ }
  })

  const onMessage = (event) => {
    if (event.source !== frame.contentWindow || event.origin !== win.location.origin) return
    const type = event.data?.type
    if (type === MSG_CLOSE) close()
    else if (type === MSG_SAVE_PDF) savePdf(event.data, status, actions, win)
    else if (type === MSG_OPEN && typeof event.data.href === 'string') {
      // openOn checks the URL again (same origin, or http(s) / mailto only)
      openAppWindow(event.data.href, { title: typeof event.data.title === 'string' ? event.data.title : undefined, win })
    }
  }
  // Android Back: MainActivity goes back in the WebView history; the entry
  // pushed here makes that a popstate on this page, which closes the view.
  const onPopState = () => close({ fromHistory: true })
  const onKey = (e) => { if (e.key === 'Escape') close() }

  let closed = false
  function close({ fromHistory = false } = {}) {
    if (closed) return
    closed = true
    win.removeEventListener('message', onMessage)
    win.removeEventListener('popstate', onPopState)
    win.removeEventListener('keydown', onKey)
    root.remove()
    current = null
    if (!fromHistory) {
      // drop the entry pushed on open, so Back does not need two presses later
      try { if (win.history.state?.ovAppWindow) win.history.back() } catch { /* ignore */ }
    }
  }

  back.addEventListener('click', () => close())
  win.addEventListener('message', onMessage)
  win.addEventListener('keydown', onKey)
  try {
    win.history.pushState({ ovAppWindow: true }, '', win.location.href)
    win.addEventListener('popstate', onPopState)
  } catch { /* no history API: the Back button of the bar still works */ }

  doc.body.appendChild(root)
  current = { root, frame, close, setTitle, status }
  return current
}

// ---------------------------------------------------------------------------
// "Save PDF" inside the in-app view (Android): the WebView cannot download a
// blob, so the page sends the PDF here and it is written with
// @capacitor/filesystem to Documents/OpenVolley/scoresheets (Files app, USB),
// like the match backups.

const toBase64 = (arrayBuffer) => {
  const bytes = new Uint8Array(arrayBuffer)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

const safeName = (name) => String(name || 'scoresheet.pdf').replace(/[\\/:*?"<>|\0]/g, '_').slice(0, 120)

/** `name`, else `name (1).pdf`, `(2)` ...: an earlier PDF is never overwritten (like the desktop app). */
export async function freePdfName(Filesystem, directory, name) {
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let n = 0; n < 1000; n++) {
    const candidate = n === 0 ? name : `${stem} (${n})${ext}`
    try {
      if (typeof Filesystem.stat !== 'function') return candidate
      await Filesystem.stat({ path: `${PDF_SUBDIR}/${candidate}`, directory })
    } catch {
      return candidate // not there: free
    }
  }
  return `${stem} (${Date.now()})${ext}`
}

/** The absolute path of a file:// URI (what the user finds in a file manager), else `fallback`. */
export function absolutePathOf(uri, fallback) {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return fallback
  const path = uri.slice('file://'.length)
  try { return decodeURIComponent(path) } catch { return path }
}

/**
 * Writes a PDF with @capacitor/filesystem. Documents first (user-visible),
 * then the app's external folder, under a free name. Returns the path shown to
 * the user (`fullPath`: absolute, e.g. /storage/emulated/0/Documents/OpenVolley/
 * scoresheets/x.pdf) and the file's URI (for Open / Share).
 * @param {{ Filesystem, Directory }} fs the plugin module
 */
export async function writePdfNative(fs, arrayBuffer, filename) {
  const { Filesystem, Directory } = fs
  const wanted = safeName(filename)
  const data = toBase64(arrayBuffer)
  let lastError = null
  for (const [directory, label] of [[Directory.Documents, 'Documents'], [Directory.External, 'Android/data/com.openvolley.escoresheet/files']]) {
    if (!directory) continue
    try {
      const name = await freePdfName(Filesystem, directory, wanted)
      const res = await Filesystem.writeFile({ path: `${PDF_SUBDIR}/${name}`, data, directory, recursive: true })
      const path = `${label}/${PDF_SUBDIR}/${name}`
      return { path, fullPath: absolutePathOf(res?.uri, path), uri: res?.uri, name }
    } catch (e) {
      lastError = e
    }
  }
  throw lastError || new Error('no writable folder')
}

/**
 * The app's own "open / share a saved scoresheet" plugin (android/.../
 * ScoresheetFilesPlugin.java: Android intents through the app's FileProvider,
 * no new dependency), or null outside the Android app.
 */
async function filesPlugin(win) {
  try {
    if (!win.Capacitor?.isNativePlatform?.()) return null
    let register = win.Capacitor?.registerPlugin
    if (typeof register !== 'function') register = (await import('@capacitor/core')).registerPlugin
    return register('OpenVolleyFiles')
  } catch {
    return null
  }
}

function actionButton(doc, text, onClick) {
  const b = el(doc, 'button', {
    height: '36px', padding: '0 12px', border: '1px solid #d6d3d1', borderRadius: '10px',
    background: '#ffffff', color: '#1c1917', fontSize: '14px', fontWeight: '600', cursor: 'pointer'
  }, { type: 'button' })
  b.textContent = text
  b.addEventListener('click', onClick)
  return b
}

async function savePdf({ arrayBuffer, filename }, status, actions, win = window) {
  status.textContent = t('appWindow.savingPdf', 'Saving the PDF...')
  if (actions) { actions.replaceChildren(); actions.style.display = 'none' }
  try {
    const fs = await import('@capacitor/filesystem')
    const { fullPath, uri } = await writePdfNative(fs, arrayBuffer, filename)
    status.textContent = t('appWindow.pdfSaved', `PDF saved to ${fullPath}`, { path: fullPath })
    const plugin = actions && uri ? await filesPlugin(win) : null
    if (plugin) {
      const run = (method) => async () => {
        try {
          await plugin[method]({ uri })
        } catch (e) {
          const error = e?.message || String(e)
          status.textContent = `${t('appWindow.pdfSaved', `PDF saved to ${fullPath}`, { path: fullPath })} - ${t('appWindow.pdfActionFailed', `It could not be opened: ${error}`, { error })}`
        }
      }
      const doc = actions.ownerDocument
      actions.append(
        actionButton(doc, t('appWindow.openPdf', 'Open'), run('open')),
        actionButton(doc, t('appWindow.sharePdf', 'Share'), run('share'))
      )
      actions.style.display = 'flex'
    }
  } catch (e) {
    const error = e?.message || String(e)
    status.textContent = t('appWindow.pdfSaveFailed', `The PDF could not be saved: ${error}`, { error })
  }
}
