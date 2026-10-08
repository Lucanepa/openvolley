/**
 * Laptop run of 2026-10-08 (OV-15): the first opening of a signature pad
 * flashed "Sign in to sign on a phone..." for 24 ms (the dialog 402 -> 350
 * px) before the local server's status arrived and offered the hall network.
 * The reason shows only once the check has answered.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import en from '../../i18n/locales/en.json'

const lookup = (key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), en)
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => {
      const found = lookup(key)
      if (typeof found === 'string') return found
      return typeof opts === 'string' ? opts : key
    },
    i18n: { language: 'en' }
  })
}))
const auth = vi.hoisted(() => ({ value: null }))
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => { if (!auth.value) throw new Error('no provider'); return auth.value } }))
const cfg = vi.hoisted(() => ({ cloud: null }))
vi.mock('../../utils/backendConfig', async (orig) => ({
  ...(await orig()),
  getCloudApiBaseUrl: () => cfg.cloud,
  getLocalServerStatusUrl: () => 'http://127.0.0.1:5173/api/local-server/status',
  isCloudBlockedOnThisPort: () => false,
  isServedFromLanOrigin: () => false
}))
const api = vi.hoisted(() => ({ start: null, close: null }))
vi.mock('../../lib/phoneSignApi', () => ({
  startPhoneSign: (...a) => api.start(...a),
  waitPhoneSign: () => new Promise(() => {}),
  closePhoneSign: (...a) => api.close(...a),
  phoneSignUrl: (h) => `${h.phoneBase}/sign#k=${h.token}`
}))

import SignaturePad from '../SignaturePad'

const PHONE = { slot: 'scorer', matchKey: 'seed-1', context: { home: 'A', away: 'B' } }

let answer
beforeEach(() => {
  auth.value = null
  cfg.cloud = 'https://backend.test'
  api.start = vi.fn()
  api.close = vi.fn(async () => ({ ok: true }))
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true })
  // the local server's status: answered when the test says so
  globalThis.fetch = vi.fn(() => new Promise((resolve) => { answer = resolve }))
  // jsdom has no 2D canvas: the pad sets its canvas up in a timer
  const ctx = { scale() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, clearRect() {}, fillRect() {} }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SignaturePad: the reason waits for the local server check', () => {
  it('no "sign in" reason while the check runs; the reason once it says no', async () => {
    render(<SignaturePad open onClose={() => {}} onSave={() => {}} title="Scorer" phone={PHONE} />)
    expect(globalThis.fetch).toHaveBeenCalled()
    // the first render already: no reason flashing before the answer
    expect(screen.queryByTestId('sign-on-phone-reason')).toBeNull()
    expect(screen.getByTestId('sign-on-phone')).toBeDisabled()

    await act(async () => { answer({ ok: false, json: async () => null }) })
    await waitFor(() => expect(screen.getByTestId('sign-on-phone-reason')).toHaveTextContent(en.phoneSign.reasonSignIn))
  })
})
