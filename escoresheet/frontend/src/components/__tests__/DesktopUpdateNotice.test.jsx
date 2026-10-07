import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '../../i18n/locales/en.json'
import DesktopUpdateNotice, { resetDesktopUpdateNoticeForTests } from '../DesktopUpdateNotice'
import { resetAppLifecycleForTests, setLiveMatch } from '../../utils/appLifecycle'
import { toast } from '../../ui'

const READY = {
  kind: 'appImage',
  phase: 'ready',
  current: '2.2.0',
  available: { version: '2.2.1', notes: null, date: null },
  autoCheck: true,
  autoInstall: true,
  blockers: [],
  canRestart: true,
  manual: false,
}

let invoke

function asDesktopApp(status, handlers = {}) {
  invoke = vi.fn(async (cmd) => {
    if (cmd === 'update_status') return status
    const h = handlers[cmd]
    if (typeof h === 'function') return h()
    return h ?? null
  })
  window.__TAURI_INTERNALS__ = { invoke, metadata: { currentWindow: { label: 'main' } } }
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: en } } })
})

beforeEach(() => {
  resetAppLifecycleForTests()
  resetDesktopUpdateNoticeForTests()
})

afterEach(() => {
  delete window.__TAURI_INTERNALS__
  vi.restoreAllMocks()
})

describe('DesktopUpdateNotice', () => {
  it('is not there in a browser', () => {
    const { container } = render(<DesktopUpdateNotice />)
    expect(container).toBeEmptyDOMElement()
  })

  it('a downloaded update: installs on quit, or restart now', async () => {
    asDesktopApp(READY, { update_install_now: READY })
    render(<DesktopUpdateNotice />)
    const notice = await screen.findByTestId('desktop-update-notice')
    expect(notice).toHaveTextContent('Update 2.2.1 is ready')
    expect(notice).toHaveTextContent('It installs when you quit OpenVolley.')
    fireEvent.click(screen.getByRole('button', { name: /Restart and update/ }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('update_install_now', undefined))
  })

  it('never while a match is live, back after it', async () => {
    asDesktopApp(READY)
    setLiveMatch('official')
    const { container } = render(<DesktopUpdateNotice />)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('update_status'))
    expect(container).toBeEmptyDOMElement()
    act(() => setLiveMatch('none'))
    expect(await screen.findByTestId('desktop-update-notice')).toBeInTheDocument()
    act(() => setLiveMatch('test'))
    expect(screen.queryByTestId('desktop-update-notice')).toBeNull()
  })

  it('a closed gate: only the reason, no button', async () => {
    asDesktopApp({ ...READY, canRestart: false, blockers: [{ kind: 'tablets', count: 2 }] })
    render(<DesktopUpdateNotice />)
    const notice = await screen.findByTestId('desktop-update-notice')
    expect(notice).toHaveTextContent('The update waits until the 2 tablets are disconnected.')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('the app refuses the restart (a tablet joined meanwhile): says why', async () => {
    const info = vi.spyOn(toast, 'info')
    asDesktopApp(READY, { update_install_now: () => { throw { code: 'blocked', blockers: [{ kind: 'tabletNetwork' }] } } })
    render(<DesktopUpdateNotice />)
    fireEvent.click(await screen.findByRole('button', { name: /Restart and update/ }))
    await waitFor(() => expect(info).toHaveBeenCalledWith('The update waits until the tablet Wi-Fi is off.'))
  })

  it('"Later" hides it for that version', async () => {
    asDesktopApp(READY)
    const first = render(<DesktopUpdateNotice />)
    fireEvent.click(await screen.findByRole('button', { name: 'Later' }))
    expect(screen.queryByTestId('desktop-update-notice')).toBeNull()
    first.unmount()
    // back on the home screen in the same run: still hidden
    render(<DesktopUpdateNotice />)
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
    expect(screen.queryByTestId('desktop-update-notice')).toBeNull()
  })

  it('a .deb installed by hand: the command that adds the repo', async () => {
    asDesktopApp({ ...READY, kind: 'debNoRepo', canRestart: false })
    render(<DesktopUpdateNotice />)
    const notice = await screen.findByTestId('desktop-update-notice')
    expect(notice).toHaveTextContent('curl -fsSL https://get.openvolley.app/install.sh | sudo sh')
    expect(screen.getByRole('button', { name: /Copy/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Restart and update/ })).toBeNull()
  })

  it('quiet while it downloads', async () => {
    asDesktopApp({ ...READY, phase: 'downloading', got: 1, total: 10, canRestart: false })
    const { container } = render(<DesktopUpdateNotice />)
    await waitFor(() => expect(invoke).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
