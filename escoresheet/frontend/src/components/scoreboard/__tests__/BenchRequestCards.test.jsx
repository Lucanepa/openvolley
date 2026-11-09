import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, renderHook, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k) => k })
}))
const askTextMock = vi.fn()
vi.mock('../../../utils/askText', () => ({ askText: (...a) => askTextMock(...a) }))
const relay = { listeners: new Set(), sent: [], ok: true }
vi.mock('../../../utils/relayPublisher', () => ({
  scorerRelay: {
    listen: (fn) => { relay.listeners.add(fn); return () => relay.listeners.delete(fn) },
    send: (m) => { if (relay.ok) relay.sent.push(m); return relay.ok }
  }
}))

import BenchRequestCards from '../BenchRequestCards'
import { useBenchRequestBridge, outcomeFromEvents } from '../useBenchRequestBridge'
import { benchInfoReducer } from '../../referee/BenchRequestIndicator'

const LU = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 }
const teams = { home: { name: 'VBC Musterdorf', colour: '#e2001a' }, away: { name: 'Volley Beispiel', colour: '#1d4ed8' } }
const entry = (team, request) => ({ team, request, status: 'pending', at: 1 })

beforeEach(() => {
  relay.listeners.clear()
  relay.sent = []
  relay.ok = true
  askTextMock.mockReset()
})

describe('BenchRequestCards', () => {
  it('one card per request, Accept opens the scorer\'s own dialog, Decline asks a reason', async () => {
    const onAcceptLineup = vi.fn()
    const onGrantTimeout = vi.fn()
    const onAcceptPair = vi.fn()
    const respond = vi.fn()
    const queue = [
      entry('home', { id: 'l', kind: 'lineup', setIndex: 2, lineup: LU, gameCaptain: 4 }),
      entry('away', { id: 't', kind: 'timeout', setIndex: 2 }),
      entry('away', { id: 's', kind: 'substitution', setIndex: 2, pairs: [{ out: 1, in: 12 }, { out: 2, in: 13 }] })
    ]
    render(<BenchRequestCards queue={queue} teams={teams} rallyInPlay={false} donePairs={{ s: [0] }} respond={respond} onAcceptLineup={onAcceptLineup} onGrantTimeout={onGrantTimeout} onAcceptPair={onAcceptPair} />)
    const cards = document.querySelectorAll('[data-bench-card]')
    expect(cards).toHaveLength(3)
    expect(cards[0].textContent).toContain('VBC Musterdorf')
    expect(cards[0].textContent).toContain('benchRequests.scorer.gameCaptain')
    fireEvent.click(cards[0].querySelector('[data-bench-accept]'))
    expect(onAcceptLineup).toHaveBeenCalledWith(queue[0])
    fireEvent.click(cards[1].querySelector('[data-bench-accept]'))
    expect(onGrantTimeout).toHaveBeenCalledWith(queue[1])
    // the first pair is recorded, the second waits for its button
    expect(cards[2].querySelector('[data-bench-pair-accept="0"]')).toBeNull()
    fireEvent.click(cards[2].querySelector('[data-bench-pair-accept="1"]'))
    expect(onAcceptPair).toHaveBeenCalledWith(queue[2], { out: 2, in: 13 })
    askTextMock.mockResolvedValueOnce('  Not in the roster ')
    await act(async () => { fireEvent.click(cards[1].querySelector('[data-bench-decline]')) })
    expect(respond).toHaveBeenCalledWith('away', 't', 'declined', 'Not in the roster')
    askTextMock.mockResolvedValueOnce(null)
    await act(async () => { fireEvent.click(cards[0].querySelector('[data-bench-decline]')) })
    expect(respond).toHaveBeenCalledTimes(1) // cancelled: nothing sent
  })

  it('a time-out or substitution waits while a rally is in play; a line-up does not', () => {
    const queue = [entry('home', { id: 'l', kind: 'lineup', setIndex: 1, lineup: LU }), entry('away', { id: 't', kind: 'timeout', setIndex: 1 })]
    render(<BenchRequestCards queue={queue} teams={teams} rallyInPlay respond={vi.fn()} onAcceptLineup={vi.fn()} onGrantTimeout={vi.fn()} onAcceptPair={vi.fn()} />)
    const [lineup, timeout] = document.querySelectorAll('[data-bench-card]')
    expect(lineup.querySelector('[data-bench-accept]')).toBeEnabled()
    expect(timeout.querySelector('[data-bench-accept]')).toBeDisabled()
    expect(timeout.textContent).toContain('benchRequests.scorer.afterRally')
  })

  it('folds into one pill and draws nothing without requests', () => {
    const { rerender } = render(<BenchRequestCards queue={[entry('home', { id: 't', kind: 'timeout', setIndex: 1 })]} teams={teams} respond={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /benchRequests.scorer.count/ }))
    expect(document.querySelector('[data-bench-card]')).toBeNull()
    rerender(<BenchRequestCards queue={[]} teams={teams} respond={vi.fn()} />)
    expect(document.querySelector('[data-bench-request-cards]')).toBeNull()
  })
})

describe('the scorer\'s bridge', () => {
  const lineupEv = (lineup, seq, team = 'home', setIndex = 1) => ({ type: 'lineup', seq, setIndex, payload: { team, lineup } })
  it('answers a request when the scorer records it, through the card or by hand', () => {
    const lu = entry('home', { id: 'l', kind: 'lineup', setIndex: 1, lineup: LU })
    expect(outcomeFromEvents(lu, [lineupEv(LU, 3)], 2)).toEqual({ status: 'accepted' })
    expect(outcomeFromEvents(lu, [lineupEv({ ...LU, I: 9 }, 3)], 2)).toEqual({ status: 'declined', reason: 'entered_differently' })
    expect(outcomeFromEvents(lu, [lineupEv(LU, 2)], 2)).toBe(null) // before the request came
    expect(outcomeFromEvents(lu, [lineupEv(LU, 3, 'away')], 2)).toBe(null)
    const to = entry('away', { id: 't', kind: 'timeout', setIndex: 1 })
    expect(outcomeFromEvents(to, [{ type: 'timeout', seq: 5, setIndex: 1, payload: { team: 'away' } }], 4)).toEqual({ status: 'accepted' })
    expect(outcomeFromEvents(to, [{ type: 'timeout', seq: 5, setIndex: 1, payload: { team: 'home' } }], 4)).toBe(null)
    const sub = entry('home', { id: 's', kind: 'substitution', setIndex: 1, pairs: [{ out: 1, in: 8 }, { out: 2, in: 9 }] })
    const s1 = { type: 'substitution', seq: 7, setIndex: 1, payload: { team: 'home', playerOut: '1', playerIn: 8 } }
    expect(outcomeFromEvents(sub, [s1], 6)).toEqual({ donePairs: [0] })
    expect(outcomeFromEvents(sub, [s1, { ...s1, seq: 8, payload: { team: 'home', playerOut: 2, playerIn: 9 } }], 6)).toEqual({ status: 'accepted' })
  })

  it('takes the relay\'s requests of its match, says seen, declines a line-up it has, answers once recorded', async () => {
    const events = [lineupEv({ ...LU }, 1, 'away')]
    const { result, rerender } = renderHook((props) => useBenchRequestBridge(props), { initialProps: { relayKey: 'seed-1', events, setIndex: 1 } })
    const push = (m) => act(() => { for (const fn of relay.listeners) fn(m) })
    push({ type: 'bench-request', matchId: 'other', team: 'home', request: { id: 'x', kind: 'timeout', setIndex: 1 }, status: 'pending' })
    expect(result.current.queue).toHaveLength(0)
    push({ type: 'bench-request', matchId: 'seed-1', team: 'home', request: { id: 'to', kind: 'timeout', setIndex: 1 }, status: 'pending' })
    expect(result.current.queue).toHaveLength(1)
    expect(relay.sent).toContainEqual({ type: 'bench-response', matchId: 'seed-1', team: 'home', id: 'to', status: 'seen' })
    // the away team already has its line-up for set 1
    push({ type: 'bench-request', matchId: 'seed-1', team: 'away', request: { id: 'lu', kind: 'lineup', setIndex: 1, lineup: LU }, status: 'pending' })
    expect(result.current.queue).toHaveLength(1)
    expect(relay.sent).toContainEqual({ type: 'bench-response', matchId: 'seed-1', team: 'away', id: 'lu', status: 'declined', reason: 'lineup_already_entered' })
    // the scorer records the time-out
    rerender({ relayKey: 'seed-1', events: [...events, { type: 'timeout', seq: 2, setIndex: 1, payload: { team: 'home' } }], setIndex: 1 })
    await waitFor(() => expect(result.current.queue).toHaveLength(0))
    expect(relay.sent).toContainEqual({ type: 'bench-response', matchId: 'seed-1', team: 'home', id: 'to', status: 'accepted' })
    // answered on another scoreboard of the match
    push({ type: 'bench-request', matchId: 'seed-1', team: 'home', request: { id: 'to2', kind: 'timeout', setIndex: 1 }, status: 'seen', replay: true })
    expect(result.current.queue).toHaveLength(1)
    push({ type: 'bench-response', matchId: 'seed-1', team: 'home', id: 'to2', status: 'declined' })
    expect(result.current.queue).toHaveLength(0)
  })

  it('an answer without a connection stays on the card, marked', () => {
    relay.ok = false
    const { result } = renderHook(() => useBenchRequestBridge({ relayKey: 'seed-1', events: [], setIndex: 1 }))
    act(() => { for (const fn of relay.listeners) fn({ type: 'bench-request', matchId: 'seed-1', team: 'home', request: { id: 'to', kind: 'timeout', setIndex: 1 }, status: 'pending' }) })
    act(() => { result.current.respond('home', 'to', 'declined') })
    expect(result.current.queue).toHaveLength(1)
    expect(result.current.unsent.to).toBe(true)
  })
})

describe('the referee\'s note', () => {
  it('open time-out / substitution requests only, one per team and kind, gone when answered', () => {
    let l = benchInfoReducer([], { type: 'bench-request-info', team: 'home', id: 'a', kind: 'timeout', status: 'pending' })
    l = benchInfoReducer(l, { type: 'bench-request-info', team: 'away', id: 'b', kind: 'substitution', pairs: [{ out: 1, in: 8 }], status: 'pending' })
    l = benchInfoReducer(l, { type: 'bench-request-info', team: 'home', id: 'c', kind: 'timeout', status: 'pending' })
    expect(l.map((e) => e.id)).toEqual(['b', 'c'])
    l = benchInfoReducer(l, { type: 'bench-request-info', team: 'home', id: 'c', kind: 'timeout', status: 'seen' })
    expect(l).toHaveLength(2)
    l = benchInfoReducer(l, { type: 'bench-request-info', team: 'home', id: 'c', kind: 'timeout', status: 'accepted' })
    l = benchInfoReducer(l, { type: 'bench-request-info', team: 'away', id: 'b', kind: 'substitution', status: 'cancelled' })
    expect(l).toEqual([])
    expect(benchInfoReducer(l, { type: 'bench-request-info', team: 'home', id: 'd', kind: 'lineup', status: 'pending' })).toEqual([])
  })
})
