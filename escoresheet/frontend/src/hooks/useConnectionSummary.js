/**
 * The scorer header's connection state (the pill of components/ConnectionStatus
 * and every other place that names it, such as the match chip's popover): one
 * rule, one word. Kept out of the component so a screen that mocks the pill
 * still has the state.
 */
import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useSyncQueueStats } from './useSyncQueue'
import { backendOnLocalNetwork } from '../utils/localNetwork'
import { UPDATE_NEEDED_SERVER } from '../utils/appUpdate'
import { useAppUpdateNeeded } from './useServiceWorker'

// The local server + WebSocket path (LAN relay) works on its own, cloud or not
export function isServerWebsocketViable(serverStatus, websocketStatus) {
  return serverStatus === 'connected' && (websocketStatus === 'connected' || websocketStatus === 'no_match')
}

const REACHABLE = new Set(['connected', 'live', 'synced', 'syncing'])

// "Syncing..." only for jobs that wait this long: every point, every save
// queues a job the queue sends within a second, and the pill flipped
// Connected → Syncing... → Connected on each one (owner 2026-11-11: "it loads
// something, stops, loads it again")
export const SYNCING_SHOW_AFTER_MS = 1500

/** True once `on` has held for `ms` without a break; false at once when it ends. */
function useHeldFor(on, ms) {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    if (!on) { setHeld(false); return }
    const timer = setTimeout(() => setHeld(true), ms)
    return () => clearTimeout(timer)
  }, [on, ms])
  return on && held
}

/**
 * The statuses shown in the menu while the browser is offline. With a cloud
 * backend nothing remote answers: server, API and cloud sync read Offline,
 * the WebSocket Disconnected. With a LAN / local backend the polled statuses
 * stand, except a WebSocket the local server does not back up.
 */
function offlineStatuses(statuses, lanBackend) {
  if (lanBackend) {
    return statuses.websocket === 'connected' && statuses.server !== 'connected'
      ? { ...statuses, websocket: 'disconnected' }
      : statuses
  }
  const out = { ...statuses }
  for (const key of ['api', 'server', 'supabase']) {
    if (REACHABLE.has(out[key])) out[key] = 'offline'
  }
  if (REACHABLE.has(out.websocket)) out.websocket = 'disconnected'
  return out
}


// Each status: its word and a kit tone (pill + dot + text, chromeClasses
// STATUS_TONES). Offline is a normal state for a hall without network, so it
// reads neutral, not as an error.
export function statusColorOf(t, status, key) {
  if (status === 'connected' || status === 'live' || status === 'scheduled' || status === 'synced' || status === 'syncing') {
    return { tone: 'ok', text: status === 'syncing' ? t('connectionStatus.syncing', 'Syncing') : t('connectionStatus.connected', 'Connected') }
  } else if (status === 'awaiting_match') {
    return { tone: 'ok', text: t('connectionStatus.connected', 'Connected') }
  } else if (status === 'local_only') {
    return { tone: 'ok', text: t('connectionStatus.localOnly', 'Local only') }
  } else if (status === 'starting') {
    return { tone: 'neutral', text: t('connectionStatus.connecting', 'Connecting') }
  } else if (status === 'attention') {
    return { tone: 'error', text: t('connectionStatus.error', 'Error') }
  } else if (status === 'no_match') {
    // For websocket, "no_match" means waiting for a match to be selected - show as gray/ready
    const text = key === 'websocket' ? t('connectionStatus.noMatch', 'No match') : t('connectionStatus.ready', 'Ready')
    return { tone: 'neutral', text }
  } else if (status === 'offline') {
    return { tone: 'neutral', text: t('connectionStatus.offline', 'Offline') }
  } else if (status === 'disconnected' || status === 'error') {
    return { tone: 'error', text: status === 'error' ? t('connectionStatus.error', 'Error') : t('connectionStatus.disconnected', 'Disconnected') }
  } else if (status === 'not_configured' || status === 'not_applicable') {
    return { tone: 'warn', text: t('connectionStatus.notConfigured', 'Not configured') }
  } else if (status === 'not_available') {
    return { tone: 'neutral', text: t('connectionStatus.naStatic', 'N/A (static)') }
  } else if (status === 'connecting') {
    return { tone: 'warn', text: t('connectionStatus.connecting', 'Connecting') }
  } else if (status === 'auth_required') {
    return { tone: 'warn', text: t('connectionStatus.signInToSync', 'Sign in to sync') }
  } else if (status === 'update_required') {
    return { tone: 'warn', text: t('connectionStatus.updateNeeded', 'Update needed') }
  } else if (status === 'server_behind') {
    return { tone: 'warn', text: t('connectionStatus.serverUpdatePending', 'Server update pending') }
  } else if (status === 'test_mode') {
    return { tone: 'violet', text: t('connectionStatus.testMode', 'Test mode') }
  } else {
    return { tone: 'neutral', text: t('connectionStatus.unknown', 'Unknown') }
  }
}

function overallStatusOf(connectionStatuses) {
  // Helper to check if a status is considered "OK"
  const isStatusOk = (status) => {
    return status === 'connected' ||
      status === 'live' ||
      status === 'scheduled' ||
      status === 'synced' ||
      status === 'syncing' ||
      status === 'test_mode' ||
      status === 'not_applicable' ||
      status === 'not_available' ||
      status === 'no_match' // No match is OK - just waiting for match selection
  }

  const serverStatus = connectionStatuses.server
  const websocketStatus = connectionStatuses.websocket
  const supabaseStatus = connectionStatuses.supabase
  const matchStatus = connectionStatuses.match

  // Check if Server+WebSocket path is viable
  const serverWebsocketViable = isServerWebsocketViable(serverStatus, websocketStatus)

  // Check if Supabase path is viable
  const supabaseViable = supabaseStatus === 'connected'

  // At least one connection path must be working
  const hasViableConnection = serverWebsocketViable || supabaseViable

  if (!hasViableConnection) {
    // Unreachable cloud and no local server: offline, not an error
    if (supabaseStatus === 'offline') return 'offline'
    // The first probe has not answered yet: Connecting, neutral (owner
    // 2026-11-11: the pill said Error, then Ready, at every start)
    if (supabaseStatus === 'connecting' || supabaseStatus === 'unknown' || supabaseStatus == null) return 'starting'
    return 'attention' // No viable connection path
  }

  // Check if we're waiting for match selection
  const waitingForMatch =
    websocketStatus === 'no_match' ||
    matchStatus === 'no_match' ||
    matchStatus === 'disconnected' ||
    matchStatus === 'unknown'

  if (waitingForMatch) {
    return 'awaiting_match'
  }

  return 'connected'
}

/**
 * The header's connection state, for the pill and for anything else that
 * names it (the match chip's popover): one rule, one word.
 */
export function useConnectionSummary({ connectionStatuses = {}, queueStats = null } = {}) {
  const { t } = useTranslation()

  // Queue counts come from a live query on the local sync queue (callers used
  // to pass the sync status string here, so pending/failed jobs never showed).
  // queueStats may still carry counts (tests) and authRequired; a caller that
  // passes the status string still gets 'auth_required' recognised.
  const liveCounts = useSyncQueueStats()
  const given = queueStats && typeof queueStats === 'object' ? queueStats : {}
  const count = (key) => (typeof given[key] === 'number' ? given[key] : (liveCounts?.[key] || 0))
  const stats = { pending: count('pending'), error: count('error'), failed: count('failed'), serverBehind: count('serverBehind') }
  const pendingCount = stats.pending
  const errorCount = stats.error + stats.failed
  const authRequired = given.authRequired === true || queueStats === 'auth_required'
  // This build is too old for the server (426, utils/appUpdate): its writes
  // wait on the device until the app is updated. The whole pill says so.
  const updateNeeded = useAppUpdateNeeded()
  const updateRequired = updateNeeded === UPDATE_NEEDED_SERVER || given.updateRequired === true || queueStats === 'update_required'
  // Every refusal is for a column or table the server lacks: the server is
  // behind this app (its update is not out yet), not an error of this device
  const serverBehind = stats.serverBehind > 0 && stats.serverBehind >= errorCount
  const syncingLong = useHeldFor(pendingCount > 0, SYNCING_SHOW_AFTER_MS)

  // The browser's own view of the network (the 'Online' switch is offline mode)
  const [browserOffline, setBrowserOffline] = useState(() => typeof navigator !== 'undefined' && navigator.onLine === false)
  useEffect(() => {
    const update = () => setBrowserOffline(navigator.onLine === false)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  // Offline as far as the browser knows. The server / WebSocket / cloud
  // statuses are polled (every 30-60 s), and a socket to the cloud relay can
  // stay OPEN without any data flowing, so their last 'connected' is not
  // believed: the pill says Offline at once. Only a backend on this machine or
  // the venue LAN (offline desktop app, Pi scoretable) can still answer; then
  // the polled statuses keep counting.
  // Read on every render (cheap): a backend chosen at runtime on the server
  // connection screen counts at once.
  const lanBackend = backendOnLocalNetwork()
  const polledStatuses = browserOffline ? offlineStatuses(connectionStatuses, lanBackend) : connectionStatuses
  // (the cloud answers, it takes no write of this version)
  const shownStatuses = updateRequired && !browserOffline && 'supabase' in polledStatuses
    ? { ...polledStatuses, supabase: 'update_required' }
    : polledStatuses
  const localPathViable = lanBackend && isServerWebsocketViable(connectionStatuses.server, connectionStatuses.websocket)

  // No network as far as the browser knows, but a local server (offline
  // desktop / LAN scoretable serving tablets) can still be connected: then the
  // match runs normally and only the cloud copy waits ('Local only' + count).
  const baseStatus = browserOffline && !localPathViable
    ? 'offline'
    : updateRequired
      ? 'update_required'
      : errorCount > 0
        ? (serverBehind ? 'server_behind' : 'attention')
        : authRequired
          ? 'auth_required'
          : overallStatusOf(connectionStatuses)
  // The venue runs on the local relay while the cloud is out of reach
  // (desktop app or LAN scoretable without internet): say so instead of
  // 'Connected' / 'Syncing...', which would claim the cloud copy is moving.
  const cloudOut = browserOffline || connectionStatuses.supabase === 'offline'
  const overallStatus = localPathViable && cloudOut && (baseStatus === 'connected' || baseStatus === 'awaiting_match')
    ? 'local_only'
    : baseStatus
  const statusInfo = statusColorOf(t, overallStatus)

  const pillText = overallStatus === 'connected' ? (syncingLong ? t('connectionStatus.syncingDots', 'Syncing...') : t('connectionStatus.connected', 'Connected')) :
    overallStatus === 'awaiting_match' ? t('connectionStatus.ready', 'Ready') :
    overallStatus === 'starting' ? t('connectionStatus.connecting', 'Connecting') :
    overallStatus === 'local_only'
      ? (pendingCount > 0
        ? t('connectionStatus.localOnlyPending', 'Local only ({{count}} waiting)', { count: pendingCount })
        : t('connectionStatus.localOnly', 'Local only'))
      :
      overallStatus === 'offline'
        ? (pendingCount > 0
          ? t('connectionStatus.offlinePending', 'Offline ({{count}} waiting)', { count: pendingCount })
          : t('connectionStatus.offline', 'Offline'))
        : overallStatus === 'auth_required' ? t('connectionStatus.signInToSync', 'Sign in to sync') :
          overallStatus === 'update_required' ? t('connectionStatus.updateNeeded', 'Update needed') :
            overallStatus === 'server_behind' ? t('connectionStatus.serverUpdatePending', 'Server update pending') :
              t('connectionStatus.error', 'Error')
  return { stats, pendingCount, errorCount, serverBehind, authRequired, updateRequired, updateNeeded, shownStatuses, overallStatus, statusInfo, pillText }
}

