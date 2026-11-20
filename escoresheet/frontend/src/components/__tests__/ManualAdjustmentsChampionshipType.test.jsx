// Edit match info: the championship type (owner 2026-11-20). It was a free
// text field, but the paper scoresheet ticks Regional / National /
// International / Other only for the stored lowercase value, so "Regional"
// typed by hand left every box empty. Now a select with the translated
// labels, as in Match setup, plus the "Other" text; a value typed by hand
// before maps to its option. Also the card order of the new layout.
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'

vi.mock('../../contexts/AlertContext', () => ({ useAlert: () => ({ showAlert: vi.fn() }) }))
vi.mock('../../ui/uiStore.js', async (orig) => ({ ...(await orig()), confirmDialog: async () => true }))

import i18n from '../../i18n'
import { db } from '../../db/db'
import ManualAdjustments from '../ManualAdjustments'

let saved
beforeAll(() => {
  saved = { fetch: globalThis.fetch }
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline (test)')))
})
afterEach(async () => {
  cleanup()
  if (i18n.language !== 'en') await act(() => i18n.changeLanguage('en'))
})
afterAll(() => { globalThis.fetch = saved.fetch })

const button = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(text) && !b.disabled)

let n = 0
async function liveMatch (extra = {}) {
  n += 1
  const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away VC', shortName: 'AWY' })
  return db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', test: false, seed_key: `match_championship_${n}_${home}`,
    coinTossConfirmed: true, coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true, hall: 'Halle', ...extra
  })
}

async function matchInfoJob (seedKey) {
  const jobs = await db.sync_queue.toArray()
  return jobs.reverse().find(j => j.resource === 'match' && j.payload?.match_info && JSON.stringify(j).includes(seedKey))
}

// Opens Edit match info and returns the championship select and the onSave spy
async function open (matchId) {
  const onSave = vi.fn()
  render(<ManualAdjustments matchId={matchId} initialTab="info" tabIds={['info']} onClose={() => {}} onSave={onSave} />)
  const select = await screen.findByRole('combobox', { name: 'Championship type' }, { timeout: 5000 })
  return { select, onSave }
}

// Save changes, then wait until the whole save is through (the cloud update queued)
async function save (onSave) {
  await waitFor(() => expect(button('Save changes')).toBeTruthy())
  fireEvent.click(button('Save changes'))
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1), { timeout: 10000 })
}

describe('Edit match info: championship type', () => {
  it('a select with the translated labels; regional shows "Regional"', async () => {
    const matchId = await liveMatch({ championshipType: 'regional' })
    const { select } = await open(matchId)
    expect(select.tagName).toBe('SELECT')
    expect(select.value).toBe('regional')
    expect(select.selectedOptions[0].textContent).toBe('Regional')
    expect([...select.options].map(o => [o.value, o.textContent])).toEqual([
      ['', '–'], ['regional', 'Regional'], ['national', 'National'], ['international', 'International'], ['other', 'Other']
    ])
    // the label follows the app language, the value stays as stored
    await act(() => i18n.changeLanguage('fr'))
    // (the French bundle loads after the switch)
    const fr = await screen.findByRole('combobox', { name: 'Type de championnat' }, { timeout: 5000 })
    expect(fr.value).toBe('regional')
    expect(fr.selectedOptions[0].textContent).toBe('Régional')
    // no "Other" text field unless Other is chosen
    expect(screen.queryByTestId('edit-championship-type-other')).toBeNull()
  }, 30000)

  it('saving keeps the lowercase value, here and in match_info', async () => {
    const matchId = await liveMatch({ championshipType: 'regional' })
    const { select, onSave } = await open(matchId)
    fireEvent.change(select, { target: { value: 'national' } })
    await save(onSave)
    const m = await db.matches.get(matchId)
    expect(m).toMatchObject({ championshipType: 'national', championshipTypeOther: null })
    expect(m.manualChanges.at(-1)).toMatchObject({ field: 'championshipType', before: 'regional', after: 'national' })
    const job = await matchInfoJob(m.seed_key)
    expect(job.payload.match_info).toMatchObject({ championship_type: 'national', championship_type_other: '' })
  }, 30000)

  it('Other: its text field appears and saves championshipTypeOther', async () => {
    const matchId = await liveMatch({ championshipType: 'national' })
    const { select, onSave } = await open(matchId)
    fireEvent.change(select, { target: { value: 'other' } })
    const other = await screen.findByTestId('edit-championship-type-other')
    expect(other).toHaveAttribute('placeholder', 'Other type')
    expect(screen.getByLabelText('Championship type (other)')).toBe(other)
    fireEvent.change(other, { target: { value: 'Kantonal' } })
    await save(onSave)
    const m = await db.matches.get(matchId)
    expect(m).toMatchObject({ championshipType: 'other', championshipTypeOther: 'Kantonal' })
    expect(m.manualChanges.map(c => c.field)).toEqual(expect.arrayContaining(['championshipType', 'championshipTypeOther']))
    expect(m.manualChanges.find(c => c.field === 'championshipTypeOther').description).toBe('Championship type (other): (empty) → Kantonal')
    const job = await matchInfoJob(m.seed_key)
    expect(job.payload.match_info).toMatchObject({ championship_type: 'other', championship_type_other: 'Kantonal' })
  }, 30000)

  it('back from Other: the text is not saved with another type', async () => {
    const matchId = await liveMatch({ championshipType: 'other', championshipTypeOther: 'Kantonal' })
    const { select, onSave } = await open(matchId)
    expect(screen.getByTestId('edit-championship-type-other').value).toBe('Kantonal')
    fireEvent.change(select, { target: { value: 'international' } })
    expect(screen.queryByTestId('edit-championship-type-other')).toBeNull()
    await save(onSave)
    expect(await db.matches.get(matchId)).toMatchObject({ championshipType: 'international', championshipTypeOther: null })
  }, 30000)

  it('a legacy "Regional" typed by hand shows as Regional and is saved lowercase', async () => {
    const matchId = await liveMatch({ championshipType: 'Regional' })
    const { select, onSave } = await open(matchId)
    expect(select.value).toBe('regional')
    expect(select.selectedOptions[0].textContent).toBe('Regional')
    // another edit saves the match: the sheet now ticks Regional
    fireEvent.change(screen.getByRole('textbox', { name: 'Hall' }), { target: { value: 'North Hall' } })
    await save(onSave)
    const m = await db.matches.get(matchId)
    expect(m).toMatchObject({ hall: 'North Hall', championshipType: 'regional' })
    expect((await matchInfoJob(m.seed_key)).payload.match_info.championship_type).toBe('regional')
  }, 30000)

  it('any other legacy text is Other with that text', async () => {
    const matchId = await liveMatch({ championshipType: 'Kantonal' })
    const { select } = await open(matchId)
    expect(select.value).toBe('other')
    expect(screen.getByTestId('edit-championship-type-other').value).toBe('Kantonal')
  }, 30000)
})

describe('Edit match info: card order', () => {
  it('Teams, Match details, then Team contacts beside Sponsors, then Match officials', async () => {
    const matchId = await liveMatch({ championshipType: 'regional', sponsorsMarked: true, homeSponsors: true, awaySponsors: false })
    await open(matchId)
    const ids = ['edit-team-labels', 'edit-match-details', 'edit-team-contacts', 'edit-sponsors', 'edit-match-officials']
    const cards = ids.map(id => screen.getByTestId(id))
    for (let i = 1; i < cards.length; i++) {
      expect(cards[i - 1].compareDocumentPosition(cards[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    // Team contacts no longer shares a row with Match details: it shares one with Sponsors
    const row = screen.getByTestId('edit-contacts-row')
    expect([...row.children]).toEqual([screen.getByTestId('edit-team-contacts'), screen.getByTestId('edit-sponsors')])
    expect(row.className).toContain('lg:grid-cols-2')
    expect(screen.getByTestId('edit-match-details').parentElement).not.toBe(row)
  }, 30000)

  it('without the sponsors boxes Team contacts takes the whole row', async () => {
    const matchId = await liveMatch({ championshipType: 'regional' })
    await open(matchId)
    const row = screen.getByTestId('edit-contacts-row')
    expect([...row.children]).toEqual([screen.getByTestId('edit-team-contacts')])
    expect(row.className).not.toContain('lg:grid-cols-2')
  }, 30000)
})
