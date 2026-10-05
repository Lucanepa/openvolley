import { useState, useEffect, useCallback } from 'react'

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

/**
 * Activate the waiting service worker and reload this tab with it.
 *
 * Only this tab reloads: other tabs of the origin (e.g. a scorer mid-match next
 * to a livescore window) keep running and are never reloaded by this.
 * Caches are NOT wiped and no worker is unregistered - the new worker is already
 * fully precached, and Workbox drops outdated precache entries on activate, so
 * the app still loads offline right after the update.
 */
export async function applyServiceWorkerUpdate({ clearIndexedDB = false, timeoutMs = 4000 } = {}) {
  const reload = () => window.location.replace(buildReloadUrl())
  try {
    if (clearIndexedDB) await deleteAllIndexedDB()

    const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : null
    const reg = sw ? await sw.getRegistration() : null
    const waiting = reg?.waiting
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
    // the tab that asked for the update.

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

      // If there's a waiting worker, an update is available
      if (reg.waiting) {
        setNeedRefresh(true)
        return
      }

      // If there's an installing worker, wait for it
      if (reg.installing) {
        trackInstalling(reg.installing)
        return
      }

      // Listen for new updates
      reg.addEventListener('updatefound', onUpdateFound)
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
   * Activate the waiting worker and reload this tab (URL query kept)
   */
  const updateServiceWorker = useCallback((clearIndexedDB = false) => {
    return applyServiceWorkerUpdate({ clearIndexedDB })
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
