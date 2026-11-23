import { useCallback, useSyncExternalStore } from 'react'
import i18n from 'i18next'
import { scoreboardDisplays } from '../../utils/scoreboardDisplay'
import { openAppWindow } from '../../utils/openAppWindow'
import { askConfirm } from '../../utils/askConfirm'

/** The host (and port) of a settings page, as the scorer is shown it before it opens. */
export function settingsHostOf(settingsUrl) {
  try { return settingsUrl ? new URL(settingsUrl).host : null } catch { return null }
}

/**
 * "Open the scoreboard settings?" with the page's host: the page is whatever
 * the display announced on the relay (a private-LAN address, checked by the
 * relay and again here), and a device on the hall's network can announce
 * itself as a display too. The scorer opens it only after seeing where it goes.
 */
export function askOpenSettings({ host }, { ask = askConfirm } = {}) {
  // the English text when i18n has not started (i18next answers '' then)
  const text = (key, fallback, values) => i18n.t(key, { defaultValue: fallback, ...values }) || fallback.replace('{{host}}', host)
  return ask({
    title: text('scoreboard.menu.scoreboardSettingsAsk', 'Open the scoreboard settings?'),
    message: text('scoreboard.menu.scoreboardSettingsAskMessage', 'This opens {{host}} on the hall\'s network. Open it only if it is your scoreboard.', { host }),
    confirmLabel: text('scoreboard.menu.scoreboardSettingsOpen', 'Open')
  })
}

/**
 * The scoreboard display that follows the match of `relayKey`, as the relay
 * told the scorer (utils/scoreboardDisplay.js): { settingsUrl, host } while
 * one follows and named a page the scorer may open, else null. `open` asks
 * first, showing the page's host (askOpenSettings), then shows that page: a
 * new tab in a browser, the system browser in the desktop and Android apps
 * (openAppWindow).
 * @param {string|null} relayKey
 * @param {{ store?: ReturnType<import('../../utils/scoreboardDisplay').createScoreboardDisplays>, openWindow?: typeof openAppWindow, askBeforeOpen?: typeof askOpenSettings }} [opts]
 */
export function useScoreboardDisplay(relayKey, { store = scoreboardDisplays, openWindow = openAppWindow, askBeforeOpen = askOpenSettings } = {}) {
  const display = useSyncExternalStore(store.subscribe, () => store.get(relayKey), () => null)
  const settingsUrl = display?.settingsUrl || null
  const host = settingsHostOf(settingsUrl)
  const open = useCallback(async () => {
    if (!settingsUrl) return
    if (!(await askBeforeOpen({ url: settingsUrl, host }))) return
    openWindow(settingsUrl)
  }, [settingsUrl, host, openWindow, askBeforeOpen])
  return { settingsUrl, host, open: settingsUrl ? open : undefined }
}
