// "Clear cache & data" wipes every local match. It must ask in the app's own
// dialog and wait for the answer, also where window.confirm is the desktop
// app's async stand-in (tauri-plugin-dialog), which returns a truthy Promise.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, fireEvent } from '@testing-library/react'

const clears = vi.hoisted(() => ({ calls: [] }))
vi.mock('../../db/db', () => {
  const table = (name) => ({ clear: vi.fn(async () => { clears.calls.push(name) }) })
  return { db: { matches: table('matches'), teams: table('teams'), players: table('players'), sets: table('sets'), events: table('events'), sync_queue: table('sync_queue') } }
})

import { DashboardOptionsMenu } from '../DashboardOptionsMenu.jsx'
import { UiHost } from '../../ui/UiHost.jsx'

describe('DashboardOptionsMenu clear cache', () => {
  let nativeConfirm
  beforeEach(() => {
    clears.calls = []
    nativeConfirm = vi.fn(async () => false)
    vi.stubGlobal('confirm', nativeConfirm)
  })
  afterEach(() => { vi.unstubAllGlobals() })

  async function openAndClickClear() {
    render(<><DashboardOptionsMenu showConnectionOptions={false} /><UiHost /></>)
    fireEvent.click(screen.getByRole('button', { name: /options/i }))
    await act(async () => { fireEvent.click(screen.getByText(/clear cache/i)) })
  }

  it('asks in the in-app dialog and clears nothing on cancel', async () => {
    await openAndClickClear()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(nativeConfirm).not.toHaveBeenCalled()
    expect(clears.calls).toEqual([])
    await act(async () => { fireEvent.click(screen.getByTestId('confirm-cancel')) })
    expect(clears.calls).toEqual([])
  })

  it('clears only after the user confirms', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      await openAndClickClear()
      expect(clears.calls).toEqual([])
      await act(async () => { fireEvent.click(screen.getByTestId('confirm-accept')) })
      expect(clears.calls).toContain('matches')
    } finally {
      vi.useRealTimers()
    }
  })
})
