// Roster import › Photo (owner 27.11.2026): RosterPhotoImport's `entry="sources"`
// shows "Take a photo" and "Choose a picture" in the roster editor, each opening
// its source at once; the photo dialog opens with the photo (corners), never at
// its source step. The default entry keeps its one button. Made-up names.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key) => key, i18n: { language: 'en' } })
}))
// jsdom draws nothing: the photo's pixels and the recognition are stand-ins
vi.mock('../../utils/rosterPhoto/scan', async (orig) => ({
  ...(await orig()),
  loadPhoto: vi.fn(async () => ({ width: 800, height: 1100 })),
  guessCorners: vi.fn(() => [[10, 10], [790, 10], [790, 1090], [10, 1090]]),
  scanPage: vi.fn(() => ({ width: 1600, height: 2200 })),
  canvasBlob: vi.fn(async () => new Blob(['jpeg']))
}))
vi.mock('../../utils/rosterPhoto/ocr', () => ({
  readRosterPhoto: vi.fn(),
  startOcrEngine: vi.fn(() => ({ terminate: vi.fn(async () => {}), ready: Promise.resolve([]) }))
}))

import RosterPhotoImport from '../rosterPhoto/RosterPhotoImport'

beforeEach(() => {
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:photo')
  globalThis.URL.revokeObjectURL = vi.fn()
})

describe('RosterPhotoImport entry="sources"', () => {
  it('two buttons, each opening its source at once, once the list\'s language is picked', () => {
    render(<RosterPhotoImport entry="sources" side="away" teamLabel="VC Talheim" onApply={() => {}} />)
    expect(screen.queryByTestId('roster-photo-away')).toBeNull()
    const camera = vi.spyOn(screen.getByTestId('roster-photo-camera-away'), 'click').mockImplementation(() => {})
    const picker = vi.spyOn(screen.getByTestId('roster-photo-file-away'), 'click').mockImplementation(() => {})
    // (no language yet: the buttons wait)
    fireEvent.click(screen.getByTestId('roster-photo-take-away'))
    expect(camera).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('roster-photo-lang-away-it'))
    fireEvent.click(screen.getByTestId('roster-photo-take-away'))
    expect(camera).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('roster-photo-choose-away'))
    expect(picker).toHaveBeenCalledTimes(1)
    // nothing open yet: the camera or the picker is in front
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByTestId('roster-photo-take-away').closest('[data-help-id="setup-photo-import"]')).not.toBeNull()
  })

  it('the photo opens the dialog at its corners, not at the source step', async () => {
    render(<RosterPhotoImport entry="sources" side="home" teamLabel="VBC Seewiese" onApply={() => {}} />)
    fireEvent.change(screen.getByTestId('roster-photo-file-home'), { target: { files: [new File(['x'], 'list.jpg', { type: 'image/jpeg' })] } })
    expect(await screen.findByTestId('roster-photo-read')).toBeInTheDocument()
    expect(screen.queryByTestId('roster-photo-source')).toBeNull()
  })

  it('disabled while a PDF is read', () => {
    render(<RosterPhotoImport entry="sources" side="home" disabled onApply={() => {}} />)
    expect(screen.getByTestId('roster-photo-take-home')).toBeDisabled()
    expect(screen.getByTestId('roster-photo-choose-home')).toBeDisabled()
  })

  it('the default entry keeps its one button and the source step', () => {
    render(<RosterPhotoImport side="home" onApply={() => {}} />)
    expect(screen.queryByTestId('roster-photo-take-home')).toBeNull()
    fireEvent.click(screen.getByTestId('roster-photo-home'))
    expect(screen.getByTestId('roster-photo-source')).toBeInTheDocument()
  })
})
