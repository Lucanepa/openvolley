import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { ConsoleShell } from '../ConsoleShell.jsx'

const tabs = [
  { id: 'a', label: 'Alpha', icon: null },
  { id: 'club', label: 'My Club', icon: null, children: [{ id: 'members', label: 'Members' }, { id: 'api', label: 'API' }] },
  { id: 'z', label: 'Zed', icon: null }
]
const shell = (props) => render(<ConsoleShell eyebrow="Manage" tabs={tabs} navLabel="nav" onSelect={() => {}} {...props}>x</ConsoleShell>)

describe('ConsoleShell tree', () => {
  it('shows a tab\'s children only while that tab is open, in the rail and as a row above the bottom bar', () => {
    const { rerender } = shell({ current: 'a' })
    expect(screen.queryByRole('group', { name: 'My Club' })).toBeNull()
    rerender(<ConsoleShell eyebrow="Manage" tabs={tabs} navLabel="nav" onSelect={() => {}} current="club">x</ConsoleShell>)
    // rail + phone row: two groups, each with both children
    const groups = screen.getAllByRole('group', { name: 'My Club' })
    expect(groups).toHaveLength(2)
    for (const g of groups) expect(within(g).getAllByRole('button').map((b) => b.textContent)).toEqual(['Members', 'API'])
  })

  it('a child click names the tab and the child; the open child is the current page, the tab itself is not', () => {
    const onSelectChild = vi.fn()
    const onSelect = vi.fn()
    shell({ current: 'club', currentChild: 'api', onSelect, onSelectChild })
    const rail = screen.getAllByRole('navigation')[0]
    fireEvent.click(within(rail).getByRole('button', { name: 'Members' }))
    expect(onSelectChild).toHaveBeenCalledWith('club', 'members')
    expect(within(rail).getByRole('button', { name: 'API' }).getAttribute('aria-current')).toBe('page')
    expect(within(rail).getByRole('button', { name: /My Club/ }).getAttribute('aria-current')).toBeNull()
    fireEvent.click(within(rail).getByRole('button', { name: /My Club/ }))
    expect(onSelect).toHaveBeenCalledWith('club')
  })

  it('on the tab\'s own page (no child) the tab is the current page', () => {
    shell({ current: 'club', currentChild: '' })
    const rail = screen.getAllByRole('navigation')[0]
    expect(within(rail).getByRole('button', { name: /My Club/ }).getAttribute('aria-current')).toBe('page')
  })
})
