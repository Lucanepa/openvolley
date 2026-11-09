import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k, opts) => (opts && typeof opts === 'object' && Object.keys(opts).some((x) => x !== 'defaultValue') ? `${k}:${JSON.stringify(Object.fromEntries(Object.entries(opts).filter(([x]) => x !== 'defaultValue')))}` : k) })
}))

const relay = { listeners: new Set(), sent: [], open: true }
vi.mock('../../../utils/serverDataSync', () => ({
  addRelayMessageListener: (_id, fn) => { relay.listeners.add(fn); return () => relay.listeners.delete(fn) },
  sendRelayMessage: (_id, payload) => { if (!relay.open) return false; relay.sent.push(payload); return true }
}))
const fromRelay = (m) => act(() => { for (const fn of relay.listeners) fn(m) })

import BenchRequestPanel from '../BenchRequestPanel'

const players = [
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((number) => ({ number, isCaptain: number === 7 })),
  { number: 13, libero: 'libero1' }
]
const LU = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 }
const base = (events = [], extra = {}) => ({
  match: { coinTossConfirmed: true },
  set: { index: 1, homePoints: 0, awayPoints: 0, finished: false },
  allSets: [{ index: 1, finished: false }],
  events,
  liveState: null,
  ...extra
})

beforeEach(() => {
  relay.listeners.clear()
  relay.sent = []
  relay.open = true
})

describe('BenchRequestPanel', () => {
  it('before the set: line-up open, time-out and substitution after the line-up', () => {
    render(<BenchRequestPanel matchId="seed-1" team="home" data={base()} players={players} />)
    expect(screen.getByRole('button', { name: /benchRequests.lineup/ })).toBeEnabled()
    const to = document.querySelector('[data-bench-request="timeout"]')
    expect(to).toBeDisabled()
    expect(to.textContent).toContain('benchRequests.unavailable.no_lineup')
    expect(document.querySelector('[data-bench-request="substitution"]')).toBeDisabled()
  })

  it('sends a line-up with the game captain when the captain is not among the six, then shows the answer', () => {
    render(<BenchRequestPanel matchId="seed-1" team="home" data={base()} players={players} />)
    fireEvent.click(document.querySelector('[data-bench-request="lineup"]'))
    const dialog = screen.getByRole('dialog')
    // liberos are not offered
    expect(dialog.querySelector('[data-lineup-player="13"]')).toBeNull()
    for (const n of [1, 2, 3, 4, 5, 6]) fireEvent.click(dialog.querySelector(`[data-lineup-player="${n}"]`))
    const send = dialog.querySelector('[data-bench-lineup-send]')
    expect(send).toBeDisabled() // 7 is not on court: game captain first
    fireEvent.click(dialog.querySelector('[data-game-captain="4"]'))
    expect(send).toBeEnabled()
    fireEvent.click(send)
    expect(relay.sent).toHaveLength(1)
    const sent = relay.sent[0]
    expect(sent).toMatchObject({ type: 'bench-request', matchId: 'seed-1', team: 'home', request: { kind: 'lineup', setIndex: 1, lineup: LU, gameCaptain: 4 } })
    const caption = () => document.querySelector('[data-bench-request-caption="lineup"]').textContent
    expect(caption()).toBe('benchRequests.status.sending')
    fromRelay({ type: 'bench-request-ack', team: 'home', id: sent.request.id, status: 'pending', delivered: 1, superseded: [] })
    expect(caption()).toBe('benchRequests.status.pending')
    fromRelay({ type: 'bench-response', team: 'home', id: sent.request.id, status: 'declined', reason: 'No 6 is injured' })
    expect(caption()).toContain('benchRequests.status.declinedBecause')
    expect(caption()).toContain('No 6 is injured')
    // sent again (prefilled from the last one), accepted: locked
    fireEvent.click(document.querySelector('[data-bench-request="lineup"]'))
    fireEvent.click(screen.getByRole('dialog').querySelector('[data-bench-lineup-send]'))
    const again = relay.sent[1]
    expect(again.request.lineup).toEqual(LU)
    fromRelay({ type: 'bench-response', team: 'home', id: again.request.id, status: 'accepted' })
    expect(document.querySelector('[data-bench-request="lineup"]')).toBeDisabled()
    expect(caption()).toBe('benchRequests.done.lineup')
  })

  it('no connection: the request is not sent and says so', () => {
    relay.open = false
    render(<BenchRequestPanel matchId="seed-1" team="home" data={base([{ type: 'lineup', setIndex: 1, seq: 1, payload: { team: 'home', lineup: { ...LU, VI: 7 } } }])} players={players} />)
    fireEvent.click(document.querySelector('[data-bench-request="timeout"]'))
    expect(relay.sent).toHaveLength(0)
    expect(document.querySelector('[data-bench-request-caption="timeout"]').textContent).toBe('benchRequests.status.notSent')
  })

  it('a socket that does not answer: not sent after a few seconds', () => {
    vi.useFakeTimers()
    try {
      render(<BenchRequestPanel matchId="seed-1" team="home" data={base([{ type: 'lineup', setIndex: 1, seq: 1, payload: { team: 'home', lineup: { ...LU, VI: 7 } } }])} players={players} />)
      fireEvent.click(document.querySelector('[data-bench-request="timeout"]'))
      expect(document.querySelector('[data-bench-request-caption="timeout"]').textContent).toBe('benchRequests.status.sending')
      act(() => { vi.advanceTimersByTime(6500) })
      expect(document.querySelector('[data-bench-request-caption="timeout"]').textContent).toBe('benchRequests.status.notSent')
      expect(document.querySelector('[data-bench-request="timeout"]')).toBeEnabled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a time-out request can be cancelled while open; the other team\'s answers are not ours', () => {
    render(<BenchRequestPanel matchId="seed-1" team="home" data={base([{ type: 'lineup', setIndex: 1, seq: 1, payload: { team: 'home', lineup: { ...LU, VI: 7 } } }])} players={players} />)
    fireEvent.click(document.querySelector('[data-bench-request="timeout"]'))
    const id = relay.sent[0].request.id
    fromRelay({ type: 'bench-request-ack', team: 'home', id, status: 'pending', delivered: 1, superseded: [] })
    fromRelay({ type: 'bench-response', team: 'away', id, status: 'accepted' })
    expect(document.querySelector('[data-bench-request-caption="timeout"]').textContent).toBe('benchRequests.status.pending')
    fireEvent.click(document.querySelector('[data-bench-request-cancel="timeout"]'))
    expect(relay.sent[1].request).toMatchObject({ kind: 'cancel', cancelId: id })
    fromRelay({ type: 'bench-request-ack', team: 'home', id: relay.sent[1].request.id, status: 'cancelled', cancelId: id, superseded: [] })
    expect(document.querySelector('[data-bench-request-caption="timeout"]').textContent).toBe('benchRequests.status.cancelled')
  })

  it('prepares a double substitution; an illegal one is greyed with why', () => {
    const events = [
      { type: 'lineup', setIndex: 1, seq: 1, payload: { team: 'home', lineup: { ...LU, VI: 7 } } },
      { type: 'point', setIndex: 1, seq: 2, payload: { team: 'home' } }
    ]
    render(<BenchRequestPanel matchId="seed-1" team="home" data={base(events)} players={players} />)
    fireEvent.click(document.querySelector('[data-bench-request="substitution"]'))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(dialog.querySelector('[data-sub-out="7"]'))
    expect(dialog.querySelector('[data-sub-in="13"]')).toBeDisabled() // a libero
    fireEvent.click(dialog.querySelector('[data-sub-in="8"]'))
    fireEvent.click(dialog.querySelector('[data-sub-out="1"]'))
    fireEvent.click(dialog.querySelector('[data-sub-in="9"]'))
    expect(within(dialog.querySelector('[data-sub-pairs]')).getAllByRole('listitem')).toHaveLength(2)
    const send = dialog.querySelector('[data-bench-sub-send]')
    expect(send).toBeDisabled() // the captain goes off: game captain first
    fireEvent.click(dialog.querySelector('[data-game-captain="8"]'))
    fireEvent.click(send)
    expect(relay.sent[0].request).toMatchObject({ kind: 'substitution', pairs: [{ out: 7, in: 8 }, { out: 1, in: 9 }], gameCaptain: 8 })
  })
})
