import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

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
// the activity log (utils/activity/bus): what the photo import writes there
const emitActivity = vi.fn()
vi.mock('../../../utils/activity/bus', () => ({ emitActivity: (...args) => emitActivity(...args) }))

import RosterPhotoImport, { readingTime } from '../RosterPhotoImport'
import { importedRosterOf } from '../../../domain/importedRoster'
import { ACTIVITY_KINDS, sanitizeActivityData } from '../../../domain/activitySummary'

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
  emitActivity.mockReset()
  engines.length = 0
  startOcrEngine.mockReset()
  startOcrEngine.mockImplementation(() => { const e = { terminate: vi.fn(async () => {}), ready: Promise.resolve([]) }; engines.push(e); return e })
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:photo')
  globalThis.URL.revokeObjectURL = vi.fn()
})

// the dialog's source step: the list's language picked (none at first), then the photo
async function toCrop (lang = 'de') {
  fireEvent.click(screen.getByTestId('roster-photo-home'))
  expect(screen.getByTestId('roster-photo-source')).toBeInTheDocument()
  fireEvent.click(screen.getByTestId(`roster-photo-lang-dialog-${lang}`))
  fireEvent.change(screen.getByTestId('roster-photo-file-home'), { target: { files: [new File(['x'], 'list.jpg', { type: 'image/jpeg' })] } })
  await screen.findByTestId('roster-photo-read')
}

describe('RosterPhotoImport', () => {
  it('the recognition starts once the list\'s language is picked, with its languages; the reading uses it, and it ends after the reading and on close', async () => {
    readRosterPhoto.mockResolvedValue(read())
    const onApply = vi.fn()
    render(<RosterPhotoImport side="home" teamLabel="VBC Seewiese" onApply={onApply} />)
    fireEvent.click(screen.getByTestId('roster-photo-home'))
    // (no language yet: nothing started)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(startOcrEngine).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('roster-photo-lang-dialog-fr'))
    await waitFor(() => expect(startOcrEngine).toHaveBeenCalledTimes(1))
    expect(startOcrEngine.mock.calls[0][0]).toEqual({ langs: ['fra', 'deu'] })
    fireEvent.change(screen.getByTestId('roster-photo-file-home'), { target: { files: [new File(['x'], 'list.jpg', { type: 'image/jpeg' })] } })
    await screen.findByTestId('roster-photo-read')
    // (still the one started at the opening)
    expect(startOcrEngine).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('roster-photo-read'))
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    expect(readRosterPhoto.mock.calls[0][1].engine).toBe(engines[0])
    expect(readRosterPhoto.mock.calls[0][1].langs).toEqual(['fra', 'deu'])
    await waitFor(() => expect(engines[0].terminate).toHaveBeenCalled())

    // another photo: no language again (a conscious pick each time); a new engine, ended when the dialog closes
    readRosterPhoto.mockReset()
    fireEvent.click(screen.getByTestId('roster-photo-home'))
    expect(screen.getByTestId('roster-photo-take')).toBeDisabled()
    expect(screen.getByTestId('roster-photo-lang-hint-dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('roster-photo-lang-dialog-other'))
    await waitFor(() => expect(startOcrEngine).toHaveBeenCalledTimes(2))
    expect(startOcrEngine.mock.calls[1][0]).toEqual({ langs: ['deu', 'fra', 'ita'] })
    fireEvent.click(screen.getByText('common.cancel'))
    await waitFor(() => expect(engines[1].terminate).toHaveBeenCalled())
  })

  it('the page hidden (the camera app in front) ends the recognition; back, it starts again', async () => {
    render(<RosterPhotoImport side="home" teamLabel="VBC Seewiese" onApply={() => {}} />)
    fireEvent.click(screen.getByTestId('roster-photo-home'))
    fireEvent.click(screen.getByTestId('roster-photo-lang-dialog-it'))
    await waitFor(() => expect(startOcrEngine).toHaveBeenCalledTimes(1))
    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(engines[0].terminate).toHaveBeenCalled())
    state.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(startOcrEngine).toHaveBeenCalledTimes(2))
    state.mockRestore()
  })

  // owner 27.11.2026: "just already import them in the official roster and fix there"
  it('the list read goes straight to onApply, with its time: no check screen; the saved team\'s spelling and the confidence (the roster\'s marks) come along', async () => {
    readRosterPhoto.mockResolvedValue(read())
    const onApply = vi.fn()
    render(<RosterPhotoImport side="home" teamLabel="VBC Seewiese" savedTeam={savedTeam} onApply={onApply} />)
    await toCrop()
    fireEvent.click(screen.getByTestId('roster-photo-read'))
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    const [applied, meta] = onApply.mock.calls[0]
    expect(applied.source).toBe('ocr')
    // the saved team's spelling for the known SV number, marked as such; 7 twice as read (fixed in the roster)
    expect(applied.players.map(p => [p.number, p.lastName, p.isCaptain, !!p.fromSavedTeam])).toEqual([[7, 'Exempel', true, false], [7, 'Muster', false, true]])
    expect(applied.players[0].confidence).toMatchObject({ number: 0.7 })
    expect(applied.coach).toMatchObject({ lastName: 'Muster', licence: '10001' })
    expect(meta.readMs).toBeGreaterThanOrEqual(0)
    // the dialog is gone, and it never showed a check screen
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByTestId('roster-photo-players')).toBeNull()
  })

  it('a row struck out on the list goes along as struck, never as a player (real photos, 2026-11-26)', async () => {
    readRosterPhoto.mockResolvedValue({ ...read(), struck: [{ firstName: 'Rita', lastName: 'Probst', licence: '123459' }] })
    const onApply = vi.fn()
    render(<RosterPhotoImport side="home" teamLabel="VBC" onApply={onApply} />)
    await toCrop()
    fireEvent.click(screen.getByTestId('roster-photo-read'))
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    const [applied] = onApply.mock.calls[0]
    expect(applied.struck).toEqual([{ firstName: 'Rita', lastName: 'Probst', licence: '123459' }])
    expect(applied.players.map(p => p.lastName)).not.toContain('Probst')
  })

  it('Cancel while reading applies nothing', async () => {
    readRosterPhoto.mockImplementation((page, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'ocr-cancelled' })))
    }))
    const onApply = vi.fn()
    render(<RosterPhotoImport side="home" teamLabel="VBC" onApply={onApply} />)
    await toCrop()
    fireEvent.click(screen.getByTestId('roster-photo-read'))
    await waitFor(() => expect(readRosterPhoto).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('roster-photo-cancel'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onApply).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
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

  it('the bar never shows 100 % while reading, even if the reading says 1: only the end of the reading does (owner 27.11)', async () => {
    let finish
    readRosterPhoto.mockImplementation((page, opts) => new Promise((resolve) => {
      opts.onProgress(0.5, 'recognizing text')
      opts.onProgress(1, 'reading marks')
      finish = () => resolve(read())
    }))
    const onApply = vi.fn()
    render(<RosterPhotoImport side="home" teamLabel="VBC Seewiese" onApply={onApply} />)
    await toCrop()
    fireEvent.click(screen.getByTestId('roster-photo-read'))
    const now = () => Number(screen.getByRole('progressbar').getAttribute('aria-valuenow'))
    await waitFor(() => expect(now()).toBeGreaterThan(50))
    expect(now()).toBeLessThan(100)
    finish()
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
  })

  it('shows the time while reading and no "read on this device" note anywhere (owner 27.11)', async () => {
    let finish
    readRosterPhoto.mockImplementation((page, opts) => new Promise((resolve) => { opts.onProgress(0.5, 'recognizing text'); finish = () => resolve(read()) }))
    const onApply = vi.fn()
    render(<RosterPhotoImport side="home" teamLabel="VBC Seewiese" onApply={onApply} />)
    fireEvent.click(screen.getByTestId('roster-photo-home'))
    expect(screen.queryByText('rosterPhoto.source.private')).toBeNull()
    fireEvent.click(screen.getByTestId('roster-photo-lang-dialog-de'))
    fireEvent.change(screen.getByTestId('roster-photo-file-home'), { target: { files: [new File(['x'], 'list.jpg', { type: 'image/jpeg' })] } })
    await screen.findByTestId('roster-photo-read')
    fireEvent.click(screen.getByTestId('roster-photo-read'))
    expect(await screen.findByTestId('roster-photo-time')).toBeInTheDocument()
    expect(screen.queryByText('rosterPhoto.source.private')).toBeNull()
    await waitFor(() => expect(readRosterPhoto).toHaveBeenCalled())
    finish()
    // the total time goes with the roster (its banner shows it)
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    expect(onApply.mock.calls[0][1].readMs).toBeGreaterThanOrEqual(0)
  })

  // owner 27.11: the tablets' reading times reach the server (activity log, kind photo.read)
  const photoReads = () => emitActivity.mock.calls.filter(([kind]) => kind === 'photo.read')
  const ROSTER_STRINGS = ['Exempel', 'Musler', 'Muster', 'Luca', 'Noé', 'Hans', '12345', '10001', 'Rita', 'Probst', 'VBC']
  const onlyCounts = (data) => {
    expect(Object.keys(data).every((k) => ACTIVITY_KINDS['photo.read'].keys.includes(k))).toBe(true)
    // the texts are from fixed lists (outcome, the reader of the marks, the list's language); nothing read from the photo
    expect(Object.entries(data).filter(([, v]) => typeof v === 'string').map(([k]) => k)).toEqual(['outcome', 'marksBy', 'lang'])
    const json = JSON.stringify(data)
    for (const s of ROSTER_STRINGS) expect(json).not.toContain(s)
    // what the server keeps is all of it
    expect(sanitizeActivityData('photo.read', data)).toEqual(data)
  }

  it('a reading that worked writes one photo.read entry: its time and counts only', async () => {
    readRosterPhoto.mockImplementation(async (page, opts) => {
      opts.stats.workers = 3
      opts.stats.turned = true
      Object.assign(opts.stats, { msEngine: 5, msPage: 7, msHand: 2, marksBy: 'onnx' })
      return { ...read(), struck: [{ firstName: 'Rita', lastName: 'Probst', licence: '123459' }] }
    })
    const onApply = vi.fn()
    render(<RosterPhotoImport side="home" teamLabel="VBC Seewiese" onApply={onApply} />)
    await toCrop('it')
    fireEvent.click(screen.getByTestId('roster-photo-read'))
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    expect(photoReads()).toHaveLength(1)
    const [, data, opts] = photoReads()[0]
    expect(opts).toEqual({ level: 'info' })
    // 7 twice (red), a last name hard to read (amber); the struck row counted, not named
    expect(data).toMatchObject({ outcome: 'ok', rows: 2, toCheck: 3, struck: 1, workers: 3, turned: true, msEngine: 5, msPage: 7, msHand: 2, marksBy: 'onnx', lang: 'it' })
    expect(data.ms).toBeGreaterThanOrEqual(0)
    expect(data.msRest).toBe(Math.max(0, data.ms - 14))
    expect(Object.keys(data).sort()).toEqual(['cores', 'lang', 'marksBy', 'memory', 'ms', 'msEngine', 'msHand', 'msPage', 'msRest', 'outcome', 'rows', 'struck', 'toCheck', 'turned', 'workers'])
    onlyCounts(data)
    // written once, when the reading ended
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(photoReads()).toHaveLength(1)
  })

  it('a reading that fails writes one entry with its code, as a warning', async () => {
    readRosterPhoto.mockImplementation(async (page, opts) => {
      opts.stats.workers = 1
      throw Object.assign(new Error('blurry'), { code: 'ocr-blurry' })
    })
    render(<RosterPhotoImport side="home" teamLabel="VBC" onApply={() => {}} />)
    await toCrop()
    fireEvent.click(screen.getByTestId('roster-photo-read'))
    await screen.findByTestId('roster-photo-error')
    expect(photoReads()).toHaveLength(1)
    const [, data, opts] = photoReads()[0]
    expect(opts).toEqual({ level: 'warn' })
    expect(data).toMatchObject({ outcome: 'ocr-blurry', workers: 1, turned: false, lang: 'de' })
    expect(data).not.toHaveProperty('rows')
    onlyCounts(data)
  })

  it('a reading the scorer cancels writes nothing', async () => {
    readRosterPhoto.mockImplementation((page, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'ocr-cancelled' })))
    }))
    render(<RosterPhotoImport side="home" teamLabel="VBC" onApply={() => {}} />)
    await toCrop()
    fireEvent.click(screen.getByTestId('roster-photo-read'))
    await waitFor(() => expect(readRosterPhoto).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('roster-photo-cancel'))
    await waitFor(() => expect(screen.queryByTestId('roster-photo-reading')).toBeNull())
    // (the rejection after the abort has run)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(photoReads()).toHaveLength(0)
  })

  it('readingTime: the elapsed seconds, and the time left once a tenth is read', () => {
    const t = (key, o) => `${key}|${o.elapsed}|${o.left ?? ''}`
    expect(readingTime(3400, 0.05, t)).toBe('rosterPhoto.reading.elapsed|3|')
    expect(readingTime(6000, 0.5, t)).toBe('rosterPhoto.reading.elapsedLeft|6|6')
    expect(readingTime(9000, 0.75, t)).toBe('rosterPhoto.reading.elapsedLeft|9|3')
    expect(readingTime(12000, 1, t)).toBe('rosterPhoto.reading.elapsed|12|')
  })

  // owner 27.11.2026: the list's language first, no default, never remembered
  it('Match setup\'s Photo segment: "Take a photo" and "Choose a picture" wait for the list\'s language, with a hint why; no language is picked for the scorer', async () => {
    readRosterPhoto.mockResolvedValue(read())
    const onApply = vi.fn()
    render(<RosterPhotoImport entry="sources" side="away" teamLabel="VBC" onApply={onApply} />)
    const take = screen.getByTestId('roster-photo-take-away')
    const choose = screen.getByTestId('roster-photo-choose-away')
    expect(take).toBeDisabled()
    expect(choose).toBeDisabled()
    expect(screen.getByTestId('roster-photo-lang-hint-away').textContent).toBe('rosterPhoto.lang.hint')
    // a radio group with nothing checked, the four choices, the first one reachable by Tab
    const radios = screen.getAllByRole('radio')
    expect(radios.map((r) => r.textContent)).toEqual(['Deutsch', 'Français', 'Italiano', 'rosterPhoto.lang.other'])
    expect(radios.every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true)
    expect(radios[0].tabIndex).toBe(0)
    // nothing starts before the pick
    expect(startOcrEngine).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('roster-photo-lang-away-de'))
    expect(take).not.toBeDisabled()
    expect(choose).not.toBeDisabled()
    expect(screen.queryByTestId('roster-photo-lang-hint-away')).toBeNull()
    expect(screen.getByTestId('roster-photo-lang-away-de').getAttribute('aria-checked')).toBe('true')
    fireEvent.change(screen.getByTestId('roster-photo-file-away'), { target: { files: [new File(['x'], 'list.jpg', { type: 'image/jpeg' })] } })
    await screen.findByTestId('roster-photo-read')
    await waitFor(() => expect(startOcrEngine).toHaveBeenCalledWith({ langs: ['deu'] }))
    fireEvent.click(screen.getByTestId('roster-photo-read'))
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    expect(readRosterPhoto.mock.calls[0][1].langs).toEqual(['deu'])
    // the next photo import starts blank again
    expect(screen.getByTestId('roster-photo-take-away')).toBeDisabled()
    expect(screen.getAllByRole('radio').every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true)
  })
})
