// The live corrections card's "Switch sides" is the court move: the teams
// change courts, A and B stay the same teams. In sets 1-4 it used to swap A
// and B (domain/coinToss swapTeamDesignation), which moved the teams only
// while the set had no saved side; "Swap A/B" now corrects the coin toss and
// moves nothing (owner's decision, 2026-10-09), so the two are apart.
//
// The real card on the real Dexie database (fake IndexedDB); the confirm
// dialog answers yes, the correction log is not written.
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('../../../ui/uiStore.js', async (importOriginal) => ({ ...(await importOriginal()), confirmDialog: async () => true }))
vi.mock('../../../services/corrections/applyCorrectionPlan', () => ({
  applyCorrectionPlan: async () => ({ addedIds: [], signaturesCleared: false })
}))

import '../../../i18n'
import { db } from '../../../db/db'
import CorrectionsPanel from '../CorrectionsPanel.jsx'
import { resetGhostClickGuard } from '../../../hooks/useConfirmAction'
import { getSideAForSet, getFirstServeForSet } from '../../../domain/rules'

const leftTeam = (m, set) => {
  const a = m.coinTossTeamA || 'home'
  return getSideAForSet(set, m) === 'left' ? a : (a === 'home' ? 'away' : 'home')
}

beforeEach(async () => {
  cleanup()
  resetGhostClickGuard()
  await Promise.all(db.tables.map(t => t.clear()))
})

async function setUp(currentSet, extra = {}) {
  const matchId = await db.matches.add({
    status: 'live', test: true, bestOf: 5, firstServe: 'home',
    coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true, coinTossServeB: false, ...extra
  })
  const sets = []
  for (let i = 1; i <= currentSet; i++) {
    const row = { matchId, index: i, homePoints: i < currentSet ? 25 : 3, awayPoints: i < currentSet ? 20 : 2, finished: i < currentSet }
    row.id = await db.sets.add(row)
    sets.push(row)
  }
  const match = await db.matches.get(matchId)
  render(<CorrectionsPanel mode="live" matchId={matchId} events={[]} match={match} sets={sets}
    homeTeam={{ name: 'Home VC' }} awayTeam={{ name: 'Away VC' }} homePlayers={[]} awayPlayers={[]}
    liveSetIndex={currentSet} hooks={{}} />)
  return matchId
}

async function switchSides(matchId) {
  const before = await db.matches.get(matchId)
  fireEvent.click(screen.getByRole('button', { name: 'Switch sides' }))
  await vi.waitFor(async () => expect(JSON.stringify(await db.matches.get(matchId))).not.toBe(JSON.stringify(before)))
  return { before, after: await db.matches.get(matchId) }
}

describe('Corrections "Switch sides": the teams change courts, A and B stay', () => {
  for (const set of [1, 2, 3, 4]) {
    it(`set ${set} (no saved side): the other team on the left from this set on, the sets before as they were`, async () => {
      const matchId = await setUp(set)
      const { before, after } = await switchSides(matchId)
      expect(after.coinTossTeamA).toBe('home')
      expect(after.coinTossTeamB).toBe('away')
      expect(after.firstServe).toBe('home')
      for (let s = 1; s <= 4; s++) {
        if (s < set) expect(leftTeam(after, s), `set ${s}`).toBe(leftTeam(before, s))
        else expect(leftTeam(after, s), `set ${s}`).not.toBe(leftTeam(before, s))
        expect(getFirstServeForSet(s, after)).toBe(getFirstServeForSet(s, before))
      }
    })
  }

  it('set 2 with a saved side: moved too', async () => {
    const matchId = await setUp(2, { setLeftTeamOverrides: { 2: 'A' } })
    const { before, after } = await switchSides(matchId)
    expect(leftTeam(before, 2)).toBe('home')
    expect(leftTeam(after, 2)).toBe('away')
    expect(after.coinTossTeamA).toBe('home')
  })

  for (const switched of [false, true]) {
    it(`set 5 ${switched ? 'after' : 'before'} the change at 8: its toss side flips, the teams change courts`, async () => {
      const matchId = await setUp(5, { set5LeftTeam: 'A', set5FirstServe: 'A', set5CourtSwitched: switched })
      const { before, after } = await switchSides(matchId)
      expect(leftTeam(after, 5)).not.toBe(leftTeam(before, 5))
      expect(after.set5CourtSwitched).toBe(switched)
      expect(after.coinTossTeamA).toBe('home')
      expect(getFirstServeForSet(5, after)).toBe(getFirstServeForSet(5, before))
    })
  }
})
