import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (opts?.host ? `${key}:${opts.host}` : key) })
}))

const site = vi.hoisted(() => ({ url: null }))
vi.mock('../../utils/managerSite', () => ({ managerSiteUrl: () => site.url }))

import ManagerSiteLink from '../ManagerSiteLink'

describe('ManagerSiteLink (in-app console header)', () => {
  it('on the web: a new-tab link to the manager site, named for screen readers', () => {
    site.url = 'https://manager.openvolley.app'
    render(<ManagerSiteLink />)
    const link = screen.getByRole('link', { name: 'managerSite.openManager:manager.openvolley.app' })
    expect(link).toHaveAttribute('href', 'https://manager.openvolley.app')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('in the desktop / Android apps (no URL): nothing', () => {
    site.url = null
    const { container } = render(<ManagerSiteLink />)
    expect(container).toBeEmptyDOMElement()
  })
})
