import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { Approvals } from '../components/FooterSection'

// Account approvals on the printed sheet (docs/account-approval-spec.md 4.6):
// a drawn signature wins, else the stamp of a VALID approval, else nothing.

const SETS = [
  { index: 1, homePoints: 25, awayPoints: 20, finished: true },
  { index: 2, homePoints: 23, awayPoints: 25, finished: true },
  { index: 3, homePoints: 25, awayPoints: 18, finished: true }
]
const KEY = 'ov-result-v1|1:25:20,2:23:25,3:25:18'
const record = (slot: string, over: Record<string, unknown> = {}) => ({
  id: `${slot}-id`, short_id: '6F1C2A9B', slot, name: 'Muster Anna', approved_at: '2026-10-07T19:42:10.000Z',
  result_key: KEY, result_matches: true, mine: false, ...over
})

describe('Approvals cell: account approval stamp', () => {
  afterEach(() => cleanup())

  it('prints the stamp for a valid approval, with no image', () => {
    const { getByTestId, queryByAltText } = render(
      <Approvals match={{ accountApprovals: { referee1: record('referee1') } }} sets={SETS} />
    )
    expect(getByTestId('approval-stamp-referee1').textContent)
      .toBe('Approved electronically · Muster Anna · 07.10.2026 21:42 · ID 6F1C2A9B')
    expect(queryByAltText('1st Referee signature')).toBeNull()
    const cls = getByTestId('approval-stamp-referee1').className
    expect(cls).toContain('text-[6px]')
    expect(cls).toContain('overflow-hidden')
  })

  it('prints the drawn signature when both exist', () => {
    const { getByAltText, queryByTestId } = render(
      <Approvals match={{ scorerSignature: 'data:image/png;base64,SIG', accountApprovals: { scorer: record('scorer') } }} sets={SETS} />
    )
    expect(getByAltText('Scorer signature')).toHaveAttribute('src', 'data:image/png;base64,SIG')
    expect(queryByTestId('approval-stamp-scorer')).toBeNull()
  })

  it('prints nothing for a stale approval', () => {
    const changed = [...SETS.slice(0, 2), { index: 3, homePoints: 25, awayPoints: 23, finished: true }]
    const { queryByTestId, container } = render(
      <Approvals match={{ accountApprovals: { referee2: record('referee2') } }} sets={changed} />
    )
    expect(queryByTestId('approval-stamp-referee2')).toBeNull()
    expect(container.textContent).not.toContain('Approved electronically')
  })

  it('the assistant scorer row never prints an approval', () => {
    const { container } = render(
      <Approvals match={{ accountApprovals: { asstScorer: record('asstScorer') } }} sets={SETS} />
    )
    expect(container.textContent).not.toContain('Approved electronically')
  })
})
