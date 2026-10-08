// Diagnostics of the desktop app's pop-up windows (scoresheet, referee): the
// app lets only the scoretable window ("main") call diagnostics_append
// (src-tauri main.rs scoresheet_windows_may_not_back_up), so a pop-up's lines
// go to the scoretable over a BroadcastChannel and are written into the same
// diagnostics-<date>.jsonl by its writer, redacted again (popupForward.js).
//
// Two windows: two jsdom windows and two copies of the diagnostics modules
// (vi.resetModules), like the two pages of the desktop app.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { JSDOM } from 'jsdom'

const ORIGIN = 'http://localhost:5173'

/**
 * A desktop app window: Tauri's IPC with the ACL of capabilities/diagnostics.json.
 * `metadataLabel`: the label the page itself reads (__TAURI_INTERNALS__.metadata).
 * In the real Linux app (WebKitGTK) a pop-up reads the opener's, "main", while
 * the app refuses its commands as "popup-<n>" (measured 2026-10-08, debug build
 * under Xvfb: metadata "main", refusal 'diagnostics_append not allowed on window
 * "popup-1", webview "popup-1", URL: ...').
 */
function desktopWindow(label, path, { env = true, metadataLabel = label } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: `${ORIGIN}${path}`, pretendToBeVisual: true })
  const win = dom.window
  const file = []
  const calls = []
  win.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: metadataLabel }, currentWebview: { label: metadataLabel } },
    invoke: vi.fn(async (cmd, args) => {
      calls.push(cmd)
      if (label !== 'main' && cmd.startsWith('diagnostics_')) {
        // Tauri rejects with a string
        throw `${cmd} not allowed on window "${label}", webview "${label}", URL: ${ORIGIN}${path}`
      }
      if (cmd === 'diagnostics_append') {
        for (const l of args.lines) {
          // what activity.rs valid_line accepts, or the whole call fails
          if (l.length > 16 * 1024 || /[\r\n]/.test(l)) throw new Error('line is not one JSON object')
          const o = JSON.parse(l)
          if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('line is not one JSON object')
        }
        file.push(...args.lines)
        return args.lines.length
      }
      return null
    })
  }
  if (env) win.__OV_DIAGNOSTICS__ = 'env'
  // Node's BroadcastChannel: same process, same channel name = same origin
  win.BroadcastChannel = globalThis.BroadcastChannel
  return { win, file, calls, close: () => dom.window.close() }
}

async function loadDiagnostics() {
  vi.resetModules()
  return {
    index: await import('../index'),
    recorder: await import('../recorder')
  }
}

const settle = async (ms = 30) => { await new Promise(r => setTimeout(r, ms)) }
const parsedFile = (w) => w.file.map(l => JSON.parse(l))

const opened = []
afterEach(async () => {
  for (const o of opened.splice(0)) {
    try { await o.diag?.index.setDiagnosticsEnabled?.(false, { win: o.win }) } catch { /* ignore */ }
    try { await o.diag?.index.stopDiagnostics?.() } catch { /* ignore */ }
    try { o.close() } catch { /* ignore */ }
  }
  try { window.sessionStorage.clear() } catch { /* ignore */ }
})

async function openMain(opts) {
  const w = desktopWindow('main', '/', opts)
  w.diag = await loadDiagnostics()
  w.diag.index.installDiagnostics({ win: w.win })
  opened.push(w)
  return w
}

async function openPopup(label, path, { app, ...opts } = {}) {
  const w = desktopWindow(label, path, opts)
  w.diag = await loadDiagnostics()
  const install = w.diag.index.installPopupDiagnostics || w.diag.index.installDiagnostics
  install({ win: w.win, app })
  opened.push(w)
  return w
}

describe('desktop pop-up windows: diagnostics reach the main window', () => {
  it('a scoresheet window\'s lines are written into the main window\'s diagnostics file, tagged with the window', async () => {
    const main = await openMain()
    const popup = await openPopup('popup-1', '/scoresheet/?matchId=7', { app: 'scoresheet' })
    popup.diag.recorder.diag('ui.click', { text: 'Save PDF' })
    await popup.diag.recorder.flushDiagnostics()
    await settle()
    await main.diag.recorder.flushDiagnostics()
    // the pop-up itself never calls diagnostics_append (refused by the ACL)
    expect(popup.calls).not.toContain('diagnostics_append')
    const lines = parsedFile(main)
    const fromPopup = lines.filter(l => l.win === 'popup-1')
    expect(fromPopup.map(l => l.k)).toEqual(expect.arrayContaining(['page.load', 'ui.click']))
    expect(fromPopup.every(l => l.page === 'scoresheet')).toBe(true)
    expect(fromPopup.find(l => l.k === 'ui.click').d).toEqual({ text: 'Save PDF' })
    // the main window's own lines carry no window tag
    expect(lines.filter(l => !l.win).map(l => l.k)).toContain('page.load')
  })

  it('lines recorded before the main window listens wait in a bounded buffer and arrive once it does', async () => {
    const popup = await openPopup('popup-2', '/referee/?match=7', { app: 'referee' })
    const { POPUP_BUFFER_MAX } = await import('../popupForward')
    for (let i = 0; i < POPUP_BUFFER_MAX + 50; i++) popup.diag.recorder.diag('ui.key', { n: i })
    await popup.diag.recorder.flushDiagnostics()
    await settle()
    const main = await openMain()
    await settle(60)
    await main.diag.recorder.flushDiagnostics()
    const fromPopup = parsedFile(main).filter(l => l.win === 'popup-2')
    const keys = fromPopup.filter(l => l.k === 'ui.key')
    expect(keys.length).toBeLessThanOrEqual(POPUP_BUFFER_MAX)
    expect(keys.length).toBeGreaterThan(POPUP_BUFFER_MAX - 200)
    // the newest are kept, the oldest dropped, and a line says how many
    expect(keys.at(-1).d.n).toBe(POPUP_BUFFER_MAX + 49)
    const dropped = fromPopup.find(l => l.k === 'diag.dropped')
    expect(dropped?.d?.lines).toBeGreaterThan(0)
    // each line once
    const seqs = fromPopup.map(l => l.seq)
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('a pop-up whose page reads "main" as its label (Linux) still sends its lines, and takes no one else\'s', async () => {
    const heard = []
    const spy = new globalThis.BroadcastChannel('ov-diagnostics')
    spy.onmessage = (e) => heard.push(e.data)
    const main = await openMain()
    const popup = await openPopup('popup-1', '/scoresheet/?matchId=7', { app: 'scoresheet', metadataLabel: 'main' })
    const other = await openPopup('popup-2', '/referee/?match=7', { app: 'referee', metadataLabel: 'main' })
    await settle()
    popup.diag.recorder.diag('ui.click', { text: 'Save PDF' })
    other.diag.recorder.diag('ui.click', { text: 'Menu' })
    await popup.diag.recorder.flushDiagnostics()
    await other.diag.recorder.flushDiagnostics()
    await settle()
    await main.diag.recorder.flushDiagnostics()
    spy.close()
    const lines = parsedFile(main)
    const clicks = lines.filter(l => l.k === 'ui.click')
    expect(clicks.map(l => [l.win, l.page, l.d.text])).toEqual(expect.arrayContaining([
      ['popup-1', 'scoresheet', 'Save PDF'],
      ['popup-2', 'referee', 'Menu']
    ]))
    expect(clicks).toHaveLength(2)
    expect(popup.diag.index.diagnosticsState().sink).toBe('forward')
    // only the main window answers: a pop-up never acknowledges another's lines
    expect(heard.filter(m => m.t === 'diag-ack')).toHaveLength(new Set(heard.filter(m => m.t === 'diag-lines').map(m => `${m.from}:${m.id}`)).size)
    // the pop-ups asked once whether they may write, and never switched native events
    for (const w of [popup, other]) {
      expect(w.calls.filter(c => c === 'diagnostics_append')).toHaveLength(1)
      expect(w.calls).not.toContain('diagnostics_native')
    }
  })

  it('a pop-up has no export of its own (its lines are in the scoretable\'s file)', async () => {
    await openMain()
    const popup = await openPopup('popup-4', '/referee/?match=7', { app: 'referee' })
    expect(popup.diag.index.diagnosticsState()).toMatchObject({ on: true, sink: 'forward' })
    await expect(popup.diag.index.exportDiagnostics({ win: popup.win })).resolves.toBe(false)
    expect(popup.calls).not.toContain('activity_open_dir')
  })

  it('nothing is forwarded or listened for while diagnostics is off', async () => {
    const main = await openMain({ env: false })
    const popup = await openPopup('popup-3', '/scoresheet/', { app: 'scoresheet', env: false })
    const heard = []
    const spy = new globalThis.BroadcastChannel('ov-diagnostics')
    spy.onmessage = (e) => heard.push(e.data)
    popup.diag.recorder.diag('ui.click', { text: 'x' })
    await popup.diag.recorder.flushDiagnostics()
    await settle()
    spy.close()
    expect(heard).toEqual([])
    expect(main.file).toEqual([])
    expect(popup.diag.recorder.diagActive()).toBe(false)
    expect(main.diag.recorder.diagActive()).toBe(false)
  })
})

describe('forwarded lines are redacted again by the main window', () => {
  it('a PIN, a token, a long text, a forged window tag or a broken line never reach the file', async () => {
    const main = await openMain()
    const { DIAG_CHANNEL } = await import('../popupForward')
    const ch = new globalThis.BroadcastChannel(DIAG_CHANNEL)
    const line = (o) => JSON.stringify({ ts: '2026-10-08T12:00:00.000Z', m: 1, sid: 'abc123', seq: 1, src: 'page', a: 0, ...o })
    ch.postMessage({
      t: 'diag-lines',
      from: 'x1',
      id: 1,
      win: 'main',
      page: 'scoresheet<script>',
      lines: [
        line({ seq: 1, k: 'ui.click', d: { text: 'Game PIN 482913', pin: '4829', url: 'http://localhost:5173/referee/?pin=4829', long: 'y'.repeat(500) } }),
        line({ seq: 2, k: 'ui.click', d: { token: 'abc', nested: { password: 'p', ok: 'fine' } } }),
        line({ seq: 3, k: 'x"}\n{"k":"evil', d: {} }),
        'not json',
        JSON.stringify([1, 2]),
        line({ seq: 4, k: 'ui.big', d: { a: Array.from({ length: 300 }, (_, i) => 'z'.repeat(100) + i) } }),
        line({ seq: 5, k: 'page.load', extra: 'dropped field', d: { url: '/scoresheet/' } })
      ]
    })
    await settle(60)
    ch.close()
    await main.diag.recorder.flushDiagnostics()
    const forwarded = parsedFile(main).filter(l => l.win)
    const text = forwarded.map(l => JSON.stringify(l)).join('\n')
    expect(text).not.toMatch(/4829|482913|password|token|<script>|evil/)
    expect(forwarded.every(l => l.win === 'popup')).toBe(true)
    expect(forwarded.every(l => l.page === null)).toBe(true)
    expect(forwarded.map(l => l.seq)).toEqual([1, 2, 4, 5])
    const first = forwarded[0]
    expect(first.d.url).toBe('http://localhost:5173/referee/')
    expect(first.d.long.length).toBeLessThanOrEqual(120)
    expect(forwarded[1].d).toEqual({ nested: { ok: 'fine' } })
    expect(forwarded[2].d.a.length).toBeLessThanOrEqual(20)
    expect(forwarded[3]).not.toHaveProperty('extra')
    expect(main.file.every(l => l.length <= 16 * 1024)).toBe(true)
  })
})

describe('web and Android builds: inert', () => {
  it('a browser tab (no desktop app) neither forwards nor listens', async () => {
    const heard = []
    const spy = new globalThis.BroadcastChannel('ov-diagnostics')
    spy.onmessage = (e) => heard.push(e.data)
    vi.resetModules()
    const { installPopupDiagnostics } = await import('../index')
    const { diagActive } = await import('../recorder')
    const dom = new JSDOM('<!doctype html><body></body>', { url: `${ORIGIN}/scoresheet/?diag=1` })
    dom.window.BroadcastChannel = globalThis.BroadcastChannel
    expect(installPopupDiagnostics({ win: dom.window, app: 'scoresheet' }).on).toBe(false)
    expect(diagActive()).toBe(false)
    await settle()
    spy.close()
    dom.window.close()
    expect(heard).toEqual([])
  })
})
