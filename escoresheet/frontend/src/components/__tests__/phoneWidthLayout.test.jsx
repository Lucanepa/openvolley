// The app on a phone's width (2026-10-13, the Android app at 384px): the
// header's match chip sat centred over the connection status and the menu
// button ran off the right edge; the cloud-backup list pushed "Created at" off
// the dialog; the "Not synced" notice squeezed its text into a column. jsdom
// has no layout, so these pin the classes and styles that make it fit.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import '../../i18n'
import { ScaleProvider } from '../../contexts/ScaleContext'
import MainHeader from '../MainHeader'
import BackupTable from '../BackupTable'
import CloudBlockNotice from '../CloudBlockNotice'

vi.mock('../auth/UserButton', () => ({ default: ({ compact }) => <span data-testid="user-button" data-compact={String(!!compact)} /> }))
vi.mock('../../hooks/useSyncQueue', () => ({ useSyncQueueStats: () => ({ pending: 0, error: 0, failed: 0 }) }))
vi.mock('../../utils/logger', () => ({ loadCloudBackup: async () => null }))

const realWidth = window.innerWidth
const setWidth = (w) => Object.defineProperty(window, 'innerWidth', { configurable: true, value: w })
afterEach(() => setWidth(realWidth))

const match = { id: 1, gameNumber: 402397, gamePin: '578487' }
const header = () => render(
  <ScaleProvider>
    <MainHeader matchStatus={{ match }} currentOfficialMatch={match} isFullscreen matchInfoMenuOpen={false} setMatchInfoMenuOpen={() => {}} />
  </ScaleProvider>
)
const chipWrapper = (container) => container.querySelector('[data-match-info-menu]').closest('[data-diag="header"] > div[style]')

describe('the header on a phone', () => {
  it('fits: the switch keeps its name but not its word, the chip joins the row, the menu is an icon', () => {
    setWidth(384)
    const { container } = header()
    expect(screen.getByRole('switch').querySelector('.sr-only')).toHaveTextContent('Online')
    expect(screen.getByRole('button', { name: /#402397/ })).toBeInTheDocument()
    expect(screen.queryByText('Match #402397')).toBeNull()
    expect(chipWrapper(container).style.position).toBe('relative')
    expect(screen.getByRole('button', { name: 'Menu' })).not.toHaveTextContent('Exit')
    expect(screen.getByTestId('user-button').dataset.compact).toBe('true')
  })

  it('is unchanged on a tablet: the words, the centred chip, "Exit"', () => {
    setWidth(1024)
    const { container } = header()
    expect(screen.getByRole('switch').querySelector('.sr-only')).toBeNull()
    expect(screen.getByText('Match #402397')).toBeInTheDocument()
    expect(chipWrapper(container).style.position).toBe('absolute')
    expect(screen.getByTestId('user-button').dataset.compact).toBe('false')
  })
})

describe('the cloud-backup list', () => {
  const backups = [{ name: 'b1.json', path: 'backups/backup_g402397/b1.json', gameN: 402397, setIndex: 3, leftScore: 20, rightScore: 15, date: '20261013', time: '163801', ms: '100' }]

  it('is sized by its own width: Game N only from 28rem, no fixed columns inline', () => {
    const { container } = render(<BackupTable backups={backups} onBackupSelect={() => {}} />)
    expect(container.firstChild.className).toContain('@container')
    const row = screen.getByRole('button')
    expect(row.style.gridTemplateColumns).toBe('')
    expect(row.className).toContain('grid-cols-[32px_56px_minmax(0,1fr)_auto]')
    expect(row.className).toContain('@md:grid-cols-[60px_35px_70px_90px_1fr]')
    expect(screen.getByText('402397').className).toMatch(/\bhidden\b.*@md:block/)
  })
})

describe('the "Not synced" notice', () => {
  it('wraps, so the button goes under the text where both do not fit', () => {
    render(<CloudBlockNotice match={{ gameN: 402397, cloudBlock: { code: 'OV_GAME_TAKEN', claim: { mine: true, game_n: 402397 } } }} />)
    expect(screen.getByTestId('cloud-block-notice').className).toContain('flex-wrap')
  })
})
