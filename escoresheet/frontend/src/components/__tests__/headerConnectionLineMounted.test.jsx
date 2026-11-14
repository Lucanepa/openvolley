// Review 5a: the match chip popover's connection line ran useConnectionSummary
// in MainHeader on every render, popover closed or not: a second live
// sync-queue query, and the whole header re-rendered on every queue change
// (about twice a point on the scorer tablet). The line is its own component,
// mounted only while the popover is open. The header's pill (ConnectionStatus,
// mocked here) is the only other reader.
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { useState } from 'react'

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

const match = { id: 7, gameNumber: 921357, gamePin: '123456', scheduledAt: '2026-11-14T18:20:00.000Z' }
const matchInfoData = { match, homeTeam: { name: 'Volley Zürich' }, awayTeam: { name: 'Volley Luzern' } }

function Screen() {
  const [open, setOpen] = useState(false)
  return (
    <MainHeader
      connectionStatuses={{ supabase: 'connected', match: 'connected' }}
      connectionDebugInfo={{}}
      showMatchSetup={false}
      matchId={7}
      currentMatch={match}
      matchInfoMenuOpen={open}
      setMatchInfoMenuOpen={setOpen}
      matchInfoData={matchInfoData}
      isFullscreen={false}
      toggleFullscreen={() => {}}
      offlineMode={false}
      setOfflineMode={() => {}}
      currentPage="scoreboard"
    />
  )
}

describe('header: the popover connection line', () => {
  it('reads the sync queue only while the popover is open', () => {
    window.innerWidth = 1280
    window.innerHeight = 800
    render(<Screen />)
    expect(queueStats).not.toHaveBeenCalled()
    fireEvent.click(document.querySelector('button[data-match-info-menu]'))
    expect(document.querySelector('div[data-match-info-menu]')).not.toBeNull()
    expect(queueStats).toHaveBeenCalled()
  })
})
