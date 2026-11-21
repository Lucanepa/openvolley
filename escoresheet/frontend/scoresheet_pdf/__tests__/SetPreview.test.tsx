import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import App from '../App_Scoresheet'
import SetPreview, { FIT_MAX } from '../SetPreview'

// The scorer's Set preview: one set of the sheet as it prints, from the same
// model and components as the PDF (utils/setBoxProps), prop-driven so a draft
// event list (a correction being made) draws the same way.

let seq = 0
const ev = (type: string, setIndex: number, payload: Record<string, unknown>) => ({
  type, setIndex, seq: ++seq, ts: new Date(Date.UTC(2026, 9, 5, 18, 0, seq)).toISOString(), payload
})
const HOME = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 }
const AWAY = { I: 11, II: 12, III: 13, IV: 14, V: 15, VI: 16 }
const rotated = (l: Record<string, number>) => ({ I: l.II, II: l.III, III: l.IV, IV: l.V, V: l.VI, VI: l.I })

const players = {
  homePlayers: [1, 2, 3, 4, 5, 6, 9, 17].map(n => ({ number: n, firstName: 'H', lastName: `${n}` })),
  awayPlayers: [11, 12, 13, 14, 15, 16, 18].map(n => ({ number: n, firstName: 'A', lastName: `${n}` }))
}
const baseMatch = {
  id: 'm1', status: 'live', bestOf: 5,
  coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true, coinTossServeB: false,
  homeShortName: 'HOM', awayShortName: 'AWY'
}

/** Set 1 in play: 2:1 for home, a home time-out at 1:1 and the substitution 5 -> 9 at 1:1. */
function liveSet1() {
  seq = 0
  const events = [
    ev('lineup', 1, { team: 'home', lineup: HOME, isInitial: true }),
    ev('lineup', 1, { team: 'away', lineup: AWAY, isInitial: true }),
    ev('point', 1, { team: 'home' }),
    ev('point', 1, { team: 'away' }),
    ev('lineup', 1, { team: 'away', lineup: rotated(AWAY) }),
    ev('timeout', 1, { team: 'home' }),
    ev('substitution', 1, { team: 'home', playerOut: 5, playerIn: 9, position: 'V' }),
    ev('lineup', 1, { team: 'home', lineup: { ...HOME, V: 9 }, fromSubstitution: true }),
    ev('point', 1, { team: 'home' }),
    ev('lineup', 1, { team: 'home', lineup: rotated({ ...HOME, V: 9 }) })
  ]
  return {
    match: baseMatch,
    homeTeam: { name: 'Home Team' },
    awayTeam: { name: 'Away Team' },
    ...players,
    sets: [{ index: 1, homePoints: 2, awayPoints: 1, finished: false, startTime: '2026-10-05T18:00:00Z' }],
    events
  }
}

/** A five-set match in its deciding set: every set has its line-ups, a point each way, a time-out and a substitution. */
function fiveSets() {
  seq = 0
  const events: any[] = []
  for (const s of [1, 2, 3, 4, 5]) {
    events.push(ev('lineup', s, { team: 'home', lineup: HOME, isInitial: true }))
    events.push(ev('lineup', s, { team: 'away', lineup: AWAY, isInitial: true }))
    events.push(ev('point', s, { team: s % 2 ? 'home' : 'away' }))
    events.push(ev('timeout', s, { team: 'away' }))
    events.push(ev('point', s, { team: s % 2 ? 'away' : 'home' }))
    events.push(ev('substitution', s, { team: 'away', playerOut: 13, playerIn: 18, position: 'III' }))
  }
  const set = (index: number, home: number, away: number, finished = true) => ({
    index, homePoints: home, awayPoints: away, finished,
    startTime: `2026-10-05T${17 + index}:00:00Z`, ...(finished ? { endTime: `2026-10-05T${17 + index}:25:00Z` } : {})
  })
  return {
    match: { ...baseMatch, set5LeftTeam: 'B', set5FirstServe: 'B' },
    homeTeam: { name: 'Home Team' },
    awayTeam: { name: 'Away Team' },
    ...players,
    sets: [set(1, 25, 20), set(2, 20, 25), set(3, 25, 18), set(4, 23, 25), set(5, 1, 1, false)],
    events
  }
}

const text = (el: Element | null) => el?.textContent || ''

describe('SetPreview', () => {
  beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterAll(() => vi.restoreAllMocks())
  afterEach(cleanup)

  it('draws the chosen set: line-ups in I-VI, the substitution and the time-out with their scores, the team names', () => {
    const { container } = render(<SetPreview matchData={liveSet1()} setIndex={1} />)
    const row = container.querySelector('[data-testid="set-preview-row"]')
    expect(row?.getAttribute('data-set-index')).toBe('1')
    // only that set's box, inside the sheet's own styles
    expect(container.querySelectorAll('[data-testid="set-box"]')).toHaveLength(1)
    expect(container.querySelector('[data-testid="set5-box"]')).toBeNull()
    expect(container.querySelector('.ss-sheet [data-testid="set-box"]')).not.toBeNull()
    const box = text(container.querySelector('[data-testid="set-box"]'))
    // the starting line-ups, never the rotated or substituted ones
    expect(box).toContain('IIIIIIIVVVI123456')
    expect(box).toContain('IIIIIIIVVVI111213141516')
    // 5 -> 9 at 1:1 under position V
    expect(box).toMatch(/IIIIIIIVVVI123456:+91:1/)
    expect(box).toContain('HOM')
    expect(box).toContain('AWY')
    // the home time-out at 1:1 (team A, the left points column)
    const timeouts = container.querySelectorAll('[data-testid="timeout-block"]')
    expect(timeouts).toHaveLength(2)
    expect(text(timeouts[0])).toContain('1:1')
    expect(text(timeouts[1])).not.toMatch(/\d:\d/)
    // the legend and the SET column, as on the sheet
    expect(container.querySelector('[data-testid="legend-box"]')).not.toBeNull()
    expect(text(row)).toContain('SET1')
  })

  it('the deciding set is drawn with SetFive (three panels), labelled 3 in a best-of-3', () => {
    const data = fiveSets()
    const { container, rerender } = render(<SetPreview matchData={data} setIndex={5} />)
    expect(container.querySelector('[data-testid="set5-box"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="set-box"]')).toBeNull()
    expect(text(container.querySelector('[data-testid="set-preview-row"]'))).toContain('SET5')
    // set 5 toss: team B on the left
    expect(text(container.querySelector('[data-testid="set5-box"]'))).toMatch(/AWY[\s\S]*HOM/)
    rerender(<SetPreview matchData={{ ...data, match: { ...data.match, bestOf: 3 }, sets: [data.sets[0], data.sets[1], data.sets[4]] }} setIndex={5} />)
    expect(text(container.querySelector('[data-testid="set-preview-row"]'))).toContain('SET3')
  })

  it('every set box is the full sheet\'s box, element for element (what you see is what prints)', () => {
    const data = fiveSets()
    const sheet = render(<App matchData={data} autoAction="preview" />)
    const sheetBoxes = [...sheet.container.querySelectorAll('[data-testid="set-box"]')].map(b => b.outerHTML)
    const sheetSet5 = sheet.container.querySelector('[data-testid="set5-box"]')?.outerHTML
    const sheetLegends = [...sheet.container.querySelectorAll('[data-testid="legend-box"]')].map(b => b.outerHTML)
    expect(sheetBoxes).toHaveLength(4)
    cleanup()
    for (const n of [1, 2, 3, 4]) {
      const { container, unmount } = render(<SetPreview matchData={data} setIndex={n} />)
      expect(container.querySelector('[data-testid="set-box"]')?.outerHTML, `set ${n}`).toBe(sheetBoxes[n - 1])
      // the substitution 13 -> 18 is in every set
      expect(text(container.querySelector('[data-testid="set-box"]')), `set ${n}`).toContain('18')
      expect(container.querySelector('[data-testid="legend-box"]')?.outerHTML).toBe(sheetLegends[0])
      unmount()
    }
    const { container } = render(<SetPreview matchData={data} setIndex={5} />)
    expect(container.querySelector('[data-testid="set5-box"]')?.outerHTML).toBe(sheetSet5)
    expect(container.querySelector('[data-testid="legend-box"]')?.outerHTML).toBe(sheetLegends[2])
  })

  it('is prop-driven: a draft event list (not written anywhere) shows in the set at once', () => {
    const data = liveSet1()
    const { container, rerender } = render(<SetPreview matchData={data} setIndex={1} />)
    expect(text(container.querySelectorAll('[data-testid="timeout-block"]')[1])).not.toMatch(/\d:\d/)
    const draft = { ...data, events: [...data.events, ev('timeout', 1, { team: 'away' })] }
    rerender(<SetPreview matchData={draft} setIndex={1} />)
    // the team's own score first: away 1, home 2
    expect(text(container.querySelectorAll('[data-testid="timeout-block"]')[1])).toContain('1:2')
    // the caller's data is left as it was
    expect(data.events.filter(e => e.type === 'timeout')).toHaveLength(1)
  })

  describe('fit to width', () => {
    const spies: any[] = []
    const sizes = (avail: number, w: number, h: number) => {
      spies.push(vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(avail))
      spies.push(vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(w))
      spies.push(vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(h))
    }
    afterEach(() => { spies.splice(0).forEach(s => s.mockRestore()) })

    it('scales the paper-size set to the width given, in a box of its scaled size', () => {
      sizes(400, 800, 200)
      const { container } = render(<SetPreview matchData={liveSet1()} setIndex={1} />)
      const viewport = container.querySelector('[data-testid="set-preview"]') as HTMLElement
      expect(viewport.getAttribute('data-scale')).toBe('0.5')
      const box = viewport.firstElementChild as HTMLElement
      expect(box.style.width).toBe('400px')
      expect(box.style.height).toBe('100px')
      expect((box.firstElementChild as HTMLElement).style.transform).toBe('scale(0.5)')
    })

    it('scrollToSet: zoomed in wider than the width given, it starts past the legend', () => {
      sizes(390, 975, 300)
      const { container } = render(<SetPreview matchData={liveSet1()} setIndex={1} zoom={2} scrollToSet />)
      const viewport = container.querySelector('[data-testid="set-preview"]') as HTMLElement
      expect(viewport.getAttribute('data-scale')).toBe('0.8')
      expect(viewport.scrollLeft).toBeGreaterThan(0)
      cleanup()
      // fitted (not wider than the width given): left as it is
      const fitted = render(<SetPreview matchData={liveSet1()} setIndex={1} scrollToSet />)
      expect((fitted.container.querySelector('[data-testid="set-preview"]') as HTMLElement).scrollLeft).toBe(0)
    })

    it('reports the fitted scale (onFitScale) once measured', () => {
      sizes(400, 800, 200)
      const onFitScale = vi.fn()
      render(<SetPreview matchData={liveSet1()} setIndex={1} onFitScale={onFitScale} />)
      expect(onFitScale).toHaveBeenLastCalledWith(0.5)
    })

    it('zoom multiplies the fitted scale (the box then scrolls sideways); a wide screen stops at FIT_MAX', () => {
      sizes(400, 800, 200)
      const { container } = render(<SetPreview matchData={liveSet1()} setIndex={1} zoom={2} />)
      const viewport = () => container.querySelector('[data-testid="set-preview"]') as HTMLElement
      expect(viewport().getAttribute('data-scale')).toBe('1')
      expect((viewport().firstElementChild as HTMLElement).style.width).toBe('800px')
      spies.splice(0).forEach(s => s.mockRestore())
      sizes(8000, 800, 200)
      cleanup()
      render(<SetPreview matchData={liveSet1()} setIndex={1} />)
      expect(document.querySelector('[data-testid="set-preview"]')?.getAttribute('data-scale')).toBe(String(FIT_MAX))
      // fit={false}: paper size
      cleanup()
      const paper = render(<SetPreview matchData={liveSet1()} setIndex={1} fit={false} />)
      expect(paper.container.querySelector('[data-testid="set-preview"]')?.getAttribute('data-scale')).toBe('1')
    })
  })
})
