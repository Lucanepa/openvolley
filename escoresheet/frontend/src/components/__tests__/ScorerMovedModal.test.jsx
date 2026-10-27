import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import en from '../../i18n/locales/en.json'

// The English strings, with {{x}} filled in
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, params = {}) => {
      const v = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), en)
      return typeof v === 'string' ? v.replace(/\{\{(\w+)\}\}/g, (_, p) => String(params[p] ?? '')) : key
    },
    i18n: { language: 'en-GB' }
  })
}))

import ScorerMovedModal, { formatTakeOver } from '../ScorerMovedModal'
import { cloudBlockMessage } from '../CloudBlockNotice'

describe('ScorerMovedModal', () => {
  const now = new Date()
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 19, 54).toISOString()

  it('says where the match is scored now, and offers Take back and Close only', async () => {
    const onTakeBack = vi.fn(async () => {})
    const onClose = vi.fn()
    render(<ScorerMovedModal scorer={{ platform: 'android', at }} onTakeBack={onTakeBack} onClose={onClose} />)
    expect(screen.getByRole('alert').textContent).toBe('This match is now scored on another device (Android phone or tablet, 19:54). This device no longer scores it.')
    expect(screen.queryByRole('button', { name: /close/i })).not.toBeNull()
    expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['Close', 'Take back scoring here'])
    fireEvent.click(screen.getByRole('button', { name: 'Take back scoring here' }))
    await waitFor(() => expect(onTakeBack).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a take-back that cannot load the cloud copy says why and stays', async () => {
    const onTakeBack = vi.fn(async () => ({ error: 'offline' }))
    render(<ScorerMovedModal scorer={null} onTakeBack={onTakeBack} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Take back scoring here' }))
    expect((await screen.findByTestId('scorer-moved-error')).textContent).toBe(en.scorerMoved.errors.offline)
    // an unknown reason, or a throw, is the generic one
    onTakeBack.mockImplementationOnce(async () => { throw new Error('x') })
    fireEvent.click(screen.getByRole('button', { name: 'Take back scoring here' }))
    await waitFor(() => expect(screen.getByTestId('scorer-moved-error').textContent).toBe(en.scorerMoved.errors.failed))
  })

  // The owner, 2026-10-27: Take back shows the server's score first, so the
  // scorer compares it with the scoreboard; only the second tap takes back
  it('with onPreview: Take back shows the server\'s score and asks again; Cancel leaves it', async () => {
    const onPreview = vi.fn(async () => ({ score: { set: 3, home: 14, away: 12, setsHome: 1, setsAway: 1 } }))
    const onTakeBack = vi.fn(async () => ({ ok: true }))
    const onScoresheet = vi.fn()
    render(<ScorerMovedModal scorer={{ platform: 'android', at }} onPreview={onPreview} onTakeBack={onTakeBack} onScoresheet={onScoresheet} onClose={() => {}} />)
    expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['Close', en.header.scoresheet, 'Take back scoring here'])
    fireEvent.click(screen.getByRole('button', { name: en.header.scoresheet }))
    expect(onScoresheet).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Take back scoring here' }))
    const preview = await screen.findByTestId('scorer-moved-preview')
    expect(preview.textContent).toContain('Set 3 · 14:12 · sets 1:1')
    expect(preview.textContent).toContain(en.scorerMoved.compareHint)
    expect(onTakeBack).not.toHaveBeenCalled()
    expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual([en.common.cancel, en.scorerMoved.confirmTakeBack])

    fireEvent.click(screen.getByRole('button', { name: en.common.cancel }))
    expect(screen.queryByTestId('scorer-moved-preview')).toBeNull()
    expect(onTakeBack).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Take back scoring here' }))
    await screen.findByTestId('scorer-moved-preview')
    fireEvent.click(screen.getByRole('button', { name: en.scorerMoved.confirmTakeBack }))
    await waitFor(() => expect(onTakeBack).toHaveBeenCalledTimes(1))
    expect(onPreview).toHaveBeenCalledTimes(2)
  })

  it('with onPreview offline: the take-back\'s own message, no score, nothing taken back', async () => {
    const onTakeBack = vi.fn()
    render(<ScorerMovedModal scorer={null} onPreview={vi.fn(async () => ({ error: 'offline' }))} onTakeBack={onTakeBack} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Take back scoring here' }))
    expect((await screen.findByTestId('scorer-moved-error')).textContent).toBe(en.scorerMoved.errors.offline)
    expect(screen.queryByTestId('scorer-moved-preview')).toBeNull()
    expect(onTakeBack).not.toHaveBeenCalled()
  })

  it('closed on the other device: the final result loads at once, no comparison', async () => {
    const onPreview = vi.fn()
    const onTakeBack = vi.fn(async () => ({ ok: true }))
    render(<ScorerMovedModal scorer={null} closed onPreview={onPreview} onTakeBack={onTakeBack} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: en.scorerMoved.showResult }))
    await waitFor(() => expect(onTakeBack).toHaveBeenCalledTimes(1))
    expect(onPreview).not.toHaveBeenCalled()
  })

  it('closed on the other device: says so and only loads the final result', () => {
    render(<ScorerMovedModal scorer={{ platform: 'android', at }} closed onTakeBack={() => {}} onClose={() => {}} />)
    expect(screen.getByRole('alert').textContent).toBe(en.scorerMoved.bodyClosed)
    expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['Close', en.scorerMoved.showResult])
  })

  it('without a known platform or time: the plain sentence', () => {
    render(<ScorerMovedModal scorer={null} onTakeBack={() => {}} onClose={() => {}} />)
    expect(screen.getByRole('alert').textContent).toBe('This match is now scored on another device. This device no longer scores it.')
  })

  it('another day shows the date too; a bad time none', () => {
    const d = new Date(2026, 9, 20, 19, 54)
    expect(formatTakeOver(d.toISOString(), 'en-GB', new Date(2026, 9, 21, 9, 0))).toBe('20/10 19:54')
    expect(formatTakeOver('nope', 'en-GB')).toBeNull()
  })

  it('the home screen notice of such a match offers no PIN join', () => {
    const t = (k) => k
    expect(cloudBlockMessage({ code: 'OV_SCORER_MOVED' }, {}, t)).toEqual({ key: 'cloudBlock.scorerMoved', params: {}, join: false })
  })
})

// review 2026-10-21: only App's 30 s backup sync was guarded; the Scoreboard
// pushed the stale copy into the relay room on every (re)connect
describe('a device that lost the match publishes nothing of it to the relay room', () => {
  const src = readFileSync(resolve(__dirname, '../Scoreboard.jsx'), 'utf8')
  const body = (from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)))

  it('not the full sync on (re)connect, nor a tablet\'s data request', () => {
    expect(body('const syncMatchData = async', 'currentWs.send(JSON.stringify(syncPayload))')).toContain('if (isScorerMoved(freshMatch)) return')
    expect(body('const handleMatchDataRequest = async', "type: 'match-data-response',\n          requestId,\n          matchId: requestedMatchId,\n          success: true")).toContain('isScorerMoved(freshMatch)')
  })

  it('not its actions or live state (sendRelayMessage)', () => {
    expect(src).toMatch(/scorerMovedRef\.current = isScorerMoved\(data\?\.match\)/)
    expect(body('const sendRelayMessage = useCallback', 'ws.send(JSON.stringify(payload))')).toContain('if (scorerMovedRef.current) return')
  })
})
