import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k) => k }) }))

import RoleChips from '../RoleChips'
import { accessFromRoles } from '../../../lib/access'

describe('RoleChips', () => {
  it('a pending account: the amber chip only', () => {
    render(<RoleChips roles={[]} pending />)
    expect(screen.getByText('access.roles.pending')).toBeInTheDocument()
  })

  it('no role but not pending (it manages a team or a club): no "Pending approval"', () => {
    const { container } = render(<RoleChips roles={[]} pending={false} />)
    expect(screen.queryByText('access.roles.pending')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('roles: one chip each', () => {
    render(<RoleChips roles={['scorer', 'referee']} pending={false} />)
    expect(screen.getByText('access.roles.scorer')).toBeInTheDocument()
    expect(screen.getByText('access.roles.referee')).toBeInTheDocument()
    expect(screen.queryByText('access.roles.pending')).toBeNull()
  })

  it('managing a club or a team shows as a role, never "Pending approval"', () => {
    render(<RoleChips roles={[]} pending manages={{ clubs: [], teams: [{ id: 't1', name: 'VBC Musterdorf H1' }] }} />)
    expect(screen.getByText('access.roles.team_manager')).toBeInTheDocument()
    expect(screen.queryByText('access.roles.pending')).toBeNull()
  })

  it('a club manager who also scores: both', () => {
    render(<RoleChips roles={['scorer']} manages={{ clubs: [{ id: 'c1' }], teams: [] }} />)
    expect(screen.getByText('access.roles.scorer')).toBeInTheDocument()
    expect(screen.getByText('access.roles.club_manager')).toBeInTheDocument()
  })

  it('OpenBeach has no club or team managers', () => {
    render(<RoleChips roles={[]} pending manages={{ clubs: [{ id: 'c1' }], teams: [] }} app="beach" />)
    expect(screen.getByText('access.roles.pending')).toBeInTheDocument()
  })

  it('db/030: the manager role in the roles and the managed team give one chip, not two', () => {
    render(<RoleChips roles={['team_manager']} manages={{ clubs: [], teams: [{ id: 't1' }] }} />)
    expect(screen.getAllByText('access.roles.team_manager')).toHaveLength(1)
  })
})

describe('access: manager roles (db/030)', () => {
  it('a club or team manager is not pending, and gets no scoring or team rights from it', () => {
    for (const r of ['club_manager', 'team_manager']) {
      const a = accessFromRoles([r])
      expect(a.isPending).toBe(false)
      expect(a.canScore).toBe(false)
      expect(a.canManageTeams).toBe(false)
    }
    expect(accessFromRoles([]).isPending).toBe(true)
  })
})

