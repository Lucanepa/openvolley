import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k, o) => (o?.field ? `${k}:${o.field}` : k) })
}))
vi.mock('../../../db/db', () => ({ db: { matches: { get: async () => null } } }))
vi.mock('../../signature/PhoneSignPanel', () => ({
  usePhoneSignTransports: () => ({ loading: false, transports: { default: 'lan', lan: { ok: true, apiBase: '', phoneBase: 'http://hall' } } })
}))
// The pairing controller of the whole app (phonePairStore), as a store the test drives
const fake = vi.hoisted(() => {
  const listeners = new Set()
  const c = {
    state: { status: 'idle', phoneConnected: false, handle: null, matchId: 7, arrival: null, ended: null },
    set(patch) { c.state = { ...c.state, ...patch }; for (const fn of listeners) fn() },
    unpair: null, start: null, reset: null, setHideKeyboard: () => {},
    getState: () => c.state,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
  }
  return c
})
vi.mock('../../../utils/phonePair/controller', () => ({ createPhonePairController: () => fake }))

import PhonePairHost, { PhonePairIndicator } from '../PhonePairHost'
import PhonePairDock from '../PhonePairDock'
import PhonePairPanel from '../PhonePairPanel'
import { closePhonePairPanel, registerPhonePairDock } from '../phonePairStore'

const handle = { code: 'ABCD1234', startedAt: Date.now(), key: 'k', phoneBase: 'http://hall' }

beforeEach(() => {
  fake.unpair = vi.fn(async () => { fake.set({ status: 'ended', ended: fake.state.status === 'paired' ? 'unpaired' : 'stopped', handle: null }) })
  fake.start = vi.fn()
  fake.reset = vi.fn()
  act(() => { closePhonePairPanel(); fake.set({ status: 'idle', phoneConnected: false, handle: null, ended: null, arrival: null }) })
})

describe('the "Phone keyboard" indicator', () => {
  it('while the pairing waits for the phone: × stops it; once paired only the keyboard (the panel)', () => {
    const onOpen = vi.fn()
    const onStop = vi.fn()
    const { rerender } = render(<PhonePairIndicator variant="phone" status="pending" label="Phone keyboard · waiting" stopLabel="Stop pairing" onOpen={onOpen} onStop={onStop} />)
    // in a bar: the keyboard alone, the words its name
    expect(screen.getByRole('button', { name: 'Phone keyboard · waiting' }).textContent).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Stop pairing' }))
    expect(onStop).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Phone keyboard · waiting' }))
    expect(onOpen).toHaveBeenCalledTimes(1)
    rerender(<PhonePairIndicator variant="phone" status="paired" phoneConnected label="Phone keyboard" stopLabel="Stop pairing" onOpen={onOpen} onStop={onStop} />)
    expect(screen.queryByRole('button', { name: 'Stop pairing' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Phone keyboard' })).toBeInTheDocument()
  })

  it('the corner pill keeps its words', () => {
    render(<PhonePairIndicator variant="corner" status="pending" label="Phone keyboard · waiting" stopLabel="Stop pairing" onOpen={() => {}} onStop={() => {}} />)
    expect(screen.getByTestId('phone-pair-indicator').textContent).toBe('Phone keyboard · waiting')
  })
})

describe('where the indicator sits', () => {
  it('in the screen\'s own bar when it keeps a slot (PhonePairDock), not in the fixed corner', () => {
    render(
      <>
        <header data-testid="bar"><PhonePairDock variant="phone" /><span>Title</span></header>
        <PhonePairHost />
      </>
    )
    act(() => fake.set({ status: 'pending', handle }))
    const pill = screen.getByTestId('phone-pair-pill')
    expect(screen.getByTestId('bar').contains(pill)).toBe(true)
    expect(pill.dataset.variant).toBe('phone')
    expect(pill.closest('.fixed')).toBeNull()
    // its × stops the waiting pairing; the indicator goes
    fireEvent.click(screen.getByRole('button', { name: 'phonePair.stop' }))
    expect(fake.unpair).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('phone-pair-pill')).toBeNull()
  })

  it('in the fixed corner on a screen without a slot; the newest slot wins, and its leaving moves it back', () => {
    render(<PhonePairHost />)
    act(() => fake.set({ status: 'paired', phoneConnected: true, handle }))
    expect(screen.getByTestId('phone-pair-pill').dataset.variant).toBe('corner')
    expect(screen.getByTestId('phone-pair-pill').closest('.fixed')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'phonePair.stop' })).toBeNull() // paired: Unpair is in the panel

    const a = document.createElement('span')
    a.dataset.variant = 'toolbar'
    const b = document.createElement('span')
    b.dataset.variant = 'strip'
    document.body.append(a, b)
    let offA
    let offB
    act(() => { offA = registerPhonePairDock(a) })
    act(() => { offB = registerPhonePairDock(b) })
    expect(b.querySelector('[data-testid=phone-pair-pill]').dataset.variant).toBe('strip')
    expect(a.querySelector('[data-testid=phone-pair-pill]')).toBeNull()
    act(() => offB())
    expect(a.querySelector('[data-testid=phone-pair-pill]').dataset.variant).toBe('toolbar')
    act(() => offA())
    expect(screen.getByTestId('phone-pair-pill').dataset.variant).toBe('corner')
    a.remove()
    b.remove()
  })
})

describe('the pairing panel', () => {
  it('offers Stop pairing while it waits for the phone; then says it stopped and offers a new one', () => {
    act(() => fake.set({ status: 'pending', handle }))
    const { rerender } = render(<PhonePairPanel match={{ matchId: 7, matchKey: 'seed-1', context: {} }} onClose={() => {}} controller={fake} />)
    expect(screen.getByTestId('phone-pair-code')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('phone-pair-stop'))
    expect(fake.unpair).toHaveBeenCalledTimes(1)
    rerender(<PhonePairPanel match={{ matchId: 7, matchKey: 'seed-1', context: {} }} onClose={() => {}} controller={fake} />)
    expect(screen.getByTestId('phone-pair-status').textContent).toBe('phonePair.stopped')
    expect(screen.getByTestId('phone-pair-again')).toBeInTheDocument()
  })
})
