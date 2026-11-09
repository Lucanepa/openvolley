// Go back (RectifyPanel): when, what happens, then everything editable
// before "Resume" writes it as one correction through the Scoreboard's
// apply hook. A team that cannot go on is only a link to Stop the match.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react'

// t() resolves from the real English file, so the test reads what users see
vi.mock('react-i18next', async () => {
  const en = (await import('../../../i18n/locales/en.json')).default
  const lookup = key => key.split('.').reduce((o, k) => (o == null ? o : o[k]), en)
  return {
    useTranslation: () => ({
      t: (key, a, b) => {
        const opts = typeof a === 'object' ? a : b
        const fallback = typeof a === 'string' ? a : opts?.defaultValue
        const text = typeof lookup(key) === 'string' ? lookup(key) : (fallback ?? key)
        return String(text).replace(/\{\{(\w+)\}\}/g, (_, k) => String(opts?.[k] ?? ''))
      }
    })
  }
})

import RectifyPanel from '../RectifyPanel.jsx'
import { resetGhostClickGuard } from '../../../hooks/useConfirmAction'
import { buildMatch, MATCH, HOME_TEAM, AWAY_TEAM, pointsFor } from '../../../domain/__tests__/fixtures/correctionsMatch'
import { applyPlanToEvents } from '../../../domain/manualCorrections'
import { scoreFromPointEvents } from '../../../domain/rules'

const LIVE = { ...MATCH, status: 'live' }
const HOME_PLAYERS = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => ({ id: n, number: n, name: `Home ${n}`, libero: n === 9 ? 'libero1' : '' }))
const AWAY_PLAYERS = [11, 12, 13, 14, 15, 16, 17, 18, 20].map(n => ({ id: 100 + n, number: n, name: `Away ${n}`, libero: n === 20 ? 'libero1' : '' }))

function setup({ points = 'HAHHAHAH', extras = [{ at: 2, type: 'substitution', payload: { team: 'home', playerOut: 4, playerIn: 7 } }], rallyInPlay = false, finished = false } = {}) {
  const built = buildMatch({ match: LIVE, sets: [{ points: pointsFor(25, 20), finished: true }, { points, finished, extras }] })
  const hooks = { apply: vi.fn(async () => true), openStopMatch: vi.fn(), close: vi.fn() }
  render(
    <RectifyPanel
      events={built.events} match={LIVE} sets={built.sets} homeTeam={HOME_TEAM} awayTeam={AWAY_TEAM}
      homePlayers={HOME_PLAYERS} awayPlayers={AWAY_PLAYERS} liveSetIndex={2} rallyInPlay={rallyInPlay} hooks={hooks}
    />
  )
  return { hooks, built }
}

const pickScore = (label) => {
  const select = screen.getByLabelText('Score where it went wrong')
  fireEvent.change(select, { target: { value: [...select.options].find(o => o.textContent === label).value } })
}
const answer = (group, option) => fireEvent.click(within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name: option }))
const click = (name) => fireEvent.click(screen.getByRole('button', { name }))
const checked = (group) => within(screen.getByRole('radiogroup', { name: group })).getAllByRole('radio').find(r => r.getAttribute('aria-checked') === 'true')?.textContent

describe('RectifyPanel', () => {
  beforeEach(() => { cleanup(); resetGhostClickGuard() })

  it('1. when: the scores of the set, and only a link for a team that cannot go on', () => {
    const { hooks } = setup()
    const options = [...screen.getByLabelText('Score where it went wrong').options].map(o => o.textContent)
    expect(options[0]).toBe('A 5:3 B')
    expect(options[options.length - 1]).toBe('Start of the set (A 0:0 B)')
    click('Stop the match')
    expect(hooks.openStopMatch).toHaveBeenCalled()
  })

  it('2. what happens: the usual answer (the opponent gets point and service; nobody for both), with the rules as hints', () => {
    setup()
    pickScore('A 1:1 B')
    click('Next')
    expect(screen.getByText(/R15\.9\.2/)).toBeTruthy()
    expect(screen.getByText(/Casebook 2\.3, 2\.4/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Confirm' }).disabled).toBe(true)
    answer('Whose points since then are cancelled?', 'Team A')
    expect(checked('Point and service to')).toBe('Team B')
    expect(screen.getByText('A 5:3 B → A 1:4 B')).toBeTruthy()
    answer('Whose points since then are cancelled?', 'Both')
    expect(checked('Point and service to')).toBe('Nobody')
    expect(screen.getByText('A 5:3 B → A 1:1 B')).toBeTruthy()
    // the scorer's own answer
    answer('Point and service to', 'Team A')
    expect(screen.getByText('A 5:3 B → A 2:1 B')).toBeTruthy()
  })

  it('3. confirmed, everything editable: score by hand, server, a substitution taken back, the remark; Resume writes one plan', async () => {
    const { hooks, built } = setup()
    pickScore('A 1:1 B')
    click('Next')
    answer('Whose points since then are cancelled?', 'Team A')
    click('Confirm')
    expect(screen.getByLabelText('Points of VC Smash (A)').textContent).toBe('1')
    expect(screen.getByLabelText('Points of Volley Bern (B)').textContent).toBe('4')
    click('One point more for VC Smash (A)')
    click('One point more for VC Smash (A)')
    expect(screen.getByLabelText('Points of VC Smash (A)').textContent).toBe('3')
    answer('Serves next', 'VC Smash (A)')
    fireEvent.click(screen.getByRole('checkbox'))
    const remark = screen.getByLabelText('Remark on the scoresheet')
    expect(remark.value).toMatch(/substitution #7 for #4 of team A taken back/)
    fireEvent.change(remark, { target: { value: 'Team A, Set 2: illegal substitution #7 (rule 15.9.2).' } })
    click('Resume')
    await vi.waitFor(() => expect(hooks.apply).toHaveBeenCalledTimes(1))
    const plan = hooks.apply.mock.calls[0][0]
    const after = applyPlanToEvents(built.events, plan)
    const s = scoreFromPointEvents(after, 2)
    expect([s.homePoints, s.awayPoints]).toEqual([3, 4])
    expect(plan.remarkAdd).toEqual(['Team A, Set 2: illegal substitution #7 (rule 15.9.2).'])
    expect(plan.preview.serve).toBe('home')
    expect(after.some(e => e.type === 'substitution' && e.setIndex === 2)).toBe(false)
    await vi.waitFor(() => expect(hooks.close).toHaveBeenCalled())
  })

  it('3. a line-up changed by hand shows at once; a player chosen twice is refused', () => {
    setup({ extras: [] })
    pickScore('Start of the set (A 0:0 B)')
    click('Next')
    answer('Whose points since then are cancelled?', 'Team A')
    click('Confirm')
    const pos = screen.getByLabelText('A: player at position I')
    const before = pos.value
    fireEvent.change(pos, { target: { value: '8' } })
    expect(screen.getByLabelText('A: player at position I').value).toBe('8')
    expect(screen.getByRole('button', { name: 'Resume' }).disabled).toBe(false)
    fireEvent.change(screen.getByLabelText('A: player at position II'), { target: { value: '8' } })
    expect(screen.getByText('#8 is chosen twice.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Resume' }).disabled).toBe(true)
    expect(before).not.toBe('8')
  })

  it('a rally in play: nothing can be resumed', () => {
    setup({ rallyInPlay: true })
    expect(screen.getByText('A rally is in play: finish it first.')).toBeTruthy()
    pickScore('A 1:1 B')
    click('Next')
    answer('Whose points since then are cancelled?', 'Team A')
    click('Confirm')
    expect(screen.getByRole('button', { name: 'Resume' }).disabled).toBe(true)
  })

  it('between sets: only the link to Stop the match', () => {
    setup({ finished: true, points: pointsFor(25, 20) })
    expect(screen.getByText('Only during a set.')).toBeTruthy()
    expect(screen.queryByLabelText('Score where it went wrong')).toBeNull()
    expect(screen.getByRole('button', { name: 'Stop the match' })).toBeTruthy()
  })
})
