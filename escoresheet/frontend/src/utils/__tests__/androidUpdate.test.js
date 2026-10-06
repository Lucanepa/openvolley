import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Capacitor's plugin proxy answers every property, `then` too
const core = vi.hoisted(() => {
  const plugin = {
    then: () => { throw new Error('the plugin proxy was resolved as a promise') },
    getInstallSource: async () => ({ family: 'sideload' }),
  }
  return { plugin, registerPlugin: vi.fn(() => plugin) }
})
vi.mock('@capacitor/core', () => ({ registerPlugin: core.registerPlugin }))
import index from './fixtures/fdroid-index-v2.json'
import {
  CHECK_INTERVAL_MS,
  DEFAULT_INDEX_URL,
  FDROID_REPO_LINK,
  FDROID_REPO_WEB,
  LAST_CHECK_KEY,
  NOTIFY_KEY,
  RETRY_AFTER_FAILURE_MS,
  checkAndroidUpdate,
  checkDue,
  dismissAndroidUpdate,
  downloadApk,
  familyOf,
  getAndroidUpdateSnapshot,
  getFromFdroid,
  installAndroidUpdates,
  isAndroidApp,
  isNewer,
  lastCheckAfterFailure,
  latestFromIndex,
  liveMatchKnown,
  openInFdroid,
  readNotify,
  repoBaseOf,
  resetAndroidUpdateForTests,
  setUpdateNotify,
  versionCode,
} from '../androidUpdate'
import { onLiveMatchChange, resetAppLifecycleForTests, setLiveMatch } from '../appLifecycle'
import en from '../../i18n/locales/en.json'
import de from '../../i18n/locales/de.json'
import deCH from '../../i18n/locales/de-CH.json'
import fr from '../../i18n/locales/fr.json'
import it_ from '../../i18n/locales/it.json'

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

/** The index with one more version on top (what a new release publishes). */
function indexWith(versionName, code) {
  const copy = structuredClone(index)
  copy.packages['com.openvolley.escoresheet'].versions.newest = {
    file: { name: `/com.openvolley.escoresheet_${code}.apk`, sha256: 'x', size: 1 },
    manifest: { versionName, versionCode: code },
  }
  return copy
}

describe('versionCode / isNewer', () => {
  it('follows build.gradle without the build digit', () => {
    expect(versionCode('2.1.0')).toBe(20010000)
    expect(versionCode('1.48.19')).toBe(10480190)
    expect(versionCode('2.2.0-test1')).toBe(20020000)
    expect(versionCode('dev')).toBe(0)
  })

  it('without the installed code: ignores the build digit and compares MAJOR.MINOR.PATCH', () => {
    expect(isNewer({ versionCode: 20020000 }, '2.1.1')).toBe(true)
    expect(isNewer({ versionCode: 20010019 }, '2.1.1')).toBe(false) // 2.1.1 build 9
    expect(isNewer({ versionCode: 20010000 }, '2.1.1')).toBe(false)
    expect(isNewer(null, '2.1.1')).toBe(false)
    expect(isNewer({ versionCode: 20020001 }, '2.2.0', null)).toBe(false)
  })

  it('with the installed code: an Android-only rebuild (build digit +1) is newer', () => {
    expect(isNewer({ versionCode: 20020001 }, '2.2.0', 20020000)).toBe(true)
    expect(isNewer({ versionCode: 20020000 }, '2.2.0', 20020000)).toBe(false)
    expect(isNewer({ versionCode: 20020000 }, '2.2.0', 20020001)).toBe(false)
    expect(isNewer({ versionCode: 20030000 }, '2.2.0', 20020001)).toBe(true)
  })
})

describe('latestFromIndex', () => {
  it('picks the highest versionCode of the app in the real index', () => {
    expect(latestFromIndex(index)).toEqual({
      versionName: '2.1.0',
      versionCode: 20010000,
      apkUrl: 'https://get.openvolley.app/fdroid/repo/com.openvolley.escoresheet_20010000.apk',
    })
  })

  it('builds the APK URL from the index it read', () => {
    const local = 'http://10.0.2.2:8765/fdroid/repo/index-v2.json'
    expect(repoBaseOf(local)).toBe('http://10.0.2.2:8765/fdroid/repo')
    expect(latestFromIndex(indexWith('2.2.0', 20020000), { indexUrl: local }).apkUrl)
      .toBe('http://10.0.2.2:8765/fdroid/repo/com.openvolley.escoresheet_20020000.apk')
  })

  it('skips malformed entries and answers null without the app', () => {
    const bad = structuredClone(index)
    const versions = bad.packages['com.openvolley.escoresheet'].versions
    versions.evil = { file: { name: '/../../x.apk' }, manifest: { versionName: '9.9.9', versionCode: 90090000 } }
    versions.text = { file: { name: '/a.apk' }, manifest: { versionName: '9.9.9', versionCode: '90090000' } }
    expect(latestFromIndex(bad).versionName).toBe('2.1.0')
    expect(latestFromIndex({ packages: {} })).toBeNull()
    expect(latestFromIndex(null)).toBeNull()
  })
})

describe('familyOf', () => {
  it.each([
    [{ installer: 'org.fdroid.fdroid' }, 'fdroid'],
    [{ installer: 'org.fdroid.basic' }, 'fdroid'],
    [{ installer: 'com.looker.droidify' }, 'fdroid'],
    [{ installer: 'com.google.android.packageinstaller', updateOwner: 'org.fdroid.fdroid' }, 'fdroid'],
    [{ installer: null }, 'sideload'],
    [{ installer: 'com.google.android.packageinstaller' }, 'sideload'],
    [{ installer: 'com.android.packageinstaller' }, 'sideload'],
    [{ installer: 'com.android.vending' }, 'other'],
  ])('%o → %s', (src, family) => {
    expect(familyOf(src)).toBe(family)
  })
})

describe('checkDue', () => {
  const now = 1_000_000_000_000
  it('at most once per 24 h', () => {
    expect(checkDue(now, 0)).toBe(true)
    expect(checkDue(now, now - CHECK_INTERVAL_MS + 1)).toBe(false)
    expect(checkDue(now, now - CHECK_INTERVAL_MS)).toBe(true)
    expect(checkDue(now, now + 60_000)).toBe(true) // the clock went back
  })

  it('after a failure: due again in an hour, not a day', () => {
    const last = lastCheckAfterFailure(now, 0)
    expect(checkDue(now + RETRY_AFTER_FAILURE_MS - 1, last)).toBe(false)
    expect(checkDue(now + RETRY_AFTER_FAILURE_MS, last)).toBe(true)
    // a success 10 min ago already scheduled the next check later: kept
    const ok = now - 10 * 60_000
    expect(lastCheckAfterFailure(now, ok)).toBe(ok)
    // a success 23.5 h ago: the retry comes later than its 24 h mark
    const old = now - CHECK_INTERVAL_MS + 30 * 60_000
    expect(lastCheckAfterFailure(now, old)).toBe(now - CHECK_INTERVAL_MS + RETRY_AFTER_FAILURE_MS)
  })
})

describe('the controller in the Android app', () => {
  let win
  let plugin
  let fetchImpl
  let clock

  function androidWin() {
    const w = new EventTarget()
    w.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' }
    w.document = document
    w.localStorage = localStorage
    return w
  }

  // App.jsx: installAndroidUpdates, then liveMatchKnown once its live-match
  // query has answered
  function start(family, body = indexWith('2.2.0', 20020000), { known = true, source = {} } = {}) {
    plugin = {
      getInstallSource: vi.fn(async () => ({ installer: null, updateOwner: null, family, ...source })),
      openStore: vi.fn(async () => ({ opened: true })),
    }
    fetchImpl = vi.fn(async () => ({ ok: true, json: async () => body }))
    const stop = installAndroidUpdates({ win, plugin, fetchImpl, now: () => clock })
    if (known) liveMatchKnown()
    return stop
  }

  beforeEach(() => {
    resetAndroidUpdateForTests()
    resetAppLifecycleForTests()
    localStorage.clear()
    win = androidWin()
    clock = 1_000_000_000_000
  })
  afterEach(() => {
    resetAndroidUpdateForTests()
  })

  it('does nothing outside the Android app', () => {
    expect(isAndroidApp(new EventTarget())).toBe(false)
    const ios = androidWin()
    ios.Capacitor.getPlatform = () => 'ios'
    installAndroidUpdates({ win: ios, plugin: {}, fetchImpl: vi.fn() })
    expect(getAndroidUpdateSnapshot().active).toBe(false)
  })

  it('installed by F-Droid: never asks, never fetches on its own', async () => {
    const stop = start('fdroid')
    await flush()
    win.dispatchEvent(new Event('ov-signed-in'))
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(getAndroidUpdateSnapshot()).toMatchObject({ active: true, family: 'fdroid', asking: false })
    expect(fetchImpl).not.toHaveBeenCalled()
    // the user may still ask
    await checkAndroidUpdate()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(getAndroidUpdateSnapshot()).toMatchObject({ status: 'available', latest: { versionName: '2.2.0' } })
    await openInFdroid()
    expect(plugin.openStore).toHaveBeenCalledWith({ fallbackUrl: 'https://get.openvolley.app/' })
    stop()
  })

  it('sideloaded: asks once, nothing is fetched before a yes', async () => {
    const stop = start('sideload')
    await flush()
    expect(getAndroidUpdateSnapshot()).toMatchObject({ family: 'sideload', notify: 'unset', asking: true })
    win.dispatchEvent(new Event('ov-signed-in'))
    await flush()
    expect(fetchImpl).not.toHaveBeenCalled()

    setUpdateNotify(false)
    expect(localStorage.getItem(NOTIFY_KEY)).toBe('no')
    expect(getAndroidUpdateSnapshot().asking).toBe(false)
    stop()

    // the next start: the answer holds, no question, no fetch
    start('sideload')
    await flush()
    expect(getAndroidUpdateSnapshot()).toMatchObject({ notify: 'no', asking: false })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sideloaded with yes: checks at most once per 24 h', async () => {
    const stop = start('sideload')
    await flush()
    setUpdateNotify(true)
    await flush()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith(DEFAULT_INDEX_URL, expect.objectContaining({ credentials: 'omit', cache: 'no-store' }))
    expect(Number(localStorage.getItem(LAST_CHECK_KEY))).toBe(clock)
    expect(getAndroidUpdateSnapshot()).toMatchObject({ status: 'available', latest: { versionName: '2.2.0' } })

    // back to the foreground, a sign-in: throttled
    clock += 60 * 60 * 1000
    document.dispatchEvent(new Event('visibilitychange'))
    win.dispatchEvent(new Event('ov-signed-in'))
    await flush()
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    clock += CHECK_INTERVAL_MS
    win.dispatchEvent(new Event('ov-signed-in'))
    await flush()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    stop()
  })

  it('never checks automatically during a live match; checks once it ends', async () => {
    localStorage.setItem(NOTIFY_KEY, 'yes')
    setLiveMatch('official')
    const stop = start('sideload')
    await flush()
    win.dispatchEvent(new Event('ov-signed-in'))
    await flush()
    expect(fetchImpl).not.toHaveBeenCalled()
    setLiveMatch('none')
    await flush()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    stop()
  })

  it('waits for the live match to be known at start (restart mid-match)', async () => {
    localStorage.setItem(NOTIFY_KEY, 'yes')
    // the install source answers before App.jsx's live query
    const stop = start('sideload', undefined, { known: false })
    await flush()
    expect(getAndroidUpdateSnapshot().family).toBe('sideload')
    win.dispatchEvent(new Event('ov-signed-in'))
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(fetchImpl).not.toHaveBeenCalled()
    // the query finds the live match: still nothing
    setLiveMatch('official')
    liveMatchKnown()
    await flush()
    expect(fetchImpl).not.toHaveBeenCalled()
    setLiveMatch('none')
    await flush()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    stop()
  })

  it('checks as soon as the live match is known to be none', async () => {
    localStorage.setItem(NOTIFY_KEY, 'yes')
    const stop = start('sideload', undefined, { known: false })
    await flush()
    expect(fetchImpl).not.toHaveBeenCalled()
    liveMatchKnown()
    await flush()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    stop()
  })

  it('a failed check is retried an hour later, not a day later', async () => {
    localStorage.setItem(NOTIFY_KEY, 'yes')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stop = start('sideload')
    fetchImpl.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await flush()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(getAndroidUpdateSnapshot().status).toBe('failed')
    // a failure does not count as a check for the 24 h throttle
    expect(Number(localStorage.getItem(LAST_CHECK_KEY))).toBeLessThan(clock - CHECK_INTERVAL_MS + 2 * RETRY_AFTER_FAILURE_MS)

    clock += 10 * 60 * 1000
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    clock += 50 * 60 * 1000 // an hour after the failure
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(getAndroidUpdateSnapshot().status).toBe('available')
    expect(Number(localStorage.getItem(LAST_CHECK_KEY))).toBe(clock)
    warn.mockRestore()
    stop()
  })

  it('never checks offline; checks when the device is back online', async () => {
    localStorage.setItem(NOTIFY_KEY, 'yes')
    win.navigator = { onLine: false }
    const stop = start('sideload')
    await flush()
    win.dispatchEvent(new Event('ov-signed-in'))
    await flush()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(localStorage.getItem(LAST_CHECK_KEY)).toBeNull()
    win.navigator.onLine = true
    win.dispatchEvent(new Event('online'))
    await flush()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    stop()
  })

  it('announces an Android-only rebuild by the installed versionCode', async () => {
    localStorage.setItem(NOTIFY_KEY, 'yes')
    // installed 2.2.0 build 0, the repo has 2.2.0 build 1
    let stop = start('sideload', indexWith('2.2.0', 20020001), { source: { versionCode: 20020000 } })
    await flush()
    expect(getAndroidUpdateSnapshot()).toMatchObject({ installedCode: 20020000, status: 'available' })
    stop()
    // the same build installed: up to date
    resetAndroidUpdateForTests()
    stop = start('sideload', indexWith('2.2.0', 20020001), { source: { versionCode: 20020001 } })
    await flush()
    expect(getAndroidUpdateSnapshot().installedCode).toBe(20020001)
    await checkAndroidUpdate()
    expect(getAndroidUpdateSnapshot().status).toBe('upToDate')
    stop()
  })

  it('a failed check keeps the app running and is reported', async () => {
    localStorage.setItem(NOTIFY_KEY, 'yes')
    start('sideload')
    fetchImpl.mockRejectedValue(new TypeError('Failed to fetch'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await flush()
    expect(getAndroidUpdateSnapshot().status).toBe('failed')
    warn.mockRestore()
  })

  it('up to date when the index has nothing newer', async () => {
    start('fdroid', index)
    await flush()
    await checkAndroidUpdate()
    // vitest's __APP_VERSION__ is 0.0.0-test: the real index is newer
    expect(getAndroidUpdateSnapshot().status).toBe('available')
    start('fdroid', { packages: { 'com.openvolley.escoresheet': { versions: {} } } })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await checkAndroidUpdate()
    expect(getAndroidUpdateSnapshot().status).toBe('failed')
    warn.mockRestore()
  })

  it('Later hides that version; the links go to F-Droid or the APK', async () => {
    localStorage.setItem(NOTIFY_KEY, 'yes')
    start('sideload')
    await flush()
    dismissAndroidUpdate()
    expect(getAndroidUpdateSnapshot().dismissed).toBe('2.2.0')
    await getFromFdroid()
    expect(plugin.openStore).toHaveBeenLastCalledWith({ url: FDROID_REPO_LINK, fallbackUrl: FDROID_REPO_WEB })
    await downloadApk()
    expect(plugin.openStore).toHaveBeenLastCalledWith({
      url: 'https://get.openvolley.app/fdroid/repo/com.openvolley.escoresheet_20020000.apk',
      fallbackUrl: 'https://get.openvolley.app/',
    })
  })

  it('an unknown install source never checks on its own', async () => {
    localStorage.setItem(NOTIFY_KEY, 'yes')
    plugin = { getInstallSource: vi.fn(async () => { throw new Error('not implemented') }) }
    fetchImpl = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    installAndroidUpdates({ win, plugin, fetchImpl, now: () => clock })
    await flush()
    expect(getAndroidUpdateSnapshot()).toMatchObject({ family: 'unknown', asking: false })
    expect(fetchImpl).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('registers the plugin through @capacitor/core when it is not loaded yet', async () => {
    // the native bridge's window.Capacitor has no registerPlugin before
    // @capacitor/core is imported (the app imports it lazily)
    installAndroidUpdates({ win, fetchImpl: vi.fn(), now: () => clock })
    await flush()
    expect(core.registerPlugin).toHaveBeenCalledWith('UpdateSource')
    expect(getAndroidUpdateSnapshot()).toMatchObject({ family: 'sideload', asking: true })
  })

  it('reads a blocked storage as never asked', () => {
    expect(readNotify({ getItem: () => { throw new Error('blocked') } })).toBe('unset')
    expect(readNotify(null)).toBe('unset')
  })
})

describe('texts', () => {
  const locales = { en, de, 'de-CH': deCH, fr, it: it_ }
  const keys = Object.keys(en.androidUpdate).sort()

  it.each(Object.keys(locales))('%s has every androidUpdate text', (lng) => {
    expect(Object.keys(locales[lng].androidUpdate).sort()).toEqual(keys)
    for (const key of keys) expect(locales[lng].androidUpdate[key]).toMatch(/\S/)
  })
})

describe('onLiveMatchChange', () => {
  it('one listener subscribed twice keeps the second subscription', () => {
    resetAppLifecycleForTests()
    const seen = []
    const listener = (v) => seen.push(v)
    const off1 = onLiveMatchChange(listener)
    const off2 = onLiveMatchChange(listener)
    off1()
    setLiveMatch('test')
    expect(seen).toEqual(['test'])
    off2()
    setLiveMatch('none')
    expect(seen).toEqual(['test'])
  })
})
