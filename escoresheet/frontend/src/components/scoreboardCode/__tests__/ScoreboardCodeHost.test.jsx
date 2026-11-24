/**
 * ScoreboardCodeHost: a stored code ends with its match (closed: approved /
 * final, or gone from the device); a match at its end screen ('ended') keeps
 * its boards (they show the final score).
 */
import { describe, it, expect, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k) => k }) }))
vi.mock('../../../db/db', () => ({ db: {} }))

import ScoreboardCodeHost from '../ScoreboardCodeHost'

describe('ScoreboardCodeHost', () => {
  it('revokes the codes of closed or deleted matches only', async () => {
    const rows = [
      { matchId: 1, relayKey: 'k1' }, { matchId: 2, relayKey: 'k2' }, { matchId: 3, relayKey: 'k3' }, { matchId: 4, relayKey: 'k4' }, { matchId: 5, relayKey: 'k5' }
    ]
    const status = { 1: 'live', 2: 'ended', 3: 'approved', 4: 'final' }
    const stopped = []
    const codes = { stored: async () => rows, stop: async (m) => { stopped.push(m) }, get: () => null, subscribe: () => () => {} }
    const matches = () => ({ get: async (id) => (status[id] ? { id, status: status[id] } : undefined) })
    const { unmount } = render(<ScoreboardCodeHost codes={codes} matches={matches} />)
    await waitFor(() => expect(stopped).toHaveLength(3))
    expect(stopped).toEqual([{ matchId: 3, relayKey: 'k3' }, { matchId: 4, relayKey: 'k4' }, { matchId: 5, relayKey: 'k5' }])
    unmount()
  })
})
