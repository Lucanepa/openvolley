import { useEffect, useState } from 'react'
import { getCloudApiBaseUrl, isLanBackendUrl } from '../utils/backendConfig'
import { measureInternet, TOTAL_BUDGET_MS } from '../utils/internetCheck'

// A check still open this long after its start reads 'not_checked': the row
// never holds the start-up dialog's heading and countdown (measureInternet
// ends every request by TOTAL_BUDGET_MS, this is the guard on top)
const WATCHDOG_MS = TOTAL_BUDGET_MS + 1500

/**
 * The server the internet is measured to: the cloud API (getCloudApiBaseUrl),
 * the server the cloud sync talks to. None when this page has no cloud (a
 * page a venue relay serves to the hall network, a self-hosted server on the
 * LAN, a dev build without its test backend): the venue there runs without
 * the internet, so there is nothing to measure.
 * @returns {string|null}
 */
export function internetCheckBaseUrl() {
  try {
    const base = getCloudApiBaseUrl()
    if (!base || isLanBackendUrl(base)) return null
    return base
  } catch {
    return null
  }
}

/**
 * The "Internet" row of the start-up connection check: measured once each
 * time `active` turns true (the dialog opens), aborted when it turns false
 * (the dialog closed: no more data is fetched). Never stored.
 * @param {boolean} active
 * @param {{ measure?: typeof measureInternet, baseUrl?: () => string|null }} [deps] for tests
 * @returns {{ status: string, rttMs?: number|null, mbps?: number|null, saveData?: boolean, noAnswerMs?: number|null }}
 */
export function useInternetCheck(active, { measure = measureInternet, baseUrl = internetCheckBaseUrl } = {}) {
  const [internet, setInternet] = useState({ status: 'unknown' })

  useEffect(() => {
    if (!active) return undefined
    const controller = new AbortController()
    let settled = false
    const settle = (value) => {
      if (settled || controller.signal.aborted) return
      settled = true
      setInternet(value)
    }
    setInternet({ status: 'connecting' })
    const watchdog = setTimeout(() => {
      settle({ status: 'not_checked' })
      controller.abort()
    }, WATCHDOG_MS)
    Promise.resolve()
      .then(() => measure({ baseUrl: baseUrl(), signal: controller.signal }))
      .then((result) => settle(result || { status: 'not_checked' }), () => settle({ status: 'not_checked' }))
      .finally(() => clearTimeout(watchdog))
    return () => {
      clearTimeout(watchdog)
      controller.abort()
    }
  }, [active, measure, baseUrl])

  return internet
}
