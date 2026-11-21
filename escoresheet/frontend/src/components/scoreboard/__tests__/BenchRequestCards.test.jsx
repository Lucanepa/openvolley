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
import { useBenchRequestBridge, outcomeFromEvents, lineupAcceptBlock } from '../useBenchRequestBridge'
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

  it('a request id that every object has (constructor, __proto__) renders like any other', () => {
    const queue = ['constructor', '__proto__', 'toString'].map((id) => entry('home', { id, kind: 'substitution', setIndex: 1, pairs: [{ out: 1, in: 8 }] }))
    render(<BenchRequestCards queue={queue} teams={teams} rallyInPlay={false} respond={vi.fn()} onAcceptLineup={vi.fn()} onGrantTimeout={vi.fn()} onAcceptPair={vi.fn()} />)
    expect(document.querySelectorAll('[data-bench-card]')).toHaveLength(3)
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
    // changed by the scorer or typed by hand: closed all the same, never declined (owner 2026-11-09)
    expect(outcomeFromEvents(lu, [lineupEv({ ...LU, I: 9 }, 3)], 2)).toEqual({ status: 'accepted' })
    expect(outcomeFromEvents(lu, [lineupEv(LU, 2)], 2)).toBe(null) // before the request came
    expect(outcomeFromEvents(lu, [lineupEv(LU, 3, 'away')], 2)).toBe(null)
    const to = entry('away', { id: 't', kind: 'timeout', setIndex: 1 })
    expect(outcomeFromEvents(to, [{ type: 'timeout', seq: 5, setIndex: 1, payload: { team: 'away' } }], 4)).toEqual({ status: 'accepted' })
    expect(outcomeFromEvents(to, [{ type: 'timeout', seq: 5, setIndex: 1, payload: { team: 'home' } }], 4)).toBe(null)
    // replayed after the scorer recorded the time-out by hand: matched by the relay's time of the request
    const late = { team: 'away', request: { id: 't2', kind: 'timeout', setIndex: 1 }, status: 'pending', at: Date.parse('2026-11-01T10:00:00Z'), replay: true }
    expect(outcomeFromEvents(late, [{ type: 'timeout', seq: 5, setIndex: 1, ts: '2026-11-01T10:00:20Z', payload: { team: 'away' } }], 5)).toEqual({ status: 'accepted' })
    expect(outcomeFromEvents(late, [{ type: 'timeout', seq: 5, setIndex: 1, ts: '2026-11-01T09:58:00Z', payload: { team: 'away' } }], 5)).toBe(null)
    // a live request: the scorer's clock runs 3 minutes ahead of the relay, the
    // team's earlier time-out (ts 10:03 on the scorer) must not close it
    const live = { ...late, at: Date.parse('2026-11-01T10:02:00Z'), replay: false }
    expect(outcomeFromEvents(live, [{ type: 'timeout', seq: 5, setIndex: 1, ts: '2026-11-01T10:03:00Z', payload: { team: 'away' } }], 5)).toBe(null)
    expect(outcomeFromEvents({ ...live, replay: true }, [{ type: 'timeout', seq: 5, setIndex: 1, ts: '2026-11-01T10:03:00Z', payload: { team: 'away' } }], 5)).toEqual({ status: 'accepted' })
    const sub = entry('home', { id: 's', kind: 'substitution', setIndex: 1, pairs: [{ out: 1, in: 8 }, { out: 2, in: 9 }] })
    const s1 = { type: 'substitution', seq: 7, setIndex: 1, payload: { team: 'home', playerOut: '1', playerIn: 8 } }
    expect(outcomeFromEvents(sub, [s1], 6)).toEqual({ donePairs: [0] })
    expect(outcomeFromEvents(sub, [s1, { ...s1, seq: 8, payload: { team: 'home', playerOut: 2, playerIn: 9 } }], 6)).toEqual({ status: 'accepted' })
  })

  it('takes a bench line-up only for the set being scored and a team without one', () => {
    const lu = entry('away', { id: 'l3', kind: 'lineup', setIndex: 3, lineup: LU })
    expect(lineupAcceptBlock(lu, [], 2)).toBe('other-set') // set 2 reopened by an undo
    expect(lineupAcceptBlock(lu, [], 3)).toBe(null)
    expect(lineupAcceptBlock(lu, [{ ...lineupEv(LU, 4, 'away'), setIndex: 3 }], 3)).toBe('has-lineup')
  })

  it('takes the relay\'s requests of its match, says seen, closes a line-up it has, answers once recorded', async () => {
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
    expect(relay.sent).toContainEqual({ type: 'bench-response', matchId: 'seed-1', team: 'away', id: 'lu', status: 'accepted' })
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

  describe('an answer without a connection goes once the scorer is back', () => {
    const push = (m) => act(() => { for (const fn of relay.listeners) fn(m) })
    const subRequest = { id: 'sub1', kind: 'substitution', setIndex: 1, pairs: [{ out: 1, in: 8 }] }
    const declined = { type: 'bench-response', matchId: 'seed-1', team: 'home', id: 'sub1', status: 'declined', reason: 'No 8 is injured' }
    const replay = (status = 'seen') => push({ type: 'bench-request', matchId: 'seed-1', team: 'home', request: subRequest, status, at: 1, replay: true })
    const offlineDecline = () => {
      const hook = renderHook(() => useBenchRequestBridge({ relayKey: 'seed-1', events: [], setIndex: 1 }))
      push({ type: 'bench-request', matchId: 'seed-1', team: 'home', request: subRequest, status: 'pending' })
      relay.sent = []
      relay.ok = false // the scorer's socket is closed
      act(() => { hook.result.current.respond('home', 'sub1', 'declined', 'No 8 is injured') })
      expect(hook.result.current.unsent.sub1).toBe(true)
      expect(relay.sent).toEqual([])
      relay.ok = true // a socket is open again, not yet proved as the match's scoreboard
      return hook
    }

    it('the relay replays the request to the socket that proved the match again: the held answer is sent, the note goes', () => {
      const { result } = offlineDecline()
      // nothing as the socket opens (the relay would refuse it: not the match's scoreboard yet)
      expect(relay.sent).toEqual([])
      replay()
      expect(relay.sent).toEqual([declined])
      expect(result.current.unsent.sub1).toBe(false)
      expect(result.current.queue).toHaveLength(0)
      // another reconnect replays nothing of it (the relay has it answered); if it did, no second answer
      replay('pending')
      expect(relay.sent.filter((m) => m.status === 'declined')).toHaveLength(1)
    })

    it('a replay while the connection is gone again keeps the answer held for the next one', () => {
      const { result } = offlineDecline()
      relay.ok = false
      replay()
      expect(result.current.unsent.sub1).toBe(true)
      expect(result.current.queue).toHaveLength(1)
      relay.ok = true
      replay()
      expect(relay.sent).toEqual([declined])
      expect(result.current.unsent.sub1).toBe(false)
      expect(result.current.queue).toHaveLength(0)
    })

    it('the scorer taps again once online: sent then, nothing more on a replay', () => {
      const { result } = offlineDecline()
      act(() => { result.current.respond('home', 'sub1', 'declined', 'No 8 is injured') })
      expect(relay.sent).toEqual([declined])
      expect(result.current.unsent.sub1).toBe(false)
      replay('pending')
      expect(relay.sent.filter((m) => m.status === 'declined')).toHaveLength(1)
      expect(relay.sent.at(-1)).toMatchObject({ id: 'sub1', status: 'seen' })
    })

    it('cancelled by the bench meanwhile: the held answer is dropped', () => {
      const { result } = offlineDecline()
      push({ type: 'bench-request', matchId: 'seed-1', team: 'home', request: { id: 'c1', kind: 'cancel', setIndex: 1, cancelId: 'sub1' }, status: 'cancelled' })
      expect(result.current.unsent.sub1).toBe(false)
      expect(result.current.queue).toHaveLength(0)
      replay('pending')
      expect(relay.sent.some((m) => m.status === 'declined')).toBe(false)
    })

    it('answered on another scoreboard of the match: the held answer is dropped', () => {
      const { result } = offlineDecline()
      push({ type: 'bench-response', matchId: 'seed-1', team: 'home', id: 'sub1', status: 'accepted' })
      expect(result.current.unsent.sub1).toBe(false)
      expect(result.current.queue).toHaveLength(0)
      replay()
      expect(relay.sent.some((m) => m.status === 'declined')).toBe(false)
    })

    it('a line-up declined offline goes on the replay too', () => {
      const lu = { id: 'lu1', kind: 'lineup', setIndex: 1, lineup: LU }
      const { result } = renderHook(() => useBenchRequestBridge({ relayKey: 'seed-1', events: [], setIndex: 1 }))
      push({ type: 'bench-request', matchId: 'seed-1', team: 'away', request: lu, status: 'pending' })
      relay.ok = false
      act(() => { result.current.respond('away', 'lu1', 'declined', 'No 4 is injured') })
      relay.ok = true
      relay.sent = []
      push({ type: 'bench-request', matchId: 'seed-1', team: 'away', request: lu, status: 'seen', at: 1, replay: true })
      expect(relay.sent).toEqual([{ type: 'bench-response', matchId: 'seed-1', team: 'away', id: 'lu1', status: 'declined', reason: 'No 4 is injured' }])
      expect(result.current.unsent.lu1).toBe(false)
    })

    it('a line-up the scorer recorded while offline is closed as accepted on the replay', () => {
      const lu = { id: 'lu2', kind: 'lineup', setIndex: 1, lineup: LU }
      const { result, rerender } = renderHook((props) => useBenchRequestBridge(props), { initialProps: { relayKey: 'seed-1', events: [], setIndex: 1 } })
      push({ type: 'bench-request', matchId: 'seed-1', team: 'away', request: lu, status: 'pending' })
      relay.ok = false
      rerender({ relayKey: 'seed-1', events: [lineupEv(LU, 1, 'away')], setIndex: 1 })
      expect(result.current.unsent.lu2).toBe(true)
      relay.ok = true
      relay.sent = []
      push({ type: 'bench-request', matchId: 'seed-1', team: 'away', request: lu, status: 'seen', at: 1, replay: true })
      expect(relay.sent).toEqual([{ type: 'bench-response', matchId: 'seed-1', team: 'away', id: 'lu2', status: 'accepted' }])
      expect(result.current.unsent.lu2).toBe(false)
      expect(result.current.queue).toHaveLength(0)
    })
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
