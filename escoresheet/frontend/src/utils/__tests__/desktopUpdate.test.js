import { beforeAll, describe, expect, it } from 'vitest'
import i18n from 'i18next'
import en from '../../i18n/locales/en.json'
import de from '../../i18n/locales/de.json'
import { blockerText, failureText, mainBlocker, noticeFor, statusLine } from '../desktopUpdate'

const t = (...args) => i18n.t(...args)

beforeAll(async () => {
  await i18n.init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, de: { translation: de } } })
})

const status = (over = {}) => ({
  kind: 'nsis',
  phase: 'ready',
  current: '2.2.0',
  available: { version: '2.2.1', notes: 'Fixes', date: '2026-10-20' },
  autoCheck: true,
  autoInstall: true,
  blockers: [],
  canRestart: true,
  manual: false,
  ...over,
})

describe('blockers, as the scorer reads them', () => {
  it('names each reason', () => {
    expect(blockerText({ kind: 'matchLive' }, t)).toBe('The update waits until the match is over.')
    expect(blockerText({ kind: 'tablets', count: 1 }, t)).toBe('The update waits until the tablet is disconnected.')
    expect(blockerText({ kind: 'tablets', count: 3 }, t)).toBe('The update waits until the 3 tablets are disconnected.')
    expect(blockerText({ kind: 'tabletNetwork' }, t)).toBe('The update waits until the tablet Wi-Fi is off.')
    expect(blockerText({ kind: 'pageNotReady' }, t)).toBe('The update waits until OpenVolley has finished loading.')
  })

  it('a live match is the reason given first', () => {
    expect(mainBlocker([{ kind: 'tabletNetwork' }, { kind: 'tablets', count: 2 }, { kind: 'matchLive' }])).toEqual({ kind: 'matchLive' })
    expect(mainBlocker([{ kind: 'tabletNetwork' }, { kind: 'tablets', count: 2 }])).toEqual({ kind: 'tablets', count: 2 })
    expect(mainBlocker([])).toBeNull()
    expect(mainBlocker(undefined)).toBeNull()
  })

  it('in the page language', async () => {
    await i18n.changeLanguage('de')
    expect(blockerText({ kind: 'tablets', count: 2 }, t)).toBe('Das Update wartet, bis die 2 Tablets getrennt sind.')
    expect(failureText('needsAdmin', t)).toContain('Administrators')
    await i18n.changeLanguage('en')
  })
})

describe('failures', () => {
  it('each code has a sentence; unknown ones say it did not install', () => {
    expect(failureText('checkFailed', t)).toMatch(/^Could not check for updates/)
    expect(failureText('downloadFailed', t)).toMatch(/^Could not download/)
    expect(failureText('needsAdmin', t)).toMatch(/administrator approval/)
    expect(failureText('noPkexec', t)).toBe('Install it in a terminal:')
    expect(failureText('aptFailed', t)).toBe('The update could not be installed.')
    expect(failureText(undefined, t)).toBe('The update could not be installed.')
  })
})

describe('the home screen notice', () => {
  it('ready with the gate open: offer the restart', () => {
    expect(noticeFor(status())).toEqual({ type: 'ready', version: '2.2.1' })
    expect(noticeFor(status({ kind: 'appImage' }))).toEqual({ type: 'ready', version: '2.2.1' })
    // macOS: the downloaded .app.tar.gz, like the AppImage
    expect(noticeFor(status({ kind: 'macApp' }))).toEqual({ type: 'ready', version: '2.2.1' })
  })

  it('ready while a match, a tablet or the tablet Wi-Fi is there: only the reason', () => {
    expect(noticeFor(status({ canRestart: false, blockers: [{ kind: 'matchLive' }] }))).toEqual({ type: 'blocked', version: '2.2.1' })
  })

  it('says nothing while checking, downloading or waiting, nor when up to date', () => {
    for (const phase of ['idle', 'checking', 'available', 'downloading', 'installing', 'upToDate', 'failed']) {
      expect(noticeFor(status({ phase })), phase).toBeNull()
    }
    expect(noticeFor(status({ available: null }))).toBeNull()
    expect(noticeFor(null)).toBeNull()
  })

  it('"Later" hides that version only', () => {
    expect(noticeFor(status(), { hidden: '2.2.1' })).toBeNull()
    expect(noticeFor(status(), { hidden: '2.2.0' })).toEqual({ type: 'ready', version: '2.2.1' })
  })

  it('Linux deb: quiet while APT installs it, then "Restart to finish"', () => {
    expect(noticeFor(status({ kind: 'debApt', phase: 'ready' }))).toBeNull()
    expect(noticeFor(status({ kind: 'debApt', phase: 'restartPending' }))).toEqual({ type: 'restartPending', version: '2.2.1' })
    expect(noticeFor(status({ kind: 'debApt', phase: 'restartPending', canRestart: false }))).toEqual({ type: 'blocked', version: '2.2.1' })
    // installed by hand: how to add the repo
    expect(noticeFor(status({ kind: 'debNoRepo', canRestart: false }))).toEqual({ type: 'noRepo', version: '2.2.1' })
  })

  it('a development build shows nothing', () => {
    expect(noticeFor(status({ kind: 'unsupported' }))).toBeNull()
  })
})

describe('the status line in Options', () => {
  it('follows the phase', () => {
    expect(statusLine(status({ phase: 'upToDate', available: null }), t)).toBe('You have the latest version.')
    expect(statusLine(status({ phase: 'available' }), t)).toBe('Update 2.2.1 downloads after the match.')
    expect(statusLine(status({ phase: 'downloading', got: 25, total: 100 }), t)).toBe('Downloading update 2.2.1… 25%')
    expect(statusLine(status({ phase: 'downloading', got: 25, total: null }), t)).toBe('Downloading update 2.2.1…')
    expect(statusLine(status(), t)).toBe('Update 2.2.1 is ready')
    expect(statusLine(status({ kind: 'debApt' }), t)).toBe('Update 2.2.1 is ready · It installs in the background.')
    expect(statusLine(status({ phase: 'restartPending' }), t)).toBe('Restart to finish the update to 2.2.1')
    expect(statusLine(status({ phase: 'installing' }), t)).toBe('Installing update…')
  })

  it('a failed automatic check stays quiet; a failed manual one is shown', () => {
    expect(statusLine(status({ phase: 'failed', msg: 'checkFailed', manual: false }), t)).toBe('')
    expect(statusLine(status({ phase: 'failed', msg: 'checkFailed', manual: true }), t)).toMatch(/^Could not check/)
    expect(statusLine(status({ phase: 'failed', msg: 'needsAdmin', manual: false }), t)).toMatch(/administrator/)
  })
})
