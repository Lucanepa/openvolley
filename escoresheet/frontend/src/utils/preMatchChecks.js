/**
 * The connection checks run when the coin toss is confirmed (informational,
 * never a block): the WebSocket relay, the cloud database, the match in the
 * cloud and the connected devices.
 *
 * In offline mode the cloud is off on purpose: the cloud checks, and the
 * relay ones when the relay is the cloud's, are skipped ("Offline mode: not
 * checked") and are not issues. They failed and showed "Some checks reported
 * issues" with a red cross on every offline coin toss (owner, 2026-10-21). A
 * venue / desktop relay is still checked: a problem with it is real.
 */

import { isStaticHost } from './backendConfig'

/** The app's offline mode (App keeps it in localStorage offlineMode). */
export function readOfflineMode() {
  try {
    return localStorage.getItem('offlineMode') === 'true'
  } catch {
    return false
  }
}

/** The relay is the cloud's (backend.openvolley.app and the other openvolley.app hosts). */
export function isCloudBackend(url) {
  if (!url) return false
  try {
    return isStaticHost(new URL(url).hostname)
  } catch {
    return false
  }
}

/**
 * Run the checks. `onUpdate(checks)` is called once the list is made (all
 * pending); the result is the same object with every status set.
 * @param {object} o
 * @param {(key: string, fallback: string) => string} o.t
 * @param {string|null} o.backendUrl getBackendUrl()
 * @param {boolean} o.offlineMode the app's offline mode (localStorage offlineMode)
 * @param {boolean} o.isTest a test match (no cloud)
 * @param {string|null} o.seedKey the match's external id
 * @param {object|null} o.localMatch the stored match (connection toggles)
 * @param {number|string} o.matchId
 * @param {Function} o.apiFrom lib/apiClient apiFrom
 * @param {Function} [o.fetchFn]
 * @param {number} [o.timeoutMs] for all checks together
 * @returns {Promise<Record<string, {status: 'pending'|'pass'|'warn'|'fail'|'skip', label: string, detail?: string, offline?: boolean, note?: string}>>}
 */
export async function runConnectionChecks({
  t, backendUrl, offlineMode = false, isTest = false, seedKey = null, localMatch = null, matchId,
  apiFrom, fetchFn = (...a) => fetch(...a), timeoutMs = 10000, onUpdate
}) {
  const checks = {
    websocket: { status: 'pending', label: t('coinToss.checks.websocket', 'WebSocket server') },
    supabase: { status: 'pending', label: t('coinToss.checks.supabase', 'Cloud database') },
    matchData: { status: 'pending', label: t('coinToss.checks.matchData', 'Match data in cloud') },
    devices: { status: 'pending', label: t('coinToss.checks.devices', 'Connected devices') }
  }
  onUpdate?.(checks)

  const offlineSkip = (check) => {
    check.status = 'skip'
    check.offline = true
    check.note = t('coinToss.checks.offlineNotChecked', 'Offline mode: not checked')
  }
  const relayOff = offlineMode && isCloudBackend(backendUrl)
  const cloudOff = offlineMode
  const pending = []

  // 1. WebSocket server health
  if (relayOff) offlineSkip(checks.websocket)
  else if (backendUrl) {
    pending.push(
      fetchFn(`${backendUrl}/health`, { method: 'GET', signal: AbortSignal.timeout(3000) })
        .then(r => { checks.websocket.status = r.ok ? 'pass' : 'fail' })
        .catch(() => { checks.websocket.status = 'fail' })
    )
  } else {
    checks.websocket.status = 'skip'
  }

  // 2. Cloud database connectivity
  if (isTest) checks.supabase.status = 'skip'
  else if (cloudOff) offlineSkip(checks.supabase)
  else {
    pending.push(
      Promise.resolve().then(() => apiFrom('matches').select('id').limit(1))
        .then(({ error }) => { checks.supabase.status = error ? 'fail' : 'pass' })
        .catch(() => { checks.supabase.status = 'fail' })
    )
  }

  // 3. Match data in cloud
  if (!seedKey || isTest) checks.matchData.status = 'skip'
  else if (cloudOff) offlineSkip(checks.matchData)
  else {
    pending.push(
      Promise.resolve().then(() => apiFrom('matches').select('status').eq('external_id', seedKey).maybeSingle())
        .then(({ data: md, error }) => {
          if (error || !md) { checks.matchData.status = 'warn' }
          else if (md.status === 'live') { checks.matchData.status = 'pass' }
          else { checks.matchData.status = 'warn' }
        })
        .catch(() => { checks.matchData.status = 'fail' })
    )
  }

  // 4. Connected devices
  if (relayOff) offlineSkip(checks.devices)
  else if (backendUrl) {
    pending.push(
      fetchFn(`${backendUrl}/api/server/connections`, { signal: AbortSignal.timeout(3000) })
        .then(r => r.json())
        .then(data => {
          const anyEnabled = localMatch?.refereeConnectionEnabled || localMatch?.homeTeamConnectionEnabled || localMatch?.awayTeamConnectionEnabled
          if (!anyEnabled) { checks.devices.status = 'skip'; return }
          const connected = Array.isArray(data.clients) ? data.clients.filter(c => c.matchId === String(matchId)).length : 0
          checks.devices.status = connected > 0 ? 'pass' : 'warn'
          checks.devices.detail = String(connected)
        })
        .catch(() => { checks.devices.status = 'fail' })
    )
  } else {
    checks.devices.status = 'skip'
  }

  let timer
  await Promise.race([
    Promise.allSettled(pending),
    new Promise(resolve => { timer = setTimeout(resolve, timeoutMs) })
  ])
  clearTimeout(timer)

  // Still pending: timed out
  for (const check of Object.values(checks)) {
    if (check.status === 'pending') check.status = 'fail'
  }
  return checks
}

/**
 * 'fail' (an issue: the scorer proceeds by hand), 'warn' (shown briefly),
 * 'ok' (all passed), or 'offline' (nothing failed or warned and offline mode
 * skipped some: no "All checks passed" for checks that never ran).
 */
export function checksOutcome(checks) {
  const list = Object.values(checks || {})
  if (list.some(c => c.status === 'fail')) return 'fail'
  if (list.some(c => c.status !== 'pass' && c.status !== 'skip')) return 'warn'
  if (list.some(c => c.offline)) return 'offline'
  return 'ok'
}
