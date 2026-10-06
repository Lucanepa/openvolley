import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanup, render, screen, waitFor, within, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, opts) => {
      let s = String(typeof fallback === 'string' ? fallback : key)
      for (const [k, v] of Object.entries(opts || {})) s = s.replaceAll(`{{${k}}}`, String(v))
      return s
    }
  })
}))

const backend = vi.hoisted(() => ({ statusUrl: 'http://localhost:5173/api/server/status', cloudBlocked: false }))
vi.mock('../../../utils/backendConfig', async (importOriginal) => ({
  ...(await importOriginal()),
  getLocalServerStatusUrl: () => backend.statusUrl,
  getCloudApiBaseUrl: () => 'https://backend.openvolley.app',
  isCloudBlockedOnThisPort: () => backend.cloudBlocked
}))
const relayTablets = vi.hoisted(() => ({ value: null }))
vi.mock('../../../hooks/useRealtimeConnection', () => ({
  useRelayTablets: () => relayTablets.value || ({ connections: { dashboardClients: 2 }, watchers: 2, referee: 0, benchHome: 0, benchAway: 0 })
}))
vi.mock('../../../hooks/useSyncQueue', () => ({ useSyncStatus: () => 'synced' }))
vi.mock('../../../utils/serverDataSync', () => ({
  relayMatchKey: (m) => m?.seed_key || null,
  matchTeamNames: (m) => ({ home: m?.homeName || null, away: m?.awayName || null })
}))
const dbMock = vi.hoisted(() => ({
  matches: { update: vi.fn(async () => 1), get: vi.fn() },
  sync_queue: { add: vi.fn(async () => 1) }
}))
vi.mock('../../../db/db', () => ({ db: dbMock }))
vi.mock('../../auth/LoginModal', () => ({ default: () => <div data-testid="login-modal" /> }))
import { AuthContext } from '../../../contexts/AuthContext'
import { UiHost } from '../../../ui/UiHost.jsx'
import ConnectTabletsModal from '../ConnectTabletsModal'

// The account: undefined = no AuthProvider around the dialog
const authState = { value: undefined }

function renderModal(props) {
  const modal = <ConnectTabletsModal open onClose={() => {}} {...props} />
  return render(
    <>
      {authState.value === undefined ? modal : <AuthContext.Provider value={authState.value}>{modal}</AuthContext.Provider>}
      <UiHost />
    </>
  )
}

const STATUS = {
  running: true,
  localIP: '192.168.1.42',
  port: 5173,
  wsPort: 8080,
  interfaces: [
    { name: 'wlp1s0', ip: '192.168.1.42', kind: 'wifi' },
    { name: 'enp0s31f6', ip: '10.0.0.5', kind: 'ethernet' }
  ]
}

const MATCH = {
  id: 7,
  seed_key: 'match_1759740000000_ab12cd',
  homeName: 'VBC Zürich',
  awayName: 'Volley Bern',
  gameNumber: 4711,
  refereePin: '123456',
  homeTeamPin: '234567',
  awayTeamPin: '345678',
  gamePin: '999999',
  refereeConnectionEnabled: true,
  homeTeamConnectionEnabled: true,
  awayTeamConnectionEnabled: false
}

const okFetch = (status = STATUS) => vi.fn(async () => ({ ok: true, json: async () => status }))

function tauri(handlers) {
  const invoke = vi.fn(async (cmd, args) => {
    if (!handlers[cmd]) throw { code: 'unknown', detail: cmd }
    return handlers[cmd](args)
  })
  return { __TAURI_INTERNALS__: { invoke }, invoke }
}

const tab = (name) => fireEvent.click(screen.getByRole('radio', { name }))

describe('ConnectTabletsModal', () => {
  beforeEach(() => {
    localStorage.clear()
    backend.statusUrl = 'http://localhost:5173/api/server/status'
    backend.cloudBlocked = false
    dbMock.matches.update.mockClear()
    dbMock.sync_queue.add.mockClear()
    authState.value = undefined
    relayTablets.value = null
  })

  it('lists every role on the hall Wi-Fi with its link, and PINs only on the scorer\'s screen', async () => {
    renderModal({ match: MATCH, fetchImpl: okFetch(), win: {} })
    expect(screen.getByText('Connect tablets')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /LAN/ })).toHaveAttribute('aria-checked', 'true')
    await waitFor(() => expect(screen.getByText('http://192.168.1.42:5173/referee?match=match_1759740000000_ab12cd')).toBeInTheDocument())

    for (const role of ['main', 'referee', 'bench_home', 'bench_away', 'livescore']) {
      expect(screen.getByTestId(`role-row-${role}`)).toBeInTheDocument()
    }
    expect(screen.getByText('http://192.168.1.42:5173/')).toBeInTheDocument()
    expect(screen.getByText('http://192.168.1.42:5173/bench?match=match_1759740000000_ab12cd&team=home')).toBeInTheDocument()
    expect(screen.getByText('http://192.168.1.42:5173/bench?match=match_1759740000000_ab12cd&team=away')).toBeInTheDocument()
    // livescore reads the cloud's live table: no LAN link, the Server tab instead
    expect(screen.queryByText('http://192.168.1.42:5173/livescore')).toBeNull()
    expect(screen.getByTestId('role-note-livescore')).toHaveTextContent('Needs internet: use the “Server” tab')

    // PINs: referee and home bench (let in); away bench is off, so no PIN; never the game PIN
    expect(screen.getByTestId('pin-referee')).toHaveTextContent('123456')
    expect(screen.getByTestId('pin-bench_home')).toHaveTextContent('234567')
    expect(screen.queryByTestId('pin-bench_away')).toBeNull()
    expect(within(screen.getByTestId('role-row-bench_away')).getByText('Off')).toBeInTheDocument()
    expect(screen.queryByTestId('pin-main')).toBeNull()
    expect(screen.queryByTestId('pin-livescore')).toBeNull()
    expect(document.body.textContent).not.toContain('999999')

    // the QR code encodes the link, never a PIN
    const qr = screen.getByTestId('role-qr')
    expect(within(qr).getByText('Referee')).toBeInTheDocument()
    expect(screen.getByText(/Connected now: 2/)).toBeInTheDocument()
  })

  it('switches the hall address and the QR role', async () => {
    renderModal({ match: MATCH, fetchImpl: okFetch(), win: {} })
    const select = await screen.findByRole('combobox', { name: 'Address' })
    fireEvent.change(select, { target: { value: '10.0.0.5' } })
    expect(screen.getByText('http://10.0.0.5:5173/referee?match=match_1759740000000_ab12cd')).toBeInTheDocument()
    fireEvent.click(within(screen.getByTestId('role-row-bench_home')).getByRole('button', { name: /QR/ }))
    expect(within(screen.getByTestId('role-qr')).getByText('Bench (home)')).toBeInTheDocument()
  })

  it('lets a role in: local match and the cloud copy with every PIN', async () => {
    dbMock.matches.get.mockResolvedValue({ ...MATCH, awayTeamConnectionEnabled: true })
    renderModal({ match: MATCH, fetchImpl: okFetch(), win: {} })
    fireEvent.click(screen.getByRole('switch', { name: 'Let Bench (away) in' }))
    await waitFor(() => expect(dbMock.sync_queue.add).toHaveBeenCalled())
    expect(dbMock.matches.update).toHaveBeenCalledWith(7, { awayTeamConnectionEnabled: true })
    const payload = dbMock.sync_queue.add.mock.calls[0][0].payload
    expect(payload).toMatchObject({ id: MATCH.seed_key, connections: { away_bench_enabled: true } })
    expect(payload.connection_pins).toMatchObject({ referee: '123456', bench_home: '234567', bench_away: '345678' })
    expect(screen.getByTestId('pin-bench_away')).toHaveTextContent('345678')
  })

  it('in a browser: no Wi-Fi button, the desktop app and a travel router instead', async () => {
    renderModal({ match: MATCH, fetchImpl: okFetch(), win: {} })
    fireEvent.click(screen.getByRole('radio', { name: 'Create Wi-Fi for tablets' }))
    expect(screen.getByText(/desktop app \(Windows, Linux\) can create its own Wi-Fi/)).toBeInTheDocument()
    expect(screen.getByText(/travel router/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Create Wi-Fi/ })).toBeNull()
    expect(within(screen.getByTestId('role-row-referee')).getByText('Needs the desktop app')).toBeInTheDocument()
  })

  it('desktop app: creates the Wi-Fi and shows its QR next to the role link on the laptop address', async () => {
    let active = false
    const win = tauri({
      hotspot_status: () => ({ supported: true, active, platform: 'linux', method: 'networkmanager', ssid: 'OpenVolley-AB12', password: 'example-Pq2m', takesOverWifi: true, gatewayIp: active ? '10.42.0.1' : null }),
      hotspot_start: () => { active = true; return { supported: true, active: true, ssid: 'OpenVolley-AB12', password: 'example-Pq2m', gatewayIp: '10.42.0.1' } },
      hotspot_stop: () => { active = false; return { supported: true, active: false, ssid: 'OpenVolley-AB12', password: 'example-Pq2m' } },
      bluetooth_status: () => ({ supported: false })
    })
    renderModal({ match: MATCH, fetchImpl: okFetch(), win })
    fireEvent.click(screen.getByRole('radio', { name: 'Create Wi-Fi for tablets' }))
    await waitFor(() => expect(screen.getByTestId('network-ssid')).toHaveTextContent('OpenVolley-AB12'))
    expect(screen.getByTestId('network-password')).toHaveTextContent('example-Pq2m')
    expect(screen.getByText(/leaves its current Wi-Fi/)).toBeInTheDocument()
    expect(screen.queryByTestId('wifi-qr')).toBeNull()
    expect(within(screen.getByTestId('role-row-referee')).getByText('Create the Wi-Fi first')).toBeInTheDocument()

    // one card: it leaves the hall Wi-Fi, so it asks first
    fireEvent.click(screen.getByRole('button', { name: 'Create Wi-Fi' }))
    expect(await screen.findByTestId('confirm-dialog')).toHaveTextContent('Leave the hall Wi-Fi?')
    fireEvent.click(screen.getByTestId('confirm-accept'))
    await waitFor(() => expect(screen.getByTestId('wifi-qr')).toBeInTheDocument())
    expect(win.invoke).toHaveBeenCalledWith('hotspot_start', {})
    expect(screen.getByText('http://10.42.0.1:5173/referee?match=match_1759740000000_ab12cd')).toBeInTheDocument()
    expect(within(screen.getByTestId('wifi-qr')).getByText('OpenVolley-AB12')).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('ov_tablet_wifi'))).toEqual({ ssid: 'OpenVolley-AB12', password: 'example-Pq2m' })

    fireEvent.click(screen.getByRole('button', { name: 'Stop Wi-Fi' }))
    await waitFor(() => expect(screen.queryByTestId('wifi-qr')).toBeNull())
    expect(win.invoke).toHaveBeenCalledWith('hotspot_stop', {})
  })

  it('desktop app: explains a laptop that cannot create a Wi-Fi', async () => {
    const win = tauri({
      hotspot_status: () => ({ supported: false, active: false, reason: 'no-ap-mode', detail: 'wlp1s0', ssid: 'OpenVolley-AB12', password: 'x' }),
      bluetooth_status: () => ({ supported: false })
    })
    renderModal({ match: MATCH, fetchImpl: okFetch(), win })
    fireEvent.click(screen.getByRole('radio', { name: 'Create Wi-Fi for tablets' }))
    await waitFor(() => expect(screen.getByText(/cannot act as an access point/)).toBeInTheDocument())
    expect(screen.getByText('wlp1s0')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create Wi-Fi' })).toBeNull()
  })

  it('server tab: cloud links, game number, and sign-in when signed out', async () => {
    authState.value = { user: null }
    renderModal({ match: MATCH, fetchImpl: okFetch(), win: {} })
    tab(/Server/)
    expect(screen.getByText('https://referee.openvolley.app/?server=https%3A%2F%2Fbackend.openvolley.app&match=match_1759740000000_ab12cd')).toBeInTheDocument()
    expect(screen.getByText('https://bench.openvolley.app/?server=https%3A%2F%2Fbackend.openvolley.app&match=match_1759740000000_ab12cd&team=away')).toBeInTheDocument()
    expect(screen.getByTestId('server-game-number')).toHaveTextContent('4711')
    expect(screen.getByText('Synced')).toBeInTheDocument()
    expect(screen.getByText('Not signed in')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(screen.getByTestId('login-modal')).toBeInTheDocument()
    expect(screen.getByTestId('pin-referee')).toHaveTextContent('123456')
  })

  it('server tab: the signed-in account, and no links where the cloud is blocked', () => {
    backend.cloudBlocked = true
    authState.value = { user: { email: 'scorer@example.org' } }
    renderModal({ match: MATCH, fetchImpl: okFetch(), win: {} })
    tab(/Server/)
    expect(screen.getByTestId('server-account')).toHaveTextContent('scorer@example.org')
    expect(screen.getByText(/does not run on port 5173/)).toBeInTheDocument()
    expect(within(screen.getByTestId('role-row-referee')).getByRole('button', { name: /Copy/ })).toBeDisabled()
  })

  it('bluetooth tab: Windows says it cannot serve a Bluetooth network', async () => {
    const win = tauri({
      hotspot_status: () => ({ supported: true, active: false, ssid: 'a', password: 'b' }),
      bluetooth_status: () => ({ supported: false, reason: 'windows-cannot-serve', platform: 'windows' })
    })
    renderModal({ match: MATCH, fetchImpl: okFetch(), win })
    tab(/Bluetooth/)
    await waitFor(() => expect(screen.getByText(/Windows cannot host a Bluetooth network/)).toBeInTheDocument())
    expect(screen.getByText(/Planned: a direct Bluetooth link/)).toBeInTheDocument()
    expect(within(screen.getByTestId('role-row-referee')).getByText('Not available on this computer')).toBeInTheDocument()
  })

  it('bluetooth tab: Linux starts the network and links its address', async () => {
    let active = false
    const win = tauri({
      hotspot_status: () => ({ supported: true, active: false, ssid: 'a', password: 'b' }),
      bluetooth_status: () => ({ supported: true, active, adapterName: 'framework', ip: active ? '10.42.1.1' : null, platform: 'linux' }),
      bluetooth_start: () => { active = true; return { supported: true, active: true, adapterName: 'framework', ip: '10.42.1.1', discoverable: true } }
    })
    renderModal({ match: MATCH, fetchImpl: okFetch(), win })
    tab(/Bluetooth/)
    fireEvent.click(await screen.findByRole('button', { name: 'Start Bluetooth network' }))
    await waitFor(() => expect(screen.getByText('http://10.42.1.1:5173/referee?match=match_1759740000000_ab12cd')).toBeInTheDocument())
    expect(screen.getByText(/pair with “framework”/)).toBeInTheDocument()
  })

  it('livescore: no LAN or Bluetooth link (the relay has no live table), the cloud link on Server', async () => {
    let active = true
    const win = tauri({
      hotspot_status: () => ({ supported: true, active, platform: 'linux', ssid: 'OpenVolley-AB12', password: 'example-Pq2m', gatewayIp: '10.42.0.1' }),
      bluetooth_status: () => ({ supported: true, active: true, adapterName: 'framework', ip: '10.42.1.1', platform: 'linux' })
    })
    renderModal({ match: MATCH, fetchImpl: okFetch(), win })
    // the open Wi-Fi brings the dialog to "Create Wi-Fi"
    await waitFor(() => expect(screen.getByText('http://10.42.0.1:5173/referee?match=match_1759740000000_ab12cd')).toBeInTheDocument())
    const row = () => screen.getByTestId('role-row-livescore')
    expect(within(row()).getByText('Needs internet: use the “Server” tab')).toBeInTheDocument()
    expect(within(row()).getByRole('button', { name: /QR/ })).toBeDisabled()
    expect(within(row()).getByRole('button', { name: /Copy/ })).toBeDisabled()

    tab(/Bluetooth/)
    await waitFor(() => expect(screen.getByText('http://10.42.1.1:5173/referee?match=match_1759740000000_ab12cd')).toBeInTheDocument())
    expect(within(row()).getByText('Needs internet: use the “Server” tab')).toBeInTheDocument()
    expect(within(row()).getByRole('button', { name: /QR/ })).toBeDisabled()

    tab(/Server/)
    expect(within(row()).getByText(/^https:\/\/livescore\.openvolley\.app\//)).toBeInTheDocument()
    expect(within(row()).getByRole('button', { name: /QR/ })).toBeEnabled()
    active = false
  })

  it('hall Wi-Fi: a hotspot switched on outside the app is offered as "This computer’s hotspot"', async () => {
    const status = { ...STATUS, localIP: '192.168.137.1', interfaces: [{ name: 'Local Area Connection* 10', ip: '192.168.137.1', kind: 'hotspot' }] }
    const win = tauri({
      // the app did not start it: Windows' quick settings did
      hotspot_status: () => ({ supported: true, active: false, platform: 'windows', method: 'mobile-hotspot', ssid: 'OpenVolley-AB12', password: 'example-Pq2m' }),
      bluetooth_status: () => ({ supported: false, reason: 'windows-cannot-serve', platform: 'windows' })
    })
    renderModal({ match: MATCH, fetchImpl: okFetch(status), win })
    await waitFor(() => expect(screen.getByText('http://192.168.137.1:5173/referee?match=match_1759740000000_ab12cd')).toBeInTheDocument())
    expect(screen.getByText('192.168.137.1 · This computer’s hotspot')).toBeInTheDocument()
    expect(screen.queryByText('No hall network')).toBeNull()

    // with the uplink too: both, the hotspot pickable
    cleanup()
    const both = { ...STATUS, interfaces: [...STATUS.interfaces, { name: 'Local Area Connection* 10', ip: '192.168.137.1', kind: 'hotspot' }] }
    renderModal({ match: MATCH, fetchImpl: okFetch(both), win })
    const select = await screen.findByRole('combobox', { name: 'Address' })
    expect(within(select).getByRole('option', { name: /192\.168\.137\.1 · This computer’s hotspot/ })).toBeInTheDocument()
    fireEvent.change(select, { target: { value: '192.168.137.1' } })
    expect(screen.getByText('http://192.168.137.1:5173/bench?match=match_1759740000000_ab12cd&team=home')).toBeInTheDocument()
  })

  it('create Wi-Fi: a hotspot the system runs shows its links and Wi-Fi code, and cannot be stopped here', async () => {
    const win = tauri({
      hotspot_status: () => ({ supported: true, active: true, external: true, platform: 'windows', method: 'mobile-hotspot', ssid: 'Luca-PC', password: 'home-secret', gatewayIp: '192.168.137.1', clients: 2, maxClients: 8 }),
      bluetooth_status: () => ({ supported: false, reason: 'windows-cannot-serve', platform: 'windows' })
    })
    renderModal({ match: MATCH, fetchImpl: okFetch(), win })
    await waitFor(() => expect(screen.getByText('http://192.168.137.1:5173/referee?match=match_1759740000000_ab12cd')).toBeInTheDocument())
    expect(screen.getByText(/switched on in the system settings/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop Wi-Fi' })).toBeDisabled()
    expect(within(screen.getByTestId('wifi-qr')).getByText('Luca-PC')).toBeInTheDocument()
    // the user's own hotspot settings are never stored as the tablets' Wi-Fi
    expect(localStorage.getItem('ov_tablet_wifi')).toBeNull()
  })

  it('create Wi-Fi on Windows: the firewall step once the Wi-Fi is on', async () => {
    const win = tauri({
      hotspot_status: () => ({ supported: true, active: true, platform: 'windows', method: 'mobile-hotspot', ssid: 'OpenVolley-AB12', password: 'example-Pq2m', gatewayIp: '192.168.137.1' }),
      bluetooth_status: () => ({ supported: false, reason: 'windows-cannot-serve', platform: 'windows' })
    })
    renderModal({ match: MATCH, fetchImpl: okFetch(), win })
    await waitFor(() => expect(screen.getByText(/Allow an app through firewall › OpenVolley › tick “Public”/)).toBeInTheDocument())
  })

  it('create Wi-Fi: cancelling the "leave the hall Wi-Fi" question starts nothing', async () => {
    relayTablets.value = { connections: { dashboardClients: 3 }, watchers: 3, referee: 1, benchHome: 1, benchAway: 0 }
    const win = tauri({
      hotspot_status: () => ({ supported: true, active: false, platform: 'linux', ssid: 'OpenVolley-AB12', password: 'example-Pq2m', takesOverWifi: true, leavesNetwork: 'Halle-WLAN' }),
      hotspot_start: () => ({ supported: true, active: true, ssid: 'OpenVolley-AB12', password: 'example-Pq2m', gatewayIp: '10.42.0.1' }),
      bluetooth_status: () => ({ supported: false })
    })
    renderModal({ match: MATCH, fetchImpl: okFetch(), win })
    fireEvent.click(screen.getByRole('radio', { name: 'Create Wi-Fi for tablets' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Create Wi-Fi' }))
    const dialog = await screen.findByTestId('confirm-dialog')
    expect(dialog).toHaveTextContent('This computer leaves Halle-WLAN')
    expect(dialog).toHaveTextContent('Tablets connected right now: 2.')
    fireEvent.click(screen.getByTestId('confirm-cancel'))
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull())
    expect(win.invoke).not.toHaveBeenCalledWith('hotspot_start', expect.anything())
  })

  it('create Wi-Fi: asks before stopping while tablets are on it; no question with none', async () => {
    let active = true
    const win = tauri({
      hotspot_status: () => ({ supported: true, active, platform: 'linux', ssid: 'OpenVolley-AB12', password: 'example-Pq2m', gatewayIp: active ? '10.42.0.1' : null }),
      hotspot_stop: () => { active = false; return { supported: true, active: false, ssid: 'OpenVolley-AB12', password: 'example-Pq2m' } },
      bluetooth_status: () => ({ supported: false })
    })
    relayTablets.value = { connections: { dashboardClients: 2 }, watchers: 2, referee: 1, benchHome: 0, benchAway: 0 }
    renderModal({ match: MATCH, fetchImpl: okFetch(), win })
    fireEvent.click(await screen.findByRole('button', { name: 'Stop Wi-Fi' }))
    expect(await screen.findByTestId('confirm-dialog')).toHaveTextContent('Tablets connected right now: 1.')
    fireEvent.click(screen.getByTestId('confirm-accept'))
    await waitFor(() => expect(win.invoke).toHaveBeenCalledWith('hotspot_stop', {}))

    cleanup()
    active = true
    win.invoke.mockClear()
    relayTablets.value = null
    renderModal({ match: MATCH, fetchImpl: okFetch(), win })
    fireEvent.click(await screen.findByRole('button', { name: 'Stop Wi-Fi' }))
    await waitFor(() => expect(win.invoke).toHaveBeenCalledWith('hotspot_stop', {}))
    expect(screen.queryByTestId('confirm-dialog')).toBeNull()
  })

  it('create Wi-Fi: "New password" replaces the remembered one before the start', async () => {
    localStorage.setItem('ov_tablet_wifi', JSON.stringify({ ssid: 'OpenVolley-AB12', password: 'leaked123456' }))
    const win = tauri({
      hotspot_status: () => ({ supported: true, active: false, platform: 'linux', ssid: 'OpenVolley-RUN1', password: 'session12345' }),
      bluetooth_status: () => ({ supported: false })
    })
    renderModal({ match: MATCH, fetchImpl: okFetch(), win })
    fireEvent.click(screen.getByRole('radio', { name: 'Create Wi-Fi for tablets' }))
    await waitFor(() => expect(screen.getByTestId('network-password')).toHaveTextContent('leaked123456'))
    fireEvent.click(screen.getByRole('button', { name: 'New password' }))
    await waitFor(() => expect(screen.getByTestId('network-password')).not.toHaveTextContent('leaked123456'))
    expect(screen.getByTestId('network-ssid')).toHaveTextContent('OpenVolley-AB12')
    expect(JSON.parse(localStorage.getItem('ov_tablet_wifi')).password).toBe(screen.getByTestId('network-password').textContent)
  })

  it('bluetooth tab: a Bluetooth network the computer only joined (Windows tethering) gives no links', async () => {
    const status = { ...STATUS, interfaces: [...STATUS.interfaces, { name: 'Bluetooth Network Connection', ip: '192.168.44.3', kind: 'bluetooth' }] }
    const win = tauri({
      hotspot_status: () => ({ supported: true, active: false, platform: 'windows', ssid: 'a', password: 'b' }),
      bluetooth_status: () => ({ supported: false, reason: 'windows-cannot-serve', platform: 'windows' })
    })
    renderModal({ match: MATCH, fetchImpl: okFetch(status), win })
    tab(/Bluetooth/)
    await waitFor(() => expect(screen.getByText(/Windows cannot host a Bluetooth network/)).toBeInTheDocument())
    expect(screen.queryByText(/192\.168\.44\.3/)).toBeNull()
    for (const role of ['main', 'referee', 'bench_home', 'bench_away']) {
      expect(within(screen.getByTestId(`role-row-${role}`)).getByRole('button', { name: /Copy/ })).toBeDisabled()
    }
  })

  it('bluetooth tab: a Bluetooth network not started by this run cannot be stopped here', async () => {
    const win = tauri({
      hotspot_status: () => ({ supported: true, active: false, ssid: 'a', password: 'b' }),
      bluetooth_status: () => ({ supported: true, active: true, external: true, adapterName: 'framework', ip: '10.42.1.1', platform: 'linux' })
    })
    renderModal({ match: MATCH, fetchImpl: okFetch(), win })
    tab(/Bluetooth/)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop Bluetooth network' })).toBeDisabled())
    expect(screen.getByText(/not started by this app run/)).toBeInTheDocument()
  })

  it('without a local server (web build) the LAN tab points to the desktop app', () => {
    backend.statusUrl = null
    renderModal({ match: null, fetchImpl: okFetch(), win: {} })
    // opens on Server; LAN explains
    expect(screen.getByRole('radio', { name: /Server/ })).toHaveAttribute('aria-checked', 'true')
    tab(/LAN/)
    expect(screen.getByText(/need the OpenVolley desktop app/)).toBeInTheDocument()
    expect(screen.getAllByText('Open a match to get links and PINs for it.').length).toBeGreaterThan(0)
  })
})
