import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) })
}))

import QRCodeModal, { cloudTabletBase, buildConnectionUrl } from '../QRCodeModal'
import { setBackendOverride, clearBackendOverride } from '../../utils/backendConfig'

describe('cloudTabletBase', () => {
  it('links the tablet apps of the scorer\'s own deployment', () => {
    expect(cloudTabletBase('referee', 'dev-app.openvolley.app')).toBe('https://dev-referee.openvolley.app')
    expect(cloudTabletBase('bench_home', 'dev-app.openvolley.app')).toBe('https://dev-bench.openvolley.app')
    expect(cloudTabletBase('livescore', 'staging-app.openvolley.app')).toBe('https://staging-livescore.openvolley.app')
    expect(cloudTabletBase('referee', 'app.openvolley.app')).toBe('https://referee.openvolley.app')
  })

  it('a Cloudflare Pages build links the same build of the tablet sites', () => {
    expect(cloudTabletBase('referee', 'dev.openvolley-app.pages.dev')).toBe('https://dev.openvolley-referee.pages.dev')
    expect(cloudTabletBase('bench_home', 'dev.openvolley-app.pages.dev')).toBe('https://dev.openvolley-bench.pages.dev')
    expect(cloudTabletBase('bench_away', 'feat-x.openvolley-app.pages.dev')).toBe('https://feat-x.openvolley-bench.pages.dev')
    expect(cloudTabletBase('livescore', 'openvolley-app.pages.dev')).toBe('https://openvolley-livescore.pages.dev')
    // Another Pages project is not the scorer's
    expect(cloudTabletBase('referee', 'dev.someone-else.pages.dev')).toBe('https://referee.openvolley.app')
  })

  it('falls back to the production sites off openvolley.app', () => {
    expect(cloudTabletBase('bench_away', 'localhost')).toBe('https://bench.openvolley.app')
    expect(cloudTabletBase('referee', 'scorer.example.org')).toBe('https://referee.openvolley.app')
    expect(cloudTabletBase('nope', 'app.openvolley.app')).toBeNull()
  })
})

describe('QRCodeModal', () => {
  afterEach(() => clearBackendOverride())

  it('shows the team names of the scorer\'s match (homeName/awayName)', () => {
    render(<QRCodeModal role="referee" match={{ homeName: 'VBC Zürich', awayName: 'Volley Bern' }} matchSeedKey="match_1_abc" onClose={() => {}} />)
    expect(screen.getByText('VBC Zürich vs Volley Bern')).toBeTruthy()
  })

  it('builds LAN links on the local server, with team for a bench', () => {
    setBackendOverride('http://192.168.1.20:3000')
    expect(buildConnectionUrl('bench_away', 'match_1_abc')).toBe('http://192.168.1.20:3000/bench?match=match_1_abc&team=away')
  })
})
