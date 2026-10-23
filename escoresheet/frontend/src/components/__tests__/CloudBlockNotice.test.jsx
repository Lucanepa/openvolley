import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import en from '../../i18n/locales/en.json'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), en) ?? key
  })
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
