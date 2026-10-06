/**
 * Updates of the Android app (ANDROID.md "Updates").
 *
 * F-Droid is the updater: on Android 12+ a client that installed the app
 * updates it in the background, with no prompt. The app never installs
 * anything itself (no REQUEST_INSTALL_PACKAGES) and there is one APK for
 * every channel, so the f-droid.org reproducible build stays valid. What
 * differs is decided at runtime, by who installed the app
 * (android/.../UpdateSourcePlugin.java):
 *
 * - an F-Droid client ('fdroid'): the app never asks the network on its own
 *   (no Tracking anti-feature). Options → App version has "Check for
 *   updates" (the user asks) and "Open in F-Droid".
 * - sideloaded ('sideload': the browser / a file manager / adb) or another
 *   store ('other'): the app asks once "Get notified about new versions?"
 *   (default off, Yes and No look the same). With yes it reads the public
 *   F-Droid index (index-v2.json, about 4 kB) at start, when it comes back to
 *   the foreground and at sign-in, at most once per 24 h, never during a live
 *   match. A newer version shows a notice on the home screen (never over the
 *   scoreboard): get it from F-Droid (it then updates itself) or download the
 *   APK.
 *
 * Nothing but the GET of the index is sent. The state lives in this module
 * (one controller per page, installAndroidUpdates in App.jsx); the notice and
 * the options read it through src/hooks/useAndroidUpdate.js.
 */

import { detectAppPlatform, isInAppView } from './openAppWindow.js'
import { getLiveMatch, onLiveMatchChange } from './appLifecycle.js'

export const APP_ID = 'com.openvolley.escoresheet'
export const REPO_URL = 'https://get.openvolley.app/fdroid/repo'
export const REPO_FINGERPRINT = '61C70F8949441E04E2E21ACC8E6E5C6CC502ADD52A157FB9A8DD8588DACE0720'
export const DEFAULT_INDEX_URL = `${REPO_URL}/index-v2.json`
// Testing only (a local copy of the index, ANDROID.md "Updates"): set on the
// command line of a debug build. Release builds (release-android.sh, the
// F-Droid recipe) never set it.
export const INDEX_URL = import.meta.env?.VITE_UPDATE_INDEX_URL || DEFAULT_INDEX_URL
/** Adds the repo in an installed F-Droid client. */
export const FDROID_REPO_LINK = `fdroidrepos://get.openvolley.app/fdroid/repo?fingerprint=${REPO_FINGERPRINT}`
/** The same in a browser (no F-Droid client yet: it explains how to get one). */
export const FDROID_REPO_WEB = `https://fdroid.link/#${REPO_URL}?fingerprint=${REPO_FINGERPRINT}`
export const INSTALL_PAGE = 'https://get.openvolley.app/'

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 15000

export const NOTIFY_KEY = 'ov.update.notify'
export const LAST_CHECK_KEY = 'ov.update.lastCheck'

// Keep in step with UpdateSourcePlugin.java
export const FDROID_INSTALLERS = [
  'org.fdroid.fdroid',
  'org.fdroid.basic',
  'org.fdroid.fdroid.privileged',
  'com.looker.droidify',
  'com.machiav3lli.fdroid',
]
export const SIDELOAD_INSTALLERS = [
  'com.google.android.packageinstaller',
  'com.android.packageinstaller',
  'com.android.shell',
]
const FAMILIES = new Set(['fdroid', 'sideload', 'other'])

const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'

// ---------------------------------------------------------------------------
// Plain data (tested)

/** 'fdroid' | 'sideload' | 'other' from the installer of record. */
export function familyOf({ installer = null, updateOwner = null } = {}) {
  if (FDROID_INSTALLERS.includes(updateOwner) || FDROID_INSTALLERS.includes(installer)) return 'fdroid'
  if (!installer || SIDELOAD_INSTALLERS.includes(installer)) return 'sideload'
  return 'other'
}

/**
 * The Android versionCode of a version name, without the build digit
 * (android/app/build.gradle: (MAJOR*1e6 + MINOR*1e3 + PATCH) * 10 + build).
 * 0 when it is not MAJOR.MINOR.PATCH.
 */
export function versionCode(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim())
  if (!m) return 0
  return (Number(m[1]) * 1000000 + Number(m[2]) * 1000 + Number(m[3])) * 10
}

/** The repo folder of an index URL (APK file names are relative to it). */
export function repoBaseOf(indexUrl) {
  return String(indexUrl).replace(/\/index-v2\.json(?:[?#].*)?$/, '')
}

/**
 * The newest version of the app in an F-Droid index-v2.json.
 * @returns {{versionName: string, versionCode: number, apkUrl: string} | null}
 */
export function latestFromIndex(json, { indexUrl = INDEX_URL, appId = APP_ID } = {}) {
  const versions = json?.packages?.[appId]?.versions
  if (!versions || typeof versions !== 'object') return null
  let best = null
  for (const entry of Object.values(versions)) {
    const code = entry?.manifest?.versionCode
    const name = entry?.manifest?.versionName
    const file = entry?.file?.name
    if (!Number.isSafeInteger(code) || code <= 0) continue
    if (typeof name !== 'string' || !/^\d+\.\d+\.\d+$/.test(name)) continue
    if (typeof file !== 'string' || !/^\/[A-Za-z0-9._-]+\.apk$/.test(file)) continue
    if (!best || code > best.versionCode) {
      best = { versionName: name, versionCode: code, apkUrl: repoBaseOf(indexUrl) + file }
    }
  }
  return best
}

/** latest is a newer release than the running app (the build digit is ignored). */
export function isNewer(latest, current = APP_VERSION) {
  if (!latest || !Number.isFinite(latest.versionCode)) return false
  return Math.floor(latest.versionCode / 10) > Math.floor(versionCode(current) / 10)
}

/** An automatic check is due: never checked, 24 h passed, or the clock went back. */
export function checkDue(now, last, interval = CHECK_INTERVAL_MS) {
  if (!Number.isFinite(last) || last <= 0) return true
  return now - last >= interval || now < last
}

// ---------------------------------------------------------------------------
// Preferences (localStorage; a blocked storage reads as "never asked")

function storageOf(win) {
  try {
    return win?.localStorage ?? null
  } catch {
    return null
  }
}

/** 'yes' | 'no' | 'unset' */
export function readNotify(storage) {
  try {
    const v = storage?.getItem(NOTIFY_KEY)
    return v === 'yes' || v === 'no' ? v : 'unset'
  } catch {
    return 'unset'
  }
}

function writeNotify(storage, value) {
  try {
    storage?.setItem(NOTIFY_KEY, value)
  } catch {
    // the answer then only lasts until the app restarts
  }
}

export function readLastCheck(storage) {
  try {
    return Number(storage?.getItem(LAST_CHECK_KEY)) || 0
  } catch {
    return 0
  }
}

function writeLastCheck(storage, at) {
  try {
    storage?.setItem(LAST_CHECK_KEY, String(at))
  } catch {
    // throttled for this run only
  }
}

// ---------------------------------------------------------------------------
// State, shared by the notice and the options

/**
 * active: running in the Android app
 * family: 'fdroid' | 'sideload' | 'other' | 'unknown' (null until known)
 * notify: the user's answer, 'yes' | 'no' | 'unset'
 * asking: the opt-in question is waiting for the home screen
 * status: 'idle' | 'checking' | 'upToDate' | 'available' | 'failed'
 * latest: the newest version seen ({versionName, versionCode, apkUrl})
 * dismissed: the version whose notice got "Later" (until the next start)
 */
const INITIAL = Object.freeze({
  active: false,
  family: null,
  notify: 'unset',
  asking: false,
  status: 'idle',
  latest: null,
  dismissed: null,
})

let state = INITIAL
const listeners = new Set()
let ctx = null

function update(patch) {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

export function subscribeAndroidUpdate(listener) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const getAndroidUpdateSnapshot = () => state

/** Running inside the Android app (not iOS, not a browser). */
export function isAndroidApp(win = typeof window !== 'undefined' ? window : undefined) {
  if (detectAppPlatform(win) !== 'capacitor') return false
  try {
    return win.Capacitor?.getPlatform?.() === 'android'
  } catch {
    return false
  }
}

function pluginOf(win) {
  const cap = win?.Capacitor
  if (typeof cap?.registerPlugin !== 'function') return null
  try {
    return cap.registerPlugin('UpdateSource')
  } catch {
    return null
  }
}

const autoFamily = (family) => family === 'sideload' || family === 'other'

/**
 * Read the index now. Manual checks (Options) run for every family, an
 * automatic one only after the user said yes.
 */
async function check() {
  if (!ctx) return state
  if (state.status === 'checking') return state
  const { storage, fetchImpl, now, indexUrl } = ctx
  update({ status: 'checking' })
  writeLastCheck(storage, now())
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null
  try {
    const res = await fetchImpl(indexUrl, {
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: controller?.signal,
    })
    if (!res.ok) throw new Error(`index ${res.status}`)
    const latest = latestFromIndex(await res.json(), { indexUrl })
    if (!latest) throw new Error('app not in the index')
    update({ status: isNewer(latest) ? 'available' : 'upToDate', latest })
  } catch (e) {
    console.warn('[update] check failed', e)
    update({ status: 'failed' })
  } finally {
    if (timer) clearTimeout(timer)
  }
  return state
}

async function autoCheck() {
  if (!ctx || !autoFamily(state.family) || state.notify !== 'yes') return
  if (getLiveMatch() !== 'none') return // again when the match ends
  if (!checkDue(ctx.now(), readLastCheck(ctx.storage))) return
  await check()
}

/** Options → "Check for updates". */
export function checkAndroidUpdate() {
  return check()
}

/** The opt-in question, or the options switch: 'yes' / 'no'. */
export function setUpdateNotify(yes) {
  const notify = yes ? 'yes' : 'no'
  if (ctx) writeNotify(ctx.storage, notify)
  update({ notify, asking: false })
  if (yes) void autoCheck()
}

/** "Later" on the notice: hidden for that version until the next start. */
export function dismissAndroidUpdate() {
  update({ dismissed: state.latest?.versionName ?? null })
}

async function openStore(opts) {
  const plugin = ctx?.plugin
  try {
    const res = await plugin?.openStore?.(opts)
    if (res?.opened) return true
  } catch (e) {
    console.warn('[update] openStore failed', e)
  }
  return false
}

/** The app's page in the F-Droid client that installed it. */
export function openInFdroid() {
  return openStore({ fallbackUrl: INSTALL_PAGE })
}

/** Add the OpenVolley repo in F-Droid (or the web page that explains it). */
export function getFromFdroid() {
  return openStore({ url: FDROID_REPO_LINK, fallbackUrl: FDROID_REPO_WEB })
}

/** The newest APK, in the browser (Android asks before it installs it). */
export function downloadApk() {
  const url = state.latest?.apkUrl
  if (!url) return Promise.resolve(false)
  return openStore({ url, fallbackUrl: INSTALL_PAGE })
}

/**
 * Start it for this page (App.jsx, once). A no-op outside the Android app
 * and inside its in-app view.
 * @returns {() => void} uninstall
 */
export function installAndroidUpdates({
  win = typeof window !== 'undefined' ? window : undefined,
  fetchImpl,
  plugin,
  now = () => Date.now(),
  indexUrl = INDEX_URL,
} = {}) {
  if (!win || isInAppView(win) || !isAndroidApp(win)) return () => {}
  const storage = storageOf(win)
  const doFetch = fetchImpl || ((...args) => win.fetch(...args))
  const me = { win, storage, fetchImpl: doFetch, plugin: plugin ?? pluginOf(win), now, indexUrl }
  ctx = me
  update({ active: true, notify: readNotify(storage) })

  let disposed = false
  const auto = () => { if (!disposed) void autoCheck() }
  const onVisible = () => { if (win.document?.visibilityState === 'visible') auto() }
  win.document?.addEventListener?.('visibilitychange', onVisible)
  win.addEventListener('ov-signed-in', auto)
  const offLive = onLiveMatchChange((live) => { if (live === 'none') auto() })

  Promise.resolve()
    .then(() => me.plugin?.getInstallSource?.())
    .then((src) => (FAMILIES.has(src?.family) ? src.family : src ? familyOf(src) : 'unknown'))
    .catch((e) => {
      console.warn('[update] install source unknown', e)
      return 'unknown'
    })
    .then((family) => {
      if (disposed) return
      update({ family, asking: autoFamily(family) && state.notify === 'unset' })
      auto()
    })

  return () => {
    disposed = true
    win.document?.removeEventListener?.('visibilitychange', onVisible)
    win.removeEventListener('ov-signed-in', auto)
    offLive()
    if (ctx === me) {
      ctx = null
      update({ active: false })
    }
  }
}

/** Tests: back to the initial state. */
export function resetAndroidUpdateForTests() {
  state = INITIAL
  listeners.clear()
  ctx = null
}
