import { useCallback, useSyncExternalStore } from 'react'
import { scoreboardDisplays } from '../../utils/scoreboardDisplay'
import { openAppWindow } from '../../utils/openAppWindow'

/**
 * The scoreboard display that follows the match of `relayKey`, as the relay
 * told the scorer (utils/scoreboardDisplay.js): { settingsUrl } while one
 * follows and named a page the scorer may open, else null. `open` shows that
 * page: a new tab in a browser, the system browser in the desktop and
 * Android apps (openAppWindow).
 * @param {string|null} relayKey
 * @param {{ store?: ReturnType<import('../../utils/scoreboardDisplay').createScoreboardDisplays>, openWindow?: typeof openAppWindow }} [opts]
 */
export function useScoreboardDisplay(relayKey, { store = scoreboardDisplays, openWindow = openAppWindow } = {}) {
  const display = useSyncExternalStore(store.subscribe, () => store.get(relayKey), () => null)
  const settingsUrl = display?.settingsUrl || null
  const open = useCallback(() => {
    if (settingsUrl) openWindow(settingsUrl)
  }, [settingsUrl, openWindow])
  return { settingsUrl, open: settingsUrl ? open : undefined }
}
