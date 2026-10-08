/**
 * Diagnostics of the desktop app's pop-up windows (the scoresheet, a referee
 * view opened from the scoretable: Tauri labels "popup-<n>", popups.rs).
 *
 * Only the scoretable window ("main") may write the diagnostics file
 * (capabilities/diagnostics.json; main.rs scoresheet_windows_may_not_back_up
 * pins it), so a pop-up's recorder writes into a forwarding sink instead: its
 * lines go over a BroadcastChannel (same origin, same web process) to the main
 * window, which redacts them again (sanitizeDiagData), tags them with the
 * window ("win": its label, "page": scoresheet / referee) and writes them into
 * the same diagnostics-YYYY-MM-DD.jsonl through its own writer.
 *
 *   pop-up -> main  { t: 'diag-hello' }                      (at start)
 *   main -> pop-ups { t: 'diag-ready' }                      (at start, and on a hello)
 *   pop-up -> main  { t: 'diag-lines', from, id, win, page, lines }
 *   main -> pop-up  { t: 'diag-ack', to, id }
 *
 * A batch stays in the pop-up until the main window acknowledges it, at most
 * POPUP_BUFFER_MAX lines (the oldest go first; a diag.dropped line says how
 * many), and is sent again when the main window says it is ready.
 *
 * Which window a page is in comes from the app, not from the page: in a
 * pop-up on Linux (WebKitGTK) the page's own __TAURI_INTERNALS__.metadata
 * names the opener, "main" (measured in the real app, 2026-10-08), while the
 * app refuses that window's diagnostics_append as "popup-<n>". So a desktop
 * page asks once (diagnostics_append with no lines, desktopWindowRole):
 * accepted, it is the scoretable; refused by the ACL, a pop-up.
 *
 * Off (diagnostics mode off in that window), nothing here runs. In a browser
 * or the Android app there is no Tauri IPC: nothing here runs either.
 */
import { sanitizeDiagData } from './redact'

export const DIAG_CHANNEL = 'ov-diagnostics'
export const MAIN_WINDOW = 'main'
/** Lines a pop-up keeps while the main window is not there to take them. */
export const POPUP_BUFFER_MAX = 2000
/** Lines the main window takes from one message. */
export const ACCEPT_LINES_MAX = 500
/** A forwarded line longer than this is not even parsed. */
const RAW_LINE_MAX = 64 * 1024
/**
 * The diagnostics file refuses a whole call (the scoretable's own lines in it
 * too) with a line above 16 KB in UTF-8 (activity.rs valid_line, bytes).
 */
const FILE_LINE_MAX = 16 * 1024 - 1
/** Batch ids the main window remembers per pop-up (a batch sent again is taken once). */
const SEEN_MAX = 1000

const LABEL = /^popup-\d{1,6}$/
const PAGE = /^[a-z][a-z_-]{0,23}$/
const KIND = /^[a-z][a-z0-9_.-]{0,47}$/i
const SID = /^[a-z0-9]{1,12}$/i
const SENDER = /^[a-z0-9]{1,16}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null
// at most 3 bytes per UTF-16 unit: without an encoder, count the worst case
const utf8Length = (text) => (encoder ? encoder.encode(text).length : text.length * 3)

const randomId = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0')

/** This page's Tauri window label, or null (a browser, the Android app). */
export function desktopWindowLabel(win = typeof window !== 'undefined' ? window : undefined) {
  try {
    const internals = win?.__TAURI_INTERNALS__
    if (typeof internals?.invoke !== 'function') return null
    const label = internals.metadata?.currentWindow?.label
    return typeof label === 'string' && label ? label : null
  } catch {
    return null
  }
}

/** Is this page in the desktop app (Tauri IPC)? */
export function isDesktopApp(win = typeof window !== 'undefined' ? window : undefined) {
  try {
    return typeof win?.__TAURI_INTERNALS__?.invoke === 'function'
  } catch {
    return false
  }
}

/**
 * Does this page's own metadata name a pop-up window? Only a hint: in a
 * Linux pop-up it names "main" (see above), so false proves nothing.
 */
export function isDesktopPopup(win = typeof window !== 'undefined' ? window : undefined) {
  const label = desktopWindowLabel(win)
  return !!label && label !== MAIN_WINDOW
}

const REFUSED = /not allowed/i
const REFUSED_LABEL = /window "(popup-\d{1,6})"/

/**
 * Which desktop window this page is in, as the app sees it:
 * { popup: false, label: 'main' } or { popup: true, label: 'popup-<n>' }.
 * Asks with diagnostics_append and no lines (writes nothing); only a refusal
 * by the ACL ("... not allowed on window "popup-1" ...") makes it a pop-up.
 */
export async function desktopWindowRole(win = typeof window !== 'undefined' ? window : undefined) {
  if (isDesktopPopup(win)) return { popup: true, label: desktopWindowLabel(win) }
  try {
    await win.__TAURI_INTERNALS__.invoke('diagnostics_append', { lines: [] })
    return { popup: false, label: MAIN_WINDOW }
  } catch (e) {
    const msg = String(e?.message ?? e)
    if (!REFUSED.test(msg)) return { popup: false, label: MAIN_WINDOW }
    return { popup: true, label: REFUSED_LABEL.exec(msg)?.[1] || 'popup' }
  }
}

// desktopWindowRole's answer per window: the app is asked once a page
const roles = new WeakMap()

/**
 * desktopWindowRole, asked once per window and kept: the diagnostics sink,
 * the desktop app's update at start and isDesktopScoretable
 * (utils/appLifecycle) share the one answer.
 */
export function desktopWindowRoleOnce(win = typeof window !== 'undefined' ? window : undefined) {
  if (!win || (typeof win !== 'object' && typeof win !== 'function')) return desktopWindowRole(win)
  let entry = roles.get(win)
  if (!entry) {
    entry = { role: null, promise: desktopWindowRole(win) }
    // kept on the side: the sink's lines wait no longer than they did
    entry.promise.then((role) => { entry.role = role })
    roles.set(win, entry)
  }
  return entry.promise
}

/** Tests only: ask the app again in this window. */
export function forgetDesktopWindowRole(win = typeof window !== 'undefined' ? window : undefined) {
  if (win) roles.delete(win)
}

/** desktopWindowRoleOnce's answer once the app has given it, else null. */
export function knownDesktopWindowRole(win = typeof window !== 'undefined' ? window : undefined) {
  try {
    return (win && roles.get(win)?.role) || null
  } catch {
    return null
  }
}

/**
 * The recorder's sink in a desktop window: the file's (`fileSink`) in the
 * scoretable, which then also takes the pop-ups' lines (`onMain`), or
 * popupForwardSink in a pop-up. Lines wait until desktopWindowRole answers.
 * @param {{ win?: Window, fileSink: object, page?: string|null, sessionId?: () => string, onMain?: () => void, Channel?: typeof BroadcastChannel }} opts
 */
export function desktopDiagnosticsSink({ win = typeof window !== 'undefined' ? window : undefined, fileSink, page = null, sessionId, onMain, Channel } = {}) {
  let target = null
  let closed = false
  const ready = desktopWindowRoleOnce(win).then(({ popup, label }) => {
    target = popup ? popupForwardSink({ win, label, page, sessionId, Channel }) : fileSink
    if (closed) {
      try { target.close?.() } catch { /* ignore */ }
    } else if (!popup) {
      try { onMain?.() } catch { /* diagnostics never breaks the app */ }
    }
    return target
  })
  return {
    /** 'file' until the app has answered, then 'file' or 'forward'. */
    get kind() { return target?.kind || 'file' },
    ready,
    write: async (batch) => (await ready).write(batch),
    setNative: async (on) => (await ready).setNative?.(on),
    openFolder: async () => !!(await (await ready).openFolder?.()),
    exportText: null,
    clear: null,
    pending: () => target?.pending?.() || 0,
    close() {
      closed = true
      try { target?.close?.() } catch { /* ignore */ }
    }
  }
}

function openChannel(win, Channel) {
  const C = Channel || win?.BroadcastChannel
  if (typeof C !== 'function') return null
  try { return new C(DIAG_CHANNEL) } catch { return null }
}

/**
 * The recorder's sink in a pop-up window: lines go to the main window.
 * @param {{ win?: Window, label?: string, page?: string|null, Channel?: typeof BroadcastChannel, now?: () => number, sessionId?: () => string }} [opts]
 */
export function popupForwardSink({ win = typeof window !== 'undefined' ? window : undefined, label = desktopWindowLabel(win), page = null, Channel, now = () => Date.now(), sessionId = () => '' } = {}) {
  const from = randomId()
  const channel = openChannel(win, Channel)
  let nextId = 0
  let held = 0
  let dropped = 0
  const unacked = new Map() // id -> lines, oldest first

  const post = (msg) => { try { channel?.postMessage(msg) } catch { /* closed */ } }
  const send = (id, lines) => post({ t: 'diag-lines', from, id, win: label, page, lines })

  let markerId = null // the batch that starts with the diag.dropped line
  const marker = () => JSON.stringify({ ts: new Date(now()).toISOString(), m: 0, sid: sessionId(), seq: 0, src: 'page', k: 'diag.dropped', a: 0, d: { lines: dropped, where: 'popup' } })

  // keep at most POPUP_BUFFER_MAX lines: the oldest go, and the oldest batch
  // left starts with one diag.dropped line saying how many
  function trim() {
    if (held <= POPUP_BUFFER_MAX) return
    if (markerId !== null && unacked.has(markerId)) {
      unacked.get(markerId).shift()
      held--
    }
    markerId = null
    for (const [id, lines] of unacked) {
      if (held <= POPUP_BUFFER_MAX) break
      const over = held - POPUP_BUFFER_MAX
      if (over >= lines.length) {
        unacked.delete(id)
        held -= lines.length
        dropped += lines.length
      } else {
        lines.splice(0, over)
        held -= over
        dropped += over
      }
    }
    const first = unacked.keys().next()
    if (!first.done) {
      unacked.get(first.value).unshift(marker())
      held++
      markerId = first.value
    }
  }

  if (channel) {
    channel.onmessage = (e) => {
      const m = e?.data
      if (!m || typeof m !== 'object') return
      if (m.t === 'diag-ack' && m.to === from) {
        const lines = unacked.get(m.id)
        if (lines) {
          unacked.delete(m.id)
          held -= lines.length
          if (m.id === markerId) {
            markerId = null
            dropped = 0
          }
        }
      } else if (m.t === 'diag-ready') {
        for (const [id, lines] of unacked) send(id, lines)
      }
    }
    post({ t: 'diag-hello', from })
  }

  return {
    kind: 'forward',
    async write(batch) {
      if (!channel || !batch?.length) return
      const lines = batch.slice()
      const id = ++nextId
      unacked.set(id, lines)
      held += lines.length
      trim()
      if (unacked.has(id)) send(id, unacked.get(id))
    },
    setNative: async () => false,
    openFolder: async () => false,
    exportText: null,
    clear: null,
    /** Lines waiting for the main window. */
    pending: () => held,
    close() {
      if (channel) channel.onmessage = null
      try { channel?.close() } catch { /* ignore */ }
    }
  }
}

/**
 * One forwarded line as the main window writes it: only the line format's
 * fields, `d` redacted again, the window's tag; null when it is not a line.
 */
export function sanitizeForwardedLine(raw, { win = null, page = null } = {}) {
  if (typeof raw !== 'string' || !raw || raw.length > RAW_LINE_MAX) return null
  let o
  try { o = JSON.parse(raw) } catch { return null }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  if (typeof o.k !== 'string' || !KIND.test(o.k)) return null
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const line = {
    ts: typeof o.ts === 'string' && ISO.test(o.ts) ? o.ts : new Date().toISOString(),
    m: num(o.m),
    sid: typeof o.sid === 'string' && SID.test(o.sid) ? o.sid : '',
    seq: num(o.seq),
    src: 'page',
    k: o.k,
    a: num(o.a),
    win: typeof win === 'string' && LABEL.test(win) ? win : 'popup',
    page: typeof page === 'string' && PAGE.test(page) ? page : null
  }
  if (o.d !== undefined) {
    const d = sanitizeDiagData(o.d)
    if (d !== undefined) line.d = d
  }
  const text = JSON.stringify(line)
  return utf8Length(text) > FILE_LINE_MAX ? null : text
}

/**
 * The main window: take the pop-ups' lines into `append` (the recorder's
 * appendLines). Returns stop().
 * @param {{ win?: Window, append: (lines: string[]) => void, Channel?: typeof BroadcastChannel }} opts
 */
export function receivePopupLines({ win = typeof window !== 'undefined' ? window : undefined, append, Channel } = {}) {
  const channel = openChannel(win, Channel)
  if (!channel || typeof append !== 'function') return () => {}
  const seen = new Map() // sender -> Set of batch ids taken
  const post = (msg) => { try { channel.postMessage(msg) } catch { /* closed */ } }
  channel.onmessage = (e) => {
    const m = e?.data
    if (!m || typeof m !== 'object') return
    if (m.t === 'diag-hello') {
      post({ t: 'diag-ready' })
      return
    }
    if (m.t !== 'diag-lines' || typeof m.from !== 'string' || !SENDER.test(m.from) || !Array.isArray(m.lines)) return
    if (!Number.isSafeInteger(m.id)) return
    post({ t: 'diag-ack', to: m.from, id: m.id })
    let ids = seen.get(m.from)
    if (!ids) seen.set(m.from, (ids = new Set()))
    if (ids.has(m.id)) return // sent again: already taken
    ids.add(m.id)
    if (ids.size > SEEN_MAX) ids.delete(ids.values().next().value)
    const out = []
    for (const raw of m.lines.slice(0, ACCEPT_LINES_MAX)) {
      const line = sanitizeForwardedLine(raw, { win: m.win, page: m.page })
      if (line) out.push(line)
    }
    if (out.length) {
      try { append(out) } catch { /* diagnostics never breaks the app */ }
    }
  }
  post({ t: 'diag-ready' })
  return () => {
    channel.onmessage = null
    try { channel.close() } catch { /* ignore */ }
  }
}
