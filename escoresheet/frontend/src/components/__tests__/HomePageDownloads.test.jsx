import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'

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
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

// Owner 2026-11-09: "just link the downloads page" (it had a desktop app
// link with its version, a .deb link and a "Download server" link)
describe('HomePage: the downloads link', () => {
  let uaSpy
  beforeEach(() => {
    backend.local = false
    uaSpy = vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(LINUX_UA)
    global.fetch = vi.fn(() => Promise.reject(new Error('no network in tests')))
  })
  afterEach(() => {
    uaSpy.mockRestore()
  })

  it('a desktop browser on the public site gets one link to the downloads page', () => {
    render(<HomePage />)
    const link = screen.getByTestId('home-downloads')
    expect(link).toHaveAttribute('href', 'https://get.openvolley.app/')
    expect(link).toHaveTextContent('Download OpenVolley')
    expect(screen.queryByText(/Download server|\.deb package|offline scoretable/)).not.toBeInTheDocument()
  })

  it('asks nobody for release lists (no GitHub call on Home)', () => {
    render(<HomePage />)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('a page served by the local relay (desktop app window, venue LAN) shows no downloads', () => {
    backend.local = true
    render(<HomePage />)
    expect(screen.queryByTestId('home-downloads')).not.toBeInTheDocument()
  })

  it('a phone browser shows no downloads link (desktop browsers only, as before)', () => {
    uaSpy.mockReturnValue(PHONE_UA)
    render(<HomePage />)
    expect(screen.queryByTestId('home-downloads')).not.toBeInTheDocument()
  })
})

// Owner 2026-11-10: "Made by Swiss referees" under the logo
describe('HomePage: who makes it', () => {
  it('says "Made by Swiss referees" right under the lockup', () => {
    render(<HomePage />)
    const line = screen.getByTestId('made-by')
    expect(line).toHaveTextContent('brand.madeBy')
    expect(line.previousElementSibling.querySelector('img')).toHaveAttribute('alt', 'OpenVolley')
  })
})
