import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'

// My teams' pickers (owner 2026-11-11: "Club, Gender, Team"), and teams that
// do not play this season left out ("KSCW DU23-2 is not playing this season").

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k) => k, i18n: { language: 'en' } }) }))

import { TeamPicker } from '../manage/MyTeamsPanel'

const T = (id, name, club, gender, active = true) => ({ id, name, club_id: club, club_name: club === 'k' ? 'KSC Wiedikon' : 'VBC Limmattal', gender, active, via: 'admin' })
const TEAMS = [
  T('d1', 'KSC Wiedikon D1', 'k', 'f'),
  T('d2', 'KSC Wiedikon D2', 'k', 'f'),
  T('du', 'KSC Wiedikon DU23-2', 'k', 'f', false),
  T('h1', 'KSC Wiedikon H1', 'k', 'm'),
  T('lg', 'KSC Wiedikon Legends', 'k', null),
  T('lh', 'VBC Limmattal HU23', 'l', 'm')
]
const options = (testId) => within(screen.getByTestId(testId)).getAllByRole('option').map((o) => o.textContent)

describe('TeamPicker', () => {
  it('club, gender, then the teams of that club and gender that play this season', () => {
    render(<TeamPicker teams={TEAMS} team={TEAMS[0]} onPick={() => {}} />)
    expect(options('my-teams-club')).toEqual(['KSC Wiedikon', 'VBC Limmattal'])
    expect(options('my-teams-gender')).toEqual(['manage.myTeams.gender.f', 'manage.myTeams.gender.m', 'manage.myTeams.gender.other'])
    expect(options('my-teams-pick')).toEqual(['KSC Wiedikon D1', 'KSC Wiedikon D2'])
  })
  it('another gender or club opens its first team (same gender when the club has one)', () => {
    const onPick = vi.fn()
    render(<TeamPicker teams={TEAMS} team={TEAMS[0]} onPick={onPick} />)
    fireEvent.change(screen.getByTestId('my-teams-gender'), { target: { value: 'm' } })
    expect(onPick).toHaveBeenLastCalledWith('h1')
    fireEvent.change(screen.getByTestId('my-teams-club'), { target: { value: 'l' } })
    expect(onPick).toHaveBeenLastCalledWith('lh')
  })
  it('one club, one gender: only the team dropdown; a team not playing stays listed while it is open', () => {
    const one = [T('a', 'KSC Wiedikon H1', 'k', 'm'), T('b', 'KSC Wiedikon H3', 'k', 'm'), T('c', 'KSC Wiedikon H9', 'k', 'm', false)]
    render(<TeamPicker teams={one} team={one[2]} onPick={() => {}} />)
    expect(screen.queryByTestId('my-teams-club')).toBeNull()
    expect(screen.queryByTestId('my-teams-gender')).toBeNull()
    expect(options('my-teams-pick')).toEqual(['KSC Wiedikon H1', 'KSC Wiedikon H3', 'KSC Wiedikon H9'])
  })
})
