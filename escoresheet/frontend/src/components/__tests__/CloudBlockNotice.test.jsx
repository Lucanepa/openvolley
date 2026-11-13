import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import en from '../../i18n/locales/en.json'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, params) => {
      const text = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), en) ?? key
      return typeof text === 'string' ? text.replace(/\{\{(\w+)\}\}/g, (_, p) => params?.[p] ?? '') : text
    }
  })
}))

const queue = vi.hoisted(() => ({ split: vi.fn(async () => 3) }))
vi.mock('../../utils/refusedRestore', () => ({
  RESTORE_REFUSED: 'OV_RESTORE_REFUSED',
  splitRefusedRestore: (...args) => queue.split(...args)
}))

import CloudBlockNotice, { cloudBlockMessage } from '../CloudBlockNotice'

// 2026-10-23: a copy still scored here whose match the server closed says
// that it differs and what to do; a copy that ended here keeps the plain text
describe('the notice of a match the server closed', () => {
  const t = (k) => k
  const block = { code: 'OV_MATCH_CLOSED' }

  it('a copy still scored here: it differs, load the official version or remove it', () => {
    expect(cloudBlockMessage(block, { status: 'live', cloudBlock: block }, t)).toEqual({ key: 'cloudBlock.matchClosedDiffers', params: {}, join: false })
    expect(cloudBlockMessage(block, { status: 'scheduled', cloudBlock: block }, t).key).toBe('cloudBlock.matchClosedDiffers')
  })

  it('a copy that ended, was approved or is final here: the plain sentence', () => {
    for (const status of ['ended', 'approved', 'final']) {
      expect(cloudBlockMessage(block, { status, cloudBlock: block }, t).key).toBe('cloudBlock.matchClosed')
    }
  })

  it('a test match: the plain sentence', () => {
    expect(cloudBlockMessage(block, { status: 'live', test: true, cloudBlock: block }, t).key).toBe('cloudBlock.matchClosed')
  })

  it('shows the English text on the home screen', () => {
    render(<CloudBlockNotice match={{ status: 'live', cloudBlock: block }} />)
    expect(screen.getByTestId('cloud-block-notice').textContent).toBe(en.cloudBlock.matchClosedDiffers)
  })
})

// fe-sync-7: a restore the server refused (a body over its limit) held
// every later write of the match, and nothing said why
describe('the notice of a refused restore', () => {
  const t = (k) => k
  const block = { code: 'OV_RESTORE_REFUSED', reason: 'OV_BODY_TOO_LARGE' }

  it('names the game and the server\'s reason', () => {
    expect(cloudBlockMessage(block, { gameN: 4711, cloudBlock: block }, t)).toEqual({ key: 'cloudBlock.restoreNotSent', params: { game: 4711, reason: 'OV_BODY_TOO_LARGE' }, join: false, parts: true })
    expect(cloudBlockMessage(block, { cloudBlock: block }, t).key).toBe('cloudBlock.restoreNotSentNoGame')
  })

  it('says what to do, and sends the restore in parts on request', async () => {
    render(<CloudBlockNotice match={{ seed_key: 'match_100_aaa', gameN: 4711, status: 'live', cloudBlock: block }} />)
    const text = screen.getByTestId('cloud-block-notice').textContent
    expect(text).toContain('game 4711')
    expect(text).toContain('OV_BODY_TOO_LARGE')
    expect(text).toContain('Contact support')
    fireEvent.click(screen.getByRole('button', { name: en.cloudBlock.sendInParts }))
    expect(queue.split).toHaveBeenCalledWith('match_100_aaa')
    expect(await screen.findByRole('button', { name: en.cloudBlock.sendingInParts })).toBeDisabled()
  })
})
