import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

// The test match's "Test mode" badge floated over the bottom right corner:
// on a 360 x 740 phone it covered the bench's last officials chip (the bench
// page scrolls there, so its bottom padding did not keep it clear) and part
// of the referee's "Last action" (full-match test 2026-11-21). On the bench
// and the referee it sits in the page's own layout (inline); the open panel
// still floats.

let bundle = null
vi.mock('../../utils/serverDataSync', () => ({ getMatchData: vi.fn(async () => bundle), addRelayMessageListener: () => () => {}, sendRelayMessage: () => false }))
vi.mock('../../hooks/useRealtimeConnection', () => ({ useRealtimeConnection: () => ({}) }))
vi.mock('../../db/db', () => ({ db: { matches: { get: vi.fn(async () => null), update: vi.fn(async () => 0) } } }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k, d, o) => (typeof d === 'string' ? d : (o?.defaultValue || k)), i18n: { language: 'en' } }) }))

const { default: TestModeControls } = await import('../TestModeControls')
const { default: MatchEntry } = await import('../MatchEntry.jsx')

describe('TestModeControls badge', () => {
  beforeEach(() => { cleanup() })

  it('floats by default', () => {
    render(<TestModeControls matchId={1} />)
    expect(screen.getByText('Test mode').style.position).toBe('fixed')
  })

  it('inline: in the layout where the parent puts it, and kept under the open panel', () => {
    render(<TestModeControls matchId={1} inline style={{ alignSelf: 'flex-end' }} />)
    const badge = screen.getByText('Test mode')
    expect(badge.style.position).toBe('')
    expect(badge.style.alignSelf).toBe('flex-end')
    fireEvent.click(badge)
    expect(screen.getByText('Test mode controls')).toBeInTheDocument()
    expect(screen.getByText('Test mode')).toBe(badge)
  })
})

describe('bench page of a test match', () => {
  beforeEach(() => { cleanup(); bundle = null })

  it('has the badge in its column after the bench rows, not over them', async () => {
    bundle = {
      success: true,
      match: { id: 'm1', test: true, status: 'live', coinTossTeamA: 'home', coinTossTeamB: 'away', firstServe: 'home', bestOf: 5, bench_home: [{ role: 'Coach' }] },
      homeTeam: { name: 'Home', color: '#e2001a' },
      awayTeam: { name: 'Away', color: '#3b82f6' },
      homePlayers: [1, 2, 3, 4, 5, 6, 7].map(number => ({ number })),
      awayPlayers: [11, 12, 13, 14, 15, 16].map(number => ({ number })),
      sets: [{ index: 1, homePoints: 0, awayPoints: 0, finished: false }],
      events: []
    }
    const { container } = render(<MatchEntry matchId="m1" team="home" onBack={() => {}} embedded />)
    await waitFor(() => expect(screen.getByText('Test mode')).toBeInTheDocument())
    const badge = screen.getByText('Test mode')
    expect(badge.style.position).toBe('')
    const page = container.querySelector('[data-bench-live]')
    expect(badge.parentElement).toBe(page)
    expect(page.lastElementChild).toBe(badge)
    expect(badge.previousElementSibling.hasAttribute('data-bench-roster')).toBe(true)
  })
})
