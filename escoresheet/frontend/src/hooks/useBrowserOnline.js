import { useEffect, useState } from 'react'

/**
 * navigator.onLine, following the online / offline events (no request: what
 * the device says about its connection). For a line such as Match Setup's
 * "Offline" beside a server check; never a reason to wait.
 */
export function useBrowserOnline () {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false)
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return online
}
