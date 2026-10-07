/**
 * The "Sign on phone" panel (components/signature/PhoneSignPanel.jsx,
 * docs/qr-signing-spec.md 5.3, 8.5) with a fake protocol API: starting, the
 * QR value and link, copy and share, the countdown, opened / received / use /
 * discard, the wait aborted and the session closed on unmount, the 45 s hint
 * on the hall network, and the fallback to the other way when start fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import en from '../../i18n/locales/en.json'

const lookup = (key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), en)
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => {
      const found = lookup(key)
      if (typeof found === 'string') return found.replace(/\{\{(\w+)\}\}/g, (_, k) => (opts && opts[k] !== undefined ? opts[k] : ''))
      return typeof opts === 'string' ? opts : key
    },
    i18n: { language: 'en' }
  })
}))
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => null }))

import PhoneSignPanel from '../signature/PhoneSignPanel'

const CLOUD = { ok: true, apiBase: 'https://backend.test', phoneBase: 'https://backend.test' }
const LAN = { ok: true, apiBase: 'http://localhost:5173', phoneBase: 'http://192.168.1.10:5173', addresses: [{ ip: '192.168.1.10', kind: 'wifi' }], ip: '192.168.1.10', wifiStep: false }
const both = { cloud: CLOUD, lan: LAN, default: 'cloud', reason: null }
const PAD = { w: 4000, h: 2000 }
const STROKES = [[0, 1000, 300, 1000]]

function fakeApi({ startFails = {} } = {}) {
  const waits = []
  let n = 0
  const api = {
    waits,
    startPhoneSign: vi.fn(async (o) => {
      if (startFails[o.transport]) return startFails[o.transport]
      n++
      return { ok: true, handle: { transport: o.transport, apiBase: o.apiBase, phoneBase: o.phoneBase, token: `T${n}`.padEnd(43, 'x'), watch: `W${n}`.padEnd(43, 'y'), ttlSeconds: 600, startedAt: Date.now() } }
    }),
    waitPhoneSign: vi.fn((handle, known, { signal } = {}) => new Promise((resolve) => {
      const w = { handle, known, resolve, aborted: false }
      signal?.addEventListener('abort', () => { w.aborted = true; resolve({ ok: false, code: 'OV_SIGN_ABORTED' }) })
      waits.push(w)
    })),
    closePhoneSign: vi.fn(async () => ({ ok: true })),
    phoneSignUrl: (h) => `${h.phoneBase}/sign#k=${h.token}`,
  }
  /** Answer the newest pending wait. */
  api.answer = async (r) => {
    await waitFor(() => expect(waits.some((w) => !w.done && !w.aborted)).toBe(true))
    const w = [...waits].reverse().find((x) => !x.done && !x.aborted)
    w.done = true
    await act(async () => { w.resolve(r) })
  }
  return api
}

const props = (api, over = {}) => ({
  transports: both,
  slot: 'captain-a',
  matchKey: 'seed-1',
  context: { home: 'A', away: 'B' },
  gamePin: '987654',
  onUse: vi.fn(),
  api,
  renderSignature: (pad, strokes) => `data:image/png;base64,${pad.w}x${strokes.length}`,
  ...over,
})

beforeEach(() => {
  try { localStorage.clear() } catch { /* none */ }
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('PhoneSignPanel', () => {
  it('starts on the default way and shows the link of the phone page', async () => {
    const api = fakeApi()
    render(<PhoneSignPanel {...props(api)} />)
    await waitFor(() => expect(screen.getByTestId('phone-sign-link')).toHaveTextContent('https://backend.test/sign#k=T1'))
    expect(api.startPhoneSign).toHaveBeenCalledWith(expect.objectContaining({
      transport: 'cloud', apiBase: 'https://backend.test', phoneBase: 'https://backend.test', slot: 'captain-a', matchKey: 'seed-1', gamePin: '987654', context: { home: 'A', away: 'B' }
    }))
    expect(screen.getByTestId('phone-sign-qr').querySelector('svg')).toBeTruthy()
    expect(screen.getByTestId('phone-sign-status')).toHaveTextContent(en.phoneSign.waiting)
    expect(screen.getByTestId('phone-sign-countdown')).toHaveTextContent('Link valid for 10:00')
    expect(screen.getByText(en.phoneSign.scanHint, { selector: 'p' })).toBeInTheDocument()
    // The first wait asks with the state the device knows
    await waitFor(() => expect(api.waitPhoneSign).toHaveBeenCalledWith(expect.objectContaining({ watch: expect.stringMatching(/^W1/) }), 'pending', expect.anything()))
  })

  it('opened, then received: Use hands over the image and closes the link', async () => {
    const api = fakeApi()
    const p = props(api)
    render(<PhoneSignPanel {...p} />)
    await api.answer({ ok: true, state: 'opened' })
    await waitFor(() => expect(screen.getByTestId('phone-sign-status')).toHaveTextContent(en.phoneSign.opened))
    await waitFor(() => expect(api.waitPhoneSign).toHaveBeenLastCalledWith(expect.anything(), 'opened', expect.anything()))
    await api.answer({ ok: true, state: 'signed', pad: PAD, strokes: STROKES })
    expect(await screen.findByTestId('phone-signature-preview')).toHaveAttribute('src', 'data:image/png;base64,4000x1')
    expect(screen.getByText(en.phoneSign.received)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('phone-sign-use'))
    expect(p.onUse).toHaveBeenCalledWith('data:image/png;base64,4000x1', { source: 'phone', transport: 'cloud' })
    expect(api.closePhoneSign).toHaveBeenCalledWith(expect.objectContaining({ watch: expect.stringMatching(/^W1/) }), expect.anything())
  })

  it('strokes that break the rules are refused', async () => {
    const api = fakeApi()
    render(<PhoneSignPanel {...props(api)} />)
    await api.answer({ ok: true, state: 'signed', pad: PAD, strokes: [[1, 1]] })
    await waitFor(() => expect(screen.getByTestId('phone-sign-status')).toHaveTextContent(en.phoneSign.startFailed))
    expect(screen.queryByTestId('phone-signature-preview')).toBeNull()
  })

  it('Discard closes the link and makes a new one', async () => {
    const api = fakeApi()
    const p = props(api)
    render(<PhoneSignPanel {...p} />)
    await api.answer({ ok: true, state: 'signed', pad: PAD, strokes: STROKES })
    fireEvent.click(await screen.findByTestId('phone-sign-discard'))
    await waitFor(() => expect(screen.getByTestId('phone-sign-link')).toHaveTextContent('#k=T2'))
    expect(api.closePhoneSign).toHaveBeenCalledTimes(1)
    expect(p.onUse).not.toHaveBeenCalled()
  })

  it('expired and cancelled links offer a new one', async () => {
    const api = fakeApi()
    render(<PhoneSignPanel {...props(api)} />)
    await api.answer({ ok: true, state: 'expired' })
    expect(await screen.findByTestId('phone-sign-status')).toHaveTextContent(en.phoneSign.expired)
    fireEvent.click(screen.getByTestId('phone-sign-new-link'))
    await waitFor(() => expect(api.startPhoneSign).toHaveBeenCalledTimes(2))
    await api.answer({ ok: true, state: 'closed' })
    expect(await screen.findByTestId('phone-sign-status')).toHaveTextContent(en.phoneSign.cancelled)
    // A relay that forgot the session (restart, D4): expired
    fireEvent.click(screen.getByTestId('phone-sign-new-link'))
    await api.answer({ ok: false, code: 'OV_SIGN_NOT_FOUND' })
    expect(await screen.findByTestId('phone-sign-status')).toHaveTextContent(en.phoneSign.expired)
  })

  it('an unreachable relay is asked again, but not past the link\'s life', async () => {
    const api = fakeApi()
    // The relay is down: every wait fails at once
    api.waitPhoneSign.mockImplementation(async () => ({ ok: false, status: 0, code: 'OV_SIGN_NETWORK', network: true }))
    const born = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(born)
    render(<PhoneSignPanel {...props(api)} />)
    await waitFor(() => expect(api.waitPhoneSign).toHaveBeenCalledTimes(1))
    // 16 minutes later (the tablet slept): one more try, then it stops
    clock.mockReturnValue(born + 16 * 60 * 1000)
    await waitFor(() => expect(api.waitPhoneSign).toHaveBeenCalledTimes(2), { timeout: 4000 })
    expect(await screen.findByTestId('phone-sign-status')).toHaveTextContent(en.phoneSign.expired)
    await new Promise((r) => setTimeout(r, 2500))
    expect(api.waitPhoneSign).toHaveBeenCalledTimes(2)
  })

  it('closing the dialog aborts the wait and closes the link', async () => {
    const api = fakeApi()
    const { unmount } = render(<PhoneSignPanel {...props(api)} />)
    await waitFor(() => expect(api.waitPhoneSign).toHaveBeenCalled())
    unmount()
    expect(api.waits[0].aborted).toBe(true)
    expect(api.closePhoneSign).toHaveBeenCalledWith(expect.objectContaining({ watch: expect.stringMatching(/^W1/) }), { keepalive: true })
  })

  it('a start that fails on the internet falls back to the hall network once', async () => {
    const api = fakeApi({ startFails: { cloud: { ok: false, status: 0, code: 'OV_SIGN_NETWORK', network: true } } })
    render(<PhoneSignPanel {...props(api)} />)
    await waitFor(() => expect(screen.getByTestId('phone-sign-link')).toHaveTextContent('http://192.168.1.10:5173/sign#k=T1'))
    expect(api.startPhoneSign.mock.calls.map((c) => c[0].transport)).toEqual(['cloud', 'lan'])
  })

  it('a refused start with no other way says so', async () => {
    const api = fakeApi({ startFails: { cloud: { ok: false, status: 429, code: 'OV_SIGN_RATE_LIMITED' } } })
    render(<PhoneSignPanel {...props(api, { transports: { cloud: CLOUD, lan: { ok: false, reason: 'noRelay' }, default: 'cloud' } })} />)
    expect(await screen.findByTestId('phone-sign-status')).toHaveTextContent(en.phoneSign.startFailed)
    expect(api.startPhoneSign).toHaveBeenCalledTimes(1)
  })

  it('a start refused for the account says why: signed out (401) or no role (403)', async () => {
    const onlyCloud = { cloud: CLOUD, lan: { ok: false, reason: 'noRelay' }, default: 'cloud' }
    let api = fakeApi({ startFails: { cloud: { ok: false, status: 401, code: 'OV_AUTH_REQUIRED' } } })
    render(<PhoneSignPanel {...props(api, { transports: onlyCloud })} />)
    expect(await screen.findByTestId('phone-sign-status')).toHaveTextContent(en.phoneSign.reasonSignIn)
    cleanup()
    api = fakeApi({ startFails: { cloud: { ok: false, status: 403, code: 'OV_SIGN_FORBIDDEN' } } })
    render(<PhoneSignPanel {...props(api, { transports: onlyCloud })} />)
    expect(await screen.findByTestId('phone-sign-status')).toHaveTextContent(en.phoneSign.reasonRole)
    expect(screen.getByTestId('phone-sign-new-link')).toBeInTheDocument()
  })

  it('both ways: the switch makes a new link on the other one and is remembered', async () => {
    const api = fakeApi()
    render(<PhoneSignPanel {...props(api)} />)
    await waitFor(() => expect(screen.getByTestId('phone-sign-link')).toHaveTextContent('#k=T1'))
    fireEvent.click(screen.getByRole('radio', { name: en.phoneSign.transportHall }))
    await waitFor(() => expect(screen.getByTestId('phone-sign-link')).toHaveTextContent('http://192.168.1.10:5173/sign#k=T2'))
    expect(api.closePhoneSign).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('ov_phone_sign_transport')).toBe('lan')
  })

  it('copies the link, or says to scan when copying is refused', async () => {
    const api = fakeApi()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(async () => {})
    render(<PhoneSignPanel {...props(api)} />)
    fireEvent.click(await screen.findByTestId('phone-sign-copy'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://backend.test/sign#k=' + 'T1'.padEnd(43, 'x')))
    expect(await screen.findByText(en.phoneSign.linkCopied)).toBeInTheDocument()
    writeText.mockRejectedValueOnce(new Error('denied'))
    fireEvent.click(screen.getByTestId('phone-sign-copy'))
    expect(await screen.findByText(en.phoneSign.copyFailedUseQr)).toBeInTheDocument()
  })

  it('shares the link where the device can', async () => {
    const api = fakeApi()
    const share = vi.fn(async () => {})
    Object.defineProperty(navigator, 'share', { configurable: true, value: share })
    try {
      render(<PhoneSignPanel {...props(api)} />)
      const btn = await screen.findByTestId('phone-sign-copy')
      expect(btn).toHaveTextContent(en.phoneSign.sendLink)
      fireEvent.click(btn)
      await waitFor(() => expect(share).toHaveBeenCalledWith({ url: expect.stringContaining('/sign#k=T1') }))
    } finally {
      delete navigator.share
    }
  })

  it('on the hall network, says after 45 s that the Wi-Fi may keep the phone out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const api = fakeApi()
    const open = vi.fn()
    render(<PhoneSignPanel {...props(api, { transports: { ...both, default: 'lan' }, onOpenConnectTablets: open })} />)
    await waitFor(() => expect(screen.getByTestId('phone-sign-link')).toHaveTextContent('192.168.1.10'))
    expect(screen.queryByTestId('phone-sign-hall-hint')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(44000) })
    expect(screen.queryByTestId('phone-sign-hall-hint')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    await waitFor(() => expect(screen.getByTestId('phone-sign-hall-hint')).toHaveTextContent(en.phoneSign.hallBlocked))
    fireEvent.click(screen.getByText(en.phoneSign.openConnectTablets))
    expect(open).toHaveBeenCalled()
  })

  it('the laptop\'s own Wi-Fi: the Wi-Fi QR code comes first', async () => {
    const api = fakeApi()
    const lan = { ...LAN, wifiStep: true, wifi: { ssid: 'OpenVolley-1234', password: 'secret-pass' }, phoneBase: 'http://10.42.0.1:5173' }
    render(<PhoneSignPanel {...props(api, { transports: { cloud: { ok: false }, lan, default: 'lan' } })} />)
    expect(await screen.findByTestId('phone-sign-wifi-qr')).toHaveTextContent('OpenVolley-1234')
    expect(screen.getByText(en.phoneSign.joinWifiFirst)).toBeInTheDocument()
  })
})
