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
const groups = (container) => {
  const kids = [...container.querySelector('[data-diag="header"]').children]
  return [kids[0], kids[kids.length - 1]]
}

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

  it('keeps its words on a tablet; the chip sits in the row between two groups that share the room', () => {
    setWidth(1024)
    const { container } = header()
    expect(screen.getByRole('switch').querySelector('.sr-only')).toBeNull()
    expect(screen.getByText('Match #402397')).toBeInTheDocument()
    expect(chipWrapper(container).style.position).toBe('relative')
    expect(chipWrapper(container).style.flex).toBe('0 0 auto')
    for (const group of groups(container)) expect(group.style.flex).toBe('1 1 0px')
    expect(screen.getByTestId('user-button').dataset.compact).toBe('false')
  })
})

// 2026-10-15, Chromium with a match on and the tablets connected: centred
// over the bar, the chip covered the tablet status at 600-760 px
describe('the header of an upright 7" tablet (600-719 px)', () => {
  it('is the compact bar a phone has', () => {
    setWidth(640)
    header()
    expect(screen.getByRole('switch').querySelector('.sr-only')).toHaveTextContent('Online')
    expect(screen.getByRole('button', { name: /#402397/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Menu' })).toBeInTheDocument()
    expect(screen.getByTestId('user-button').dataset.compact).toBe('true')
  })

  it('keeps its words from 720 px', () => {
    setWidth(720)
    header()
    expect(screen.getByRole('switch').querySelector('.sr-only')).toBeNull()
    expect(screen.getByText('Match #402397')).toBeInTheDocument()
  })
})

describe('the full bar that does not fit', () => {
  afterEach(() => vi.restoreAllMocks())

  it('turns compact: its right group ends past the bar (a long status, a translation)', () => {
    setWidth(900)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const bar = this.dataset?.diag === 'header'
      const right = this.parentElement?.dataset?.diag === 'header' && !this.nextElementSibling
      const r = bar ? 900 : right ? 950 : 0
      return { left: 0, top: 0, right: r, bottom: 40, width: r, height: 40, x: 0, y: 0, toJSON: () => ({}) }
    })
    header()
    expect(screen.getByRole('switch').querySelector('.sr-only')).toHaveTextContent('Online')
    expect(screen.getByRole('button', { name: 'Menu' })).toBeInTheDocument()
    expect(screen.getByTestId('user-button').dataset.compact).toBe('true')
  })

  it('tries the full bar again when what it says changes (a shorter status)', () => {
    setWidth(900)
    let rightEnd = 950
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const bar = this.dataset?.diag === 'header'
      const right = this.parentElement?.dataset?.diag === 'header' && !this.nextElementSibling
      const r = bar ? 900 : right ? rightEnd : 0
      return { left: 0, top: 0, right: r, bottom: 40, width: r, height: 40, x: 0, y: 0, toJSON: () => ({}) }
    })
    const el = (connectionStatuses) => (
      <ScaleProvider>
        <MainHeader matchStatus={{ match }} currentOfficialMatch={match} isFullscreen matchInfoMenuOpen={false} setMatchInfoMenuOpen={() => {}} connectionStatuses={connectionStatuses} />
      </ScaleProvider>
    )
    const { rerender } = render(el({ api: 'connecting' }))
    expect(screen.getByTestId('user-button').dataset.compact).toBe('true')
    rightEnd = 880
    rerender(el({ api: 'connected' }))
    expect(screen.getByTestId('user-button').dataset.compact).toBe('false')
    expect(screen.getByText('Match #402397')).toBeInTheDocument()
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
