// The roster upload page keeps the roster rules of the scorer's editor and
// Accept (domain/uploadedRoster): one captain, one player per libero slot,
// no number twice; a roster that breaks them is not sent. The LFP mark of an
// imported Einsatzliste goes with the roster. Made-up names.
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'

const sync = vi.hoisted(() => ({
  findMatchByGameNumber: vi.fn(),
  getMatchData: vi.fn(async () => ({ success: false })),
  updateMatchData: vi.fn(async () => ({ success: true })),
  listAvailableMatches: vi.fn(async () => ({ success: true, matches: [] })),
  getWebSocketStatus: vi.fn(() => 'disconnected'),
  validateUploadPinSupabase: vi.fn(),
  uploadRosterToCloud: vi.fn()
}))
vi.mock('../utils/serverDataSync', async (importOriginal) => ({ ...(await importOriginal()), ...sync }))
vi.mock('../utils/rosterUploadMatches', () => ({ listRosterUploadMatches: vi.fn(async () => ({ success: true, matches: [] })) }))
vi.mock('../utils/parseRosterPdf', () => ({
  parseRosterPdf: vi.fn(async () => ({
    players: [
      { number: 4, firstName: 'Anna', lastName: 'Muster', dob: '14/03/2008' },
      { number: 7, firstName: 'Eva', lastName: 'Beispiel', dob: '', isLfp: true },
      { number: 9, firstName: 'Lea', lastName: 'Exemple', dob: '' }
    ]
  }))
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key), i18n: { language: 'en' } })
}))
vi.mock('../components/SimpleHeader', () => ({ default: () => null }))
vi.mock('../components/UpdateBanner', () => ({ default: () => null }))

import UploadRosterApp from '../UploadRosterApp'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function openImportedRoster() {
  render(<UploadRosterApp />)
  // the app's test match (six taps on "no active games")
  const empty = await screen.findByText('uploadRoster.noActiveGames')
  for (let i = 0; i < 6; i++) fireEvent.click(empty)
  fireEvent.change(await screen.findByLabelText('uploadRoster.uploadPin'), { target: { value: '123456' } })
  const file = new File(['%PDF-1.4'], 'roster.pdf', { type: 'application/pdf' })
  fireEvent.change(await screen.findByLabelText('uploadRoster.selectPdfFile'), { target: { files: [file] } })
  fireEvent.click(await screen.findByRole('button', { name: 'uploadRoster.confirm' }))
  await screen.findAllByLabelText('Number')
}
const captains = () => screen.getAllByRole('button', { name: 'Captain' })
const liberoSelects = () => screen.getAllByLabelText('Libero')

describe('roster upload: the roster rules', () => {
  it('one captain: choosing another takes it from the first', async () => {
    await openImportedRoster()
    fireEvent.click(captains()[0])
    fireEvent.click(captains()[2])
    expect(captains().map(b => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true'])
  })

  it('a libero slot another player has is not offered', async () => {
    await openImportedRoster()
    fireEvent.change(liberoSelects()[0], { target: { value: 'libero1' } })
    const offered = within(liberoSelects()[1]).getAllByRole('option').map(o => o.value)
    expect(offered).toEqual(['', 'libero2'])
  })

  it('a number twice is not sent', async () => {
    await openImportedRoster()
    fireEvent.change(screen.getAllByLabelText('Number')[1], { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }))
    expect(await screen.findByText('uploadRoster.problems.numberTwice')).toBeTruthy()
    expect(screen.queryByText('uploadRoster.confirmMessage')).toBeNull()
    expect(sync.updateMatchData).not.toHaveBeenCalled()
  })

  it('sends the checked roster, with the LFP mark of the import', async () => {
    await openImportedRoster()
    fireEvent.click(captains()[0])
    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }))
    fireEvent.click(await screen.findByRole('button', { name: 'common.yes' }))
    await waitFor(() => expect(sync.updateMatchData).toHaveBeenCalled())
    const [, { pendingHomeRoster }] = sync.updateMatchData.mock.calls[0]
    expect(pendingHomeRoster.players.map(p => [p.number, p.isCaptain, p.isLfp])).toEqual([[4, true, false], [7, false, true], [9, false, false]])
  })
})
