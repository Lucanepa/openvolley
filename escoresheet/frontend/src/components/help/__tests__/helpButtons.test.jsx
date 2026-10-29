// The "?" of the referee, bench and livescore headers, and the help button of
// the scorer's dialogs (restore, take-back, closed copy), which asks App for
// the panel on the dialog's screen.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' }
  })
}))
vi.mock('../../../i18n', () => ({ default: { language: 'en', changeLanguage: () => {} } }))
vi.mock('../../../hooks/useServiceWorker', () => ({ clearCachesAndReload: async () => true }))

import DashboardHeader from '../../DashboardHeader'
import SimpleHeader from '../../SimpleHeader'
import Modal from '../../Modal'
import ScorerMovedModal from '../../ScorerMovedModal'
import ClosedOnServerModal from '../../ClosedOnServerModal'
import { OPEN_HELP_EVENT, openHelp } from '../helpEvents'

afterEach(cleanup)

/** The screens the help buttons asked for while `run` ran. */
function helpRequests(run) {
  const screens = []
  const onOpen = (e) => screens.push(e.detail.screen)
  window.addEventListener(OPEN_HELP_EVENT, onOpen)
  try {
    run()
  } finally {
    window.removeEventListener(OPEN_HELP_EVENT, onOpen)
  }
  return screens
}

describe('the dashboards\' headers: the ? of the help panel', () => {
  it.each([
    ['DashboardHeader (referee entry, bench, livescore)', DashboardHeader, { title: 'Referee' }],
    ['SimpleHeader (the referee\'s match)', SimpleHeader, { title: 'Referee' }]
  ])('%s shows it with onHelp, pressed while the panel is open', (_name, Header, props) => {
    const onHelp = vi.fn()
    const { rerender } = render(<Header {...props} onHelp={onHelp} helpOpen={false} />)
    const button = screen.getByRole('button', { name: 'Help' })
    expect(button.textContent).toBe('?')
    expect(button.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(button)
    expect(onHelp).toHaveBeenCalledTimes(1)
    rerender(<Header {...props} onHelp={onHelp} helpOpen />)
    expect(screen.getByRole('button', { name: 'Help' }).getAttribute('aria-pressed')).toBe('true')
    cleanup()
    render(<Header {...props} />)
    expect(screen.queryByRole('button', { name: 'Help' })).toBeNull()
  })
})

describe('the dialogs\' help button', () => {
  it('openHelp asks for the panel on a screen', () => {
    expect(helpRequests(() => openHelp('restore'))).toEqual(['restore'])
    expect(helpRequests(() => openHelp(null))).toEqual([])
  })

  it('a Modal with helpScreen has it beside its close button', () => {
    const onClose = vi.fn()
    render(<Modal title="Restore match" open onClose={onClose} helpScreen="restore"><p>body</p></Modal>)
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
    expect(helpRequests(() => fireEvent.click(screen.getByTestId('dialog-help')))).toEqual(['restore'])
    expect(onClose).not.toHaveBeenCalled()
    cleanup()
    render(<Modal title="Delete match" open onClose={onClose}><p>body</p></Modal>)
    expect(screen.queryByTestId('dialog-help')).toBeNull()
  })

  it('Scored on another device opens the take-back help, Closed on the server its own', () => {
    render(<ScorerMovedModal scorer={null} onTakeBack={vi.fn()} onClose={vi.fn()} />)
    expect(helpRequests(() => fireEvent.click(screen.getByTestId('dialog-help')))).toEqual(['takeBack'])
    cleanup()
    render(<ClosedOnServerModal onLoadOfficial={vi.fn()} onRemove={vi.fn()} onUsePin={vi.fn()} onClose={vi.fn()} />)
    expect(helpRequests(() => fireEvent.click(screen.getByTestId('dialog-help')))).toEqual(['closedCopy'])
  })
})
