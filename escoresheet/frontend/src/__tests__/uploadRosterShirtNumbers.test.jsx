// A shirt number typed in the roster upload app is a whole number.
//
// The uploaded roster becomes the match's pending roster, and the scorer's
// "Accept" writes its numbers straight to the match roster: a number typed as
// '1.5' (the '.' next to the digits on a phone keypad, meant as 15) reached the
// court and the sheet, and the cloud refused every rally that player served
// (review of #37). The number input keeps only the digits typed, as the match
// setup's (domain/roster shirtNumberDigits).
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const sync = vi.hoisted(() => ({
  findMatchByGameNumber: vi.fn(),
  getMatchData: vi.fn(async () => ({ success: false })),
  updateMatchData: vi.fn(),
  listAvailableMatches: vi.fn(async () => ({ success: true, matches: [] })),
  getWebSocketStatus: vi.fn(() => 'disconnected'),
  validateUploadPinSupabase: vi.fn(),
  uploadRosterToCloud: vi.fn()
}))
vi.mock('../utils/serverDataSync', async (importOriginal) => ({ ...(await importOriginal()), ...sync }))
vi.mock('../utils/rosterUploadMatches', () => ({ listRosterUploadMatches: vi.fn(async () => ({ success: true, matches: [] })) }))
vi.mock('../utils/parseRosterPdf', () => ({
  parseRosterPdf: vi.fn(async () => ({ players: [{ number: 7, firstName: 'Anna', lastName: 'Muster', dob: '' }] }))
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key), i18n: { language: 'en' } })
}))
vi.mock('../components/SimpleHeader', () => ({ default: () => null }))
vi.mock('../components/UpdateBanner', () => ({ default: () => null }))

import UploadRosterApp from '../UploadRosterApp'

afterEach(cleanup)

describe('roster upload: shirt numbers', () => {
  it('a number typed as 1.5 is 15', async () => {
    render(<UploadRosterApp />)
    // the app's test match (six taps on "no active games")
    const empty = await screen.findByText('uploadRoster.noActiveGames')
    for (let i = 0; i < 6; i++) fireEvent.click(empty)
    fireEvent.change(await screen.findByLabelText('uploadRoster.uploadPin'), { target: { value: '123456' } })
    const file = new File(['%PDF-1.4'], 'roster.pdf', { type: 'application/pdf' })
    fireEvent.change(await screen.findByLabelText('uploadRoster.selectPdfFile'), { target: { files: [file] } })
    fireEvent.click(await screen.findByRole('button', { name: 'uploadRoster.confirm' }))

    const number = await screen.findByLabelText('Number')
    expect(number.value).toBe('7')
    fireEvent.change(number, { target: { value: '1.5' } })
    await waitFor(() => expect(screen.getByLabelText('Number').value).toBe('15'))
  })
})
