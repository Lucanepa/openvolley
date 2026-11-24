import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key) => key, i18n: { language: 'en' } })
}))
const reload = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('../../diagnostics/reload', () => ({ reloadWithReason: (...a) => reload.fn(...a) }))
// The sheet itself is App_Scoresheet's (its tests): here the dialog's steps
const sheet = vi.hoisted(() => ({ props: null, throwWith: null }))
vi.mock('../../../scoresheet_pdf/App_Scoresheet', () => ({
  default: (props) => {
    if (sheet.throwWith) throw sheet.throwWith
    sheet.props = props
    return <div data-testid="sheet" />
  }
}))

import RebuildScoresheet, { isChunkLoadError, REBUILD_TIMEOUT_MS } from '../manage/RebuildScoresheet'
import { PDF_TIMEOUT_MS } from '../../utils/scoresheetPdfRequest'

const pdf = { blob: new Blob(['%PDF-1.4'], { type: 'application/pdf' }), filename: 'game1.pdf' }

describe('RebuildScoresheet', () => {
  let onDone
  let onCancel
  beforeEach(() => {
    sheet.props = null
    sheet.throwWith = null
    onDone = vi.fn()
    onCancel = vi.fn()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  const show = (props = {}) => render(
    <RebuildScoresheet matchData={{ match: {} }} remark="Rebuilt after the match" title="Game 1" onDone={onDone} onCancel={onCancel} {...props} />
  )

  it('draws the sheet with getBlob and the remark; its PDF goes to onDone once', async () => {
    show()
    await screen.findByTestId('sheet')
    expect(sheet.props).toMatchObject({ autoAction: 'getBlob', readOnly: true, embedded: true, extraRemarks: ['Rebuilt after the match'] })
    sheet.props.onBlob(pdf)
    sheet.props.onBlob(pdf)
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledWith(pdf, undefined)
  })

  it('Cancel while the PDF is made: a PDF (or a failure) that comes out afterwards is never handed on', async () => {
    show()
    await screen.findByTestId('sheet')
    const late = sheet.props.onBlob
    fireEvent.click(screen.getByTestId('rebuild-scoresheet-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
    late(pdf)
    late(null)
    expect(onDone).not.toHaveBeenCalled()
  })

  it('no PDF in time: "could not be made" (timed out), and a PDF after that is dropped', async () => {
    expect(REBUILD_TIMEOUT_MS).toBe(PDF_TIMEOUT_MS)
    show({ timeoutMs: 40 })
    await screen.findByTestId('sheet')
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(null, { timedOut: true }))
    sheet.props.onBlob(pdf)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('a sheet that throws while drawing: the error in this dialog (not a blank manager), nothing stored, Close', async () => {
    sheet.throwWith = new TypeError("Cannot read properties of undefined (reading 'index')")
    show({ timeoutMs: 40 })
    expect(await screen.findByTestId('rebuild-scoresheet-failed')).toHaveTextContent('manage.scoresheets.rebuildDrawFailed')
    expect(screen.getByTestId('rebuild-scoresheet-error')).toHaveTextContent("reading 'index'")
    expect(screen.queryByTestId('rebuild-scoresheet-reload')).toBeNull()
    // the bar stays: Close ends it
    expect(screen.getByTestId('rebuild-scoresheet-cancel')).toHaveTextContent('common.close')
    await new Promise(r => setTimeout(r, 80))
    expect(onDone).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('rebuild-scoresheet-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('the sheet\'s chunk gone after a deploy: says so and offers Reload', async () => {
    sheet.throwWith = new TypeError('Failed to fetch dynamically imported module: https://manager.example/assets/App_Scoresheet-abc123.js')
    show()
    expect(await screen.findByTestId('rebuild-scoresheet-failed')).toHaveTextContent('manage.scoresheets.rebuildUpdated')
    fireEvent.click(screen.getByTestId('rebuild-scoresheet-reload'))
    expect(reload.fn).toHaveBeenCalledWith('rebuild-chunk')
    expect(onDone).not.toHaveBeenCalled()
  })

  it('isChunkLoadError: Chromium, Firefox, Safari and webpack wordings; not an ordinary error', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: /a.js'))).toBe(true)
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module: /a.js'))).toBe(true)
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true)
    expect(isChunkLoadError(Object.assign(new Error('Loading chunk 7 failed'), { name: 'ChunkLoadError' }))).toBe(true)
    expect(isChunkLoadError(new Error('boom'))).toBe(false)
    expect(isChunkLoadError(null)).toBe(false)
  })
})
