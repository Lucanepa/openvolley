// The desktop scoretable page crashes into its error screen (main.jsx: the
// ErrorBoundary wraps <App /> and <UiHost />). The page stays loaded, so the
// app sees no new page load: only the handler's uninstall can tell it that
// nothing answers "Quit OpenVolley…" any more (it then asks natively,
// lifecycle.rs). Before, the tray's Quit went into a page where nothing
// listened, and the app could not be quit.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useEffect } from 'react'
import { render, screen, act } from '@testing-library/react'
import ErrorBoundary from '../../components/ErrorBoundary'
import { UiHost } from '../../ui/UiHost.jsx'
import { LIFECYCLE_EVENT, installAppLifecycle, resetAppLifecycleForTests } from '../appLifecycle'
import { hasConfirmHost } from '../../ui/uiStore'

function desktopWin() {
  const win = new EventTarget()
  win.location = { href: 'http://localhost:5173/', origin: 'http://localhost:5173' }
  const invoke = vi.fn(async (cmd) => (cmd === 'app_page_state' ? { tray: true } : { active: false }))
  win.__TAURI_INTERNALS__ = { invoke, metadata: { currentWindow: { label: 'main' } } }
  return { win, invoke }
}

let crash = false
function App({ win }) {
  useEffect(() => installAppLifecycle({ win }), [win])
  if (crash) throw new Error('bad persisted data')
  return <p>scoreboard</p>
}

describe('desktop scoretable crash', () => {
  beforeEach(() => {
    resetAppLifecycleForTests()
    crash = false
  })

  it('tells the app its handler is gone; a tray quit is then not taken by the page', async () => {
    const { win, invoke } = desktopWin()
    const tree = () => (
      <ErrorBoundary name="scorer">
        <App win={win} />
        <div className="ov-kit ov-kit-host"><UiHost /></div>
      </ErrorBoundary>
    )
    const { rerender } = render(tree())
    expect(screen.getByText('scoreboard')).toBeTruthy()
    expect(hasConfirmHost()).toBe(true)
    const { handler } = invoke.mock.calls.find(([cmd]) => cmd === 'app_page_state')[1]

    vi.spyOn(console, 'error').mockImplementation(() => {})
    crash = true
    rerender(tree())
    expect(screen.queryByText('scoreboard')).toBeNull()
    expect(invoke).toHaveBeenCalledWith('app_page_gone', { handler })
    expect(hasConfirmHost()).toBe(false)

    // even if Rust sent it anyway: nothing takes it, so the app's
    // acknowledgement timeout asks natively
    invoke.mockClear()
    await act(async () => {
      win.dispatchEvent(new CustomEvent(LIFECYCLE_EVENT, { detail: { type: 'quit-requested' } }))
    })
    expect(invoke).not.toHaveBeenCalledWith('app_quit_ack')
    console.error.mockRestore()
  })
})
