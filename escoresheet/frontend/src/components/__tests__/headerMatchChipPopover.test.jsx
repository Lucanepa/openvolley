// UI tour 14.11 (o13): the header match chip's popover gave the kick-off in
// UTC (18:20 for a 19:20 game), said "NOT SYNCED" while the header said
// Connected, and stayed open over the scoreboard's Match menu. It shows the
// Zürich time the rest of the app shows, the header's own connection word,
// and closes when another menu opens.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { useState } from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) })
}))
vi.mock('../../i18n', () => ({ default: { language: 'en', changeLanguage: () => {} } }))
vi.mock('../../db/db', () => ({ db: {} }))
vi.mock('../../hooks/useSyncQueue', () => ({ useSyncQueueStats: () => ({ pending: 0, error: 0, failed: 0 }) }))
vi.mock('../../hooks/useScaledLayout', () => ({
  useScaledLayout: () => ({ scaleFactor: 1, userScaleOverride: null, setUserScaleOverride: () => {} })
}))
vi.mock('../TabletStatusIndicator', () => ({ default: () => null }))
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: null, profile: null, loading: false, signOut: async () => {} }) }))

import MainHeader from '../MainHeader'
import MenuList from '../MenuList'

const match = { id: 7, gameNumber: 921357, gamePin: '123456', scheduledAt: '2026-11-14T18:20:00.000Z' }
const matchInfoData = { match, homeTeam: { name: 'Volley Zürich' }, awayTeam: { name: 'Volley Luzern' } }

function Screen({ connectionStatuses = { supabase: 'connected', match: 'connected' }, offlineMode = false }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <MainHeader
        connectionStatuses={connectionStatuses}
        connectionDebugInfo={{}}
        showMatchSetup={false}
        matchId={7}
        currentMatch={match}
        matchInfoMenuOpen={open}
        setMatchInfoMenuOpen={setOpen}
        matchInfoData={matchInfoData}
        isFullscreen={false}
        toggleFullscreen={() => {}}
        offlineMode={offlineMode}
        setOfflineMode={() => {}}
        currentPage="scoreboard"
      />
      <MenuList buttonLabel="Match" buttonTitle="Match" menuTitle="Match" items={[{ key: 'x', label: 'Go back', onClick: () => {} }]} />
    </div>
  )
}

const chip = () => document.querySelector('button[data-match-info-menu]')
const popover = () => document.querySelector('div[data-match-info-menu]')

describe('header match chip popover', () => {
  beforeEach(() => {
    window.innerWidth = 1280
    window.innerHeight = 800
  })

  it('gives the kick-off in Zürich time, dd.mm.yyyy HH:mm', () => {
    render(<Screen />)
    fireEvent.click(chip())
    expect(within(popover()).getByText('14.11.2026 19:20')).toBeInTheDocument()
  })

  it('names the header\'s connection state, never a fixed "Not synced"', () => {
    render(<Screen />)
    fireEvent.click(chip())
    expect(within(popover()).queryByText('header.notSynced')).toBeNull()
    expect(within(popover()).getByText('Connected')).toBeInTheDocument()
  })

  it('says Offline in offline mode', () => {
    render(<Screen offlineMode />)
    fireEvent.click(chip())
    expect(within(popover()).getByText('header.offline')).toBeInTheDocument()
  })

  it('closes when the Match menu opens, and the menu closes when the chip opens', () => {
    render(<Screen />)
    fireEvent.click(chip())
    expect(popover()).not.toBeNull()
    const menuButton = screen.getByRole('button', { name: /^Match/ })
    fireEvent.pointerDown(menuButton)
    fireEvent.mouseDown(menuButton)
    fireEvent.click(menuButton)
    expect(screen.getByRole('menu', { name: 'Match' })).toBeInTheDocument()
    expect(popover()).toBeNull()

    fireEvent.pointerDown(chip())
    fireEvent.mouseDown(chip())
    fireEvent.click(chip())
    expect(popover()).not.toBeNull()
    expect(screen.queryByRole('menu', { name: 'Match' })).toBeNull()
  })
})
