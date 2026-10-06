import { useTranslation } from 'react-i18next'
import { Bluetooth, KeyRound, Loader2, LogIn, Power, Router, Wifi } from 'lucide-react'
import { Button, Notice, Select, StatusPill } from '../../ui'

// Inner block (kit Block recipe): no shadow, one radius down from the dialog.
const BLOCK = 'rounded-xl border border-stone-200/70 bg-stone-50/60 p-3'
const EYEBROW = 'text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400'

function Busy({ children }) {
  return (
    <div className="flex items-center gap-2 text-sm text-stone-500" role="status">
      <Loader2 size={16} className="animate-spin" aria-hidden="true" />
      {children}
    </div>
  )
}

/** The system's own words under a translated reason, small. */
function Detail({ text }) {
  if (!text) return null
  return <p className="mt-1 break-words font-mono text-[11px] leading-snug text-stone-400">{text}</p>
}

function Steps({ items }) {
  return (
    <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs leading-snug text-stone-600">
      {items.map((s, i) => <li key={i}>{s}</li>)}
    </ol>
  )
}

function Credential({ label, value, testId }) {
  return (
    <div className="min-w-0">
      <dt className={EYEBROW}>{label}</dt>
      <dd className="truncate font-mono text-sm font-semibold text-stone-900" data-testid={testId}>{value}</dd>
    </div>
  )
}

export function useNetErrorText() {
  const { t } = useTranslation()
  return (code) => {
    const texts = {
      'no-networkmanager': t('connectTablets.err.noNetworkManager', 'NetworkManager is not running on this computer, so the app cannot create a Wi-Fi.'),
      'no-wifi-device': t('connectTablets.err.noWifiDevice', 'This computer has no Wi-Fi adapter.'),
      'no-ap-mode': t('connectTablets.err.noApMode', 'The Wi-Fi adapter of this computer cannot act as an access point.'),
      'wifi-off': t('connectTablets.err.wifiOff', 'Wi-Fi is switched off on this computer (airplane mode?). Switch it on and try again.'),
      'not-authorized': t('connectTablets.err.notAuthorized', 'Your user account may not create networks. Ask an administrator, or log in at the computer itself (not over remote access).'),
      'disabled-by-policy': t('connectTablets.err.policy', 'Mobile Hotspot is turned off by your organisation (group policy).'),
      'disabled-by-hardware': t('connectTablets.err.hardware', 'The Wi-Fi adapter of this computer cannot host a hotspot.'),
      'no-profile': t('connectTablets.err.noProfile', 'Windows found no network connection to start the Mobile Hotspot from.'),
      'radio-restriction': t('connectTablets.err.radio', 'The Wi-Fi radio refused the hotspot (band or country restriction). Try again, or use a travel router.'),
      busy: t('connectTablets.err.busy', 'The hotspot is still switching. Wait a moment and try again.'),
      'hotspot-failed': t('connectTablets.err.hotspotFailed', 'The Wi-Fi for the tablets could not be started.'),
      'invalid-credentials': t('connectTablets.err.invalidCredentials', 'The network name or password is not valid.'),
      'unsupported-os': t('connectTablets.err.unsupportedOs', 'The app cannot create networks on this system.'),
      'no-bluez': t('connectTablets.err.noBluez', 'The Bluetooth service (BlueZ) is not running on this computer.'),
      'no-adapter': t('connectTablets.err.noAdapter', 'This computer has no Bluetooth adapter.'),
      'bluetooth-off': t('connectTablets.err.bluetoothOff', 'Bluetooth is switched off and could not be switched on.'),
      'bluetooth-failed': t('connectTablets.err.bluetoothFailed', 'The Bluetooth network could not be started.'),
      'windows-cannot-serve': t('connectTablets.err.windowsBluetooth', 'Windows cannot host a Bluetooth network for tablets: it can only join one.'),
      'not-desktop': t('connectTablets.err.notDesktop', 'Only the OpenVolley desktop app can do this.')
    }
    return texts[code] || t('connectTablets.err.generic', 'Something went wrong.')
  }
}

function TravelRouterTip() {
  const { t } = useTranslation()
  return (
    <p className="mt-2 flex items-start gap-1.5 text-xs leading-snug text-stone-600">
      <Router size={14} className="mt-0.5 shrink-0 text-stone-400" aria-hidden="true" />
      <span>{t('connectTablets.travelRouter', 'No hall Wi-Fi? A small travel router works too, no internet needed: switch it on, connect this computer and the tablets to it, then use Hall Wi-Fi.')}</span>
    </p>
  )
}

/** Hall Wi-Fi: the addresses this computer has on the hall network. */
export function HallPanel({ served, loading, interfaces, selectedIp, onSelectIp }) {
  const { t } = useTranslation()
  const kindLabel = (k) => ({
    wifi: t('connectTablets.kind.wifi', 'Wi-Fi'),
    ethernet: t('connectTablets.kind.ethernet', 'Ethernet'),
    hotspot: t('connectTablets.kind.hotspot', 'This computer’s hotspot'),
    other: t('connectTablets.kind.other', 'Network')
  }[k] || k)
  // The hotspot's adapter name ("Local Area Connection* 10") says nothing
  const addressLabel = (i) => `${i.ip} · ${kindLabel(i.kind)}${i.name && i.kind !== 'hotspot' ? ` (${i.name})` : ''}`

  if (!served) {
    return (
      <div className={BLOCK}>
        <Notice tone="warning">{t('connectTablets.lanNeedsServer', 'Tablets on the local network need the OpenVolley desktop app (or a venue box) on this computer: it serves the referee, bench and livescore pages. In a browser, use the Server tab.')}</Notice>
      </div>
    )
  }
  if (loading) return <div className={BLOCK}><Busy>{t('connectTablets.loading', 'Reading the local server…')}</Busy></div>
  if (!interfaces.length) {
    return (
      <div className={BLOCK}>
        <Notice tone="warning">{t('connectTablets.noHallNetwork', 'This computer is on no network. Connect it to the hall Wi-Fi, or create a Wi-Fi for the tablets.')}</Notice>
        <TravelRouterTip />
      </div>
    )
  }
  return (
    <div className={BLOCK}>
      <div className="flex flex-wrap items-center gap-2">
        <Wifi size={16} className="shrink-0 text-stone-400" aria-hidden="true" />
        <p className="min-w-0 flex-1 text-sm text-stone-700">{t('connectTablets.hallIntro', 'Tablets join the same Wi-Fi as this computer.')}</p>
        {interfaces.length > 1 ? (
          <Select
            aria-label={t('connectTablets.address', 'Address')}
            value={selectedIp || ''}
            onChange={(e) => onSelectIp(e.target.value)}
            options={interfaces.map(i => ({ value: i.ip, label: addressLabel(i) }))}
          />
        ) : (
          <span className="font-mono text-xs text-stone-600">{`${interfaces[0].ip} · ${kindLabel(interfaces[0].kind)}`}</span>
        )}
      </div>
    </div>
  )
}

/** Wi-Fi from this laptop (desktop app): start / stop, name, password. */
export function HotspotPanel({ desktop, status, loading, busy, error, wifi, onStart, onStop, onNewPassword }) {
  const { t } = useTranslation()
  const errorText = useNetErrorText()

  if (!desktop) {
    return (
      <div className={BLOCK}>
        <p className="text-sm text-stone-700">{t('connectTablets.hotspotDesktopOnly', 'The OpenVolley desktop app (Windows, Linux) can create its own Wi-Fi for the tablets, with no router and no internet.')}</p>
        <TravelRouterTip />
      </div>
    )
  }
  if (loading && !status) return <div className={BLOCK}><Busy>{t('connectTablets.hotspotChecking', 'Checking this computer’s Wi-Fi…')}</Busy></div>

  if (status && !status.supported && !status.active) {
    return (
      <div className={BLOCK}>
        <Notice tone="warning">{errorText(status.reason)}</Notice>
        <Detail text={status.detail} />
        <TravelRouterTip />
      </div>
    )
  }

  const active = !!status?.active
  // On, but switched on outside the app (system settings): the app did not
  // start it and cannot stop it.
  const external = active && !!status?.external
  const windows = status?.platform === 'windows'
  return (
    <div className={BLOCK} data-testid="hotspot-panel">
      <div className="flex flex-wrap items-start gap-3">
        <dl className="grid min-w-0 flex-1 grid-cols-2 gap-x-4 gap-y-2">
          <Credential label={t('connectTablets.networkName', 'Wi-Fi name')} value={wifi?.ssid || '–'} testId="network-ssid" />
          <Credential label={t('connectTablets.networkPassword', 'Password')} value={wifi?.password || '–'} testId="network-password" />
        </dl>
        {active ? (
          <Button variant="ghost" icon={Power} loading={busy} disabled={external} onClick={onStop}>
            {t('connectTablets.hotspotStop', 'Stop Wi-Fi')}
          </Button>
        ) : (
          <Button icon={Wifi} loading={busy} onClick={onStart}>
            {t('connectTablets.hotspotStart', 'Create Wi-Fi')}
          </Button>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-stone-500">
        {active ? (
          <StatusPill tone="done">{t('connectTablets.hotspotOn', 'On')}</StatusPill>
        ) : (
          <StatusPill tone="neutral">{t('connectTablets.hotspotOff', 'Off')}</StatusPill>
        )}
        {active && status?.gatewayIp && <span className="font-mono">{status.gatewayIp}</span>}
        {active && status?.clients != null && (
          <span className="tabular-nums">
            {t('connectTablets.hotspotClients', '{{count}} of {{max}} devices joined', { count: status.clients, max: status.maxClients ?? '–' })}
          </span>
        )}
        {!active && onNewPassword && wifi?.ssid && (
          <Button variant="ghost" size="sm" icon={KeyRound} disabled={busy} onClick={onNewPassword} className="ml-auto">
            {t('connectTablets.newPassword', 'New password')}
          </Button>
        )}
        {status?.method === 'wifi-direct' && <span>{t('connectTablets.wifiDirect', 'Windows’ mobile hotspot is unavailable here: a direct Wi-Fi network is used instead.')}</span>}
      </div>

      {external && (
        <Notice tone="info" className="mt-2">{t('connectTablets.hotspotExternal', 'This computer’s hotspot was switched on in the system settings. The tablets on it can use the links below; switch it off there.')}</Notice>
      )}
      {!active && status?.takesOverWifi && (
        <Notice tone="warning" className="mt-2">{t('connectTablets.takesOverWifi', 'This computer leaves its current Wi-Fi while the tablets’ Wi-Fi is on. Cloud sync pauses unless it is on a network cable.')}</Notice>
      )}
      {!active && status?.needsAdmin && (
        <p className="mt-2 text-xs text-stone-500">{t('connectTablets.needsAdmin', 'Your system may ask for an administrator password.')}</p>
      )}
      {error && (
        <div className="mt-2">
          <Notice tone="error">{errorText(error.code)}</Notice>
          <Detail text={error.detail} />
        </div>
      )}
      {active && (
        <Steps items={[
          t('connectTablets.joinIpad', 'iPad: open the Camera, point it at the Wi-Fi code, tap “Join”.'),
          t('connectTablets.joinAndroid', 'Android: Settings › Wi-Fi › QR icon (or the camera), scan the Wi-Fi code.'),
          t('connectTablets.joinNoInternet', '“No internet”? Choose “Stay connected”, then scan the role’s code.'),
          ...(windows ? [t('connectTablets.windowsFirewall', 'Tablets join but the page does not load? Windows Security › Firewall & network protection › Allow an app through firewall › OpenVolley › tick “Public”.')] : [])
        ]} />
      )}
    </div>
  )
}

/** Server: the cloud, which needs the scorer signed in and the match synced. */
export function ServerPanel({ user, onSignIn, syncStatus, cloudBlocked, gameNumber, hasMatch }) {
  const { t } = useTranslation()
  const syncTone = { synced: 'done', syncing: 'planned', connecting: 'planned', auth_required: 'todo', error: 'attention', offline: 'neutral', online_no_supabase: 'neutral' }
  const syncText = {
    synced: t('connectTablets.sync.synced', 'Synced'),
    syncing: t('connectTablets.sync.syncing', 'Syncing…'),
    connecting: t('connectTablets.sync.connecting', 'Connecting…'),
    auth_required: t('connectTablets.sync.authRequired', 'Sign-in needed'),
    error: t('connectTablets.sync.error', 'Sync error'),
    offline: t('connectTablets.sync.offline', 'Offline'),
    online_no_supabase: t('connectTablets.sync.noCloud', 'Cloud not reachable')
  }
  return (
    <div className={BLOCK} data-testid="server-panel">
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-3">
        <div className="min-w-0">
          <dt className={EYEBROW}>{t('connectTablets.account', 'Account')}</dt>
          <dd className="flex flex-wrap items-center gap-2 text-sm text-stone-800">
            {user ? (
              <span className="truncate" data-testid="server-account">{user.email || t('connectTablets.signedIn', 'Signed in')}</span>
            ) : (
              <>
                <span className="text-stone-500">{t('connectTablets.notSignedIn', 'Not signed in')}</span>
                {onSignIn && (
                  <Button variant="dark" size="sm" icon={LogIn} onClick={onSignIn}>
                    {t('connectTablets.signIn', 'Sign in')}
                  </Button>
                )}
              </>
            )}
          </dd>
        </div>
        <div>
          <dt className={EYEBROW}>{t('connectTablets.syncLabel', 'Match sync')}</dt>
          <dd><StatusPill tone={syncTone[syncStatus] || 'neutral'}>{syncText[syncStatus] || syncStatus || '–'}</StatusPill></dd>
        </div>
        <div>
          <dt className={EYEBROW}>{t('connectTablets.gameNumber', 'Game number')}</dt>
          <dd className="text-sm font-semibold tabular-nums text-stone-900" data-testid="server-game-number">{gameNumber ?? '–'}</dd>
        </div>
      </dl>
      {cloudBlocked && <Notice tone="warning" className="mt-2">{t('connectTablets.cloudBlocked', 'Cloud sync is off for this app window (it does not run on port 5173). Use the LAN tab.')}</Notice>}
      {!cloudBlocked && !user && <Notice tone="warning" className="mt-2">{t('connectTablets.serverNeedsSignIn', 'Tablets reach this match through the cloud only once you are signed in and the match is synced.')}</Notice>}
      {!hasMatch && <p className="mt-2 text-xs text-stone-500">{t('connectTablets.openMatchFirst', 'Open a match to get links and PINs for it.')}</p>}
      <p className="mt-2 text-xs text-stone-500">{t('connectTablets.serverHint', 'Tablets need internet (hall Wi-Fi or mobile data). Each tablet then asks for its PIN.')}</p>
    </div>
  )
}

/** Bluetooth: guided set-up where the system can serve a Bluetooth network. */
export function BluetoothPanel({ desktop, status, loading, busy, error, ip, onStart, onStop }) {
  const { t } = useTranslation()
  const errorText = useNetErrorText()
  const name = status?.adapterName || t('connectTablets.thisComputer', 'this computer')
  const later = (
    <p className="mt-3 border-t border-stone-200 pt-2 text-[11px] leading-snug text-stone-400">
      {t('connectTablets.btLater', 'Planned: a direct Bluetooth link in the Android app (tablet browsers cannot use Bluetooth).')}
    </p>
  )

  if (!desktop) {
    return (
      <div className={BLOCK} data-testid="bluetooth-panel">
        {ip ? (
          <p className="text-sm text-stone-700">{t('connectTablets.btFound', 'Bluetooth network found: tablets paired with this computer open the links below.')} <span className="font-mono text-xs">{ip}</span></p>
        ) : (
          <p className="text-sm text-stone-700">{t('connectTablets.btDesktopOnly', 'The OpenVolley desktop app on Linux can open a Bluetooth network for the tablets. Windows cannot (it can only join one).')}</p>
        )}
        {later}
      </div>
    )
  }
  if (loading && !status) return <div className={BLOCK}><Busy>{t('connectTablets.btChecking', 'Checking Bluetooth…')}</Busy></div>

  if (status && !status.supported && !status.active) {
    return (
      <div className={BLOCK} data-testid="bluetooth-panel">
        <Notice tone="warning">{errorText(status.reason)}</Notice>
        <Detail text={status.reason === 'windows-cannot-serve' ? null : status.detail} />
        <p className="mt-2 text-xs text-stone-600">{t('connectTablets.btAlternative', 'Use “Create Wi-Fi for tablets” on the LAN tab instead: it works for every tablet.')}</p>
        {later}
      </div>
    )
  }

  const active = !!status?.active
  const external = active && !!status?.external
  return (
    <div className={BLOCK} data-testid="bluetooth-panel">
      <div className="flex flex-wrap items-center gap-3">
        <Bluetooth size={16} className="shrink-0 text-stone-400" aria-hidden="true" />
        <div className="min-w-0 flex-1 text-sm text-stone-700">
          <span className="font-semibold text-stone-900">{name}</span>
          <span className="ml-2 inline-flex"><StatusPill tone="planned">{t('connectTablets.experimental', 'Experimental')}</StatusPill></span>
        </div>
        {active ? (
          <Button variant="ghost" icon={Power} loading={busy} disabled={external} onClick={onStop}>{t('connectTablets.btStop', 'Stop Bluetooth network')}</Button>
        ) : (
          <Button icon={Bluetooth} loading={busy} onClick={onStart}>{t('connectTablets.btStart', 'Start Bluetooth network')}</Button>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-stone-500">
        <StatusPill tone={active ? 'done' : 'neutral'}>{active ? t('connectTablets.hotspotOn', 'On') : t('connectTablets.hotspotOff', 'Off')}</StatusPill>
        {active && ip && <span className="font-mono">{ip}</span>}
        {active && status?.discoverable && <span>{t('connectTablets.btVisible', 'Visible for pairing for 3 minutes')}</span>}
      </div>
      {external && <Notice tone="info" className="mt-2">{t('connectTablets.btExternal', 'This Bluetooth network was not started by this app run. Stop it in the system’s network settings.')}</Notice>}
      {!active && status?.needsAdmin && <p className="mt-2 text-xs text-stone-500">{t('connectTablets.needsAdmin', 'Your system may ask for an administrator password.')}</p>}
      {error && (
        <div className="mt-2">
          <Notice tone="error">{errorText(error.code)}</Notice>
          <Detail text={error.detail} />
        </div>
      )}
      <Steps items={[
        t('connectTablets.btAndroid', 'Android: Settings › Bluetooth › pair with “{{name}}”, tap ⚙ next to it and switch on “Internet access”. If it does not connect, switch the tablet’s Wi-Fi off.', { name }),
        t('connectTablets.btIpad', 'iPad (may not work): Settings › Bluetooth › tap “{{name}}”.', { name }),
        t('connectTablets.btThen', 'Then scan the role’s code. Bluetooth is slow and fits about 6 devices.')
      ]} />
      {later}
    </div>
  )
}

