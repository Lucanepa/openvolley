import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (opts?.version ? `${key} ${opts.version}` : key) })
}))

import AndroidUpdateNotice from '../AndroidUpdateNotice'
import AndroidVersionRows from '../options/AndroidVersionRows'
import { NOTIFY_KEY, getAndroidUpdateSnapshot, installAndroidUpdates, resetAndroidUpdateForTests } from '../../utils/androidUpdate'
import { resetAppLifecycleForTests, setLiveMatch } from '../../utils/appLifecycle'

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

const newerIndex = {
  packages: {
    'com.openvolley.escoresheet': {
      versions: {
        a: { file: { name: '/com.openvolley.escoresheet_20020000.apk' }, manifest: { versionName: '2.2.0', versionCode: 20020000 } },
      },
    },
  },
}

let stop = () => {}
let plugin

async function start(family) {
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' }
  plugin = {
    getInstallSource: vi.fn(async () => ({ family })),
    openStore: vi.fn(async () => ({ opened: true })),
  }
  const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => newerIndex }))
  await act(async () => {
    stop = installAndroidUpdates({ win: window, plugin, fetchImpl })
    await flush()
  })
  return fetchImpl
}

describe('AndroidUpdateNotice', () => {
  beforeEach(() => {
    resetAndroidUpdateForTests()
    resetAppLifecycleForTests()
    localStorage.clear()
  })
  afterEach(() => {
    stop()
    delete window.Capacitor
    vi.useRealTimers()
  })

  it('renders nothing outside the Android app', () => {
    const { container } = render(<AndroidUpdateNotice />)
    expect(container).toBeEmptyDOMElement()
  })

  it('asks a sideloaded app once, with equal answers; No is kept', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchImpl = await start('sideload')
    render(<AndroidUpdateNotice />)
    await act(async () => { vi.advanceTimersByTime(2000) })
    const yes = screen.getByTestId('update-ask-yes')
    const no = screen.getByTestId('update-ask-no')
    expect(yes.className).toBe(no.className)
    expect(screen.getByText('update.askTitle')).toBeInTheDocument()
    fireEvent.click(no)
    expect(localStorage.getItem(NOTIFY_KEY)).toBe('no')
    expect(screen.queryByText('update.askTitle')).not.toBeInTheDocument()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('a newer version waits for the end of the live match', async () => {
    localStorage.setItem(NOTIFY_KEY, 'yes')
    await start('sideload')
    expect(getAndroidUpdateSnapshot().status).toBe('available')
    act(() => setLiveMatch('test'))
    render(<AndroidUpdateNotice />)
    expect(screen.queryByTestId('android-update-notice')).not.toBeInTheDocument()
    act(() => setLiveMatch('none'))
    const notice = screen.getByTestId('android-update-notice')
    expect(notice).toHaveTextContent('update.available 2.2.0')
    expect(notice).toHaveTextContent('0.0.0-test')
    await act(async () => {
      fireEvent.click(screen.getByText('update.getFdroid'))
      await flush()
    })
    expect(plugin.openStore).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringMatching(/^fdroidrepos:\/\//) }))
    fireEvent.click(screen.getByText('common.later'))
    expect(screen.queryByTestId('android-update-notice')).not.toBeInTheDocument()
  })

  it('options: F-Droid installs get "Open in F-Droid" and a manual check only', async () => {
    const fetchImpl = await start('fdroid')
    render(<AndroidVersionRows />)
    expect(screen.getByText('update.fromFdroid')).toBeInTheDocument()
    expect(screen.queryByText('update.notifyOption')).not.toBeInTheDocument()
    expect(fetchImpl).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(screen.getByText('options.checkForUpdates'))
      await flush()
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(screen.getAllByText('update.openFdroid').length).toBe(2)
  })

  it('options: a sideloaded app has the notify switch (off by default)', async () => {
    await start('sideload')
    render(<AndroidVersionRows />)
    const sw = screen.getByRole('switch', { name: 'update.notifyOption' })
    expect(sw).toHaveAttribute('aria-checked', 'false')
    await act(async () => {
      fireEvent.click(sw)
      await flush()
    })
    expect(localStorage.getItem(NOTIFY_KEY)).toBe('yes')
    expect(sw).toHaveAttribute('aria-checked', 'true')
  })
})
