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
  matchTeamNames: (m, { homeTeam, awayTeam } = {}) => ({ home: m?.homeName || homeTeam || null, away: m?.awayName || awayTeam || null })
}))
const dbMock = vi.hoisted(() => ({
  matches: { update: vi.fn(async () => 1), get: vi.fn() },
  sync_queue: { add: vi.fn(async () => 1) },
  teams: { get: vi.fn(async (id) => ({ 11: { name: 'KSC Wiedikon' }, 12: { name: 'Volley Luzern' } })[id]) }
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

const SEED = 'match_1759740000000_ab12cd'

/** Step 1: pick a connection by its card's name. */
const choose = (name) => fireEvent.click(screen.getByRole('radio', { name }))
/** Step 2: pick a tablet. */
const pick = (role) => fireEvent.click(within(screen.getByTestId(`role-row-${role}`)).getByRole('radio'))
/** Step 3: the link the shown code encodes, or null without a code. */
const qrUrl = () => screen.queryByTestId('role-qr')?.getAttribute('data-url') || null
const scanText = () => screen.getByTestId('qr-panel').textContent

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

  it('hall Wi-Fi: three steps, one code per tablet, PINs only on the scorer\'s screen', async () => {
    renderModal({ match: MATCH, fetchImpl: okFetch(), win: {} })
    expect(screen.getByText('Connect tablets')).toBeInTheDocument()
    expect(screen.getByText('How tablets connect')).toBeInTheDocument()
    expect(screen.getByText('Which tablet')).toBeInTheDocument()
    expect(screen.getByText('Scan, then enter the PIN')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Hall Wi-Fi' })).toHaveAttribute('aria-checked', 'true')
    expect(within(screen.getByTestId('transport-hall')).getByText('Recommended')).toBeInTheDocument()

    // the referee is let in and picked first
    await waitFor(() => expect(qrUrl()).toBe(`http://192.168.1.42:5173/referee?match=${SEED}`))
    expect(screen.getByTestId('pin-referee')).toHaveTextContent('123 456')
    expect(screen.getByTestId('pin-referee')).toHaveAttribute('aria-label', 'PIN 1 2 3 4 5 6')

    pick('bench_home')
    expect(qrUrl()).toBe(`http://192.168.1.42:5173/bench?match=${SEED}&team=home`)
    expect(screen.getByTestId('pin-bench_home')).toHaveTextContent('234 567')
    expect(within(screen.getByTestId('role-row-bench_home')).getByText('VBC Zürich')).toBeInTheDocument()

    // the away bench is off: no code (its tablet would be told the PIN is wrong), no PIN
    pick('bench_away')
    expect(qrUrl()).toBeNull()
    expect(screen.queryByTestId('pin-bench_away')).toBeNull()
    expect(screen.getByTestId('scan-off')).toHaveTextContent('Away bench is off. A tablet that scans now is told its PIN is wrong.')
    expect(within(screen.getByTestId('role-row-bench_away')).getByText('Off · turn on to show its PIN')).toBeInTheDocument()

    // livescore follows the relay on the hall Wi-Fi: a code, no match, no PIN
    pick('livescore')
    expect(qrUrl()).toBe('http://192.168.1.42:5173/livescore')
    expect(screen.queryByTestId('pin-livescore')).toBeNull()
    expect(scanText()).toContain('No PIN needed')

    // the scoretable link sits in the footer, explained
    expect(screen.getByTestId('role-row-main')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Scorer on another computer' }))
    expect(screen.getByTestId('role-row-main')).toHaveTextContent('It does not follow this match.')

    // never the game PIN
    expect(document.body.textContent).not.toContain('999999')
    expect(document.body.textContent).not.toContain('999 999')
  })

  it('switches the hall address, and remembers it', async () => {
    renderModal({ match: MATCH, fetchImpl: okFetch(), win: {} })
    const select = await screen.findByRole('combobox', { name: 'Address' })
    fireEvent.change(select, { target: { value: '10.0.0.5' } })
    expect(qrUrl()).toBe(`http://10.0.0.5:5173/referee?match=${SEED}`)
    expect(JSON.parse(localStorage.getItem('ov_connect_tablets_view'))).toEqual({ tab: 'lan', lanMode: 'hall', hallIp: '10.0.0.5' })

    cleanup()
    renderModal({ match: MATCH, fetchImpl: okFetch(), win: {} })
    await waitFor(() => expect(qrUrl()).toBe(`http://10.0.0.5:5173/referee?match=${SEED}`))
  })

  it('lets a role in: local match and the cloud copy with every PIN', async () => {
    dbMock.matches.get.mockResolvedValue({ ...MATCH, awayTeamConnectionEnabled: true })
    renderModal({ match: MATCH, fetchImpl: okFetch(), win: {} })
    fireEvent.click(screen.getByRole('switch', { name: 'Let Away bench in' }))
    await waitFor(() => expect(dbMock.sync_queue.add).toHaveBeenCalled())
    expect(dbMock.matches.update).toHaveBeenCalledWith(7, { awayTeamConnectionEnabled: true })
    const payload = dbMock.sync_queue.add.mock.calls[0][0].payload
    expect(payload).toMatchObject({ id: MATCH.seed_key, connections: { away_bench_enabled: true } })
    expect(payload.connection_pins).toMatchObject({ referee: '123456', bench_home: '234567', bench_away: '345678' })
    // flipping the switch picks that tablet too
    expect(within(screen.getByTestId('role-row-bench_away')).getByRole('radio')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('pin-bench_away')).toHaveTextContent('345 678')
  })

  it('an off role is let in from step 3 as well', async () => {
    dbMock.matches.get.mockResolvedValue({ ...MATCH, awayTeamConnectionEnabled: true })
    renderModal({ match: MATCH, fetchImpl: okFetch(), win: {} })
    pick('bench_away')
    fireEvent.click(screen.getByRole('button', { name: 'Let Away bench in' }))
    await waitFor(() => expect(dbMock.matches.update).toHaveBeenCalledWith(7, { awayTeamConnectionEnabled: true }))
    await waitFor(() => expect(qrUrl()).toBe(`http://192.168.1.42:5173/bench?match=${SEED}&team=away`))
  })

  it('starts on the first tablet that is let in', () => {
    renderModal({ match: { ...MATCH, refereeConnectionEnabled: false }, fetchImpl: okFetch(), win: {} })
    expect(within(screen.getByTestId('role-row-bench_home')).getByRole('radio')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('scan-title')).toHaveTextContent('Home bench tablet')
  })

  it('a bench let in without a PIN says so and shows no code', () => {
    renderModal({ match: { ...MATCH, homeTeamPin: null }, fetchImpl: okFetch(), win: {} })
    pick('bench_home')
    expect(qrUrl()).toBeNull()
    expect(scanText()).toContain('This tablet has no PIN yet. Set one in Match setup › Connections.')
    expect(within(screen.getByTestId('role-row-bench_home')).getByText('On · no PIN yet')).toBeInTheDocument()
  })

  it('live status: waiting, then connected with the time and the address', async () => {
    relayTablets.value = {
      reachable: true,
      connections: {
        clients: [{ id: 'c1', role: 'referee', matchId: SEED, ip: '192.168.1.23', connectedAt: '2026-10-07T12:32:05.000Z' }]
      },
      referee: 1,
      benchHome: 0,
      benchAway: 0
    }
    renderModal({ match: MATCH, fetchImpl: okFetch(), win: {} })
    // a tablet already in shows with the code, in one change (the dialog
    // keeps its placeholders until everything it reads has answered)
    await waitFor(() => expect(qrUrl()).not.toBeNull())
    expect(screen.getByTestId('scan-status')).toHaveTextContent('Tablet connected at 14:32 (…23)')
    expect(screen.getByTestId('role-status-referee')).toHaveTextContent('Connected · since 14:32')
    expect(screen.getByTestId('role-status-referee')).toHaveAttribute('data-status', 'connected')
    expect(screen.getByTestId('role-status-bench_home')).toHaveTextContent('Waiting for the tablet…')
    expect(screen.getByTestId('role-status-bench_away')).toHaveAttribute('data-status', 'off')
    expect(screen.getByTestId('scan-status')).toHaveTextContent('Tablet connected at 14:32 (…23)')
    expect(screen.getByTestId('devices-connected')).toHaveTextContent('Connected: Referee · 1 of 2 tablets')
    pick('bench_home')
    expect(screen.getByTestId('scan-status')).toHaveTextContent('Waiting for the tablet…')
  })

  it('bench cards name the team from the teams table when the match has only its id', async () => {
    const { homeName: _h, awayName: _a, ...bare } = MATCH
    renderModal({ match: { ...bare, homeTeamId: 11, awayTeamId: 12 }, fetchImpl: okFetch(), win: {} })
    await waitFor(() => expect(screen.getByTestId('role-row-bench_home')).toHaveTextContent('KSC Wiedikon'))
    expect(screen.getByTestId('role-row-bench_away')).toHaveTextContent('Volley Luzern')
  })

  it('footer: one tablet let in and connected reads without "1 of 1 tablets"', async () => {
    relayTablets.value = {
      reachable: true,
      connections: { clients: [{ role: 'referee', matchId: SEED, ip: '192.168.1.23', connectedAt: '2026-10-06T12:32:00.000Z' }] },
      referee: 1,
      benchHome: 0,
      benchAway: 0
    }
    renderModal({ match: { ...MATCH, homeTeamConnectionEnabled: false }, fetchImpl: okFetch(), win: {} })
    await waitFor(() => expect(screen.getByTestId('devices-connected')).toHaveTextContent('Connected: Referee'))
    expect(screen.getByTestId('devices-connected')).not.toHaveTextContent('of')
  })

  it('live status: never "waiting" when the relay cannot be read', () => {
    renderModal({ match: MATCH, fetchImpl: okFetch(), win: {} })
    expect(screen.getByTestId('role-status-referee')).toHaveTextContent('Live status not available')
    expect(screen.getByTestId('devices-connected')).toHaveTextContent('Live status not available')
  })

  it('in a browser: no Wi-Fi button, the desktop app and a travel router instead', async () => {
    renderModal({ match: MATCH, fetchImpl: okFetch(), win: {} })
    expect(within(screen.getByTestId('transport-laptop')).getByText('Needs the desktop app (Windows, Linux)')).toBeInTheDocument()
    choose('Wi-Fi from this computer')
    expect(screen.getByText(/desktop app \(Windows, Linux\) can create its own Wi-Fi/)).toBeInTheDocument()
    expect(screen.getByText(/travel router/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Create Wi-Fi/ })).toBeNull()
    expect(screen.getByTestId('scan-no-link')).toHaveTextContent('Needs the desktop app')
  })

  it('desktop app: creates the Wi-Fi and shows its code in step 1, the tablet\'s code in step 3', async () => {
    let active = false
    const win = tauri({
      hotspot_status: () => ({ supported: true, active, platform: 'linux', method: 'networkmanager', ssid: 'OpenVolley-AB12', password: 'example-Pq2m', takesOverWifi: true, gatewayIp: active ? '10.42.0.1' : null }),
      hotspot_start: () => { active = true; return { supported: true, active: true, ssid: 'OpenVolley-AB12', password: 'example-Pq2m', gatewayIp: '10.42.0.1' } },
      hotspot_stop: () => { active = false; return { supported: true, active: false, ssid: 'OpenVolley-AB12', password: 'example-Pq2m' } },
      bluetooth_status: () => ({ supported: false })
    })
    renderModal({ match: MATCH, fetchImpl: okFetch(), win })
    choose('Wi-Fi from this computer')
    await waitFor(() => expect(screen.getByTestId('network-ssid')).toHaveTextContent('OpenVolley-AB12'))
    expect(screen.getByTestId('network-password')).toHaveTextContent('example-Pq2m')
    expect(screen.getByText(/leaves its current Wi-Fi/)).toBeInTheDocument()
    expect(screen.queryByTestId('wifi-qr')).toBeNull()
    expect(screen.getByTestId('scan-no-link')).toHaveTextContent('Create the Wi-Fi first (step 1)')
    // nothing to scan yet: no "waiting for the tablet"
    expect(screen.queryByTestId('scan-status')).toBeNull()

    // one card: it leaves the hall Wi-Fi, so it asks first
    fireEvent.click(screen.getByRole('button', { name: 'Create Wi-Fi' }))
    expect(await screen.findByTestId('confirm-dialog')).toHaveTextContent('Leave the hall Wi-Fi?')
    fireEvent.click(screen.getByTestId('confirm-accept'))
    await waitFor(() => expect(screen.getByTestId('wifi-qr')).toBeInTheDocument())
    expect(within(screen.getByTestId('hotspot-panel')).getByTestId('wifi-qr')).toBeInTheDocument()
    expect(screen.getByTestId('wifi-qr-caption')).toHaveTextContent('Scan to join this Wi-Fi first')
    expect(win.invoke).toHaveBeenCalledWith('hotspot_start', {})
    expect(qrUrl()).toBe(`http://10.42.0.1:5173/referee?match=${SEED}`)
    expect(within(screen.getByTestId('wifi-qr')).getByText('OpenVolley-AB12')).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('ov_tablet_wifi'))).toEqual({ ssid: 'OpenVolley-AB12', password: 'example-Pq2m' })
    // the join steps wait behind "How to join"
    expect(screen.queryByText(/Choose “Stay connected”/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'How to join' }))
    expect(screen.getByText(/Choose “Stay connected”/)).toBeInTheDocument()

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
    await waitFor(() => expect(within(screen.getByTestId('transport-laptop')).getByText('This computer cannot create a Wi-Fi')).toBeInTheDocument())
    choose('Wi-Fi from this computer')
    await waitFor(() => expect(screen.getByText(/cannot act as an access point/)).toBeInTheDocument())
    expect(screen.getByText('wlp1s0')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create Wi-Fi' })).toBeNull()
  })

  it('internet, signed out: sign in first; the link can be copied but there is no code yet', async () => {
    authState.value = { user: null }
    renderModal({ match: MATCH, fetchImpl: okFetch(), win: {} })
    choose('Internet')
    expect(screen.getByTestId('server-game-number')).toHaveTextContent('4711')
    expect(screen.getByText('Synced')).toBeInTheDocument()
    expect(screen.getByText('Not signed in')).toBeInTheDocument()
    expect(qrUrl()).toBeNull()
    expect(screen.getByTestId('scan-no-link')).toHaveTextContent('Sign in first (step 1)')
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Type the address' }))
    expect(screen.getByTestId('scan-url')).toHaveTextContent(`https://referee.openvolley.app/?server=https%3A%2F%2Fbackend.openvolley.app&match=${SEED}`)
    pick('bench_home')
    fireEvent.click(screen.getByRole('button', { name: 'Type the address' }))
    expect(screen.getByTestId('scan-url')).toHaveTextContent(`https://bench.openvolley.app/?server=https%3A%2F%2Fbackend.openvolley.app&match=${SEED}&team=home`)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(screen.getByTestId('login-modal')).toBeInTheDocument()
  })

  it('internet, signed in: the cloud code, and a status that does not pretend to see cloud tablets', () => {
    authState.value = { user: { email: 'scorer@example.org' } }
    relayTablets.value = { reachable: true, connections: { clients: [] }, referee: 0, benchHome: 0, benchAway: 0 }
    renderModal({ match: MATCH, fetchImpl: okFetch(), win: {} })
    choose('Internet')
    expect(screen.getByTestId('server-account')).toHaveTextContent('scorer@example.org')
    expect(qrUrl()).toBe(`https://referee.openvolley.app/?server=https%3A%2F%2Fbackend.openvolley.app&match=${SEED}`)
    expect(screen.getByTestId('pin-referee')).toHaveTextContent('123 456')
    expect(screen.getByTestId('role-status-referee')).toHaveTextContent('On · status not visible over the internet')
    expect(screen.getByTestId('scan-status')).toHaveTextContent('Ask them to confirm they are in')
    expect(screen.getByTestId('devices-connected')).toHaveTextContent('Live status shows tablets on this network only')
  })

  it('internet where the cloud is blocked: dimmed with the reason, no links', () => {
    backend.cloudBlocked = true
    authState.value = { user: { email: 'scorer@example.org' } }
    localStorage.setItem('ov_connect_tablets_view', JSON.stringify({ tab: 'server', lanMode: 'hall' }))
    renderModal({ match: MATCH, fetchImpl: okFetch(), win: {} })
    // the saved choice cannot work here: the recommendation instead
    expect(screen.getByRole('radio', { name: 'Hall Wi-Fi' })).toHaveAttribute('aria-checked', 'true')
    expect(within(screen.getByTestId('transport-server')).getByText('Cloud is off in this app window')).toBeInTheDocument()
    choose('Internet')
    expect(screen.getByText(/does not run on port 5173/)).toBeInTheDocument()
    expect(qrUrl()).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull()
  })

  it('bluetooth: Windows says it cannot serve a Bluetooth network', async () => {
    const win = tauri({
      hotspot_status: () => ({ supported: true, active: false, platform: 'windows', ssid: 'a', password: 'b' }),
      bluetooth_status: () => ({ supported: false, reason: 'windows-cannot-serve', platform: 'windows' })
    })
    renderModal({ match: MATCH, fetchImpl: okFetch(), win })
    await waitFor(() => expect(within(screen.getByTestId('transport-bluetooth')).getByText('Windows cannot host a Bluetooth network')).toBeInTheDocument())
    choose('Bluetooth')
    await waitFor(() => expect(screen.getByText(/Windows cannot host a Bluetooth network for tablets/)).toBeInTheDocument())
    expect(screen.queryByText(/Planned: a direct Bluetooth link/)).toBeNull()
    expect(screen.getByText(/Wi-Fi from this computer” instead/)).toBeInTheDocument()
    expect(screen.getByTestId('scan-no-link')).toHaveTextContent('Not available on this computer')
  })

  it('bluetooth: Linux starts the network and links its address', async () => {
    let active = false
    const win = tauri({
      hotspot_status: () => ({ supported: true, active: false, ssid: 'a', password: 'b' }),
      bluetooth_status: () => ({ supported: true, active, adapterName: 'framework', ip: active ? '10.42.1.1' : null, platform: 'linux' }),
      bluetooth_start: () => { active = true; return { supported: true, active: true, adapterName: 'framework', ip: '10.42.1.1', discoverable: true } }
    })
    renderModal({ match: MATCH, fetchImpl: okFetch(), win })
    choose('Bluetooth')
    expect(within(screen.getByTestId('transport-bluetooth')).getByText('Experimental')).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Start Bluetooth network' }))
    await waitFor(() => expect(qrUrl()).toBe(`http://10.42.1.1:5173/referee?match=${SEED}`))
    fireEvent.click(screen.getByRole('button', { name: 'How to pair' }))
    expect(screen.getByText(/pair with “framework”/)).toBeInTheDocument()
  })

  it('livescore: a code on the laptop\'s Wi-Fi and Bluetooth (the relay feed), the cloud link on Internet', async () => {
    const win = tauri({
      hotspot_status: () => ({ supported: true, active: true, platform: 'linux', ssid: 'OpenVolley-AB12', password: 'example-Pq2m', gatewayIp: '10.42.0.1' }),
      bluetooth_status: () => ({ supported: true, active: true, adapterName: 'framework', ip: '10.42.1.1', platform: 'linux' })
    })
    renderModal({ match: MATCH, fetchImpl: okFetch(), win })
    // the open Wi-Fi brings the dialog to "Wi-Fi from this computer"
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Wi-Fi from this computer' })).toHaveAttribute('aria-checked', 'true'))
    pick('livescore')
    await waitFor(() => expect(qrUrl()).toBe('http://10.42.0.1:5173/livescore'))
    expect(within(screen.getByTestId('role-row-livescore')).getByText('Public · no PIN')).toBeInTheDocument()
    expect(within(screen.getByTestId('role-row-livescore')).queryByRole('switch')).toBeNull()

    choose('Bluetooth')
    await waitFor(() => expect(qrUrl()).toBe('http://10.42.1.1:5173/livescore'))

    choose('Internet')
    expect(qrUrl()).toMatch(/^https:\/\/livescore\.openvolley\.app\//)
  })

  it('hall Wi-Fi: a hotspot switched on outside the app is offered as "This computer’s hotspot"', async () => {
    const status = { ...STATUS, localIP: '192.168.137.1', interfaces: [{ name: 'Local Area Connection* 10', ip: '192.168.137.1', kind: 'hotspot' }] }
    const win = tauri({
      // the app did not start it: Windows' quick settings did
      hotspot_status: () => ({ supported: true, active: false, platform: 'windows', method: 'mobile-hotspot', ssid: 'OpenVolley-AB12', password: 'example-Pq2m' }),
      bluetooth_status: () => ({ supported: false, reason: 'windows-cannot-serve', platform: 'windows' })
    })
    renderModal({ match: MATCH, fetchImpl: okFetch(status), win })
    await waitFor(() => expect(qrUrl()).toBe(`http://192.168.137.1:5173/referee?match=${SEED}`))
    expect(screen.getByTestId('hall-address')).toHaveTextContent('This computer: 192.168.137.1 (This computer’s hotspot)')

    // with the uplink too: both, the hotspot pickable
    cleanup()
    const both = { ...STATUS, interfaces: [...STATUS.interfaces, { name: 'Local Area Connection* 10', ip: '192.168.137.1', kind: 'hotspot' }] }
    renderModal({ match: MATCH, fetchImpl: okFetch(both), win })
    const select = await screen.findByRole('combobox', { name: 'Address' })
    expect(within(select).getByRole('option', { name: /192\.168\.137\.1 · This computer’s hotspot/ })).toBeInTheDocument()
    fireEvent.change(select, { target: { value: '192.168.137.1' } })
    pick('bench_home')
    expect(qrUrl()).toBe(`http://192.168.137.1:5173/bench?match=${SEED}&team=home`)
  })

  it('hall Wi-Fi: names the Wi-Fi to join where the system says it', async () => {
    const win = tauri({
      hotspot_status: () => ({ supported: true, active: false, platform: 'linux', ssid: 'a', password: 'b', takesOverWifi: true, leavesNetwork: 'Halle-WLAN' }),
      bluetooth_status: () => ({ supported: false })
    })
    renderModal({ match: MATCH, fetchImpl: okFetch(), win })
    await waitFor(() => expect(screen.getByText('Tablets join the Wi-Fi “Halle-WLAN”.')).toBeInTheDocument())
    expect(screen.getByTestId('isolation-tip')).toHaveTextContent('Some hall Wi-Fis keep devices apart')
  })

  // The hall panel's text came in three steps within 83 ms on opening:
  // "Reading the local server…", the addresses (server answered), then the
  // Wi-Fi to join (the system answered). It now waits for both.
  it('hall Wi-Fi: the addresses and the Wi-Fi name come in one change', async () => {
    let answer
    const win = tauri({
      hotspot_status: () => new Promise(resolve => { answer = resolve }),
      bluetooth_status: () => ({ supported: false })
    })
    const fetchImpl = okFetch()
    renderModal({ match: MATCH, fetchImpl, win })
    await waitFor(() => expect(answer).toBeTypeOf('function'))
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 20))
    // the server has answered, the system not yet: still reading
    expect(screen.getByTestId('hall-panel')).toHaveTextContent('Reading the local server…')
    expect(screen.queryByText(/Tablets join/)).toBeNull()
    // nor the referee's code (step 3), which needs the same address
    expect(qrUrl()).toBeNull()
    answer({ supported: true, active: false, platform: 'linux', ssid: 'a', password: 'b', takesOverWifi: true, leavesNetwork: 'Halle-WLAN' })
    await waitFor(() => expect(screen.getByText('Tablets join the Wi-Fi “Halle-WLAN”.')).toBeInTheDocument())
    expect(screen.getByTestId('hall-panel')).not.toHaveTextContent('Reading the local server…')

    expect(qrUrl()).toBeTruthy()
  })

  it('the live status and the bench teams come with the addresses, in one change', async () => {
    relayTablets.value = {
      checked: true,
      reachable: true,
      connections: { clients: [{ id: 'c1', role: 'referee', matchId: SEED, ip: '192.168.1.23', connectedAt: '2026-10-07T12:32:05.000Z' }] },
      referee: 1,
      benchHome: 0,
      benchAway: 0
    }
    let answer
    const win = tauri({
      hotspot_status: () => new Promise(resolve => { answer = resolve }),
      bluetooth_status: () => ({ supported: false })
    })
    const { homeName: _h, awayName: _a, ...bare } = MATCH
    renderModal({ match: { ...bare, homeTeamId: 11, awayTeamId: 12 }, fetchImpl: okFetch(), win })
    await waitFor(() => expect(answer).toBeTypeOf('function'))
    await waitFor(() => expect(dbMock.teams.get).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 20))
    // the relay and the database have answered, the Wi-Fi not yet: nothing of it shows
    expect(screen.getByTestId('role-row-bench_home')).not.toHaveTextContent('KSC Wiedikon')
    expect(screen.getByTestId('role-status-referee')).not.toHaveTextContent('Connected')
    answer({ supported: true, active: false, platform: 'linux', ssid: 'a', password: 'b', takesOverWifi: true, leavesNetwork: 'Halle-WLAN' })
    await waitFor(() => expect(screen.getByText('Tablets join the Wi-Fi “Halle-WLAN”.')).toBeInTheDocument())
    expect(screen.getByTestId('role-row-bench_home')).toHaveTextContent('KSC Wiedikon')
    expect(screen.getByTestId('role-status-referee')).toHaveTextContent('Connected · since 14:32')
  })

  it('create Wi-Fi: a hotspot the system runs shows its codes, and cannot be stopped here', async () => {
    const win = tauri({
      hotspot_status: () => ({ supported: true, active: true, external: true, platform: 'windows', method: 'mobile-hotspot', ssid: 'Luca-PC', password: 'home-secret', gatewayIp: '192.168.137.1', clients: 2, maxClients: 8 }),
      bluetooth_status: () => ({ supported: false, reason: 'windows-cannot-serve', platform: 'windows' })
    })
    renderModal({ match: MATCH, fetchImpl: okFetch(), win })
    await waitFor(() => expect(qrUrl()).toBe(`http://192.168.137.1:5173/referee?match=${SEED}`))
    expect(screen.getByText(/switched on in the system settings/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop Wi-Fi' })).toBeDisabled()
    expect(within(screen.getByTestId('wifi-qr')).getByText('Luca-PC')).toBeInTheDocument()
    expect(screen.getByText('2 of 8 devices joined')).toBeInTheDocument()
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

  it('Windows with the installer’s firewall rule: no manual firewall step, on either Wi-Fi', async () => {
    const win = tauri({
      firewall_status: () => ({ platform: 'windows', supported: true, ready: true, reason: null }),
      hotspot_status: () => ({ supported: true, active: true, platform: 'windows', method: 'mobile-hotspot', ssid: 'OpenVolley-AB12', password: 'example-Pq2m', gatewayIp: '192.168.137.1' }),
      bluetooth_status: () => ({ supported: false, reason: 'windows-cannot-serve', platform: 'windows' })
    })
    renderModal({ match: MATCH, fetchImpl: okFetch(), win })
    await waitFor(() => expect(qrUrl()).toBe(`http://192.168.137.1:5173/referee?match=${SEED}`))
    await waitFor(() => expect(win.invoke).toHaveBeenCalledWith('firewall_status', {}))
    expect(screen.queryByText(/tick “Public”/)).toBeNull()
    choose('Hall Wi-Fi')
    await waitFor(() => expect(qrUrl()).toBe(`http://192.168.1.42:5173/referee?match=${SEED}`))
    expect(screen.queryByTestId('firewall-step')).toBeNull()
  })

  it('Windows: no firewall step while the check has not answered (no flash on every opening)', async () => {
    let answer
    const win = tauri({
      firewall_status: () => new Promise(resolve => { answer = resolve }),
      hotspot_status: () => ({ supported: true, active: true, platform: 'windows', method: 'mobile-hotspot', ssid: 'OpenVolley-AB12', password: 'example-Pq2m', gatewayIp: '192.168.137.1' }),
      bluetooth_status: () => ({ supported: false, reason: 'windows-cannot-serve', platform: 'windows' })
    })
    renderModal({ match: MATCH, fetchImpl: okFetch(), win })
    // the hotspot (platform windows) has answered, the firewall check not yet
    await waitFor(() => expect(qrUrl()).toBe(`http://192.168.137.1:5173/referee?match=${SEED}`))
    await waitFor(() => expect(answer).toBeTypeOf('function'))
    expect(screen.queryByText(/tick “Public”/)).toBeNull()
    choose('Hall Wi-Fi')
    await waitFor(() => expect(qrUrl()).toBe(`http://192.168.1.42:5173/referee?match=${SEED}`))
    expect(screen.queryByTestId('firewall-step')).toBeNull()
    // then a Block rule for the app: the step
    answer({ platform: 'windows', supported: true, ready: false, reason: 'blocked-by-rule' })
    await waitFor(() => expect(screen.getByTestId('firewall-step')).toHaveTextContent('tick “Public”'))
  })

  it('Windows without the rule (dev build, rule removed): the manual step on the hall Wi-Fi too', async () => {
    const win = tauri({
      firewall_status: () => ({ platform: 'windows', supported: true, ready: false, reason: 'rule-missing' }),
      hotspot_status: () => ({ supported: true, active: false, platform: 'windows', method: 'mobile-hotspot', ssid: 'OpenVolley-AB12', password: 'example-Pq2m' }),
      bluetooth_status: () => ({ supported: false, reason: 'windows-cannot-serve', platform: 'windows' })
    })
    renderModal({ match: MATCH, fetchImpl: okFetch(), win })
    await waitFor(() => expect(screen.getByTestId('firewall-step')).toHaveTextContent('Allow an app through firewall › OpenVolley › tick “Public”'))
  })

  it('Linux: never a Windows firewall step', async () => {
    const win = tauri({
      firewall_status: () => ({ platform: 'linux', supported: false, ready: false, reason: 'unsupported-os' }),
      hotspot_status: () => ({ supported: true, active: true, platform: 'linux', ssid: 'OpenVolley-AB12', password: 'example-Pq2m', gatewayIp: '10.42.0.1' }),
      bluetooth_status: () => ({ supported: false })
    })
    renderModal({ match: MATCH, fetchImpl: okFetch(), win })
    await waitFor(() => expect(qrUrl()).toBe(`http://10.42.0.1:5173/referee?match=${SEED}`))
    await waitFor(() => expect(win.invoke).toHaveBeenCalledWith('firewall_status', {}))
    expect(screen.queryByText(/tick “Public”/)).toBeNull()
    choose('Hall Wi-Fi')
    expect(screen.queryByTestId('firewall-step')).toBeNull()
  })

  it('create Wi-Fi: cancelling the "leave the hall Wi-Fi" question starts nothing', async () => {
    relayTablets.value = { connections: { dashboardClients: 3 }, watchers: 3, referee: 1, benchHome: 1, benchAway: 0 }
    const win = tauri({
      hotspot_status: () => ({ supported: true, active: false, platform: 'linux', ssid: 'OpenVolley-AB12', password: 'example-Pq2m', takesOverWifi: true, leavesNetwork: 'Halle-WLAN' }),
      hotspot_start: () => ({ supported: true, active: true, ssid: 'OpenVolley-AB12', password: 'example-Pq2m', gatewayIp: '10.42.0.1' }),
      bluetooth_status: () => ({ supported: false })
    })
    renderModal({ match: MATCH, fetchImpl: okFetch(), win })
    choose('Wi-Fi from this computer')
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
    choose('Wi-Fi from this computer')
    await waitFor(() => expect(screen.getByTestId('network-password')).toHaveTextContent('leaked123456'))
    fireEvent.click(screen.getByRole('button', { name: 'New password' }))
    await waitFor(() => expect(screen.getByTestId('network-password')).not.toHaveTextContent('leaked123456'))
    expect(screen.getByTestId('network-ssid')).toHaveTextContent('OpenVolley-AB12')
    expect(JSON.parse(localStorage.getItem('ov_tablet_wifi')).password).toBe(screen.getByTestId('network-password').textContent)
  })

  it('bluetooth: a Bluetooth network the computer only joined (Windows tethering) gives no links', async () => {
    const status = { ...STATUS, interfaces: [...STATUS.interfaces, { name: 'Bluetooth Network Connection', ip: '192.168.44.3', kind: 'bluetooth' }] }
    const win = tauri({
      hotspot_status: () => ({ supported: true, active: false, platform: 'windows', ssid: 'a', password: 'b' }),
      bluetooth_status: () => ({ supported: false, reason: 'windows-cannot-serve', platform: 'windows' })
    })
    renderModal({ match: MATCH, fetchImpl: okFetch(status), win })
    choose('Bluetooth')
    await waitFor(() => expect(screen.getByText(/Windows cannot host a Bluetooth network for tablets/)).toBeInTheDocument())
    expect(screen.queryByText(/192\.168\.44\.3/)).toBeNull()
    for (const role of ['referee', 'bench_home', 'livescore']) {
      pick(role)
      expect(qrUrl()).toBeNull()
      expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull()
    }
  })

  it('bluetooth: a Bluetooth network not started by this run cannot be stopped here', async () => {
    const win = tauri({
      hotspot_status: () => ({ supported: true, active: false, ssid: 'a', password: 'b' }),
      bluetooth_status: () => ({ supported: true, active: true, external: true, adapterName: 'framework', ip: '10.42.1.1', platform: 'linux' })
    })
    renderModal({ match: MATCH, fetchImpl: okFetch(), win })
    choose('Bluetooth')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop Bluetooth network' })).toBeDisabled())
    expect(screen.getByText(/not started by this app run/)).toBeInTheDocument()
  })

  it('without a local server (web build): opens on Internet; Hall Wi-Fi points to the desktop app', () => {
    backend.statusUrl = null
    localStorage.setItem('ov_connect_tablets_view', JSON.stringify({ tab: 'lan', lanMode: 'hall' }))
    renderModal({ match: null, fetchImpl: okFetch(), win: {} })
    // the saved hall choice cannot work in a browser
    expect(screen.getByRole('radio', { name: 'Internet' })).toHaveAttribute('aria-checked', 'true')
    expect(within(screen.getByTestId('transport-hall')).getByText('Needs the desktop app or a venue box')).toBeInTheDocument()
    expect(within(screen.getByTestId('transport-server')).getByText('Recommended')).toBeInTheDocument()
    choose('Hall Wi-Fi')
    expect(screen.getByText(/need the OpenVolley desktop app/)).toBeInTheDocument()
    expect(screen.getByText(/In a browser, choose Internet\./)).toBeInTheDocument()
    // no match: no tablets, no codes
    expect(screen.getByTestId('no-match')).toHaveTextContent('Open a match first')
    expect(screen.queryByTestId('qr-panel')).toBeNull()
  })

  it('arrow keys move the choice in step 1 and step 2', () => {
    renderModal({ match: MATCH, fetchImpl: okFetch(), win: {} })
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Hall Wi-Fi' }), { key: 'ArrowDown' })
    expect(screen.getByRole('radio', { name: 'Wi-Fi from this computer' })).toHaveAttribute('aria-checked', 'true')
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Wi-Fi from this computer' }))
    fireEvent.keyDown(within(screen.getByTestId('role-row-referee')).getByRole('radio'), { key: 'ArrowDown' })
    expect(within(screen.getByTestId('role-row-bench_home')).getByRole('radio')).toHaveAttribute('aria-checked', 'true')
  })

  it('no hover-only tooltips (title=) anywhere in the dialog', async () => {
    authState.value = { user: null }
    renderModal({ match: MATCH, fetchImpl: okFetch(), win: {} })
    await waitFor(() => expect(qrUrl()).not.toBeNull())
    expect(screen.getByRole('dialog').querySelectorAll('[title]')).toHaveLength(0)
    choose('Internet')
    expect(screen.getByRole('dialog').querySelectorAll('[title]')).toHaveLength(0)
  })
})
