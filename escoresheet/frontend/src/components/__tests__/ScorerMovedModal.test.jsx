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
