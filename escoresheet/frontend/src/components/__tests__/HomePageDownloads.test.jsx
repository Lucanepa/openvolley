import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => fallback || key })
}))
vi.mock('../SupportFeedbackModal', () => ({ default: () => null }))
vi.mock('../auth/UserButton', () => ({ default: () => null }))

const backend = vi.hoisted(() => ({ local: false }))
vi.mock('../../utils/backendConfig', () => ({
  isServedFromLocalServer: () => backend.local
}))

import HomePage from '../pages/HomePage'

const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
const RELEASE = {
  tag_name: 'desktop-v1.48.19',
  draft: false,
  prerelease: false,
  html_url: 'https://github.com/Lucanepa/openvolley/releases/tag/desktop-v1.48.19',
  assets: [
    { name: 'Openvolley.eScoresheet_1.48.19_amd64.AppImage', browser_download_url: 'https://example.test/app.AppImage' },
    { name: 'Openvolley.eScoresheet_1.48.19_amd64.deb', browser_download_url: 'https://example.test/app.deb' }
  ]
}

describe('HomePage desktop download section', () => {
  let uaSpy
  beforeEach(() => {
    backend.local = false
    uaSpy = vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(LINUX_UA)
    global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([RELEASE]) }))
  })
  afterEach(() => {
    uaSpy.mockRestore()
  })

  it('a desktop browser on the public site gets the newest desktop release', async () => {
    render(<HomePage />)
    await waitFor(() => expect(screen.getByText(/Download the desktop app.*\(v1\.48\.19\)/)).toBeInTheDocument())
  })

  // From 2.0 the Linux bundles are named after tauri.linux.conf.json's
  // productName ("openvolley-escoresheet_<v>_amd64.*"); assets are matched by
  // extension, so the old and the new names both resolve.
  it('finds the Linux assets under the openvolley-escoresheet name', async () => {
    const renamed = {
      ...RELEASE,
      tag_name: 'desktop-v2.0.0',
      assets: [
        { name: 'Openvolley.eScoresheet_2.0.0_x64-setup.exe', browser_download_url: 'https://example.test/setup.exe' },
        { name: 'openvolley-escoresheet_2.0.0_amd64.AppImage', browser_download_url: 'https://example.test/new.AppImage' },
        { name: 'openvolley-escoresheet_2.0.0_amd64.deb', browser_download_url: 'https://example.test/new.deb' }
      ]
    }
    global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([renamed]) }))
    render(<HomePage />)
    const app = await screen.findByText(/Download the desktop app.*\(v2\.0\.0\)/)
    expect(app.closest('a')).toHaveAttribute('href', 'https://example.test/new.AppImage')
    expect(screen.getByText('or get the .deb package').closest('a')).toHaveAttribute('href', 'https://example.test/new.deb')
  })

  it('a page served by the local relay (desktop app window, venue LAN) shows no downloads', () => {
    backend.local = true
    render(<HomePage />)
    expect(screen.queryByText(/Download the desktop app/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Download server/)).not.toBeInTheDocument()
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
