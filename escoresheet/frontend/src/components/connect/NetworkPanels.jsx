import { useTranslation } from 'react-i18next'
import { QRCodeSVG } from 'qrcode.react'
import { Bluetooth, KeyRound, Loader2, LogIn, Power, Router, Shield, Users, Wifi } from 'lucide-react'
import { Button, Notice, Select, StatusPill } from '../../ui'
import { Disclosure } from './parts'

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
      <dd className="break-all font-mono text-sm font-semibold text-stone-900" data-testid={testId}>{value}</dd>
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

function Tip({ icon: Icon, children, testId }) {
  return (
    <p className="mt-2 flex items-start gap-1.5 text-xs leading-snug text-stone-600" data-testid={testId}>
      <Icon size={14} className="mt-0.5 shrink-0 text-stone-400" aria-hidden="true" />
      <span>{children}</span>
    </p>
  )
}

function TravelRouterTip() {
  const { t } = useTranslation()
  return (
    <p className="mt-2 flex items-start gap-1.5 text-xs leading-snug text-stone-600">
      <Router size={14} className="mt-0.5 shrink-0 text-stone-400" aria-hidden="true" />
      <span>{t('connectTablets.travelRouter', 'No hall Wi-Fi? A small travel router works too, no internet needed: switch it on, connect this computer and the tablets to it, then choose Hall Wi-Fi.')}</span>
    </p>
  )
}

// The manual step while the installer's firewall rule is missing (Windows)
const firewallText = (t) => t('connectTablets.windowsFirewall', 'Tablets join but the page does not load? Windows Security › Firewall & network protection › Allow an app through firewall › OpenVolley › tick “Public”.')

/** Windows without the installer's firewall rule: the manual step. */
export function FirewallTip() {
  const { t } = useTranslation()
  return (
    <p className="mt-2 flex items-start gap-1.5 text-xs leading-snug text-stone-600" data-testid="firewall-step">
      <Shield size={14} className="mt-0.5 shrink-0 text-stone-400" aria-hidden="true" />
      <span>{firewallText(t)}</span>
    </p>
  )
}

/** "192.168.1.42 · Wi-Fi (wlp1s0)": one address of this computer, as the hall step lists it. */
export function addressLabel(i, kindLabel) {
  // The hotspot's adapter name ("Local Area Connection* 10") says nothing
  return `${i.ip} · ${kindLabel(i.kind)}${i.name && i.kind !== 'hotspot' ? ` (${i.name})` : ''}`
}

export function useKindLabel() {
  const { t } = useTranslation()
  return (k) => ({
    wifi: t('connectTablets.kind.wifi', 'Wi-Fi'),
    ethernet: t('connectTablets.kind.ethernet', 'Ethernet'),
    hotspot: t('connectTablets.kind.hotspot', 'This computer’s hotspot'),
    other: t('connectTablets.kind.other', 'Network')
  }[k] || k)
}

/**
 * Hall Wi-Fi: which Wi-Fi the tablets join (its name where the system says
 * it) and this computer's address on it.
 */
export function HallPanel({ served, loading, interfaces, selectedIp, onSelectIp, firewallStep = false, network = null }) {
  const { t } = useTranslation()
  const kindLabel = useKindLabel()

  if (!served) {
    return (
      <div className={BLOCK} data-testid="hall-panel">
        <Notice tone="warning">{t('connectTablets.lanNeedsServer', 'Tablets on the local network need the OpenVolley desktop app (or a venue box) on this computer: it serves the referee, bench and livescore pages. In a browser, choose Internet.')}</Notice>
      </div>
    )
  }
  if (loading) return <div className={BLOCK} data-testid="hall-panel"><Busy>{t('connectTablets.loading', 'Reading the local server…')}</Busy></div>
  if (!interfaces.length) {
    return (
      <div className={BLOCK} data-testid="hall-panel">
        <Notice tone="warning">{t('connectTablets.noHallNetwork', 'This computer is on no network. Connect it to the hall Wi-Fi, or create a Wi-Fi for the tablets.')}</Notice>
        <TravelRouterTip />
      </div>
    )
  }
  const selected = interfaces.find(i => i.ip === selectedIp) || interfaces[0]
  return (
    <div className={BLOCK} data-testid="hall-panel">
      <p className="flex items-start gap-2 text-sm text-stone-800">
        <Wifi size={16} className="mt-0.5 shrink-0 text-stone-400" aria-hidden="true" />
        <span>
          {network
            ? t('connectTablets.hallJoin', 'Tablets join the Wi-Fi “{{network}}”.', { network })
            : t('connectTablets.hallIntro', 'Tablets join the same Wi-Fi as this computer.')}
        </span>
      </p>
      {interfaces.length > 1 ? (
        <div className="mt-2">
          <Select
            block
            aria-label={t('connectTablets.address', 'Address')}
            value={selected.ip}
            onChange={(e) => onSelectIp(e.target.value)}
            options={interfaces.map(i => ({ value: i.ip, label: addressLabel(i, kindLabel) }))}
          />
        </div>
      ) : (
        <p className="mt-1 text-xs text-stone-500" data-testid="hall-address">
          {t('connectTablets.thisComputerAt', 'This computer: {{ip}} ({{kind}})', { ip: selected.ip, kind: kindLabel(selected.kind) })}
        </p>
      )}
      <Tip icon={Users} testId="isolation-tip">
        {t('connectTablets.isolationTip', 'Page does not load on the tablet? Some hall Wi-Fis keep devices apart: choose Wi-Fi from this computer or Internet instead.')}
      </Tip>
      {firewallStep && <FirewallTip />}
    </div>
  )
}

/** Wi-Fi from this computer (desktop app): start / stop, name, password and the code to join it. */
export function HotspotPanel({ desktop, status, loading, busy, error, wifi, wifiQr = null, firewallStep = false, onStart, onStop, onNewPassword }) {
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
  const credentials = (
    <dl className={active && wifiQr ? 'min-w-0 space-y-1' : 'grid min-w-0 grid-cols-2 gap-x-4 gap-y-2'}>
      <Credential label={t('connectTablets.networkName', 'Wi-Fi name')} value={wifi?.ssid || '–'} testId="network-ssid" />
      <Credential label={t('connectTablets.networkPassword', 'Password')} value={wifi?.password || '–'} testId="network-password" />
    </dl>
  )
  return (
    <div className={BLOCK} data-testid="hotspot-panel">
      {active && wifiQr ? (
        <div className="flex items-start gap-3">
          <figure className="shrink-0 rounded-md border border-stone-200 bg-white p-1" data-testid="wifi-qr">
            <QRCodeSVG value={wifiQr.qr} size={104} level="M" marginSize={1} />
            <figcaption className="sr-only">{wifiQr.ssid}</figcaption>
          </figure>
          <div className="min-w-0 flex-1">
            <p className="mb-1.5 text-xs font-medium leading-snug text-stone-700" data-testid="wifi-qr-caption">
              {t('connectTablets.wifiQrCaption', 'Scan to join this Wi-Fi first')}
            </p>
            {credentials}
          </div>
        </div>
      ) : credentials}

      {active ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-stone-500">
          <StatusPill tone="done">{t('connectTablets.hotspotOn', 'On')}</StatusPill>
          {status?.clients != null && (
            <span className="tabular-nums">
              {t('connectTablets.hotspotClients', '{{count}} of {{max}} devices joined', { count: status.clients, max: status.maxClients ?? '–' })}
            </span>
          )}
          <Button variant="ghost" size="sm" icon={Power} loading={busy} disabled={external} onClick={onStop} className="ml-auto">
            {t('connectTablets.hotspotStop', 'Stop Wi-Fi')}
          </Button>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button icon={Wifi} loading={busy} onClick={onStart}>
            {t('connectTablets.hotspotStart', 'Create Wi-Fi')}
          </Button>
          {onNewPassword && wifi?.ssid && (
            <Button variant="ghost" size="sm" icon={KeyRound} disabled={busy} onClick={onNewPassword}>
              {t('connectTablets.newPassword', 'New password')}
            </Button>
          )}
        </div>
      )}
      {status?.method === 'wifi-direct' && <p className="mt-2 text-xs text-stone-500">{t('connectTablets.wifiDirect', 'Windows’ mobile hotspot is unavailable here: a direct Wi-Fi network is used instead.')}</p>}

      {external && (
        <Notice tone="info" className="mt-2">{t('connectTablets.hotspotExternal', 'This computer’s hotspot was switched on in the system settings. Tablets on it can scan the codes; switch it off there.')}</Notice>
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
      {active && firewallStep && <FirewallTip />}
      {active && (
        <Disclosure label={t('connectTablets.howToJoin', 'How to join')} className="mt-2">
          <Steps items={[
            t('connectTablets.joinIpad', 'iPad: open the Camera, point it at the Wi-Fi code, tap “Join”.'),
            t('connectTablets.joinAndroid', 'Android: Settings › Wi-Fi › QR icon (or the camera), scan the Wi-Fi code.'),
            t('connectTablets.joinNoInternet', '“No internet”? Choose “Stay connected”, then scan the role’s code.')
          ]} />
        </Disclosure>
      )}
    </div>
  )
}

const SYNC_TONE = { synced: 'done', syncing: 'planned', connecting: 'planned', auth_required: 'todo', error: 'attention', offline: 'neutral', online_no_supabase: 'neutral' }

/** Internet: the cloud, which needs the scorer signed in and the match synced. */
export function ServerPanel({ user, onSignIn, syncStatus, cloudBlocked, gameNumber }) {
  const { t } = useTranslation()
  const syncText = {
    synced: t('connectTablets.sync.synced', 'Synced'),
    syncing: t('connectTablets.sync.syncing', 'Syncing…'),
    connecting: t('connectTablets.sync.connecting', 'Connecting…'),
    auth_required: t('connectTablets.sync.authRequired', 'Sign-in needed'),
    error: t('connectTablets.sync.error', 'Sync error'),
    offline: t('connectTablets.sync.offline', 'Offline'),
    online_no_supabase: t('connectTablets.sync.noCloud', 'Cloud not reachable')
  }
  if (cloudBlocked) {
    return (
      <div className={BLOCK} data-testid="server-panel">
        <Notice tone="warning">{t('connectTablets.cloudBlocked', 'Cloud sync is off for this app window (it does not run on port 5173). Choose Hall Wi-Fi or Wi-Fi from this computer.')}</Notice>
      </div>
    )
  }
  return (
    <div className={BLOCK} data-testid="server-panel">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 text-sm">
        <dt className={EYEBROW}>{t('connectTablets.account', 'Account')}</dt>
        <dd className="min-w-0 text-stone-800">
          {user ? (
            <span className="block truncate" data-testid="server-account">{user.email || t('connectTablets.signedIn', 'Signed in')}</span>
          ) : (
            <span className="text-stone-500">{t('connectTablets.notSignedIn', 'Not signed in')}</span>
          )}
        </dd>
        <dt className={EYEBROW}>{t('connectTablets.syncLabel', 'Match sync')}</dt>
        <dd><StatusPill tone={SYNC_TONE[syncStatus] || 'neutral'}>{syncText[syncStatus] || syncStatus || '–'}</StatusPill></dd>
        <dt className={EYEBROW}>{t('connectTablets.gameNumber', 'Game number')}</dt>
        <dd className="font-semibold tabular-nums text-stone-900" data-testid="server-game-number">{gameNumber ?? '–'}</dd>
      </dl>
      {!user ? (
        <div className="mt-2 flex items-center gap-2">
          <Notice tone="warning" className="min-w-0 flex-1">{t('connectTablets.serverSignIn', 'Sign in so tablets can find this match on the internet.')}</Notice>
          {onSignIn && (
            <Button variant="dark" size="sm" icon={LogIn} onClick={onSignIn} className="shrink-0">
              {t('connectTablets.signIn', 'Sign in')}
            </Button>
          )}
        </div>
      ) : syncStatus !== 'synced' ? (
        <Notice tone="info" className="mt-2">{t('connectTablets.serverNotSynced', 'The match is not in the cloud yet. Tablets find it once sync shows Synced.')}</Notice>
      ) : null}
      {user && <p className="mt-2 text-xs text-stone-500">{t('connectTablets.serverHint', 'Tablets need internet (hall Wi-Fi or mobile data).')}</p>}
    </div>
  )
}

/** Bluetooth: guided set-up where the system can serve a Bluetooth network. */
export function BluetoothPanel({ desktop, status, loading, busy, error, ip, onStart, onStop }) {
  const { t } = useTranslation()
  const errorText = useNetErrorText()
  const name = status?.adapterName || t('connectTablets.thisComputer', 'this computer')

  if (!desktop) {
    return (
      <div className={BLOCK} data-testid="bluetooth-panel">
        {ip ? (
          <p className="text-sm text-stone-700">{t('connectTablets.btFound', 'Bluetooth network found: tablets paired with this computer can scan the codes.')} <span className="font-mono text-xs">{ip}</span></p>
        ) : (
          <p className="text-sm text-stone-700">{t('connectTablets.btDesktopOnly', 'The OpenVolley desktop app on Linux can open a Bluetooth network for the tablets. Windows cannot (it can only join one).')}</p>
        )}
      </div>
    )
  }
  if (loading && !status) return <div className={BLOCK}><Busy>{t('connectTablets.btChecking', 'Checking Bluetooth…')}</Busy></div>

  if (status && !status.supported && !status.active) {
    return (
      <div className={BLOCK} data-testid="bluetooth-panel">
        <Notice tone="warning">{errorText(status.reason)}</Notice>
        <Detail text={status.reason === 'windows-cannot-serve' ? null : status.detail} />
        <p className="mt-2 text-xs text-stone-600">{t('connectTablets.btAlternative', 'Choose “Wi-Fi from this computer” instead: it works for every tablet.')}</p>
      </div>
    )
  }

  const active = !!status?.active
  const external = active && !!status?.external
  return (
    <div className={BLOCK} data-testid="bluetooth-panel">
      <div className="flex items-center gap-2 text-sm text-stone-700">
        <Bluetooth size={16} className="shrink-0 text-stone-400" aria-hidden="true" />
        <span className="min-w-0 truncate font-semibold text-stone-900">{name}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-stone-500">
        <StatusPill tone={active ? 'done' : 'neutral'}>{active ? t('connectTablets.hotspotOn', 'On') : t('connectTablets.hotspotOff', 'Off')}</StatusPill>
        {active && ip && <span className="font-mono">{ip}</span>}
        {active && status?.discoverable && <span>{t('connectTablets.btVisible', 'Visible for pairing for 3 minutes')}</span>}
      </div>
      <div className="mt-2">
        {active ? (
          <Button variant="ghost" size="sm" icon={Power} loading={busy} disabled={external} onClick={onStop}>{t('connectTablets.btStop', 'Stop Bluetooth network')}</Button>
        ) : (
          <Button icon={Bluetooth} loading={busy} onClick={onStart}>{t('connectTablets.btStart', 'Start Bluetooth network')}</Button>
        )}
      </div>
      {external && <Notice tone="info" className="mt-2">{t('connectTablets.btExternal', 'This Bluetooth network was not started by this app run. Stop it in the system’s network settings.')}</Notice>}
      {!active && status?.needsAdmin && <p className="mt-2 text-xs text-stone-500">{t('connectTablets.needsAdmin', 'Your system may ask for an administrator password.')}</p>}
      {error && (
        <div className="mt-2">
          <Notice tone="error">{errorText(error.code)}</Notice>
          <Detail text={error.detail} />
        </div>
      )}
      <Disclosure label={t('connectTablets.howToPair', 'How to pair')} className="mt-2">
        <Steps items={[
          t('connectTablets.btAndroid', 'Android: Settings › Bluetooth › pair with “{{name}}”, tap ⚙ next to it and switch on “Internet access”. If it does not connect, switch the tablet’s Wi-Fi off.', { name }),
          t('connectTablets.btIpad', 'iPad (may not work): Settings › Bluetooth › tap “{{name}}”.', { name }),
          t('connectTablets.btThen', 'Then scan the role’s code. Bluetooth is slow and fits about 6 devices.')
        ]} />
      </Disclosure>
    </div>
  )
}
