// Go back / rectify (RectifyPanel): the scorer picks what happened, the team
// at fault and the moment from the set's log, sees what changes, and
// confirms; the plan goes to the Scoreboard's apply hook as one correction.
// The forfeits are handed to the Scoreboard's own flows.
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

const LIVE = { ...MATCH, status: 'live' }
const HOME_PLAYERS = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => ({ id: n, number: n, name: `Home ${n}`, libero: n === 9 ? 'libero1' : '' }))
const AWAY_PLAYERS = [11, 12, 13, 14, 15, 16, 17, 18, 20].map(n => ({ id: 100 + n, number: n, name: `Away ${n}`, libero: n === 20 ? 'libero1' : '' }))

function setup({ points = 'HAHHAHAH', extras = [{ at: 2, type: 'substitution', payload: { team: 'home', playerOut: 4, playerIn: 7 } }], rallyInPlay = false, finished = false } = {}) {
  const built = buildMatch({ match: LIVE, sets: [{ points: pointsFor(25, 20), finished: true }, { points, finished, extras }] })
  const hooks = {
    apply: vi.fn(async () => true),
    forfeitSet: vi.fn(async () => true),
    forfeitMatch: vi.fn(() => true),
    close: vi.fn()
  }
  render(
    <RectifyPanel
      events={built.events} match={LIVE} sets={built.sets} homeTeam={HOME_TEAM} awayTeam={AWAY_TEAM}
      homePlayers={HOME_PLAYERS} awayPlayers={AWAY_PLAYERS} liveSetIndex={2} rallyInPlay={rallyInPlay} hooks={hooks}
    />
  )
  return { hooks, built }
}

const choose = (name) => fireEvent.click(screen.getByRole('button', { name: new RegExp(name) }))
const pickTeam = (group, team) => fireEvent.click(within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name: new RegExp(team) }))
const preview = () => screen.getByRole('region', { name: 'What changes' })

describe('RectifyPanel', () => {
  beforeEach(() => { cleanup(); resetGhostClickGuard() })

  it('lists the situations in four groups, each with its rule', () => {
    setup()
    for (const g of ['Points of the team at fault cancelled', 'Back to an earlier score', 'Noticed before the next service', 'A team cannot go on']) {
      expect(screen.getByRole('region', { name: g })).toBeTruthy()
    }
    expect(screen.getByRole('button', { name: /Illegal substitution found after play went on.*15\.9\.2/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Wrong server found later.*7\.7\.2/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /officials' mistake.*Casebook 2\.3/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Team incomplete for this set.*6\.4\.3/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /default or incomplete for the match.*6\.4\.1/ })).toBeTruthy()
  })

  it('illegal substitution: team, the substitution, the preview, and one plan to the apply hook', async () => {
    const { hooks } = setup()
    choose('Illegal substitution found after play went on')
    expect(screen.getByText(/The substitution is put right/)).toBeTruthy()
    // nothing to write before the team is chosen
    expect(screen.getByRole('button', { name: 'Cancel the points and give the point' }).disabled).toBe(true)
    pickTeam('Team at fault', 'VC Smash')
    expect(screen.getByLabelText('Which substitution was illegal?').value).toMatch(/^event:/)
    // the suggestion: #4 back for #7
    const box = preview()
    expect(within(box).getByText(/^4 of VC Smash: /)).toBeTruthy()
    expect(within(box).getByText('A 5:3 B → A 1:4 B')).toBeTruthy()
    expect(within(box).getByText('Point and service to Volley Bern (B)')).toBeTruthy()
    expect(within(box).getByText(/^Volley Bern \(B\), #\d+$/)).toBeTruthy()
    expect(within(box).getByText('(put right)')).toBeTruthy()
    expect(within(box).getByText(/^Team A, Set 2, Result 5:3: illegal substitution \(rule 15\.9\.2\)/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel the points and give the point' }))
    await vi.waitFor(() => expect(hooks.apply).toHaveBeenCalledTimes(1))
    const plan = hooks.apply.mock.calls[0][0]
    expect(plan.rectification).toEqual({ kind: 'illegal_substitution', setIndex: 2, team: 'home', penaltyTo: 'away' })
    expect(plan.update.filter(u => u.changes.type === 'cancelled_point')).toHaveLength(4)
    await vi.waitFor(() => expect(hooks.close).toHaveBeenCalled())
  })

  it('the line-up can be changed before confirming: the preview follows', () => {
    setup({ extras: [] })
    choose('Players not in the positions of the line-up sheet')
    pickTeam('Team at fault', 'VC Smash')
    // the set start is offered first (the line-up sheet holds from 0:0)
    expect(screen.getByLabelText('From which score?').selectedOptions[0].textContent).toBe('Start of the set (A 0:0 B)')
    expect(within(preview()).queryByText('(put right)')).toBeNull()
    const pos = screen.getByLabelText('Player at position I')
    fireEvent.change(pos, { target: { value: '7' } })
    expect(within(preview()).getByText('(put right)')).toBeTruthy()
  })

  it('back to an earlier score: both teams, no penalty point', async () => {
    const { hooks } = setup({ extras: [] })
    choose('Back to an earlier score \\(officials')
    const select = screen.getByLabelText('From which score?')
    const option = [...select.options].find(o => o.textContent === 'A 2:1 B')
    fireEvent.change(select, { target: { value: option.value } })
    const box = preview()
    expect(within(box).getByText('No point added')).toBeTruthy()
    expect(within(box).getByText(/^A 5:3 B → A 2:1 B$/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Go back to this score' }))
    await vi.waitFor(() => expect(hooks.apply).toHaveBeenCalledTimes(1))
    expect(hooks.apply.mock.calls[0][0].rectification.kind).toBe('official_error')
  })

  it('a rally in play: the situation explains, nothing can be confirmed', () => {
    setup({ rallyInPlay: true })
    choose('Illegal substitution found after play went on')
    expect(screen.getByText('A rally is in play: finish it first.')).toBeTruthy()
    pickTeam('Team at fault', 'VC Smash')
    expect(screen.getByRole('button', { name: 'Cancel the points and give the point' }).disabled).toBe(true)
  })

  it('noticed before the next service: the entry and the delay sanction', async () => {
    const { hooks } = setup({ points: 'HA' })
    choose('noticed before the next service')
    pickTeam('Team at fault', 'VC Smash')
    expect(within(preview()).getByText('Delay warning')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Take back and give the delay sanction' }))
    await vi.waitFor(() => expect(hooks.apply).toHaveBeenCalledTimes(1))
    expect(hooks.apply.mock.calls[0][0].rectification).toMatchObject({ kind: 'before_service', team: 'home', sanctionType: 'delay_warning' })
  })

  it('team incomplete for this set: the score it ends on, then the Scoreboard forfeit', async () => {
    const { hooks } = setup()
    choose('Team incomplete for this set')
    pickTeam('Team that cannot go on', 'VC Smash')
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Why' })).getByRole('radio', { name: 'Expulsion' }))
    expect(within(preview()).getByText('A 5:3 B → A 5:25 B')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Give the set to the opponent' }))
    await vi.waitFor(() => expect(hooks.forfeitSet).toHaveBeenCalledWith('home', 'expulsion'))
  })

  it('team in default or incomplete for the match: handed to the Stop the match confirmation', async () => {
    const { hooks } = setup()
    choose('default or incomplete for the match')
    pickTeam('Team that cannot go on', 'Volley Bern')
    expect(screen.getByText(/VC Smash \(A\) gets the points and sets it needs to win the match/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Continue to the forfeit of the match' }))
    await vi.waitFor(() => expect(hooks.forfeitMatch).toHaveBeenCalledWith('away'))
  })

  it('between sets only the forfeit of the match is offered', () => {
    setup({ finished: true, points: pointsFor(25, 20) })
    expect(screen.getByRole('button', { name: /Illegal substitution found after play went on/ }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: /Team incomplete for this set/ }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: /default or incomplete for the match/ }).disabled).toBe(false)
  })
})
