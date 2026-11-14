// The scoring screen's pre-match signing (PreMatchSignDialog): a collected
// coach or captain signature opens read-only; only an explicit Re-sign
// replaces it, and the remarks record that it was replaced (rollout audit,
// logic-cointoss-signatures-4). Real Dexie (fake IndexedDB), real pad.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup, screen } from '@testing-library/react'
import '../../i18n'
import { db } from '../../db/db'

vi.mock('../rosters/RostersPanel', () => ({ default: () => null }))
import PreMatchSignDialog from '../signature/PreMatchSignDialog'

const INK = 'data:image/png;base64,FIRST'
const NEW_INK = 'data:image/png;base64,SECOND'

beforeAll(() => {
  // jsdom has no canvas: a 2D context that draws nothing
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => ({})), set: (t, k, v) => { t[k] = v; return true } })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => NEW_INK)
})
afterAll(() => {
  cleanup()
  vi.restoreAllMocks()
})
beforeEach(async () => {
  cleanup()
  await Promise.all(db.tables.map(t => t.clear()))
})

const button = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)

async function openDialog () {
  const matchId = await db.matches.add({ status: 'live', test: false, homeCaptainSignature: INK, remarks: '' })
  const match = await db.matches.get(matchId)
  render(
    <PreMatchSignDialog
      data={{ match, homeTeam: { name: 'Home V' }, awayTeam: { name: 'Away V' }, homePlayers: [], awayPlayers: [] }}
      team="home"
      teamTitle="A · HOM"
      matchId={matchId}
      onClose={() => {}}
    />
  )
  return matchId
}

describe('PreMatchSignDialog: a signed slot', () => {
  it('opens read-only: no Save, Close keeps the signature', async () => {
    const matchId = await openDialog()
    fireEvent.click(screen.getByTestId('pre-match-sign-captain'))
    await waitFor(() => expect(screen.getByTestId('signature-resign')).toBeTruthy())
    expect(button('Save')).toBeUndefined()
    fireEvent.click(button('Close'))
    const m = await db.matches.get(matchId)
    expect(m.homeCaptainSignature).toBe(INK)
    expect(m.remarks).toBe('')
  })

  it('Re-sign replaces it and writes a remark', async () => {
    const matchId = await openDialog()
    fireEvent.click(screen.getByTestId('pre-match-sign-captain'))
    fireEvent.click(await screen.findByTestId('signature-resign'))
    const canvas = await waitFor(() => {
      const c = document.querySelector('canvas')
      expect(c).toBeTruthy()
      return c
    })
    fireEvent.mouseDown(canvas, { clientX: 10, clientY: 10 })
    fireEvent.mouseMove(canvas, { clientX: 40, clientY: 30 })
    fireEvent.mouseUp(canvas)
    await waitFor(() => expect(button('Save')).toBeTruthy())
    fireEvent.click(button('Save'))
    await waitFor(async () => expect((await db.matches.get(matchId)).homeCaptainSignature).toBe(NEW_INK))
    const m = await db.matches.get(matchId)
    expect(m.remarks).toMatch(/^Captain signature of Home V replaced \(re-signed/)
  })
})
