/**
 * The game PIN notice before the coin toss (components/MatchPinNotice.jsx):
 * the PIN large with the owner's sentence; "Send to my email" asks the server
 * (POST /api/match/send-pin) for the signed-in account's own address only;
 * any other address goes to the device's mail app (mailto:), never to the
 * server. Made-up names and addresses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, opts) => String(typeof fallback === 'string' ? fallback : key)
      .replace(/\{\{(\w+)\}\}/g, (_, k) => String((typeof fallback === 'object' ? fallback : opts)?.[k] ?? ''))
  })
}))
const env = vi.hoisted(() => ({ url: 'https://backend.example/api/match/send-pin', token: 'tok' }))
vi.mock('../../utils/backendConfig', () => ({ getCloudApiUrl: () => env.url }))
vi.mock('../../lib/apiClient', () => ({ authorizationHeader: () => (env.token ? { Authorization: `Bearer ${env.token}` } : {}) }))

import MatchPinNotice from '../MatchPinNotice'

const MATCH = {
  id: 7, status: 'setup', seed_key: 'match_7_setup', gamePin: '654321',
  homeName: 'Alpha VC', awayName: 'Beta VC', game_n: 991501, league: '3L',
  scheduledAt: '2026-11-21T18:00:00.000Z'
}
const WRITE_DOWN = 'Please write the PIN down somewhere: it is needed to recover the match and/or to reopen it.'

function show (props = {}) {
  const onClose = vi.fn()
  const sendPin = vi.fn(async () => ({ success: true, status: 200 }))
  const openMail = vi.fn(() => ({ ok: true, mode: 'external' }))
  render(<MatchPinNotice open match={MATCH} onClose={onClose} sendPin={sendPin} openMail={openMail} {...props} />)
  return { onClose, sendPin, openMail }
}

beforeEach(() => {
  env.url = 'https://backend.example/api/match/send-pin'
  env.token = 'tok'
})
afterEach(() => cleanup())

describe('MatchPinNotice', () => {
  it('shows the game PIN large with the sentence, the match and OK', async () => {
    const { onClose } = show()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByTestId('pin-notice-pin')).toHaveTextContent('654321')
    expect(screen.getByTestId('pin-notice-pin').className).toMatch(/sm:text-5xl/)
    expect(screen.getByText(WRITE_DOWN)).toBeInTheDocument()
    expect(screen.getByText('Alpha VC – Beta VC · 21.11.2026 19:00 · Game 991501')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('pin-notice-ok'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('the backdrop does not close it (a stray tap never skips the PIN)', async () => {
    const { onClose } = show()
    const backdrop = screen.getByRole('dialog').parentElement
    fireEvent.pointerDown(backdrop)
    fireEvent.pointerUp(backdrop)
    fireEvent.click(backdrop)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('signed in: "Send to my email" asks the server for the account address, with the PIN to check, never an address', async () => {
    const { sendPin, openMail } = show({ accountEmail: 'sina@example.ch', prefillEmail: 'other@example.ch' })
    const button = screen.getByTestId('pin-notice-send-account')
    expect(button).toHaveTextContent('Send to my email (sina@example.ch)')
    fireEvent.click(button)
    await screen.findByText('Sent to sina@example.ch.')
    expect(sendPin).toHaveBeenCalledTimes(1)
    const [args] = sendPin.mock.calls[0]
    expect(args).toEqual({ url: env.url, headers: { Authorization: 'Bearer tok' }, externalId: 'match_7_setup', gamePin: '654321' })
    expect(JSON.stringify(args)).not.toContain('other@example.ch')
    expect(openMail).not.toHaveBeenCalled()
    expect(button).toBeDisabled()
  })

  it.each([
    [{ status: 409, code: 'OV_EMAIL_UNCONFIRMED' }, 'Confirm your email address first, or use your mail app below.'],
    [{ status: 409, code: 'OV_PIN_MISMATCH' }, 'The server has another PIN for this match. Use your mail app below.'],
    [{ status: 404 }, 'The match is not on the server yet. Use your mail app below.'],
    [{ status: 429 }, 'Too many emails in a short time. Try again in a minute, or use your mail app below.'],
    // a backend without the route yet, or no mailer: the mail app is the way
    [{ status: 503 }, 'The email could not be sent. Use your mail app below.'],
    [{ status: 0, network: true }, 'No connection to the server – use your mail app below.']
  ])('a refused send (%o) says why and points to the mail app', async (answer, text) => {
    const sendPin = vi.fn(async () => ({ success: false, ...answer }))
    show({ accountEmail: 'sina@example.ch', sendPin })
    fireEvent.click(screen.getByTestId('pin-notice-send-account'))
    expect(await screen.findByText(text)).toBeInTheDocument()
    expect(screen.getByTestId('pin-notice-mail-app')).toBeEnabled()
  })

  it('signed out (or unconfirmed): no server button, the mail app only', () => {
    show({ accountEmail: null, prefillEmail: 'sina@example.ch' })
    expect(screen.queryByTestId('pin-notice-send-account')).toBeNull()
    expect(screen.getByLabelText('Email address')).toHaveValue('sina@example.ch')
  })

  it('no server button without a cloud backend or a session token', () => {
    env.url = null
    show({ accountEmail: 'sina@example.ch' })
    expect(screen.queryByTestId('pin-notice-send-account')).toBeNull()
    cleanup()
    env.url = 'https://backend.example/api/match/send-pin'
    env.token = null
    show({ accountEmail: 'sina@example.ch' })
    expect(screen.queryByTestId('pin-notice-send-account')).toBeNull()
  })

  it('"Open in mail app" opens a mailto: with the typed address, match, teams, date and PIN', async () => {
    const { openMail, sendPin } = show({ accountEmail: 'sina@example.ch', prefillEmail: 'sina@example.ch' })
    const field = screen.getByLabelText('Another address')
    fireEvent.change(field, { target: { value: 'coach@example.ch' } })
    fireEvent.click(screen.getByTestId('pin-notice-mail-app'))
    expect(openMail).toHaveBeenCalledTimes(1)
    const href = openMail.mock.calls[0][0]
    expect(href.startsWith('mailto:coach@example.ch?')).toBe(true)
    const url = new URL(href)
    expect(url.searchParams.get('subject')).toBe('Game PIN: Alpha VC – Beta VC')
    expect(url.searchParams.get('body').split('\r\n')).toEqual([
      'Alpha VC – Beta VC', 'Game 991501', 'League: 3L', 'Date: 21.11.2026 19:00', '', 'Game PIN: 654321', '', WRITE_DOWN
    ])
    expect(await screen.findByText('Your mail app opened with the PIN. Send it from there.')).toBeInTheDocument()
    // nothing for a typed address goes through the server
    expect(sendPin).not.toHaveBeenCalled()
  })

  it('an invalid address is refused inline; an empty one lets the mail app ask', () => {
    const { openMail } = show({ prefillEmail: '' })
    const field = screen.getByLabelText('Email address')
    fireEvent.change(field, { target: { value: 'not an address' } })
    fireEvent.click(screen.getByTestId('pin-notice-mail-app'))
    expect(openMail).not.toHaveBeenCalled()
    expect(screen.getByText('Please enter a valid email address')).toBeInTheDocument()
    expect(field).toHaveAttribute('aria-invalid', 'true')
    fireEvent.change(field, { target: { value: '' } })
    fireEvent.click(screen.getByTestId('pin-notice-mail-app'))
    expect(openMail).toHaveBeenCalledTimes(1)
    expect(openMail.mock.calls[0][0].startsWith('mailto:?subject=')).toBe(true)
  })

  it('a mail app that could not be opened says so', async () => {
    const openMail = vi.fn(() => ({ ok: false, mode: 'blocked' }))
    show({ prefillEmail: 'sina@example.ch', openMail })
    fireEvent.click(screen.getByTestId('pin-notice-mail-app'))
    expect(await screen.findByText('The mail app could not be opened. Write the PIN down instead.')).toBeInTheDocument()
  })

  it('nothing while closed', () => {
    render(<MatchPinNotice open={false} match={MATCH} onClose={() => {}} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText('654321')).toBeNull()
  })

  it('no account button while offline, and it says why', async () => {
    const onLine = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false)
    try {
      show({ accountEmail: 'sina@example.ch' })
      expect(screen.getByTestId('pin-notice-send-account')).toBeDisabled()
      expect(screen.getByText('No connection to the server – use your mail app below.')).toBeInTheDocument()
    } finally {
      onLine.mockRestore()
    }
    await waitFor(() => expect(screen.getByTestId('pin-notice-mail-app')).toBeEnabled())
  })
})
