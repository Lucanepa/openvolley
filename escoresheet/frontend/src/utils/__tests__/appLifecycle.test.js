import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import i18n from 'i18next'
import en from '../../i18n/locales/en.json'
import de from '../../i18n/locales/de.json'
import {
  LIFECYCLE_EVENT,
  closeNotice,
  exitQuestion,
  getLiveMatch,
  installAppLifecycle,
  isDesktopScoretable,
  liveOf,
  quitQuestion,
  requestDesktopQuit,
  resetAppLifecycleForTests,
  resolveDesktopWindow,
  setLiveMatch,
  trayLabels,
  windowsLine,
} from '../appLifecycle'
import { allowLeaving } from '../leaveGuard'
import { askConfirm } from '../askConfirm'
import { getConfirmSnapshot, settleConfirm } from '../../ui/uiStore'
import { openAppWindow, resetAppWindowsForTests } from '../openAppWindow'

beforeAll(async () => {
  await i18n.init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, de: { translation: de } } })
})

beforeEach(async () => {
  resetAppLifecycleForTests()
  resetAppWindowsForTests()
  await i18n.changeLanguage('en')
})

const flush = () => new Promise((r) => setTimeout(r, 0))

/** The desktop app's scoretable window: an EventTarget with Tauri's invoke. */
function desktopWin({ label = 'main', status = {} } = {}) {
  const win = new EventTarget()
  win.location = { href: 'http://localhost:5173/', origin: 'http://localhost:5173' }
  const invoke = vi.fn(async (cmd) => {
    if (cmd === 'app_page_state') return { tray: status.tray ?? true }
    if (cmd === 'hotspot_status') return status.wifi ?? { active: false }
    if (cmd === 'bluetooth_status') return status.bt ?? { active: false }
    if (cmd === 'app_windows') return typeof status.windows === 'function' ? status.windows() : (status.windows ?? [])
    return null
  })
  win.__TAURI_INTERNALS__ = { invoke, metadata: { currentWindow: { label } } }
  return { win, invoke }
}

const fire = (win, type) => win.dispatchEvent(new CustomEvent(LIFECYCLE_EVENT, { detail: { type } }))

describe('live match', () => {
  it('is official / test only while live', () => {
    expect(liveOf(null)).toBe('none')
    expect(liveOf({ status: 'scheduled' })).toBe('none')
    expect(liveOf({ status: 'final', test: true })).toBe('none')
    expect(liveOf({ status: 'live' })).toBe('official')
    expect(liveOf({ status: 'live', test: true })).toBe('test')
    setLiveMatch('bogus')
    expect(getLiveMatch()).toBe('none')
  })
})

describe('questions', () => {
  it('quit: tablets disconnect; the laptop network only when it runs', () => {
    const q = quitQuestion()
    expect(q).toMatchObject({ title: 'Quit OpenVolley?', tone: 'danger', confirmLabel: 'Quit OpenVolley', cancelLabel: 'Keep running' })
    expect(q.message).toBe("Tablets on this computer's network will disconnect.")
    expect(quitQuestion({ wifi: true }).message).toContain("The laptop's Wi-Fi for tablets will stop.")
    expect(quitQuestion({ bluetooth: true }).message).toContain("The laptop's Bluetooth network for tablets will stop.")
    expect(quitQuestion({ wifi: true, bluetooth: true }).message).toContain('Wi-Fi and Bluetooth network')
  })

  it('quit during a match is stronger and says which match is saved', () => {
    const official = quitQuestion({ live: 'official' })
    expect(official.title).toBe('Quit OpenVolley during the match?')
    expect(official.message).toMatch(/^A match is in progress\. It is saved on this computer/)
    const test = quitQuestion({ live: 'test' })
    expect(test.title).toBe('Quit OpenVolley during the test match?')
    expect(test.message).toMatch(/^A test match is in progress/)
  })

  it('in the page language', async () => {
    await i18n.changeLanguage('de')
    expect(quitQuestion({ live: 'official', wifi: true })).toMatchObject({
      title: 'OpenVolley während des Spiels beenden?',
      confirmLabel: 'OpenVolley beenden',
    })
    expect(trayLabels()).toMatchObject({ show: 'OpenVolley anzeigen', quit: 'OpenVolley beenden…', tablets: '{{count}} Tablets verbunden' })
  })

  it('tray labels keep {{count}} for the app to fill in', () => {
    expect(trayLabels()).toEqual({
      tooltip: 'OpenVolley eScoresheet',
      show: 'Show OpenVolley',
      quit: 'Quit OpenVolley…',
      noTablets: 'No tablets connected',
      oneTablet: '1 tablet connected',
      tablets: '{{count}} tablets connected',
      matchLive: 'Match in progress',
      testMatchLive: 'Test match in progress',
      // the app's native quit question, when the page cannot ask
      quitTitle: 'Quit OpenVolley?',
      quitTitleMatch: 'Quit OpenVolley during the match?',
      quitTitleTestMatch: 'Quit OpenVolley during the test match?',
      quitBody: "Tablets on this computer's network will disconnect.",
      quitMatchBody: 'A match is in progress. It is saved on this computer: start OpenVolley again and continue it from the home screen.',
      quitTestMatchBody: 'A test match is in progress. It is saved on this computer: start OpenVolley again and continue it from the home screen.',
      quitConfirm: 'Quit OpenVolley',
      keepRunning: 'Keep running',
      // a downloaded update (updater.rs): {{version}} for the app to fill in
      updateReady: 'Restart to update to {{version}}',
      updateStatus: 'Update ready',
      // the other app windows the quit closes, in the native question
      alsoCloses: 'Also closes: {{windows}}',
      windowGroupOne: '{{name}} ({{count}} window)',
      windowGroupOther: '{{name}} ({{count}} windows)',
      windowScoresheet: 'Scoresheet',
    })
  })

  it('quit lists the other app windows it closes, grouped, in one line', () => {
    expect(windowsLine([])).toBe('')
    expect(windowsLine(['Openvolley Scoresheet'])).toBe('Also closes: Scoresheet (1 window)')
    // a popup before its page set a title has the app's title: a scoresheet too
    expect(windowsLine(['Openvolley Scoresheet', 'OpenVolley eScoresheet', 'Help', ''])).toBe(
      'Also closes: Scoresheet (3 windows), Help (1 window)')
    const q = quitQuestion({ windows: ['Openvolley Scoresheet', 'Openvolley Scoresheet'] })
    expect(q.message).toBe("Tablets on this computer's network will disconnect.\n\nAlso closes: Scoresheet (2 windows)")
    expect(q.title).toBe('Quit OpenVolley?')
    // a window title is page text: no control characters, cut
    expect(windowsLine([`Report\u0007${'x'.repeat(200)}`])).toMatch(/^Also closes: Reportx{54} \(1 window\)$/)
  })

  it('says when a scoresheet window is still saving a PDF', () => {
    expect(quitQuestion({ windows: ['Openvolley Scoresheet'], pdfBusy: true }).message).toMatch(
      /Also closes: Scoresheet \(1 window\)\n\nA PDF is still being saved in the scoresheet window\.$/)
    expect(quitQuestion({ windows: ['Openvolley Scoresheet'] }).message).not.toContain('PDF')
  })

  it('the windows line in the page language, placeholders kept for the app', async () => {
    await i18n.changeLanguage('de')
    expect(windowsLine(['Openvolley Scoresheet', 'Openvolley Scoresheet'])).toBe('Schliesst auch: Matchblatt (2 Fenster)')
    expect(trayLabels()).toMatchObject({
      alsoCloses: 'Schliesst auch: {{windows}}',
      windowGroupOne: '{{name}} ({{count}} Fenster)',
      windowGroupOther: '{{name}} ({{count}} Fenster)',
      windowScoresheet: 'Matchblatt',
    })
  })

  it('close notice: tray or minimised', () => {
    expect(closeNotice({ tray: true })).toMatchObject({ title: 'OpenVolley keeps running in the tray', confirmLabel: 'Hide window' })
    expect(closeNotice({ tray: false })).toMatchObject({ title: 'OpenVolley keeps running', confirmLabel: 'Minimise window' })
  })

  it('Android exit warns that the match is saved', () => {
    expect(exitQuestion()).toMatchObject({ title: 'Exit OpenVolley?', message: undefined, tone: 'default' })
    expect(exitQuestion({ live: 'official' })).toMatchObject({
      title: 'Exit OpenVolley during the match?',
      message: 'The match is saved on this device: open OpenVolley again to continue it.',
      tone: 'danger',
    })
  })
})

describe('desktop app', () => {
  let uninstall = () => {}
  afterEach(() => uninstall())

  it('only the scoretable window, not a scoresheet window or a browser', () => {
    expect(isDesktopScoretable(desktopWin().win)).toBe(true)
    expect(isDesktopScoretable(desktopWin({ label: 'popup-1' }).win)).toBe(false)
    expect(isDesktopScoretable({})).toBe(false)
  })

  // A pop-up window in the real Linux app (WebKitGTK): its own metadata names
  // the opener, "main", while the app refuses it the scoretable's commands
  // as "popup-<n>" (measured 2026-10-08; diagnostics/popupForward.js)
  function linuxPopupWin({ opener = {} } = {}) {
    const win = new EventTarget()
    win.opener = opener
    const invoke = vi.fn(async (cmd) => {
      if (cmd === 'diagnostics_append') throw `diagnostics_append not allowed on window "popup-1", webview "popup-1", URL: http://localhost:5173/scoresheet/`
      return null
    })
    win.__TAURI_INTERNALS__ = { invoke, metadata: { currentWindow: { label: 'main' } } }
    return { win, invoke }
  }

  it('a Linux pop-up whose metadata says "main" is no scoretable: its opener says so at once', async () => {
    const { win, invoke } = linuxPopupWin()
    expect(isDesktopScoretable(win)).toBe(false)
    expect(await resolveDesktopWindow(win)).toBe(false)
    expect(isDesktopScoretable(win)).toBe(false)
    expect(invoke).toHaveBeenCalledWith('diagnostics_append', { lines: [] })
  })

  it('a pop-up opened without an opener is known once the app has said which window it is', async () => {
    const { win } = linuxPopupWin({ opener: null })
    expect(isDesktopScoretable(win)).toBe(true) // the metadata's guess until the app answers
    expect(await resolveDesktopWindow(win)).toBe(false)
    expect(isDesktopScoretable(win)).toBe(false)
  })

  it('the scoretable: the app takes its (empty) diagnostics line; asked once', async () => {
    const { win, invoke } = desktopWin()
    expect(isDesktopScoretable(win)).toBe(true)
    expect(await resolveDesktopWindow(win)).toBe(true)
    expect(await resolveDesktopWindow(win)).toBe(true)
    expect(isDesktopScoretable(win)).toBe(true)
    expect(invoke.mock.calls.filter(([cmd]) => cmd === 'diagnostics_append')).toHaveLength(1)
  })

  it('outside the desktop app nothing is asked', async () => {
    expect(await resolveDesktopWindow({})).toBe(false)
    expect(await resolveDesktopWindow(undefined)).toBe(false)
  })

  it('reports its tray texts and the live match, again when either changes', async () => {
    const { win, invoke } = desktopWin()
    uninstall = installAppLifecycle({ win, ask: vi.fn() })
    expect(invoke).toHaveBeenLastCalledWith('app_page_state', { handler: expect.any(String), labels: trayLabels(), live: 'none' })
    setLiveMatch('test')
    expect(invoke).toHaveBeenLastCalledWith('app_page_state', expect.objectContaining({ live: 'test' }))
    await i18n.changeLanguage('de')
    expect(invoke).toHaveBeenLastCalledWith('app_page_state', expect.objectContaining({ labels: expect.objectContaining({ show: 'OpenVolley anzeigen' }) }))
  })

  it('reports again when a language loads after the switch (lazy bundles)', async () => {
    const { win, invoke } = desktopWin()
    uninstall = installAppLifecycle({ win, ask: vi.fn() })
    await i18n.changeLanguage('it') // not loaded yet: English for now
    expect(invoke).toHaveBeenLastCalledWith('app_page_state', expect.objectContaining({ labels: expect.objectContaining({ show: 'Show OpenVolley' }) }))
    i18n.addResourceBundle('it', 'translation', { appLifecycle: { trayShow: 'Mostra OpenVolley' } })
    expect(invoke).toHaveBeenLastCalledWith('app_page_state', expect.objectContaining({ labels: expect.objectContaining({ show: 'Mostra OpenVolley' }) }))
    i18n.removeResourceBundle('it', 'translation')
  })

  it('the first close shows the notice, then hides', async () => {
    const { win, invoke } = desktopWin()
    const ask = vi.fn().mockResolvedValue(true)
    uninstall = installAppLifecycle({ win, ask })
    await flush()
    fire(win, 'close-requested')
    await flush()
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ title: 'OpenVolley keeps running in the tray' }))
    expect(invoke).toHaveBeenCalledWith('app_hide')
  })

  it('the notice says "minimised" without a tray; Keep open does not hide', async () => {
    const { win, invoke } = desktopWin({ status: { tray: false } })
    const ask = vi.fn().mockResolvedValue(false)
    uninstall = installAppLifecycle({ win, ask })
    await flush()
    fire(win, 'close-requested')
    await flush()
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: 'Minimise window' }))
    expect(invoke).not.toHaveBeenCalledWith('app_hide')
  })

  it('quit from the tray asks; cancel keeps running, confirm quits', async () => {
    const { win, invoke } = desktopWin({ status: { wifi: { active: true, external: false } } })
    const ask = vi.fn().mockResolvedValue(false)
    uninstall = installAppLifecycle({ win, ask })
    setLiveMatch('official')
    fire(win, 'quit-requested')
    await flush(); await flush()
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Quit OpenVolley during the match?',
      tone: 'danger',
      message: expect.stringContaining("The laptop's Wi-Fi for tablets will stop."),
    }))
    expect(invoke).not.toHaveBeenCalledWith('app_quit')

    ask.mockResolvedValue(true)
    expect(await requestDesktopQuit(win, ask)).toBe(true)
    expect(invoke).toHaveBeenCalledWith('app_quit')
  })

  it('one question for every window: it lists the scoresheet windows the quit closes', async () => {
    const { win, invoke } = desktopWin({ status: { windows: ['Openvolley Scoresheet', 'Openvolley Scoresheet'] } })
    const ask = vi.fn().mockResolvedValue(true)
    expect(await requestDesktopQuit(win, ask)).toBe(true)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0][0].message).toContain('Also closes: Scoresheet (2 windows)')
    expect(invoke).toHaveBeenCalledWith('app_windows')
    expect(invoke).toHaveBeenCalledWith('app_quit')
    // quitting: the hidden scoresheet windows are not brought back
    expect(invoke).not.toHaveBeenCalledWith('app_quit_cancel')
  })

  it('Keep running brings back the scoresheet windows the quit request left hidden', async () => {
    const { win, invoke } = desktopWin({ status: { windows: ['Openvolley Scoresheet'] } })
    const ask = vi.fn().mockResolvedValue(false)
    expect(await requestDesktopQuit(win, ask)).toBe(false)
    expect(invoke).not.toHaveBeenCalledWith('app_quit')
    expect(invoke).toHaveBeenCalledWith('app_quit_cancel')
  })

  it('an app that does not list its windows in time does not hold the question', async () => {
    vi.useFakeTimers()
    try {
      const { win } = desktopWin({ status: { windows: () => new Promise(() => {}) } })
      const ask = vi.fn().mockResolvedValue(false)
      const quitting = requestDesktopQuit(win, ask)
      await vi.advanceTimersByTimeAsync(1500)
      expect(await quitting).toBe(false)
      expect(ask).toHaveBeenCalledTimes(1)
      expect(ask.mock.calls[0][0].message).not.toContain('Also closes')
    } finally {
      vi.useRealTimers()
    }
  })

  it('says when a scoresheet window it opened is still saving a PDF', async () => {
    const { win } = desktopWin({ status: { windows: ['Openvolley Scoresheet'] } })
    const scoresheet = { closed: false, __ovPdfBusy: true }
    openAppWindow('/scoresheet/?matchId=7&action=save', { win: { ...win, location: win.location, open: () => scoresheet }, platform: 'tauri' })
    const ask = vi.fn().mockResolvedValue(false)
    await requestDesktopQuit(win, ask)
    expect(ask.mock.calls[0][0].message).toContain('A PDF is still being saved in the scoresheet window.')
    scoresheet.__ovPdfBusy = false
    await requestDesktopQuit(win, ask)
    expect(ask.mock.calls[1][0].message).not.toContain('PDF')
  })

  it('a hotspot switched on outside the app is not mentioned (the app does not stop it)', async () => {
    const { win } = desktopWin({ status: { wifi: { active: true, external: true } } })
    const ask = vi.fn().mockResolvedValue(false)
    await requestDesktopQuit(win, ask)
    expect(ask.mock.calls[0][0].message).not.toContain('Wi-Fi')
  })

  it('a second quit while the question is open is ignored', async () => {
    const { win } = desktopWin()
    let answer
    const ask = vi.fn(() => new Promise((r) => { answer = r }))
    const first = requestDesktopQuit(win, ask)
    await flush(); await flush()
    expect(await requestDesktopQuit(win, ask)).toBe(false)
    answer(false)
    expect(await first).toBe(false)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('the tray quit is taken (app_quit_ack) before the question', async () => {
    const { win, invoke } = desktopWin()
    const ask = vi.fn().mockResolvedValue(false)
    uninstall = installAppLifecycle({ win, ask })
    fire(win, 'quit-requested')
    expect(invoke).toHaveBeenCalledWith('app_quit_ack')
    await flush(); await flush()
    expect(ask).toHaveBeenCalledTimes(1)
    // a second request while it asks is taken too (the question is on screen)
    // and asks nothing new
    let answer
    ask.mockImplementation(() => new Promise((r) => { answer = r }))
    fire(win, 'quit-requested')
    await flush(); await flush()
    invoke.mockClear()
    fire(win, 'quit-requested')
    expect(invoke).toHaveBeenCalledWith('app_quit_ack')
    expect(ask).toHaveBeenCalledTimes(2)
    answer(false)
  })

  it('without a dialog host it does not take the request (the app asks natively)', async () => {
    const { win, invoke } = desktopWin()
    const ask = vi.fn().mockResolvedValue(true)
    expect(await requestDesktopQuit(win, ask, { canAsk: () => false })).toBe(false)
    expect(invoke).not.toHaveBeenCalledWith('app_quit_ack')
    expect(ask).not.toHaveBeenCalled()
    // the real askConfirm with no <UiHost /> mounted: the same
    expect(await requestDesktopQuit(win, askConfirm)).toBe(false)
    expect(invoke).not.toHaveBeenCalledWith('app_quit_ack')
    expect(getConfirmSnapshot()).toBeNull()
  })

  it('uninstalling (e.g. a crash into the error screen) tells the app its handler is gone', async () => {
    const { win, invoke } = desktopWin()
    const stop = installAppLifecycle({ win, ask: vi.fn() })
    const { handler } = invoke.mock.calls.find(([cmd]) => cmd === 'app_page_state')[1]
    stop()
    expect(invoke).toHaveBeenLastCalledWith('app_page_gone', { handler })
    // a reinstall (Try again, StrictMode) is a new handler
    uninstall = installAppLifecycle({ win, ask: vi.fn() })
    expect(invoke.mock.calls.at(-1)[1].handler).not.toBe(handler)
  })

  it('a tray quit while the first-close notice is open replaces the notice', async () => {
    const { win, invoke } = desktopWin()
    let noticeSignal
    const ask = vi.fn((q) => {
      if (q.signal) {
        noticeSignal = q.signal
        return new Promise((r) => q.signal.addEventListener('abort', () => r(false)))
      }
      return Promise.resolve(false)
    })
    uninstall = installAppLifecycle({ win, ask })
    await flush()
    fire(win, 'close-requested')
    await flush()
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'OpenVolley keeps running in the tray' }))
    fire(win, 'quit-requested')
    await flush(); await flush()
    expect(noticeSignal.aborted).toBe(true)
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Quit OpenVolley?' }))
    expect(invoke).not.toHaveBeenCalledWith('app_hide')
  })

  it('with the real dialog: the notice is taken away for the quit question', async () => {
    const { win } = desktopWin()
    uninstall = installAppLifecycle({ win, ask: askConfirm })
    fire(win, 'close-requested')
    await flush()
    expect(getConfirmSnapshot()).toMatchObject({ title: 'OpenVolley keeps running in the tray' })
    const quitting = requestDesktopQuit(win, askConfirm, { canAsk: () => true })
    await flush(); await flush()
    expect(getConfirmSnapshot()).toMatchObject({ title: 'Quit OpenVolley?' })
    settleConfirm(getConfirmSnapshot().id, false)
    expect(await quitting).toBe(false)
    expect(getConfirmSnapshot()).toBeNull()
  })

  it('a scoresheet window installs nothing', () => {
    const { win, invoke } = desktopWin({ label: 'popup-2' })
    uninstall = installAppLifecycle({ win, ask: vi.fn() })
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('Android app', () => {
  function androidWin() {
    const exitApp = vi.fn(async () => {})
    const win = new EventTarget()
    win.location = { href: 'https://localhost/', origin: 'https://localhost' }
    win.Capacitor = { isNativePlatform: () => true, registerPlugin: vi.fn(() => ({ exitApp })) }
    return { win, exitApp }
  }

  it('Back on the first page asks; only Exit exits', async () => {
    const { win, exitApp } = androidWin()
    const ask = vi.fn().mockResolvedValue(false)
    const uninstall = installAppLifecycle({ win, ask })
    expect(win.__ovAndroidBack()).toBe(true) // handled: MainActivity neither exits nor backgrounds
    await flush()
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Exit OpenVolley?' }))
    expect(exitApp).not.toHaveBeenCalled()

    setLiveMatch('official')
    ask.mockResolvedValue(true)
    win.__ovAndroidBack()
    await flush()
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Exit OpenVolley during the match?' }))
    expect(win.Capacitor.registerPlugin).toHaveBeenCalledWith('OpenVolleyApp')
    expect(exitApp).toHaveBeenCalled()
    uninstall()
    expect(win.__ovAndroidBack).toBeUndefined()
  })

  it('Back closes an open in-app confirm instead of asking to exit', async () => {
    const { win, exitApp } = androidWin()
    const ask = vi.fn().mockResolvedValue(true)
    installAppLifecycle({ win, ask })
    const endSet = askConfirm({ title: 'End set?' })
    expect(getConfirmSnapshot()).toMatchObject({ title: 'End set?' })
    expect(win.__ovAndroidBack()).toBe(true)
    expect(await endSet).toBe(false) // cancelled, like Escape
    expect(ask).not.toHaveBeenCalled()
    expect(exitApp).not.toHaveBeenCalled()
  })

  it('Back on "Exit OpenVolley?" itself is Stay', async () => {
    const { win, exitApp } = androidWin()
    installAppLifecycle({ win, ask: askConfirm })
    win.__ovAndroidBack()
    await flush()
    expect(getConfirmSnapshot()).toMatchObject({ title: 'Exit OpenVolley?' })
    expect(win.__ovAndroidBack()).toBe(true)
    await flush()
    expect(getConfirmSnapshot()).toBeNull()
    expect(exitApp).not.toHaveBeenCalled()
    // and the next Back asks again
    win.__ovAndroidBack()
    await flush()
    expect(getConfirmSnapshot()).toMatchObject({ title: 'Exit OpenVolley?' })
    settleConfirm(getConfirmSnapshot().id, false)
  })

  it('Back closes an open modal (its × or Escape) instead of asking to exit', () => {
    const { win } = androidWin()
    win.document = document
    win.KeyboardEvent = KeyboardEvent
    const ask = vi.fn().mockResolvedValue(false)
    installAppLifecycle({ win, ask })

    // a legacy modal with its × (components/Modal.jsx)
    const legacy = document.createElement('div')
    legacy.innerHTML = '<div role="dialog" aria-modal="true"><button data-modal-close="">×</button></div>'
    document.body.appendChild(legacy)
    const close = vi.fn()
    legacy.querySelector('button').addEventListener('click', close)
    expect(win.__ovAndroidBack()).toBe(true)
    expect(close).toHaveBeenCalledTimes(1)
    legacy.remove()

    // a kit modal: Escape
    const kit = document.createElement('div')
    kit.innerHTML = '<div role="dialog" aria-modal="true"><p>Substitution</p></div>'
    document.body.appendChild(kit)
    const keys = []
    const onKey = (e) => keys.push(e.key)
    document.addEventListener('keydown', onKey)
    expect(win.__ovAndroidBack()).toBe(true)
    expect(keys).toEqual(['Escape'])
    document.removeEventListener('keydown', onKey)
    kit.remove()

    expect(ask).not.toHaveBeenCalled()
    // nothing open: it asks
    expect(win.__ovAndroidBack()).toBe(true)
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Exit OpenVolley?' }))
  })

  it('a second Back while it asks does not stack questions', async () => {
    const { win } = androidWin()
    const ask = vi.fn(() => new Promise(() => {}))
    installAppLifecycle({ win, ask })
    win.__ovAndroidBack()
    expect(win.__ovAndroidBack()).toBe(true)
    expect(ask).toHaveBeenCalledTimes(1)
  })
})

describe('browser', () => {
  function unload(win) {
    const event = new Event('beforeunload', { cancelable: true })
    win.dispatchEvent(event)
    return event.defaultPrevented
  }

  it('asks before leaving a live match only', () => {
    const win = new EventTarget()
    win.location = { href: 'https://app.openvolley.app/', origin: 'https://app.openvolley.app' }
    const uninstall = installAppLifecycle({ win })
    expect(unload(win)).toBe(false)
    setLiveMatch('official')
    expect(unload(win)).toBe(true)
    setLiveMatch('test')
    expect(unload(win)).toBe(true)
    // the app's own reloads (update, restore) do not ask
    allowLeaving()
    expect(unload(win)).toBe(false)
    uninstall()
  })

  it('not in the Electron build (a cancelled unload there closes nothing, silently)', () => {
    const win = new EventTarget()
    win.location = { href: 'http://localhost:5173/', origin: 'http://localhost:5173' }
    win.electronAPI = {}
    installAppLifecycle({ win })
    setLiveMatch('official')
    expect(unload(win)).toBe(false)
  })
})
