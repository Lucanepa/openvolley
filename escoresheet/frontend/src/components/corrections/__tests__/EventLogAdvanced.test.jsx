import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { buildMatch, MATCH, HOME_TEAM, AWAY_TEAM, pointsFor } from '../../../domain/__tests__/fixtures/correctionsMatch'
import EventLogAdvanced, { EVENT_LOG_ORDER_KEY, readEventLogOrder } from '../EventLogAdvanced.jsx'

const ctx = { match: MATCH, homeTeam: HOME_TEAM, awayTeam: AWAY_TEAM, matchId: 1, mode: 'review' }

function open(container) {
  const details = container.querySelector('details')
  details.open = true
  fireEvent(details, new Event('toggle'))
}

// The seq column of every listed row, top to bottom
const seqs = (container) => [...container.querySelectorAll('ol > li')].map(li => Number(li.firstChild.textContent))

describe('EventLogAdvanced: order', () => {
  beforeEach(() => localStorage.clear())

  it('lists the newest entry first by default', () => {
    const { events } = buildMatch({ sets: [{ points: pointsFor(25, 20), finished: true }] })
    const { container } = render(<EventLogAdvanced events={events} filterSet="all" ctx={ctx} readOnly={false} onRemove={() => {}} />)
    open(container)
    const list = seqs(container)
    expect(list.length).toBeGreaterThan(10)
    expect(list).toEqual([...list].sort((a, b) => b - a))
    expect(screen.getByRole('button', { name: 'Newest first' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('Oldest first lists 1, 2, 3 … and is remembered on the device', () => {
    const { events } = buildMatch({ sets: [{ points: pointsFor(25, 20), finished: true }] })
    const first = render(<EventLogAdvanced events={events} filterSet="all" ctx={ctx} readOnly={false} onRemove={() => {}} />)
    open(first.container)
    fireEvent.click(within(screen.getByRole('group', { name: 'Order' })).getByRole('button', { name: 'Oldest first' }))
    const list = seqs(first.container)
    expect(list).toEqual([...list].sort((a, b) => a - b))
    expect(localStorage.getItem(EVENT_LOG_ORDER_KEY)).toBe('oldest')
    expect(readEventLogOrder()).toBe('oldest')
    first.unmount()

    // a new panel opens with the order chosen last
    const again = render(<EventLogAdvanced events={events} filterSet="all" ctx={ctx} readOnly={false} onRemove={() => {}} />)
    open(again.container)
    expect(screen.getByRole('button', { name: 'Oldest first' }).getAttribute('aria-pressed')).toBe('true')
    const reopened = seqs(again.container)
    expect(reopened[0]).toBeLessThan(reopened[reopened.length - 1])

    fireEvent.click(screen.getByRole('button', { name: 'Newest first' }))
    expect(localStorage.getItem(EVENT_LOG_ORDER_KEY)).toBe('newest')
    const back = seqs(again.container)
    expect(back[0]).toBeGreaterThan(back[back.length - 1])
  })

  it('an unknown stored value falls back to newest first', () => {
    localStorage.setItem(EVENT_LOG_ORDER_KEY, 'sideways')
    expect(readEventLogOrder()).toBe('newest')
  })
})
