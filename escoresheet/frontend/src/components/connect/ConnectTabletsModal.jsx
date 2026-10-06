import { useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Bluetooth, Cloud, Tablet, Wifi } from 'lucide-react'
import { Modal, SegmentedControl, confirmDialog } from '../../ui'
import { AuthContext } from '../../contexts/AuthContext'
import LoginModal from '../auth/LoginModal'
import { useSyncStatus } from '../../hooks/useSyncQueue'
import { useRelayTablets } from '../../hooks/useRealtimeConnection'
import { getCloudApiBaseUrl, getLocalServerStatusUrl, isCloudBlockedOnThisPort } from '../../utils/backendConfig'
import { relayMatchKey, matchTeamNames } from '../../utils/serverDataSync'
import { buildConnectionPins } from '../../utils/connectionPins'
import { db } from '../../db/db'
import {
  LAN_UNAVAILABLE_ROLES, TABLET_ROLES, cloudRoleUrl, firstOfKind, hallInterfaces, lanRoleUrl, roleAccess, wifiQrString
} from '../../utils/tabletLinks'
import {
  bluetoothNetwork, displayedWifi, hotspot, isTabletNetworkAvailable, netError, renewWifiPassword
} from '../../utils/tabletNetwork'
import { QrPanel, RoleRows } from './RoleLinks'
import { BluetoothPanel, HallPanel, HotspotPanel, ServerPanel } from './NetworkPanels'

const VIEW_KEY = 'ov_connect_tablets_view'
const POLL_MS = 6000

function readView() {
  try { return JSON.parse(localStorage.getItem(VIEW_KEY) || 'null') || {} } catch { return {} }
}
function saveView(view) {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)) } catch { /* private mode */ }
}

/**
 * Let a role in (or out) on the scorer's match: the local match, and the
 * cloud copy through the sync queue with every PIN (a partial
 * connection_pins write would erase the other roles' PINs on the server).
 */
export async function setRoleEnabled(matchId, access, enabled) {
  await db.matches.update(matchId, { [access.field]: enabled })
  const m = await db.matches.get(matchId)
  if (m?.seed_key) {
    await db.sync_queue.add({
      resource: 'match',
      action: 'update',
      payload: { id: m.seed_key, connections: { [access.syncField]: enabled }, connection_pins: buildConnectionPins(m) },
      ts: new Date().toISOString(),
      status: 'queued'
    })
  }
}

/** Poll `load` every POLL_MS while `active`. */
function usePoll(active, load) {
  useEffect(() => {
    if (!active) return undefined
    let cancelled = false
    const run = () => { if (!cancelled) load(() => cancelled) }
    run()
    const timer = setInterval(run, POLL_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [active, load])
}

/**
 * "Connect tablets": every role (scoretable, referee, home and away bench,
 * livescore) with its link, QR code and PIN, over
 *
 *   - LAN: the hall Wi-Fi, or a Wi-Fi this laptop creates (desktop app);
 *   - Server: the cloud (scorer signed in, match synced, tablets online);
 *   - Bluetooth: a Bluetooth network this laptop serves (desktop app on
 *     Linux; Windows cannot serve one).
 *
 * Every role has a LAN / Bluetooth link: the livescore served by the relay
 * follows the relay's public match summaries, no internet needed
 * (utils/relayLivescore; tabletLinks LAN_UNAVAILABLE_ROLES is empty).
 *
 * Links only preselect the match; each tablet asks for its role's PIN, which
 * is shown here and never put in a link or a QR code. The game PIN is never
 * shown (the relay accepts it for every role).
 */
export default function ConnectTabletsModal({ open, onClose, match = null, fetchImpl = fetch, win = typeof window !== 'undefined' ? window : undefined }) {
  const { t } = useTranslation()
  // Outside an AuthProvider (a test, an embedded page) there is no account
  const auth = useContext(AuthContext) || null
  const syncStatus = useSyncStatus()
  const desktop = isTabletNetworkAvailable(win)
  const statusUrl = getLocalServerStatusUrl()
  const served = !!statusUrl

  const [view, setView] = useState(() => {
    const v = readView()
    const tab = ['lan', 'server', 'bluetooth'].includes(v.tab) ? v.tab : (served || desktop ? 'lan' : 'server')
    return { tab, lanMode: v.lanMode === 'laptop' ? 'laptop' : 'hall' }
  })
  const setTab = (tab) => setView(v => { const next = { ...v, tab }; saveView(next); return next })
  const setLanMode = (lanMode) => setView(v => { const next = { ...v, lanMode }; saveView(next); return next })

  const [relay, setRelay] = useState({ loading: served, status: null })
  const [hallIp, setHallIp] = useState(null)
  const [hs, setHs] = useState({ loading: desktop, status: null, busy: false, error: null })
  const [bt, setBt] = useState({ loading: desktop, status: null, busy: false, error: null })
  const [qrRole, setQrRole] = useState('referee')
  const [showLogin, setShowLogin] = useState(false)
  const [roleOverride, setRoleOverride] = useState({})
  // Bumped when the remembered Wi-Fi password changes (it lives in localStorage)
  const [, setWifiRev] = useState(0)

  // -- local server status (addresses of every network) --
  const loadRelay = useCallback((cancelled) => {
    if (!statusUrl) return
    fetchImpl(statusUrl, { headers: { Accept: 'application/json' } })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(status => { if (!cancelled()) setRelay({ loading: false, status }) })
      .catch(() => { if (!cancelled()) setRelay(r => ({ loading: false, status: r.status })) })
  }, [statusUrl, fetchImpl])
  usePoll(open && served, loadRelay)

  // -- the laptop's Wi-Fi (desktop app) --
  const hotspotVisible = open && desktop && view.tab === 'lan' && view.lanMode === 'laptop'
  const loadHotspot = useCallback((cancelled) => {
    hotspot.status(win)
      .then(status => { if (!cancelled()) setHs(s => ({ ...s, loading: false, status })) })
      .catch(err => { if (!cancelled()) setHs(s => ({ ...s, loading: false, error: s.error || netError(err) })) })
  }, [win])
  usePoll(hotspotVisible, loadHotspot)
  // On opening: a Wi-Fi already on means the tablets use it
  useEffect(() => {
    if (!open || !desktop) return undefined
    let cancelled = false
    hotspot.status(win).then(status => {
      if (cancelled) return
      setHs(s => ({ ...s, loading: false, status }))
      if (status?.active) setView(v => ({ ...v, tab: 'lan', lanMode: 'laptop' }))
    }).catch(() => { if (!cancelled) setHs(s => ({ ...s, loading: false })) })
    return () => { cancelled = true }
  }, [open, desktop, win])

  // -- the laptop's Bluetooth network (desktop app) --
  const loadBluetooth = useCallback((cancelled) => {
    bluetoothNetwork.status(win)
      .then(status => { if (!cancelled()) setBt(s => ({ ...s, loading: false, status })) })
      .catch(err => { if (!cancelled()) setBt(s => ({ ...s, loading: false, error: s.error || netError(err) })) })
  }, [win])
  usePoll(open && desktop && view.tab === 'bluetooth', loadBluetooth)

  const act = async (setter, fn) => {
    setter(s => ({ ...s, busy: true, error: null }))
    try {
      const status = await fn()
      setter(s => ({ ...s, busy: false, status }))
      loadRelay(() => false)
    } catch (err) {
      setter(s => ({ ...s, busy: false, error: netError(err) }))
    }
  }

  // -- the match --
  const seedKey = match ? (relayMatchKey(match) || match.seed_key || match.externalId || null) : null
  const matchView = useMemo(() => (match ? { ...match, ...roleOverride } : null), [match, roleOverride])
  const teamNames = match ? matchTeamNames(match) : null
  const gameNumber = match ? (match.gameNumber ?? match.gameN ?? match.game_n ?? null) : null
  useEffect(() => { setRoleOverride({}) }, [match?.id])

  const toggleRole = async (role, enabled) => {
    const access = roleAccess(match, role)
    if (!match?.id || !access.field) return
    setRoleOverride(o => ({ ...o, [access.field]: enabled }))
    try {
      await setRoleEnabled(match.id, access, enabled)
    } catch (err) {
      console.error('[ConnectTablets] could not switch', role, err)
      setRoleOverride(o => ({ ...o, [access.field]: !enabled }))
    }
  }

  const relayTablets = useRelayTablets(open && seedKey ? String(seedKey) : null, match, { enabled: open, intervalMs: 5000 })
  const devices = relayTablets.connections?.dashboardClients ?? relayTablets.watchers ?? null
  // Referee and bench tablets on this match right now (the relay's view)
  const tabletsOnMatch = (relayTablets.referee || 0) + (relayTablets.benchHome || 0) + (relayTablets.benchAway || 0)

  /** Ask before cutting tablets off; true when there is nothing to ask. */
  const confirmCut = (title, message, confirmLabel) => confirmDialog({
    title,
    message,
    confirmLabel,
    cancelLabel: t('common.cancel', 'Cancel'),
    tone: 'danger'
  })
  const tabletsGone = (count) => (count > 0
    ? ` ${t('connectTablets.confirm.tabletsOn', 'Tablets connected right now: {{count}}.', { count })}`
    : '')

  // One stray click must not break a running match: creating the Wi-Fi on
  // the laptop's only Wi-Fi card leaves the hall Wi-Fi at once (every tablet
  // on it drops off, cloud sync pauses), and stopping a network drops the
  // tablets on it.
  const startHotspot = async () => {
    if (hs.status?.takesOverWifi) {
      const network = hs.status.leavesNetwork || t('connectTablets.confirm.itsWifi', 'its Wi-Fi')
      const ok = await confirmCut(
        t('connectTablets.confirm.leaveTitle', 'Leave the hall Wi-Fi?'),
        t('connectTablets.confirm.leaveMessage', 'This computer leaves {{network}}: tablets on it disconnect and cloud sync pauses until the computer is back on it (or on a network cable).', { network }) + tabletsGone(tabletsOnMatch),
        t('connectTablets.hotspotStart', 'Create Wi-Fi')
      )
      if (!ok) return
    }
    act(setHs, () => hotspot.start(win))
  }
  const stopHotspot = async () => {
    const count = Math.max(tabletsOnMatch, hs.status?.clients || 0)
    if (count > 0) {
      const ok = await confirmCut(
        t('connectTablets.confirm.stopWifiTitle', 'Stop the tablets’ Wi-Fi?'),
        t('connectTablets.confirm.stopMessage', 'The tablets on it disconnect.') + tabletsGone(count),
        t('connectTablets.hotspotStop', 'Stop Wi-Fi')
      )
      if (!ok) return
    }
    act(setHs, () => hotspot.stop(win))
  }
  const stopBluetooth = async () => {
    if (tabletsOnMatch > 0) {
      const ok = await confirmCut(
        t('connectTablets.confirm.stopBtTitle', 'Stop the Bluetooth network?'),
        t('connectTablets.confirm.stopMessage', 'The tablets on it disconnect.') + tabletsGone(tabletsOnMatch),
        t('connectTablets.btStop', 'Stop Bluetooth network')
      )
      if (!ok) return
    }
    act(setBt, () => bluetoothNetwork.stop(win))
  }

  // -- links for the chosen connection --
  const port = relay.status?.port || (typeof window !== 'undefined' ? window.location.port : '') || null
  const halls = hallInterfaces(relay.status)
  const hallAddress = halls.find(i => i.ip === hallIp)?.ip || halls[0]?.ip || null
  const hotspotIp = hs.status?.active ? (hs.status.gatewayIp || firstOfKind(relay.status, 'hotspot')?.ip || null) : null
  // Only a Bluetooth network this computer serves: never one it merely joined
  // (tethered to a phone), which the tablets cannot reach. The desktop app
  // knows; a page elsewhere has only the relay's report.
  const btIp = desktop
    ? ((bt.status?.active && bt.status?.supported && bt.status?.ip) || null)
    : (firstOfKind(relay.status, 'bluetooth')?.ip || null)

  let ip = null
  let noUrlText = ''
  if (view.tab === 'lan' && view.lanMode === 'hall') {
    ip = served ? hallAddress : null
    noUrlText = served ? t('connectTablets.noAddress', 'No hall network') : t('connectTablets.needsDesktop', 'Needs the desktop app')
  } else if (view.tab === 'lan') {
    ip = hotspotIp
    noUrlText = !desktop
      ? t('connectTablets.needsDesktop', 'Needs the desktop app')
      : hs.status && !hs.status.supported
        ? t('connectTablets.notHere', 'Not available on this computer')
        : t('connectTablets.createWifiFirst', 'Create the Wi-Fi first')
  } else if (view.tab === 'bluetooth') {
    ip = served ? btIp : null
    noUrlText = !desktop
      ? t('connectTablets.needsDesktop', 'Needs the desktop app')
      : bt.status && !bt.status.supported
        ? t('connectTablets.notHere', 'Not available on this computer')
        : t('connectTablets.startBtFirst', 'Start the Bluetooth network first')
  }
  const cloudBlocked = isCloudBlockedOnThisPort()
  const cloudApiBase = cloudBlocked ? null : getCloudApiBaseUrl()
  // Why a role has no link on this network (tabletLinks LAN_UNAVAILABLE_ROLES; none today)
  const lanNotes = {}
  const rows = TABLET_ROLES.map(role => {
    if (view.tab === 'server') return { role, url: cloudBlocked ? null : cloudRoleUrl(role, seedKey, { cloudApiBase }) }
    const unavailable = LAN_UNAVAILABLE_ROLES[role]
    if (unavailable) return { role, url: null, note: lanNotes[unavailable] }
    return { role, url: lanRoleUrl(ip, port, role, seedKey) }
  })
  const qrRow = rows.find(r => r.role === qrRole) || rows[1]

  const wifi = displayedWifi(hs.status)
  // A hotspot started outside the app without a known password gets no
  // Wi-Fi code (it would say "no password")
  const wifiQr = view.tab === 'lan' && view.lanMode === 'laptop' && hs.status?.active && wifi?.ssid && wifi?.password
    ? { qr: wifiQrString({ ssid: wifi.ssid, password: wifi.password }), ssid: wifi.ssid }
    : null
  const newPassword = () => {
    if (renewWifiPassword(wifi)) setWifiRev(n => n + 1)
  }

  const tabs = [
    { value: 'lan', label: t('connectTablets.tab.lan', 'LAN'), icon: Wifi },
    { value: 'server', label: t('connectTablets.tab.server', 'Server'), icon: Cloud },
    { value: 'bluetooth', label: t('connectTablets.tab.bluetooth', 'Bluetooth'), icon: Bluetooth }
  ]
  const lanModes = [
    { value: 'hall', label: t('connectTablets.lanHall', 'Hall Wi-Fi') },
    { value: 'laptop', label: t('connectTablets.lanLaptop', 'Create Wi-Fi for tablets') }
  ]

  // ov-kit: the kit's scoped preflight (the legacy unlayered button styles
  // would repaint the kit buttons otherwise)
  return (
    <div className="ov-kit contents">
      <Modal
        open={open}
        onClose={onClose}
        size="xl"
        className="max-w-3xl"
        icon={Tablet}
        title={t('connectTablets.title', 'Connect tablets')}
        description={t('connectTablets.description', 'Referee, benches and livescore follow this match on their own tablet. Pick how the tablets reach this computer.')}
        closeLabel={t('common.close', 'Close')}
      >
        <SegmentedControl
          options={tabs}
          value={view.tab}
          onChange={setTab}
          ariaLabel={t('connectTablets.connection', 'Connection')}
          className="mb-4"
        />

        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_14.5rem]">
          <div className="min-w-0 space-y-3">
            {view.tab === 'lan' && (
              <>
                <SegmentedControl
                  options={lanModes}
                  value={view.lanMode}
                  onChange={setLanMode}
                  ariaLabel={t('connectTablets.lanWhich', 'Which Wi-Fi')}
                />
                {view.lanMode === 'hall' ? (
                  <HallPanel served={served} loading={relay.loading} interfaces={halls} selectedIp={hallAddress} onSelectIp={setHallIp} />
                ) : (
                  <HotspotPanel
                    desktop={desktop}
                    status={hs.status}
                    loading={hs.loading}
                    busy={hs.busy}
                    error={hs.error}
                    wifi={wifi}
                    onStart={startHotspot}
                    onStop={stopHotspot}
                    onNewPassword={newPassword}
                  />
                )}
              </>
            )}
            {view.tab === 'server' && (
              <ServerPanel
                user={auth?.user || null}
                onSignIn={auth ? () => setShowLogin(true) : null}
                syncStatus={syncStatus}
                cloudBlocked={cloudBlocked}
                gameNumber={gameNumber}
                hasMatch={!!match}
              />
            )}
            {view.tab === 'bluetooth' && (
              <BluetoothPanel
                desktop={desktop}
                status={bt.status}
                loading={bt.loading}
                busy={bt.busy}
                error={bt.error}
                ip={btIp}
                onStart={() => act(setBt, () => bluetoothNetwork.start(win))}
                onStop={stopBluetooth}
              />
            )}

            <RoleRows
              rows={rows}
              match={matchView}
              qrRole={qrRow?.role}
              onPickQr={setQrRole}
              onToggleRole={toggleRole}
              noUrlText={noUrlText}
              teamNames={teamNames}
            />
          </div>

          <QrPanel row={qrRow} wifi={wifiQr} />
        </div>

        <p className="mt-4 text-xs leading-snug text-stone-500">
          {match
            ? t('connectTablets.pinHint', 'Each tablet asks for its PIN: read it out from here. Links and QR codes never contain a PIN. Switch a role off to keep its tablet out.')
            : t('connectTablets.openMatchFirst', 'Open a match to get links and PINs for it.')}
          {devices != null && seedKey && (
            <span className="ml-1 tabular-nums" data-testid="devices-connected">
              {t('connectTablets.devices', 'Connected now: {{count}}.', { count: devices })}
            </span>
          )}
        </p>
      </Modal>

      {showLogin && typeof document !== 'undefined' && createPortal(
        <LoginModal open onClose={() => setShowLogin(false)} onSwitchToSignUp={() => setShowLogin(false)} />,
        document.body
      )}
    </div>
  )
}
