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

  it('a page served by the local relay (desktop app window, venue LAN) shows no downloads', () => {
    backend.local = true
    render(<HomePage />)
    expect(screen.queryByText(/Download the desktop app/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Download server/)).not.toBeInTheDocument()
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
