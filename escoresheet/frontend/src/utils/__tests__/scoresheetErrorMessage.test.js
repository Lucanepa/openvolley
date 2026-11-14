import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  MAX_ERROR_DETAILS,
  MAX_ERROR_TEXT,
  SCORESHEET_ERROR,
  postScoresheetError,
  scoresheetErrorFromEvent,
  scoresheetErrorMessage,
} from '../scoresheetErrorMessage.js'

const win = { location: { origin: 'https://app.openvolley.app' } }
const sheet = { name: 'the scoresheet window' }

describe('scoresheet error messages', () => {
  it('are posted to the app origin only, as text', () => {
    const opener = { postMessage: vi.fn() }
    const err = new Error('Cannot read the match')
    postScoresheetError(opener, err, 'App_Scoresheet.tsx:12', win)
    expect(opener.postMessage).toHaveBeenCalledWith(
      { type: SCORESHEET_ERROR, error: 'Cannot read the match', details: 'App_Scoresheet.tsx:12' },
      'https://app.openvolley.app'
    )
    expect(scoresheetErrorMessage(err).details).toBe(err.stack)
    expect(scoresheetErrorMessage('x'.repeat(5000)).error).toHaveLength(MAX_ERROR_TEXT)
  })

  it('are taken from the app origin and the window it opened only', () => {
    const data = { type: SCORESHEET_ERROR, error: 'Boom', details: 'line 1' }
    expect(scoresheetErrorFromEvent({ origin: win.location.origin, source: sheet, data }, { win, source: sheet }))
      .toEqual({ error: 'Boom', details: 'line 1' })
    // another site that holds a reference to the scorer's tab
    expect(scoresheetErrorFromEvent({ origin: 'https://other.example', source: sheet, data }, { win, source: sheet })).toBeNull()
    // the app's origin, but not the window the app opened
    expect(scoresheetErrorFromEvent({ origin: win.location.origin, source: {}, data }, { win, source: sheet })).toBeNull()
    // no window known (opened in another way): the origin decides
    expect(scoresheetErrorFromEvent({ origin: win.location.origin, source: {}, data }, { win })).not.toBeNull()
    // not ours
    expect(scoresheetErrorFromEvent({ origin: win.location.origin, data: { type: 'OTHER' } }, { win })).toBeNull()
    expect(scoresheetErrorFromEvent({ origin: win.location.origin, data: 'SCORESHEET_ERROR' }, { win })).toBeNull()
  })

  it('never hand an object or a huge text to the error dialog', () => {
    const got = scoresheetErrorFromEvent({
      origin: win.location.origin,
      data: { type: SCORESHEET_ERROR, error: { toString: () => 'obj' }, details: 'd'.repeat(10000) },
    }, { win })
    expect(got.error).toBe('obj')
    expect(typeof got.details).toBe('string')
    expect(got.details).toHaveLength(MAX_ERROR_DETAILS)
    const empty = scoresheetErrorFromEvent({ origin: win.location.origin, data: { type: SCORESHEET_ERROR, error: {} } }, { win })
    expect(typeof empty.error).toBe('string')
  })

  it('the scoresheet page and the scorer use them (no wildcard target, no unchecked listener)', () => {
    const root = resolve(__dirname, '../../..')
    const page = readFileSync(resolve(root, 'scoresheet_pdf/index_scoresheet.tsx'), 'utf8')
    expect(page).toContain('postScoresheetError(')
    expect(page).not.toMatch(/SCORESHEET_ERROR[\s\S]{0,400}'\*'\)/)
    const board = readFileSync(resolve(root, 'src/components/Scoreboard.jsx'), 'utf8')
    expect(board).toContain('scoresheetErrorFromEvent(event')
    expect(board).not.toContain("event.data.type === 'SCORESHEET_ERROR'")
  })
})
