import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k) => k }) }))

import RoleChips from '../RoleChips'

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
})

