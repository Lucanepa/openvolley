// Owner 23.11.2026: the header's Online switch stays on while nothing answers
// ("Offline (1 waiting)" beside it), and should then turn grey too: online
// wanted, not reachable. Without a sync-queue read (review 5a: the header must
// not re-render on every queue change).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'

const queueStats = vi.fn(() => ({ pending: 0, error: 0, failed: 0 }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) })
}))
vi.mock('../../i18n', () => ({ default: { language: 'en', changeLanguage: () => {} } }))
vi.mock('../../db/db', () => ({ db: {} }))
vi.mock('../../hooks/useSyncQueue', () => ({ useSyncQueueStats: () => queueStats() }))
vi.mock('../../hooks/useScaledLayout', () => ({
  useScaledLayout: () => ({ scaleFactor: 1, userScaleOverride: null, setUserScaleOverride: () => {} })
}))
vi.mock('../TabletStatusIndicator', () => ({ default: () => null }))
vi.mock('../ConnectionStatus', () => ({ default: () => null }))
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: null, profile: null, loading: false, signOut: async () => {} }) }))

import MainHeader from '../MainHeader'

function header(props) {
  return render(
    <MainHeader
      connectionDebugInfo={{}}
      showMatchSetup={false}
      matchId={null}
      currentMatch={null}
      matchInfoMenuOpen={false}
      setMatchInfoMenuOpen={() => {}}
      isFullscreen={false}
      toggleFullscreen={() => {}}
      setOfflineMode={() => {}}
      currentPage="home"
      {...props}
    />
  )
}
const theSwitch = () => document.querySelector('button[role="switch"]')
const track = () => theSwitch().querySelector('span[aria-hidden="true"]')
const setOnline = (on) => Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => on })

afterEach(() => { cleanup(); setOnline(true) })

describe('header: the Online switch while nothing answers', () => {
  it('is green when online and connected', () => {
    setOnline(true)
    header({ offlineMode: false, connectionStatuses: { supabase: 'connected', match: 'connected' } })
    expect(theSwitch().getAttribute('aria-checked')).toBe('true')
    expect(track().className).toContain('bg-emerald-500')
    expect(theSwitch().hasAttribute('data-connection-down')).toBe(false)
  })

  it('stays on but turns grey when the cloud is out of reach (the pill says Offline)', () => {
    setOnline(true)
    header({ offlineMode: false, connectionStatuses: { supabase: 'offline', server: 'offline', websocket: 'disconnected' } })
    expect(theSwitch().getAttribute('aria-checked')).toBe('true')
    expect(track().className).toContain('bg-stone-300')
    expect(track().className).not.toContain('bg-emerald-500')
    expect(theSwitch().hasAttribute('data-connection-down')).toBe(true)
    expect(theSwitch().getAttribute('title')).toBe('header.onlineButNoConnection')
    expect(document.querySelector('[data-testid="header-online-icon"]').getAttribute('class')).toContain('text-stone-400')
  })

  it('turns grey as soon as the browser goes offline, and green again when it is back', () => {
    setOnline(true)
    header({ offlineMode: false, connectionStatuses: { supabase: 'connected', match: 'connected' } })
    expect(track().className).toContain('bg-emerald-500')
    setOnline(false)
    act(() => { window.dispatchEvent(new Event('offline')) })
    expect(track().className).toContain('bg-stone-300')
    setOnline(true)
    act(() => { window.dispatchEvent(new Event('online')) })
    expect(track().className).toContain('bg-emerald-500')
  })

  it('stays green while the first probe is still answering (Connecting is not offline)', () => {
    setOnline(true)
    header({ offlineMode: false, connectionStatuses: { supabase: 'connecting' } })
    expect(track().className).toContain('bg-emerald-500')
  })

  it('offline mode chosen: the plain off switch, not the "can\'t" grey', () => {
    setOnline(false)
    header({ offlineMode: true, connectionStatuses: { supabase: 'offline' } })
    expect(theSwitch().getAttribute('aria-checked')).toBe('false')
    expect(theSwitch().hasAttribute('data-connection-down')).toBe(false)
    expect(theSwitch().getAttribute('title')).toBe('header.switchToOnline')
  })

  it('reads no sync queue', () => {
    queueStats.mockClear()
    header({ offlineMode: false, connectionStatuses: { supabase: 'offline' } })
    expect(queueStats).not.toHaveBeenCalled()
  })
})
