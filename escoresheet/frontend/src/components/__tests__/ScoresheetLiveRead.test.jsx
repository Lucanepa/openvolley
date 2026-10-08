// Laptop run of 2026-10-08 (OV-19): the scoresheet window, open during a
// match, flashed "the points recorded (2:2) do not match the set score (3:2)"
// after every point, and its content jumped 52 px. The sets and the events
// were two live queries, so one render had the new set score with the old
// events. The sheet reads the match in one transaction.
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { render, waitFor, cleanup } from '@testing-library/react'

const seen = vi.hoisted(() => [])

vi.mock('../../i18n', () => ({}))
vi.mock('../../../scoresheet_pdf/App_Scoresheet', () => ({
  default: ({ matchData }) => {
    const set1 = matchData.sets.find(s => s.index === 1)
    const points = matchData.events.filter(e => e.type === 'point' && e.setIndex === 1).length
    seen.push({ score: set1 ? set1.homePoints + set1.awayPoints : null, points })
    return <div data-testid="scoresheet">{points}</div>
  }
}))
vi.mock('../../contexts/AuthContext', () => ({
  AuthProvider: ({ children }) => children,
  useAuth: () => ({ user: null, loading: false })
}))

import { db } from '../../db/db'
import ScoresheetApp from '../../ScoresheetApp'

let previousAct
beforeAll(() => { previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT; globalThis.IS_REACT_ACT_ENVIRONMENT = false })
afterAll(() => { cleanup(); globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct; window.history.pushState({}, '', '/') })

describe('Scoresheet window: a point is one consistent sheet', () => {
  it('never shows the new set score with the old events', async () => {
    const matchId = await db.matches.add({ status: 'live', test: true })
    const setId = await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 0, finished: false })
    window.history.pushState({}, '', `/?matchId=${matchId}`)
    render(<ScoresheetApp />)
    await waitFor(() => expect(seen.length).toBeGreaterThan(0))

    for (let n = 1; n <= 5; n++) {
      // a point as the scorer writes it: score and event in one transaction
      await db.transaction('rw', db.sets, db.events, async () => {
        await db.sets.update(setId, { homePoints: n })
        await db.events.add({ matchId, setIndex: 1, type: 'point', payload: { team: 'home' }, seq: n, ts: new Date().toISOString() })
      })
      await waitFor(() => expect(seen.at(-1)).toEqual({ score: n, points: n }))
    }
    const torn = seen.filter(s => s.score !== null && s.score !== s.points)
    expect(torn).toEqual([])
  }, 20000)
})
