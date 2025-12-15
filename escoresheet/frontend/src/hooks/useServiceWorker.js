import { useState, useEffect, useCallback } from 'react'

/**
 * Hook to detect service worker updates and provide update functionality
 * Works with vite-plugin-pwa in 'prompt' mode
 */
export function useServiceWorker() {
  const [needRefresh, setNeedRefresh] = useState(false)
  const [offlineReady, setOfflineReady] = useState(false)
  const [registration, setRegistration] = useState(null)

  useEffect(() => {
    // Check if service worker is supported
    if (!('serviceWorker' in navigator)) {
      return
    }

    let refreshing = false

    // Listen for controller change (new SW activated)
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return
      refreshing = true
      window.location.reload()
    })

    // Check for existing registration
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (!reg) return

      setRegistration(reg)

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
      reg.addEventListener('updatefound', () => {
        if (reg.installing) {
          trackInstalling(reg.installing)
        }
      })
    })

    function trackInstalling(worker) {
      worker.addEventListener('statechange', () => {
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

    // Check for updates periodically (every 5 minutes)
    const intervalId = setInterval(() => {
      navigator.serviceWorker.getRegistration().then((reg) => {
        if (reg) {
          reg.update().catch(console.error)
        }
      })
    }, 5 * 60 * 1000)

    return () => clearInterval(intervalId)
  }, [])

  /**
   * Clear all caches and reload with the new version
   */
  const updateServiceWorker = useCallback(async (clearIndexedDB = false) => {
    try {
      // Clear all caches
      if ('caches' in window) {
        const cacheNames = await caches.keys()
        await Promise.all(
          cacheNames.map((cacheName) => caches.delete(cacheName))
        )
        console.log('[SW] Cleared all caches')
      }

      // Optionally clear IndexedDB
      if (clearIndexedDB) {
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

      // Tell waiting service worker to skip waiting and activate
      if (registration?.waiting) {
        registration.waiting.postMessage({ type: 'SKIP_WAITING' })
      }

      // Force reload from server (bypass cache)
      window.location.reload()
    } catch (error) {
      console.error('[SW] Update error:', error)
      // Still reload even if cache clearing fails
      window.location.reload()
    }
  }, [registration])

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
