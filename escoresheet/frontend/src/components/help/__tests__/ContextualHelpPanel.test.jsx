// The "?" panel: on every screen its sections (helpSections.js), each with
// its questions, its video (online only), More help and Contact support.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'

const support = vi.hoisted(() => ({ props: [] }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'de' }
  })
}))
// The support form is another agent's; here only what it is given. It reads
// the scale context as the real one does (useScaledLayout).
vi.mock('../../SupportFeedbackModal', async () => {
  const { useScale } = await vi.importActual('../../../contexts/ScaleContext')
  return {
    default: (props) => {
      useScale()
      support.props.push(props)
      return props.open ? <div data-testid="support-modal" data-area={props.area} /> : null
    }
  }
})
vi.mock('../../../utils/openAppWindow', () => ({ openAppWindow: vi.fn(() => ({ ok: true })) }))

import ContextualHelpPanel from '../ContextualHelpPanel'
import { HELP_SCREENS, helpSection } from '../helpSections'
import { openAppWindow } from '../../../utils/openAppWindow'

const sectionIds = () => [...document.querySelectorAll('[data-testid^="help-section-"]')].map(n => n.dataset.testid.replace('help-section-', ''))
const header = (id) => within(screen.getByTestId(`help-section-${id}`)).getAllByRole('button')[0]
const panel = (props = {}) => render(<ContextualHelpPanel open onClose={() => {}} {...props} />)

beforeEach(() => {
  support.props = []
  vi.mocked(openAppWindow).mockClear()
  localStorage.removeItem('offlineMode')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ContextualHelpPanel: the screen\'s sections', () => {
  it.each(Object.keys(HELP_SCREENS))('%s shows its sections, the main one open', (id) => {
    panel({ screen: id })
    const sections = HELP_SCREENS[id].sections
    expect(sectionIds()).toEqual(sections)
    sections.forEach((s, i) => expect(header(s).getAttribute('aria-expanded'), s).toBe(i === 0 ? 'true' : 'false'))
    // the main section's questions (the mocked t shows the key)
    for (const item of helpSection(sections[0]).faq) expect(screen.getByText(item.questionKey)).toBeTruthy()
    // a folded one shows none of its own
    if (sections[1]) expect(screen.queryByText(helpSection(sections[1]).faq[0].questionKey)).toBeNull()
    // the screen's name under the title
    expect(screen.getByText(HELP_SCREENS[id].nameKey)).toBeTruthy()
  })

  it('reads App\'s page name as the screen (currentPage)', () => {
    panel({ currentPage: 'scoreboard' })
    expect(sectionIds()).toEqual(HELP_SCREENS.scoreboard.sections)
  })

  it('opens another section on its header', () => {
    panel({ screen: 'scoreboard' })
    fireEvent.click(header('sanctions'))
    expect(header('sanctions').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('contextHelp.sanctions.q_teamSanctions')).toBeTruthy()
  })

  it('is a dialog while open: Escape closes it, closed it is hidden and no dialog', () => {
    const onClose = vi.fn()
    const { rerender } = render(<ContextualHelpPanel open onClose={onClose} screen="home" />)
    expect(screen.getByTestId('help-panel').getAttribute('aria-modal')).toBe('true')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    rerender(<ContextualHelpPanel open={false} onClose={onClose} screen="home" />)
    expect(screen.getByTestId('help-panel').getAttribute('aria-modal')).toBeNull()
    expect(screen.getByTestId('help-panel').style.visibility).toBe('hidden')
  })

  it('"Show me" hands the target and its tip to the page', () => {
    const onShowMe = vi.fn()
    panel({ screen: 'home', onShowMe })
    fireEvent.click(screen.getByText('contextHelp.home.q_createMatch'))
    fireEvent.click(screen.getByText('Show me'))
    expect(onShowMe).toHaveBeenCalledWith('home-new-match-button', 'contextHelp.home.tip_createMatch')
  })
})

describe('ContextualHelpPanel: the video', () => {
  it('online: the section\'s video with its poster and subtitles, nothing loaded before Play, no autoplay', () => {
    panel({ screen: 'coinToss' })
    const video = screen.getByTestId('help-video')
    expect(video.getAttribute('src')).toBe('https://openvolley.app/support/videos/coin-toss.mp4')
    expect(video.getAttribute('poster')).toBe('https://openvolley.app/support/videos/coin-toss.jpg')
    expect(video.getAttribute('preload')).toBe('none')
    expect(video.hasAttribute('autoplay')).toBe(false)
    expect(video.hasAttribute('controls')).toBe(true)
    expect(video.getAttribute('crossorigin')).toBe('anonymous')
    const tracks = [...video.querySelectorAll('track')]
    expect(tracks.map(t => [t.getAttribute('srclang'), t.getAttribute('src')])).toEqual(['en', 'de', 'fr', 'it'].map(l => [l, `https://openvolley.app/support/videos/coin-toss.${l}.vtt`]))
    // the app speaks German (mocked i18n): its subtitles are on
    expect(tracks.filter(t => t.hasAttribute('default')).map(t => t.getAttribute('srclang'))).toEqual(['de'])
  })

  it('only for the open sections', () => {
    panel({ screen: 'scoreboard' })
    expect(screen.getAllByTestId('help-video')).toHaveLength(1)
    fireEvent.click(header('set-end'))
    expect(screen.getAllByTestId('help-video').map(v => v.getAttribute('src'))).toEqual([
      'https://openvolley.app/support/videos/scoring.mp4',
      'https://openvolley.app/support/videos/set-end.mp4'
    ])
  })

  it('offline: no video, a line and the link to the website instead', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    panel({ screen: 'scoreboard' })
    expect(screen.queryByTestId('help-video')).toBeNull()
    const note = screen.getByTestId('help-video-offline')
    expect(note.textContent).toContain('contextHelp.videoOffline')
    const link = within(note).getByRole('link')
    expect(link.getAttribute('href')).toBe('https://openvolley.app/support#scoring')
    fireEvent.click(link)
    expect(openAppWindow).toHaveBeenCalledWith('https://openvolley.app/support#scoring')
  })

  it('the scorer\'s Offline switch counts as offline too', () => {
    localStorage.setItem('offlineMode', 'true')
    panel({ screen: 'matchEnd' })
    expect(screen.queryByTestId('help-video')).toBeNull()
    expect(screen.getByTestId('help-video-offline')).toBeTruthy()
  })

  it('goes offline while open: the video goes', () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    panel({ screen: 'home' })
    expect(screen.getByTestId('help-video')).toBeTruthy()
    online.mockReturnValue(false)
    fireEvent(window, new Event('offline'))
    expect(screen.queryByTestId('help-video')).toBeNull()
  })

  it('a video that does not load gives way to the link', () => {
    panel({ screen: 'bench' })
    fireEvent.error(screen.getByTestId('help-video'))
    expect(screen.queryByTestId('help-video')).toBeNull()
    expect(screen.getByTestId('help-video-offline').textContent).toContain('contextHelp.videoUnavailable')
  })

  it('no poster yet (the video is not recorded): the link instead of a dead player', async () => {
    const RealImage = globalThis.Image
    // the poster request fails
    globalThis.Image = class {
      set src(_url) { setTimeout(() => this.onerror?.(), 0) }
    }
    try {
      panel({ screen: 'livescore' })
      expect(await screen.findByTestId('help-video-offline')).toBeTruthy()
      expect(screen.queryByTestId('help-video')).toBeNull()
      expect(screen.getByTestId('help-video-offline').textContent).toContain('contextHelp.videoUnavailable')
    } finally {
      globalThis.Image = RealImage
    }
  })
})

describe('ContextualHelpPanel: More help and Contact support', () => {
  it('More help opens the section on openvolley.app/support outside the app', () => {
    panel({ screen: 'coinToss' })
    const link = screen.getByText('contextHelp.moreHelp').closest('a')
    expect(link.getAttribute('href')).toBe('https://openvolley.app/support#coin-toss')
    fireEvent.click(link)
    expect(openAppWindow).toHaveBeenCalledWith('https://openvolley.app/support#coin-toss')
  })

  it('Contact support opens the support form with the section as its area', () => {
    panel({ screen: 'scoreboard' })
    expect(screen.queryByTestId('support-modal')).toBeNull()
    fireEvent.click(within(screen.getByTestId('help-section-scoring')).getByText('contextHelp.contactSupport'))
    expect(screen.getByTestId('support-modal').dataset.area).toBe('scoring')
    expect(support.props.at(-1)).toMatchObject({ open: true, area: 'scoring' })
    // closed, then from another section
    support.props.at(-1).onClose()
    cleanup()
    support.props = []
    panel({ screen: 'scoreboard' })
    fireEvent.click(header('sanctions'))
    fireEvent.click(within(screen.getByTestId('help-section-sanctions')).getByText('contextHelp.contactSupport'))
    expect(support.props.at(-1)).toMatchObject({ open: true, area: 'sanctions' })
  })

  it('works on a page without a ScaleProvider (bench, livescore)', () => {
    panel({ screen: 'livescore' })
    fireEvent.click(screen.getByText('contextHelp.contactSupport'))
    expect(screen.getByTestId('support-modal').dataset.area).toBe('livescore')
  })

  it('Escape leaves the panel open while the support form is on top', () => {
    const onClose = vi.fn()
    render(<ContextualHelpPanel open onClose={onClose} screen="referee" />)
    fireEvent.click(screen.getByText('contextHelp.contactSupport'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })
})
