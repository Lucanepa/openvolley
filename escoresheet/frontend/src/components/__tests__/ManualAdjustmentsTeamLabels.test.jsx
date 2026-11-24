// Edit match info during the match (Match › Edit match info, the match info
// tab alone): each team's short name and shirt colour (owner, on the Point Hub
// board). The save writes the team record, the match row's mirror fields the
// live state reads first, queues the cloud update with the team and marks the
// live state for a fresh push; the team names stay read-only.
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'

vi.mock('../../contexts/AlertContext', () => ({ useAlert: () => ({ showAlert: vi.fn() }) }))

import '../../i18n'
import { db } from '../../db/db'
import { isLiveStateDirty, setLiveStateDirty } from '../../utils/eventSync'
import { liveTeamIdentity } from '../../domain/teamIdentity'
import ManualAdjustments from '../ManualAdjustments'

let saved
beforeAll(() => {
  saved = { fetch: globalThis.fetch }
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline (test)')))
})
afterEach(cleanup)
afterAll(() => { globalThis.fetch = saved.fetch })

const button = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(text) && !b.disabled)

async function liveMatch() {
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM', color: '#ef4444' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY', color: '#3b82f6' })
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', test: false, seed_key: `match_labels_${home}`,
    coinTossConfirmed: true, coinTossTeamA: 'away', coinTossTeamB: 'home', coinTossServeA: true,
    homeName: 'Home VC', awayName: 'Away VC', homeShortName: 'HOM', awayShortName: 'AWY', homeColor: '#ef4444', awayColor: '#3b82f6', hall: 'Halle'
  })
  setLiveStateDirty(matchId, false)
  return { matchId, home, away }
}

describe('Edit match info: short names and shirt colours', () => {
  it('changes a short name and a colour; the live state gets them', async () => {
    const { matchId, home, away } = await liveMatch()
    render(<ManualAdjustments matchId={matchId} initialTab="info" tabIds={['info']} onClose={() => {}} onSave={() => {}} />)
    const card = await screen.findByTestId('edit-team-labels', {}, { timeout: 5000 })
    // the names are shown, not editable
    expect(within(card).getByText('Home VC')).toBeTruthy()
    expect(within(card).queryByDisplayValue('Home VC')).toBeNull()

    fireEvent.change(screen.getByLabelText('Home VC Short name (max 8)'), { target: { value: 'newhome12' } })
    expect(screen.getByLabelText('Home VC Short name (max 8)').value).toBe('NEWHOME1')

    fireEvent.click(screen.getByTestId('edit-team-colour-away'))
    const dialog = await screen.findByTestId('edit-team-colour-dialog')
    const preset = [...dialog.querySelectorAll('button[aria-pressed]')].find(b => !b.hasAttribute('data-custom-tile') && b.getAttribute('aria-pressed') === 'false')
    const picked = preset.getAttribute('aria-label').split(' ').pop()
    fireEvent.click(preset)
    await waitFor(() => expect(screen.queryByTestId('edit-team-colour-dialog')).toBeNull())

    fireEvent.click(button('Save changes'))
    await waitFor(async () => expect((await db.matches.get(matchId)).homeShortName).toBe('NEWHOME1'), { timeout: 5000 })
    const m = await db.matches.get(matchId)
    expect(m).toMatchObject({ homeShortName: 'NEWHOME1', awayColor: picked, awayShortName: 'AWY', homeName: 'Home VC', awayName: 'Away VC' })
    expect(await db.teams.get(home)).toMatchObject({ name: 'Home VC', shortName: 'NEWHOME1', color: '#ef4444' })
    expect(await db.teams.get(away)).toMatchObject({ name: 'Away VC', color: picked })

    // what the scoring screen sends as team_a_* / team_b_* (team A = away here)
    const live = liveTeamIdentity(m, await db.teams.get(home), await db.teams.get(away))
    expect(live).toMatchObject({ teamAShort: 'AWY', teamAColor: picked, teamBShort: 'NEWHOME1', teamBColor: '#ef4444' })
    await waitFor(() => expect(isLiveStateDirty(matchId)).toBe(true), { timeout: 5000 })

    // the cloud match gets the teams through the sync queue
    const job = (await db.sync_queue.toArray()).filter(j => j.resource === 'match' && j.payload?.id === m.seed_key).at(-1)
    expect(job.payload.home_team).toMatchObject({ name: 'Home VC', short_name: 'NEWHOME1', color: '#ef4444' })
    expect(job.payload.away_team).toMatchObject({ name: 'Away VC', short_name: 'AWY', color: picked })
    // logged like every edit of this page
    expect(m.manualChanges.map(c => c.field)).toEqual(expect.arrayContaining(['home.shortName', 'away.color']))
  }, 30000)

  it('at the match end (Teams tab offered) the info tab shows no second copy', async () => {
    const { matchId } = await liveMatch()
    render(<ManualAdjustments matchId={matchId} initialTab="info" onClose={() => {}} onSave={() => {}} />)
    await screen.findByLabelText('Hall', {}, { timeout: 5000 })
    expect(screen.queryByTestId('edit-team-labels')).toBeNull()
  }, 30000)
})
