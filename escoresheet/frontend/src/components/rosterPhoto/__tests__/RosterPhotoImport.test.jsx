import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (opts && typeof opts === 'object' && 'count' in opts ? `${key}:${opts.count}` : (typeof opts === 'string' ? key : key)), i18n: { language: 'en' } })
}))

// jsdom draws nothing: the photo's pixels and the recognition are stand-ins
vi.mock('../../../utils/rosterPhoto/scan', async (orig) => ({
  ...(await orig()),
  loadPhoto: vi.fn(async () => ({ width: 800, height: 1100 })),
  guessCorners: vi.fn(() => [[10, 10], [790, 10], [790, 1090], [10, 1090]]),
  scanPage: vi.fn(() => ({ width: 1600, height: 2200 })),
  canvasBlob: vi.fn(async () => new Blob(['jpeg']))
}))
const readRosterPhoto = vi.fn()
const startOcrEngine = vi.fn()
vi.mock('../../../utils/rosterPhoto/ocr', () => ({ readRosterPhoto: (...args) => readRosterPhoto(...args), startOcrEngine: (...args) => startOcrEngine(...args) }))

import RosterPhotoImport from '../RosterPhotoImport'
import { importedRosterOf } from '../../../domain/importedRoster'

// Made-up people
const read = () => importedRosterOf({
  players: [
    { number: 7, licence: '123451', firstName: 'Luca', lastName: 'Exempel', isCaptain: true, confidence: { number: 0.7, licence: 0.96, firstName: 0.95, lastName: 0.95 } },
    { number: 7, licence: '123452', firstName: 'Noé', lastName: 'Musler', confidence: { number: 0.7, licence: 0.96, firstName: 0.9, lastName: 0.4 } }
  ],
  coach: { firstName: 'Hans', lastName: 'Muster', licence: '10001' }
}, 'ocr')
const savedTeam = { players: [{ number: 9, first_name: 'Noé', last_name: 'Muster', license_number: '123452', active: true }], staff: [] }

const engines = []
beforeEach(() => {
  readRosterPhoto.mockReset()
  engines.length = 0
  startOcrEngine.mockReset()
  startOcrEngine.mockImplementation(() => { const e = { terminate: vi.fn(async () => {}), ready: Promise.resolve([]) }; engines.push(e); return e })
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:photo')
  globalThis.URL.revokeObjectURL = vi.fn()
})

async function toCrop () {
  fireEvent.click(screen.getByTestId('roster-photo-home'))
  expect(screen.getByTestId('roster-photo-source')).toBeInTheDocument()
  fireEvent.change(screen.getByTestId('roster-photo-file-home'), { target: { files: [new File(['x'], 'list.jpg', { type: 'image/jpeg' })] } })
  await screen.findByTestId('roster-photo-read')
}

describe('RosterPhotoImport', () => {
  it('the recognition starts when the dialog opens, the reading uses it, and it ends after the reading and on close', async () => {
    readRosterPhoto.mockResolvedValue(read())
    render(<RosterPhotoImport side="home" teamLabel="VBC Seewiese" onApply={() => {}} />)
    fireEvent.click(screen.getByTestId('roster-photo-home'))
    await waitFor(() => expect(startOcrEngine).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByTestId('roster-photo-file-home'), { target: { files: [new File(['x'], 'list.jpg', { type: 'image/jpeg' })] } })
    await screen.findByTestId('roster-photo-read')
    // (still the one started at the opening)
    expect(startOcrEngine).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('roster-photo-read'))
    await screen.findByTestId('roster-photo-players')
    expect(readRosterPhoto.mock.calls[0][1].engine).toBe(engines[0])
    await waitFor(() => expect(engines[0].terminate).toHaveBeenCalled())

    // another photo: a new one, ended when the dialog closes
    readRosterPhoto.mockReset()
    fireEvent.click(screen.getByTestId('roster-photo-cancel'))
    fireEvent.click(screen.getByTestId('roster-photo-home'))
    await waitFor(() => expect(startOcrEngine).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByText('common.cancel'))
    await waitFor(() => expect(engines[1].terminate).toHaveBeenCalled())
  })

  it('the page hidden (the camera app in front) ends the recognition; back, it starts again', async () => {
    render(<RosterPhotoImport side="home" teamLabel="VBC Seewiese" onApply={() => {}} />)
    fireEvent.click(screen.getByTestId('roster-photo-home'))
    await waitFor(() => expect(startOcrEngine).toHaveBeenCalledTimes(1))
    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(engines[0].terminate).toHaveBeenCalled())
    state.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(startOcrEngine).toHaveBeenCalledTimes(2))
    state.mockRestore()
  })

  it('nothing is applied until the scorer fixes the red fields and taps Use; the edits are what is applied', async () => {
    readRosterPhoto.mockResolvedValue(read())
    const onApply = vi.fn()
    render(<RosterPhotoImport side="home" teamLabel="VBC Seewiese" savedTeam={savedTeam} onApply={onApply} />)
    await toCrop()
    fireEvent.click(screen.getByTestId('roster-photo-read'))
    const table = await screen.findByTestId('roster-photo-players')

    // the saved team's spelling for the known SV number; the method shown
    const lasts = within(table).getAllByTestId('roster-photo-last')
    expect(lasts.map(i => i.value)).toEqual(['Exempel', 'Muster'])
    expect(screen.getByTestId('roster-photo-method').textContent).toContain('rosterPhoto.confirm.method')
    expect(screen.getByTestId('roster-photo-method').textContent).toContain('rosterPhoto.confirm.fromSaved:1')

    // 7 twice: red, and "Use" stays off
    const numbers = within(table).getAllByTestId('roster-photo-number')
    expect(numbers.map(i => i.getAttribute('data-issue'))).toEqual(['invalid', 'invalid'])
    expect(screen.getByTestId('roster-photo-apply')).toBeDisabled()
    expect(screen.getByTestId('roster-photo-issues').textContent).toContain('rosterPhoto.confirm.toFix:2')
    expect(onApply).not.toHaveBeenCalled()

    // the scorer corrects the second number and marks a libero
    fireEvent.change(numbers[1], { target: { value: '12' } })
    fireEvent.click(within(table).getAllByTestId('roster-photo-libero')[1])
    expect(screen.getByTestId('roster-photo-apply')).not.toBeDisabled()
    fireEvent.click(screen.getByTestId('roster-photo-apply'))

    expect(onApply).toHaveBeenCalledTimes(1)
    const applied = onApply.mock.calls[0][0]
    expect(applied.source).toBe('ocr')
    expect(applied.players.map(p => [p.number, p.lastName, p.isCaptain, p.isLibero])).toEqual([[7, 'Exempel', true, false], [12, 'Muster', false, true]])
    expect(applied.coach).toMatchObject({ lastName: 'Muster', licence: '10001' })
    // the dialog is gone
    expect(screen.queryByTestId('roster-photo-players')).toBeNull()
  })

  it('a row struck out on the list is named on the confirm screen and never applied (real photos, 2026-11-26)', async () => {
    readRosterPhoto.mockResolvedValue({ ...read(), struck: [{ firstName: 'Rita', lastName: 'Probst', licence: '123459' }] })
    const onApply = vi.fn()
    render(<RosterPhotoImport side="home" teamLabel="VBC" onApply={onApply} />)
    await toCrop()
    fireEvent.click(screen.getByTestId('roster-photo-read'))
    expect(await screen.findByTestId('roster-photo-struck')).toHaveTextContent('rosterPhoto.confirm.struck:1')
    expect(screen.getAllByTestId('roster-photo-row')).toHaveLength(2)
  })

  it('Cancel on the confirm screen applies nothing', async () => {
    readRosterPhoto.mockResolvedValue(read())
    const onApply = vi.fn()
    render(<RosterPhotoImport side="home" teamLabel="VBC" onApply={onApply} />)
    await toCrop()
    fireEvent.click(screen.getByTestId('roster-photo-read'))
    await screen.findByTestId('roster-photo-players')
    fireEvent.click(screen.getByTestId('roster-photo-cancel'))
    expect(onApply).not.toHaveBeenCalled()
    expect(screen.queryByTestId('roster-photo-players')).toBeNull()
  })

  it('a row can be removed before it is used', async () => {
    readRosterPhoto.mockResolvedValue(read())
    const onApply = vi.fn()
    render(<RosterPhotoImport side="away" teamLabel="VBC" onApply={onApply} />)
    fireEvent.click(screen.getByTestId('roster-photo-away'))
    fireEvent.change(screen.getByTestId('roster-photo-file-away'), { target: { files: [new File(['x'], 'list.png', { type: 'image/png' })] } })
    fireEvent.click(await screen.findByTestId('roster-photo-read'))
    const table = await screen.findByTestId('roster-photo-players')
    fireEvent.click(within(table).getAllByTestId('roster-photo-remove')[1])
    fireEvent.click(screen.getByTestId('roster-photo-apply'))
    expect(onApply.mock.calls[0][0].players.map(p => p.licence)).toEqual(['123451'])
  })

  it('a reading that fails says why, and offers the same photo again', async () => {
    readRosterPhoto.mockRejectedValue(Object.assign(new Error('slow'), { code: 'ocr-timeout' }))
    render(<RosterPhotoImport side="home" teamLabel="VBC" onApply={() => {}} />)
    await toCrop()
    fireEvent.click(screen.getByTestId('roster-photo-read'))
    const error = await screen.findByTestId('roster-photo-error')
    expect(error.getAttribute('data-code')).toBe('ocr-timeout')
    expect(error.textContent).toBe('rosterPhoto.error.ocr-timeout')
    fireEvent.click(screen.getByTestId('roster-photo-retry'))
    await waitFor(() => expect(screen.getByTestId('roster-photo-read')).toBeInTheDocument())
  })

  it('Turn moves the page\'s top to the next side', async () => {
    render(<RosterPhotoImport side="home" teamLabel="VBC" onApply={() => {}} />)
    await toCrop()
    const before = (await screen.findByTestId('roster-photo-corner-0')).getAttribute('aria-valuetext')
    fireEvent.click(screen.getByTestId('roster-photo-turn'))
    expect(screen.getByTestId('roster-photo-corner-0').getAttribute('aria-valuetext')).not.toBe(before)
  })

  it('the bar never shows 100 % while reading, even if the reading says 1: only the check screen ends it (owner 27.11)', async () => {
    let finish
    readRosterPhoto.mockImplementation((page, opts) => new Promise((resolve) => {
      opts.onProgress(0.5, 'recognizing text')
      opts.onProgress(1, 'reading marks')
      finish = () => resolve(read())
    }))
    render(<RosterPhotoImport side="home" teamLabel="VBC Seewiese" onApply={() => {}} />)
    await toCrop()
    fireEvent.click(screen.getByTestId('roster-photo-read'))
    const now = () => Number(screen.getByRole('progressbar').getAttribute('aria-valuenow'))
    await waitFor(() => expect(now()).toBeGreaterThan(50))
    expect(now()).toBeLessThan(100)
    finish()
    await screen.findByTestId('roster-photo-players')
  })
})
