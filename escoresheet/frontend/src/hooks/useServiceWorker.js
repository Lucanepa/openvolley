import { useState, useEffect, useCallback, useSyncExternalStore } from 'react'
import { allowLeaving } from '../utils/leaveGuard'
import { reloadWithReason } from '../diagnostics/reload'
import { clearStorageKeepingDeviceId } from '../utils/deviceId'
import { writeSessionMirror } from '../lib/sessionMirror'
import { UPDATE_NEEDED_FILES, appUpdateNeeded, noteAppUpdateNeeded, subscribeAppUpdateNeeded } from '../utils/appUpdate'
import { toast } from '../ui/uiStore.js'
import i18next from 'i18next'

const CACHE_BUST_PARAM = 'cache_bust'

/**
 * URL to reload the current page with: keeps the path, every query param
 * (?match=&team=&server= attach referee/bench/livescore tablets to the live
 * match) and the hash, and only adds/replaces cache_bust.
 */
export function buildReloadUrl(href = window.location.href, now = Date.now()) {
  const url = new URL(href)
  url.searchParams.set(CACHE_BUST_PARAM, String(now))
  return url.toString()
}

/**
 * Remove only the cache_bust param added by the update / clear-cache reload,
 * keeping the rest of the query string. Called from the *-main.jsx entries.
 */
export function stripCacheBustParam() {
  try {
    const url = new URL(window.location.href)
    if (!url.searchParams.has(CACHE_BUST_PARAM)) return
    url.searchParams.delete(CACHE_BUST_PARAM)
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
  } catch {
    // Never block app start on URL cleanup
  }
}

async function deleteAllIndexedDB() {
  if (!indexedDB.databases) return
  const databases = await indexedDB.databases()
  await Promise.all(
    databases.map((db) => {
      return new Promise((resolve, reject) => {
        const req = indexedDB.deleteDatabase(db.name)
        req.onsuccess = () => {
          console.log(`[SW] Deleted IndexedDB: ${db.name}`)
          resolve()
        }
        req.onerror = () => reject(req.error)
        req.onblocked = () => {
          console.warn(`[SW] IndexedDB ${db.name} is blocked`)
          resolve()
        }
      })
    })
  )
  console.log('[SW] Cleared IndexedDB')
}

/** Resolves with the worker once it is installed (waiting), or null on failure/timeout. */
function waitUntilInstalled(worker, timeoutMs) {
  if (worker.state === 'installed') return Promise.resolve(worker)
  return new Promise((resolve) => {
    const done = (value) => {
      clearTimeout(timer)
      worker.removeEventListener('statechange', onState)
      resolve(value)
    }
    const onState = () => {
      if (worker.state === 'installed') done(worker)
      else if (worker.state === 'redundant' || worker.state === 'activated') done(null)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    worker.addEventListener('statechange', onState)
  })
}

/**
 * True when the server that serves this app answers. version.json is never
 * precached and matches no runtime route, so this really hits the network.
 */
export async function canReachAppServer(timeoutMs = 4000) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = setTimeout(() => controller?.abort(), timeoutMs)
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}version.json?t=${Date.now()}`, {
      cache: 'no-store',
      signal: controller?.signal
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Options > "Clear cache": delete every Cache Storage entry, unregister the
 * service workers and reload this page with its query kept (?match=&team=
 * keep a referee/bench tablet attached to the live match).
 *
 * Returns false WITHOUT touching anything when the app's server cannot be
 * reached: with the precache and the worker gone, the reload would have
 * nothing to load from, and the device would be stuck on a browser error page
 * for the rest of the match.
 */
export async function clearCachesAndReload({ includeLocalStorage = false } = {}) {
  if (!(await canReachAppServer())) return false
  if (typeof caches !== 'undefined') {
    const cacheNames = await caches.keys()
    await Promise.all(cacheNames.map((name) => caches.delete(name)))
  }
  if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
    const registrations = await navigator.serviceWorker.getRegistrations()
    await Promise.all(registrations.map((reg) => reg.unregister()))
  }
  // (this installation's id stays: the matches in IndexedDB stay too)
  if (includeLocalStorage) {
    clearStorageKeepingDeviceId()
    // and the session's IndexedDB copy goes with it: the reload would sign the
    // previous scorer back in from it (lib/apiClient restoreMirroredSession),
    // on a shared club laptop too
    await writeSessionMirror(null)
  }
  allowLeaving()
  reloadWithReason(includeLocalStorage ? 'clear-cache-and-storage' : 'clear-cache', { how: 'replace', url: buildReloadUrl() })
  return true
}

// --- Tabs of one origin -------------------------------------------------------
// Every tab of the origin runs under one service worker: SKIP_WAITING in one
// tab hands all of them to the new build, and the old build's files leave
// the cache with its precache. A tab that stays on the old code (a match in
// another tab or window) then fails its next lazy load: a language, the
// backup key, a passkey sign-in, the logs. So a tab asks the others on
// UPDATE_CHANNEL before it activates an update; one with a match on show
// answers (answerUpdateQuestions), and the update waits: that tab's Home
// screen offers it once the match is closed there.
export const UPDATE_CHANNEL = 'ov-app-update'
// How long a tab waits for the others' answers (a page in the background
// answers at once; a frozen one does not answer at all)
const UPDATE_ANSWER_MS = 300
// applyServiceWorkerUpdate's result when another tab has a match on show
export const UPDATE_DEFERRED = 'deferred'

let updateChannel
let answeringUpdates = false
// One channel per page, for asking and answering: a BroadcastChannel never
// hears its own messages, every other one of the name (other tabs) does
function pageUpdateChannel() {
  if (updateChannel !== undefined) return updateChannel
  try {
    updateChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(UPDATE_CHANNEL) : null
    // (Node, the tests: an open channel must not keep the process alive)
    updateChannel?.unref?.()
  } catch {
    updateChannel = null
  }
  return updateChannel
}

/**
 * This page answers the other tabs' "may I update?" (the scorer app,
 * main.jsx): `isBusy()` true while a match is on show here (readOpenMatch).
 * A page that needs the update itself ("Update needed", utils/appUpdate)
 * holds nobody back: its match cannot sync on the old build anyway.
 */
export function answerUpdateQuestions({ isBusy = () => false } = {}) {
  const channel = pageUpdateChannel()
  if (!channel || answeringUpdates) return
  answeringUpdates = true
  channel.addEventListener('message', (e) => {
    if (e.data?.type !== 'update-ask') return
    let busy = false
    try { busy = !!isBusy() && !appUpdateNeeded() } catch { busy = false }
    if (busy) channel.postMessage({ type: 'update-busy', id: e.data.id })
  })
}

/** Does another tab of the origin have a match on show? Asks, and waits UPDATE_ANSWER_MS for an answer. */
export function otherTabHasOpenMatch({ timeoutMs = UPDATE_ANSWER_MS } = {}) {
  const channel = pageUpdateChannel()
  if (!channel) return Promise.resolve(false)
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return new Promise((resolve) => {
    const done = (busy) => {
      clearTimeout(timer)
      channel.removeEventListener('message', onMessage)
      resolve(busy)
    }
    const onMessage = (e) => { if (e.data?.type === 'update-busy' && e.data.id === id) done(true) }
    const timer = setTimeout(() => done(false), timeoutMs)
    channel.addEventListener('message', onMessage)
    try {
      channel.postMessage({ type: 'update-ask', id })
    } catch {
      done(false)
    }
  })
}

/** Tests: forget this page's channel. */
export function resetUpdateChannelForTests() {
  try { updateChannel?.close() } catch { /* already closed */ }
  updateChannel = undefined
  answeringUpdates = false
}

/**
 * Activate the waiting service worker and reload this tab with it.
 *
 * Only this tab reloads. Activating the worker moves every other tab of the
 * origin to the new build's worker too (and the old build's files go with
 * the old precache), so a tab with a match on show is asked first
 * (otherTabHasOpenMatch): while one has, nothing is activated or cleared and
 * this resolves UPDATE_DEFERRED (a notice says why) instead of reloading.
 * Caches are NOT wiped and no worker is unregistered - the new worker is already
 * fully precached, and Workbox drops outdated precache entries on activate, so
 * the app still loads offline right after the update.
 */
export async function applyServiceWorkerUpdate({ clearIndexedDB = false, checkForUpdate = false, timeoutMs = 4000, askOtherTabs = otherTabHasOpenMatch, notify = true } = {}) {
  const reload = () => {
    allowLeaving()
    reloadWithReason(clearIndexedDB ? 'sw-update-clear-db' : 'sw-update', { how: 'replace', url: buildReloadUrl() })
  }
  try {
    const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : null
    const reg = sw ? await sw.getRegistration() : null
    // Options > "Update": the new worker may not even be downloaded yet. A plain
    // reload would keep the old active worker (skipWaiting is off) and serve the
    // old precached app, so fetch it and wait for it to finish installing.
    if (reg && checkForUpdate && !reg.waiting && !reg.installing) {
      await reg.update().catch(() => {})
    }
    const waiting = reg?.waiting || (reg?.installing ? await waitUntilInstalled(reg.installing, timeoutMs) : null)
    // What reaches the other tabs (a worker switched under them, their
    // database deleted) waits while one of them has a match on show
    if ((waiting || clearIndexedDB) && await askOtherTabs()) {
      // (`notify: false`: the caller says so itself, the update banner)
      const text = 'A match is open in another window of OpenVolley. The update waits until it is closed there.'
      if (notify) toast.info(i18next.t?.('update.waitsForOtherWindow', text) || text, { duration: 8000 })
      return UPDATE_DEFERRED
    }
    if (clearIndexedDB) await deleteAllIndexedDB()
    if (waiting) {
      // Wait for the new worker to take control before reloading, so the reload
      // is served by it (with a timeout in case controllerchange never fires).
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs)
        sw.addEventListener('controllerchange', () => {
          clearTimeout(timer)
          resolve()
        }, { once: true })
        waiting.postMessage({ type: 'SKIP_WAITING' })
      })
    }
  } catch (error) {
    console.error('[SW] Update error:', error)
  }
  reload()
}

// When this tab last applied an update on its own (applyUpdateAtStart, the
// desktop UpdateBanner): sessionStorage, so it survives the reload it causes
export const AUTO_UPDATE_KEY = 'ov.autoUpdateAt'
export const AUTO_UPDATE_WINDOW_MS = 120000

function sessionStore() {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null
  } catch {
    return null
  }
}

/**
 * May this tab apply an update on its own now? Not within
 * AUTO_UPDATE_WINDOW_MS of its last try: applyServiceWorkerUpdate reloads
 * after its timeout even when the new worker never took control, and the
 * reloaded page, still on the old build with the new one waiting, would try
 * again every few seconds. A second try falls back to the "Update available"
 * banner. Without sessionStorage it never does it on its own.
 */
export function autoApplyAllowed({ storage = sessionStore(), now = Date.now() } = {}) {
  if (!storage) return false
  try {
    const last = Number(storage.getItem(AUTO_UPDATE_KEY))
    return !(last > 0 && now - last >= 0 && now - last < AUTO_UPDATE_WINDOW_MS)
  } catch {
    return false
  }
}

/**
 * The page is about to reload into an update it applies on its own: no tap
 * may start anything on it now (a point or a new match half written when the
 * reload comes, up to applyServiceWorkerUpdate's timeout later).
 */
export function holdTapsUntilReload(win = typeof window !== 'undefined' ? window : undefined) {
  try {
    if (win?.document?.body) win.document.body.inert = true
    showUpdatingNotice(win)
  } catch {
    // never block the update
  }
}

/**
 * The update did not happen after all (UPDATE_DEFERRED: a match is open in
 * another tab): taps work again and the "Updating" notice goes.
 */
export function releaseTaps(win = typeof window !== 'undefined' ? window : undefined) {
  try {
    if (win?.document?.body) win.document.body.inert = false
    win?.document?.getElementById('ov-updating-notice')?.remove()
  } catch {
    // nothing to undo
  }
}

/**
 * "Updating OpenVolley…" over the page while it reloads into the new build
 * (owner 2026-11-11: a tap in those seconds did nothing, without a word).
 * Plain DOM next to <body> (which is inert by then), gone with the reload.
 */
export function showUpdatingNotice(win = typeof window !== 'undefined' ? window : undefined) {
  const doc = win?.document
  if (!doc?.documentElement || doc.getElementById('ov-updating-notice')) return
  const el = doc.createElement('div')
  el.id = 'ov-updating-notice'
  el.setAttribute('role', 'status')
  el.setAttribute('aria-live', 'polite')
  el.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(250,250,249,.82);font:600 18px/1.4 system-ui,sans-serif;color:#1c1917'
  const box = doc.createElement('div')
  box.style.cssText = 'padding:16px 22px;border-radius:14px;background:#fff;box-shadow:0 4px 24px rgba(0,0,0,.12)'
  box.textContent = i18next.t?.('update.reloading', 'Updating OpenVolley…') || 'Updating OpenVolley…'
  el.appendChild(box)
  doc.documentElement.appendChild(el)
}

/** This tab applies an update on its own now (see autoApplyAllowed). */
export function noteAutoApply({ storage = sessionStore(), now = Date.now() } = {}) {
  try {
    storage?.setItem(AUTO_UPDATE_KEY, String(now))
  } catch {
    // never block the update on storage
  }
}

/**
 * The desktop app at start (main.jsx calls this in its scoretable
 * window only). Its binary IS the update, but the page that just loaded is the
 * previous build, served by the service worker, with the new one installing
 * next to it (about a second). Until the scorer touches anything, the new
 * build is applied at once on whatever screen opened: a restored match reloads
 * into itself, where no update banner is ever shown. After a touch, or after
 * the grace time, the home screen's banner applies it instead.
 */
export function applyUpdateAtStart({
  win = window,
  sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : null,
  apply = () => applyServiceWorkerUpdate(),
  graceMs = 20000,
  allowed = () => autoApplyAllowed(),
  note = () => noteAutoApply()
} = {}) {
  if (!sw) return
  let open = true
  const close = () => {
    open = false
    clearTimeout(timer)
    win.removeEventListener('pointerdown', close, true)
    win.removeEventListener('keydown', close, true)
  }
  const timer = setTimeout(close, graceMs)
  win.addEventListener('pointerdown', close, true)
  win.addEventListener('keydown', close, true)
  // a first install (no controller yet) is no update; a second try within
  // a short time is a reload loop (autoApplyAllowed): the banner then asks
  const go = () => {
    if (!open || !sw.controller || !allowed()) return
    close()
    note()
    holdTapsUntilReload(win)
    // (another window has a match open: the home screen's banner asks later)
    Promise.resolve(apply()).then((r) => { if (r === UPDATE_DEFERRED) releaseTaps(win) }).catch(() => {})
  }
  const watch = (worker) => worker?.addEventListener('statechange', () => {
    if (worker.state === 'installed') go()
  })
  sw.getRegistration().then((reg) => {
    if (!reg || !open) return
    if (reg.waiting) return go()
    watch(reg.installing)
    reg.addEventListener('updatefound', () => watch(reg.installing))
  }).catch(() => {})
}

/**
 * Files of this build gone from the site (vite:preloadError: a lazy chunk,
 * after a newer version replaced it): the page needs the update
 * (utils/appUpdate 'files': the banner on the match screens too, the worker
 * looks for the newer build) and the scorer is told once to reload after the
 * rally. The failed import still fails for its caller (no preventDefault).
 * The scorer app, at start (main.jsx).
 */
let preloadNoticeInstalled = false
export function installPreloadErrorNotice(win = typeof window !== 'undefined' ? window : undefined) {
  if (!win?.addEventListener || preloadNoticeInstalled) return
  preloadNoticeInstalled = true
  let told = false
  win.addEventListener('vite:preloadError', () => {
    noteAppUpdateNeeded(UPDATE_NEEDED_FILES)
    if (told) return
    told = true
    const text = 'A part of OpenVolley could not be loaded: a newer version is out. Reload the app after this rally.'
    toast.info(i18next.t?.('update.reloadAfterRally', text) || text, { duration: 0 })
  })
}

/** Tests: install the notice again. */
export function resetPreloadErrorNoticeForTests() {
  preloadNoticeInstalled = false
}

/** Why this page needs an update ('server' | 'files', utils/appUpdate), or null; re-renders on a change. */
export function useAppUpdateNeeded() {
  return useSyncExternalStore(subscribeAppUpdateNeeded, appUpdateNeeded, appUpdateNeeded)
}

/**
 * Hook to detect service worker updates and provide update functionality
 * Works with vite-plugin-pwa in 'prompt' mode: a new worker stays waiting until
 * the user confirms, so an update never activates or reloads mid-match on its own.
 */
export function useServiceWorker() {
  const [needRefresh, setNeedRefresh] = useState(false)
  const [offlineReady, setOfflineReady] = useState(false)

  useEffect(() => {
    // Check if service worker is supported
    if (!('serviceWorker' in navigator)) {
      return
    }

    let cancelled = false
    let registration = null

    // No controllerchange -> reload listener here: with clientsClaim, a first
    // install or another tab's SKIP_WAITING would otherwise reload this page
    // (possibly the scorer mid-match). applyServiceWorkerUpdate() reloads only
    // the tab that asked for the update, and waits while another tab has a
    // match on show (otherTabHasOpenMatch).

    function trackInstalling(worker) {
      worker.addEventListener('statechange', () => {
        if (cancelled) return
        if (worker.state === 'installed') {
          if (navigator.serviceWorker.controller) {
            // New update available
            setNeedRefresh(true)
          } else {
            // First install - app is ready for offline
            setOfflineReady(true)
          }
        }
      })
    }

    function onUpdateFound() {
      if (registration?.installing) {
        trackInstalling(registration.installing)
      }
    }

    // Check for existing registration
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (!reg || cancelled) return
      registration = reg

      // Listen for new updates (always: an install in progress at mount must not
      // stop later updates in this session from being noticed)
      reg.addEventListener('updatefound', onUpdateFound)

      if (reg.waiting) {
        // A waiting worker means an update is available
        setNeedRefresh(true)
      } else if (reg.installing) {
        // An installing worker: wait for it
        trackInstalling(reg.installing)
      }
    }).catch(() => {})

    // Check for updates periodically (every 5 minutes)
    const intervalId = setInterval(() => {
      navigator.serviceWorker.getRegistration().then((reg) => {
        if (reg) {
          reg.update().catch(() => {}) // offline: nothing to do
        }
      }).catch(() => {})
    }, 5 * 60 * 1000)

    return () => {
      cancelled = true
      clearInterval(intervalId)
      registration?.removeEventListener('updatefound', onUpdateFound)
    }
  }, [])

  /**
   * Activate the waiting worker and reload this tab (URL query kept).
   * Resolves UPDATE_DEFERRED, without a notice, while another tab has a
   * match on show: the caller shows it.
   */
  const updateServiceWorker = useCallback((clearIndexedDB = false) => {
    return applyServiceWorkerUpdate({ clearIndexedDB, notify: false })
  }, [])

  /**
   * Dismiss the update notification
   */
  const dismissUpdate = useCallback(() => {
    setNeedRefresh(false)
  }, [])

  return {
    needRefresh,
    offlineReady,
    updateServiceWorker,
    dismissUpdate
  }
}

export default useServiceWorker
