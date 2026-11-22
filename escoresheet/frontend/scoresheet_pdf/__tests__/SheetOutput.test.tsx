import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import { render, cleanup, act, waitFor } from '@testing-library/react'
import App from '../App_Scoresheet'
import { BRAND } from '../../src/brand.js'
import { REMARKS_MIN_PX } from '../components/FooterSection'
import { NUMBER_CIRCLE_MM, SERVICE_NUMBER_PX, SUB_CIRCLE_MM, LINEUP_NUMBER_PT, TWO_DIGIT_INK_RADIUS_EM, MARK_STROKE } from '../components/Marks'

// The owner's request of 2026-10-07 on the printed sheet and its PDF:
// OpenVolley instead of Swiss Volley, the new ball, "DoB" in APPROVAL ("Licence"
// since 2026-11-19), a file
// name with the real teams, a valid PDF and where it went.

// ---- the PDF libraries: a canvas of the sheet's size, a PDF that is a PDF
const pdfCalls: any[] = []
vi.mock('html-to-image', () => ({
  toCanvas: vi.fn(async () => ({
    width: 3100,
    height: 2170,
    toDataURL: () => `data:image/jpeg;base64,${'A'.repeat(20_000)}`
  }))
}))
vi.mock('jspdf', () => ({
  jsPDF: class {
    constructor (opts: any) { pdfCalls.push(['new', opts]) }
    setProperties (p: any) { pdfCalls.push(['setProperties', p]) }
    addImage (...a: any[]) { pdfCalls.push(['addImage', ...a.slice(1, 6)]) }
    setFontSize () {}
    setFont (...a: any[]) { pdfCalls.push(['setFont', ...a]) }
    getFontList () { return {} }
    addFileToVFS () {}
    addFont () {}
    text (t: string | string[]) { pdfCalls.push(['text', t]) }
    addPage (...a: any[]) { pdfCalls.push(['addPage', ...a]) }
    splitTextToSize (t: string) { return t.split('\n') }
    output () { return new TextEncoder().encode(`%PDF-1.3\n${'x'.repeat(30_000)}\n%%EOF\n`).buffer }
  }
}))

// jsdom has no ::before / ::after styles and says so on the console for every
// element the capture looks at (usedStyleProperties): the element's own style
// stands in, as it has no generated content either
const realGetComputedStyle = window.getComputedStyle.bind(window)
beforeEach(() => {
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => realGetComputedStyle(el))
})

let seq = 0
const ev = (type: string, setIndex: number, payload: Record<string, unknown>) => ({
  type, setIndex, seq: ++seq, ts: new Date(Date.UTC(2026, 9, 7, 18, 0, seq)).toISOString(), payload
})
const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).toISOString()

function fixture({ match: matchOver = {}, ...over }: Record<string, any> = {}) {
  seq = 0
  return {
    match: {
      id: 7, status: 'live', bestOf: 5,
      coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true, coinTossServeB: false,
      homeShortName: 'MUST-H1', awayShortName: 'SPATZ', gameNumber: '382208', league: '2L',
      scheduledAt: local(2026, 10, 7, 20, 0), city: 'Zürich', hall: 'KS Musterdorf',
      officials: [
        { role: '1st referee', firstName: 'Claudia', lastName: 'Moser', country: 'CHE', dob: '19.04.1982' },
        { role: '2nd referee', firstName: 'Paul', lastName: 'Kunz', country: 'CHE', dob: '1979-09-02' },
        { role: 'scorer', firstName: 'Sara', lastName: 'Schneider', country: 'CHE', dob: '01.01.1900' },
        { role: 'assistant scorer', firstName: 'Lea', lastName: 'Baumann', country: 'CHE', dob: '7.6.1988' },
        { role: 'line judge 1', name: 'Marie Claire de la Fontaine' }
      ],
      bench_home: [{ role: 'Coach', firstName: 'Hans', lastName: 'Frei', dob: '1975-05-15' }],
      bench_away: null,
      ...matchOver
    },
    homeTeam: { name: 'VBC Musterdorf H1' },
    awayTeam: { name: 'Volley Spatz Academica H1' },
    homePlayers: [12, 3, 1, 7].map(n => ({ number: n, firstName: 'Anna', lastName: `Home${n}`, dob: '1998-03-0' + (n % 9 || 1), isCaptain: n === 7 })),
    awayPlayers: [2, 4].map(n => ({ number: n, first_name: 'X', lastName: `Away${n}`, dob: `0${n}/03/1998` })),
    sets: [],
    events: [ev('lineup', 1, { team: 'home', lineup: { I: 1, II: 3, III: 7, IV: 12, V: 5, VI: 6 }, isInitial: true })],
    ...over
  }
}

const sheetText = (c: HTMLElement) => c.querySelector('.scoresheet-container')?.textContent || ''

describe('the generated sheet', () => {
  beforeAll(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })
  afterAll(() => vi.restoreAllMocks())
  afterEach(() => cleanup())

  it('OpenVolley, never Swiss Volley: the logo top left, the match identity top right, the side banner spelt right', () => {
    const { container, getByTestId } = render(<App matchData={fixture()} autoAction="preview" />)
    const sheet = container.querySelector('.scoresheet-container') as HTMLElement
    expect(sheet.innerHTML).not.toMatch(/swiss ?volley|swissvolley|FIVB/i)
    const imgs = [...sheet.querySelectorAll('img')]
    expect(imgs.map(i => i.getAttribute('src'))).toEqual([BRAND.lockupPng, BRAND.ballPng])
    expect(getByTestId('header-logo').getAttribute('alt')).toBe('OpenVolley')
    expect(getByTestId('header-identity').textContent).toContain('382208')
    expect(getByTestId('header-identity').textContent).not.toMatch(/OpenVolley/)
    expect(getByTestId('side-banner').textContent).toBe('OpenVolley eScoresheet')
    expect(sheet.textContent).not.toMatch(/Openvolley/)
  })

  it('the ball is the bundled flat ball A (content-hashed), never the unhashed /ball.png', () => {
    const { getByTestId } = render(<App matchData={fixture()} autoAction="preview" />)
    const ball = getByTestId('sheet-ball').getAttribute('src')
    expect(ball).toBe(BRAND.ballPng)
    expect(ball).not.toBe('/ball.png')
    expect(ball).toMatch(/ball_fallback/)
  })

  it('header: the local date DD.MM.YYYY, the match number from any of its fields', () => {
    const late = fixture({ match: { scheduledAt: local(2026, 10, 8, 0, 30), gameNumber: '', game_n: 77 } })
    const { getByTestId } = render(<App matchData={late} autoAction="preview" />)
    expect(getByTestId('header-date').textContent).toBe('08.10.2026')
    expect(getByTestId('header-match-no').textContent).toBe('77')
  })

  it('APPROVAL: a "Licence" column (owner 2026-11-19), dates of birth as DD.MM.YYYY, placeholder left empty', () => {
    const { container, getByTestId } = render(<App matchData={fixture()} autoAction="preview" />)
    const text = sheetText(container)
    const approval = text.slice(text.indexOf('APPROVAL'), text.indexOf('Line Judges'))
    expect(approval).toContain('OfficialNameCountryLicenceSignature')
    expect(approval).not.toContain('DoB')
    expect(approval).not.toContain('Lic.')
    expect(getByTestId('approval-dob-0').textContent).toBe('19.04.1982')
    expect(getByTestId('approval-dob-1').textContent).toBe('02.09.1979')
    expect(getByTestId('approval-dob-2').textContent).toBe('') // 01.01.1900
    expect(getByTestId('approval-dob-3').textContent).toBe('07.06.1988')
    expect(approval).toContain('Moser, C.')
    // the line judge as entered
    expect(text).toContain('Marie Claire de la Fontaine')
  })

  it('APPROVAL: a scorer without a date of birth shows the licence number in its place (owner 2026-11-15)', () => {
    const base = fixture()
    const officials = base.match.officials.map((o: any) => (o.role === 'scorer' ? { ...o, licence: 'SV 12345' } : o))
    const { getByTestId, unmount } = render(<App matchData={{ ...base, match: { ...base.match, officials } }} autoAction="preview" />)
    expect(getByTestId('approval-dob-2').textContent).toBe('SV 12345')
    unmount()
    // a real date of birth stays first
    const withDob = base.match.officials.map((o: any) => (o.role === 'scorer' ? { ...o, dob: '03.03.1990', licence: 'SV 12345' } : o))
    const again = render(<App matchData={{ ...base, match: { ...base.match, officials: withDob } }} autoAction="preview" />)
    expect(again.getByTestId('approval-dob-2').textContent).toBe('03.03.1990')
  })

  it('never crashes on older shapes: role-keyed officials, snake_case names, bench null, no players', () => {
    const data = fixture({
      match: {
        officials: { ref1: { first_name: 'Paul', last_name: 'Kunz', dob: '1979-09-02', country: 'CHE' } },
        bench_home: null,
        bench_away: { role: 'Coach' }
      },
      homePlayers: undefined,
      awayPlayers: null
    })
    const { container } = render(<App matchData={data as any} autoAction="preview" />)
    const text = sheetText(container)
    expect(text).toContain('Kunz, P.')
    expect(text).toContain('02.09.1979')
  })

  it('rosters: Licence | No | Name, sorted by number, normalised dates, a short name always', () => {
    const data = fixture({ match: { awayShortName: '' } })
    const { container } = render(<App matchData={data} autoAction="preview" />)
    const text = sheetText(container)
    const home = text.slice(text.indexOf('MUST-H1LicenceNoName'))
    expect(home.startsWith('MUST-H1LicenceNoName')).toBe(true)
    // 1, 3, 7, 12 in shirt-number order, ISO dates as DD.MM.YYYY
    expect(home).toMatch(/01\.03\.19981Home1, A\.03\.03\.19983Home3, A\.07\.03\.19987Home7, A\.03\.03\.199812Home12, A\./)
    // the away short name was empty: the team name
    expect(text).toContain('BVolley Spatz Academica H1LicenceNoName')
    expect(text).toContain('02.03.19982Away2, X.')
    expect(text).not.toContain('Lic.')
  })

  it('LFP marks only with LFP tracking on (default off; owner 2026-11-16)', () => {
    const base = fixture()
    const data = { ...base, homePlayers: base.homePlayers.map((p: any) => ({ ...p, isLfp: true })) }
    try {
      localStorage.removeItem('lfpTrackingEnabled')
      const off = render(<App matchData={data} autoAction="preview" />)
      expect(sheetText(off.container)).not.toContain('LFP')
      off.unmount()
      localStorage.setItem('lfpTrackingEnabled', 'true')
      const on = render(<App matchData={data} autoAction="preview" />)
      expect(sheetText(on.container)).toContain('LFP')
    } finally {
      localStorage.removeItem('lfpTrackingEnabled')
    }
  })
})

describe('Rebuild PDF: the sheet drawn from the server\'s record', () => {
  afterEach(() => cleanup())

  it('a slot approved with a PIN keeps its stamp; the set starts are the confirmed ones, not the rows\' creation times', async () => {
    const { scoresheetDataFromCloud } = await import('../../src/utils/scoresheetFromCloud')
    const { resultKey } = await import('../../src/domain/accountApproval')
    const sets = [
      { index: 1, home_points: 25, away_points: 20, finished: true, start_time: '2026-11-15T13:00:00Z', end_time: '2026-11-15T13:52:00Z' },
      { index: 2, home_points: 25, away_points: 18, finished: true, start_time: '2026-11-15T13:55:00Z', end_time: '2026-11-15T14:20:00Z' },
      { index: 3, home_points: 25, away_points: 22, finished: true, start_time: '2026-11-15T14:23:00Z', end_time: '2026-11-15T14:50:00Z' }
    ]
    const key = resultKey(sets.map(x => ({ index: x.index, homePoints: x.home_points, awayPoints: x.away_points, finished: true })))
    const opened = (i: number, at: string) => ({ external_id: `m:e:s${i}`, set_index: i, type: 'set_start', seq: i * 100, ts: at, payload: { setIndex: i, startTime: at, firstRallyAt: at } })
    const data = scoresheetDataFromCloud({
      match: {
        id: 'x', external_id: 'm', status: 'final', game_n: 424849, scheduled_at: '2026-11-15T13:00:00Z',
        home_team: { name: 'Home Club', short_name: 'HOME' }, away_team: { name: 'Away Club', short_name: 'AWAY' },
        coin_toss: { team_a: 'home', team_b: 'away', serve_a: true, confirmed: true },
        officials: [{ role: '1st referee', firstName: 'Claudia', lastName: 'Moser', country: 'CHE' }],
        players_home: [], players_away: []
      },
      // set 1's row made at the coin toss (13:00), set 2's when set 1 ended (13:52)
      sets: [sets[0], { ...sets[1], start_time: '2026-11-15T13:52:00Z' }, sets[2]],
      events: [opened(1, '2026-11-15T13:31:00Z'), opened(2, '2026-11-15T13:55:00Z'), opened(3, '2026-11-15T14:23:00Z')],
      approvals: [{ id: 'a1', short_id: 'K7Q2', slot: 'referee1', name: 'Moser Claudia', approved_at: '2026-11-15T14:55:00Z', result_key: key }]
    })
    const view = render(<App matchData={data} readOnly />)
    expect(view.getByTestId('approval-stamp-referee1').textContent).toMatch(/^Approved electronically · Moser Claudia · 15\.11\.2026 \d{2}:55 · ID K7Q2$/)
    expect(data.sets.map((x: any) => x.startTime)).toEqual(['2026-11-15T13:31:00.000Z', '2026-11-15T13:55:00.000Z', '2026-11-15T14:23:00Z'])
  })
})

describe('Save PDF', () => {
  let clicked: HTMLAnchorElement[] = []
  beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    // jsdom lays nothing out: the sheet counts as visible
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get () { return 1550 } })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get () { return 1085 } })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this) })
    ;(URL as any).createObjectURL = vi.fn(() => 'blob:x')
    ;(URL as any).revokeObjectURL = vi.fn()
  })
  afterAll(() => {
    delete (HTMLElement.prototype as any).offsetWidth
    delete (HTMLElement.prototype as any).offsetHeight
    vi.restoreAllMocks()
  })
  afterEach(() => { cleanup(); clicked = []; pdfCalls.length = 0 })

  it('the automatic save waits for every query, then names the file game<n>_<league>_<date>', async () => {
    // first render: the match row only (short names HOME / AWAY, teams not loaded yet)
    const first = fixture({ match: { homeShortName: 'HOME', awayShortName: 'AWAY' } })
    const loading = { ...first, homeTeam: null, awayTeam: null }
    const view = render(<App matchData={loading} autoAction="save" dataReady={false} />)
    await new Promise(r => setTimeout(r, 700))
    expect(clicked).toHaveLength(0)

    view.rerender(<App matchData={first} autoAction="save" dataReady />)
    await waitFor(() => expect(clicked).toHaveLength(1))
    expect(clicked[0].download).toBe('game382208_2L_2026-10-07.pdf')
    // a valid A3 PDF, the sheet at its true size, with its metadata
    expect(pdfCalls.find(c => c[0] === 'new')[1]).toMatchObject({ orientation: 'landscape', unit: 'mm', format: 'a3' })
    expect(pdfCalls.find(c => c[0] === 'addImage')).toEqual(['addImage', 'JPEG', 5, 5, 410, 287])
    const props = pdfCalls.find(c => c[0] === 'setProperties')[1]
    expect(props.creator).toBe('OpenVolley eScoresheet')
    // a viewer shows the scoresheet's name, as the file is named (owner 2026-10-13)
    expect(props.title).toBe('game382208_2L_2026-10-07')
    expect(props.subject).toBe('OpenVolley eScoresheet: VBC Musterdorf H1 vs Volley Spatz Academica H1, 07.10.2026, game 382208')
    expect(JSON.stringify(pdfCalls)).not.toMatch(/swiss/i)
    // a browser: the notice names the file and where it went
    await waitFor(() => expect(view.getByTestId('pdf-notice').textContent).toContain("browser's download folder"))
    expect(view.getByTestId('pdf-notice-path').textContent).toBe('game382208_2L_2026-10-07.pdf')
  })

  it('getBlob with onBlob (the manager\'s "Rebuild PDF"): the PDF goes to the callback, no opener, no download; the extra remark is on the sheet', async () => {
    const got: any[] = []
    const remark = 'Rebuilt after the match: 16.11.2026, 10:05 - Set start times corrected'
    const view = render(<App matchData={fixture()} autoAction="getBlob" dataReady readOnly embedded extraRemarks={[remark]} onBlob={(out) => got.push(out)} />)
    expect(sheetText(view.container)).toContain(remark)
    await waitFor(() => expect(got).toHaveLength(1))
    expect(got[0].filename).toBe('game382208_2L_2026-10-07.pdf')
    expect(got[0].blob.type).toBe('application/pdf')
    expect(clicked).toHaveLength(0)
  })

  // Perf pass 22.11.2026: the tablet's 43 s approval PDF was one number; the
  // page's heartbeat runs on the thread the capture holds (in-app view)
  it('getBlob for the approval: each step of the capture tells the opener the time it took, numbers only', async () => {
    const posted: any[] = []
    const opener = { closed: false, postMessage: (m: any) => posted.push(m) }
    const own = Object.getOwnPropertyDescriptor(window, 'opener')
    Object.defineProperty(window, 'opener', { configurable: true, value: opener })
    const close = vi.spyOn(window, 'close').mockImplementation(() => {})
    try {
      render(<App matchData={fixture()} autoAction="getBlob" dataReady />)
      await waitFor(() => expect(posted.some(m => m.type === 'pdfBlob')).toBe(true), { timeout: 4000 })
      const steps = posted.filter(m => m.type === 'pdfProgress' && 'ms' in m)
      expect(steps.map(m => m.step)).toEqual(['capture', 'styles', 'canvas', 'jpeg', 'pdf'])
      for (const m of steps) {
        expect(Object.keys(m).sort()).toEqual(['ms', 'step', 'type'])
        expect(Number.isInteger(m.ms) && m.ms >= 0).toBe(true)
      }
      // ... before the PDF, which comes last
      expect(posted.findIndex(m => m.type === 'pdfBlob')).toBeGreaterThan(posted.indexOf(steps[4]))
    } finally {
      close.mockRestore()
      if (own) Object.defineProperty(window, 'opener', own)
      else delete (window as any).opener
    }
  })

  it('getBlob for the manager (onBlob, the PDF stays on its page) reports no steps to anyone', async () => {
    const posted: any[] = []
    const own = Object.getOwnPropertyDescriptor(window, 'opener')
    Object.defineProperty(window, 'opener', { configurable: true, value: { closed: false, postMessage: (m: any) => posted.push(m) } })
    try {
      const got: any[] = []
      render(<App matchData={fixture()} autoAction="getBlob" dataReady readOnly embedded onBlob={(out) => got.push(out)} />)
      await waitFor(() => expect(got).toHaveLength(1))
      expect(posted.filter(m => m.type === 'pdfProgress')).toEqual([])
    } finally {
      if (own) Object.defineProperty(window, 'opener', own)
      else delete (window as any).opener
    }
  })

  it('Chromium (Brave, the manager\'s Rebuild PDF) copies only the styles the sheet uses, in one capture: the copy of every property took ~10 s', async () => {
    const htmlToImage: any = await import('html-to-image')
    htmlToImage.toCanvas.mockClear()
    // a browser lists every property in <html>'s computed style, the app's custom properties too
    vi.mocked(window.getComputedStyle).mockImplementation((el: Element) => el === document.documentElement
      ? (['color', 'display', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'margin-inline-start', '--tw-shadow', '--color-red-500'] as unknown as CSSStyleDeclaration)
      : realGetComputedStyle(el))
    const got: any[] = []
    render(<App matchData={fixture()} autoAction="getBlob" dataReady readOnly embedded onBlob={(out) => got.push(out)} />)
    await waitFor(() => expect(got).toHaveLength(1))
    expect(got[0].blob.type).toBe('application/pdf')
    expect(htmlToImage.toCanvas).toHaveBeenCalledTimes(1)
    const opts = htmlToImage.toCanvas.mock.calls[0][1]
    expect(opts.pixelRatio).toBe(2)
    expect(opts.includeStyleProperties).toContain('display')
    expect(opts.includeStyleProperties.some((p: string) => p.startsWith('--'))).toBe(false)
    expect(opts.includeStyleProperties).not.toContain('margin-inline-start')
  })

  // owner 22.11.2026: the hall tablet's capture at 1.5 (capturePixelRatio);
  // the web, the desktop apps, iOS and the server render keep 2 (above)
  it('in the Android app the capture is made at pixel ratio 1.5, the PDF placed in mm as before', async () => {
    const htmlToImage: any = await import('html-to-image')
    htmlToImage.toCanvas.mockClear()
    pdfCalls.length = 0
    const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 13; SM-T220 Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Safari/537.36'
    ;(window as any).Capacitor = { isNativePlatform: () => true }
    Object.defineProperty(window.navigator, 'userAgent', { configurable: true, get: () => ANDROID_UA })
    try {
      const got: any[] = []
      render(<App matchData={fixture()} autoAction="getBlob" dataReady readOnly embedded onBlob={(out) => got.push(out)} />)
      await waitFor(() => expect(got).toHaveLength(1))
      expect(got[0].blob.type).toBe('application/pdf')
      expect(htmlToImage.toCanvas).toHaveBeenCalledTimes(1)
      expect(htmlToImage.toCanvas.mock.calls[0][1].pixelRatio).toBe(1.5)
      // the picture on the A3 page: 410 x 287 mm at 5 mm, whatever its pixels
      expect(pdfCalls.find(c => c[0] === 'addImage')).toEqual(['addImage', 'JPEG', 5, 5, 410, 287])
    } finally {
      delete (window as any).Capacitor
      delete (window.navigator as any).userAgent
    }
  })

  // Options › Effects and speed › Sharp PDF off (utils/lookSettings): the
  // device's choice, read when the PDF is made
  it('with Sharp PDF off on this device the capture is made at 1.5, on again at 2', async () => {
    const htmlToImage: any = await import('html-to-image')
    for (const [stored, ratio] of [['false', 1.5], ['true', 2]] as const) {
      htmlToImage.toCanvas.mockClear()
      pdfCalls.length = 0
      localStorage.setItem('ov.look.pdfSharp', stored)
      try {
        const got: any[] = []
        const { unmount } = render(<App matchData={fixture()} autoAction="getBlob" dataReady readOnly embedded onBlob={(out) => got.push(out)} />)
        await waitFor(() => expect(got).toHaveLength(1))
        expect(htmlToImage.toCanvas.mock.calls[0][1].pixelRatio).toBe(ratio)
        expect(pdfCalls.find(c => c[0] === 'addImage')).toEqual(['addImage', 'JPEG', 5, 5, 410, 287])
        unmount()
      } finally {
        localStorage.removeItem('ov.look.pdfSharp')
      }
    }
  })

  it('a lean capture that fails in Chromium is tried once more with the lean list, never with the full copy (~8x larger)', async () => {
    const htmlToImage: any = await import('html-to-image')
    htmlToImage.toCanvas.mockClear()
    const lists: string[][] = []
    const canvas = { width: 3100, height: 2170, getContext: () => ({ drawImage: () => {} }), toDataURL: () => `data:image/jpeg;base64,${'A'.repeat(20_000)}` }
    htmlToImage.toCanvas
      .mockImplementationOnce(async (_n: any, o: any) => { lists.push([...o.includeStyleProperties]); throw new Error('decode failed') })
      .mockImplementationOnce(async (_n: any, o: any) => { lists.push([...o.includeStyleProperties]); return canvas })
    vi.mocked(window.getComputedStyle).mockImplementation((el: Element) => el === document.documentElement
      ? (['color', 'display', '--tw-shadow'] as unknown as CSSStyleDeclaration)
      : realGetComputedStyle(el))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const got: any[] = []
    render(<App matchData={fixture()} autoAction="getBlob" dataReady readOnly embedded onBlob={(out) => got.push(out)} />)
    await waitFor(() => expect(got).toHaveLength(1))
    expect(got[0]?.blob.type).toBe('application/pdf')
    expect(lists).toHaveLength(2)
    expect(lists[0]).not.toContain('--tw-shadow')
    expect(lists[1]).not.toContain('--tw-shadow')
    expect(lists[1]).toEqual(lists[0])
    expect(warn.mock.calls.some(c => /retrying with the pictures drawn afterwards/.test(String(c[0])))).toBe(true)
    warn.mockRestore()
  })

  it('getBlob with onBlob, the view closed while the PDF is made (Rebuild PDF cancelled): nothing is handed on, no PDF made', async () => {
    const htmlToImage: any = await import('html-to-image')
    let release: () => void = () => {}
    htmlToImage.toCanvas.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ width: 3100, height: 2170, toDataURL: () => `data:image/jpeg;base64,${'A'.repeat(20_000)}` })
    }))
    const got: any[] = []
    const view = render(<App matchData={fixture()} autoAction="getBlob" dataReady readOnly embedded onBlob={(out) => got.push(out)} />)
    await waitFor(() => expect(htmlToImage.toCanvas).toHaveBeenCalled())
    // the "Generating PDF" cover stays inside the embedded view: the host's bar (Cancel) is free
    expect(view.getByTestId('pdf-generating').style.position).toBe('absolute')
    view.unmount()
    release()
    await new Promise(r => setTimeout(r, 50))
    expect(got).toHaveLength(0)
    expect(pdfCalls.find(c => c[0] === 'new')).toBeUndefined()
    expect(clicked).toHaveLength(0)
  })

  // Perf pass 22.11.2026: the approval waited a fixed 500 ms before it began
  it('an automatic getBlob begins at once: no fixed wait before the capture', async () => {
    vi.useFakeTimers()
    try {
      const view = render(<App matchData={fixture()} autoAction="getBlob" dataReady readOnly embedded onBlob={() => {}} />)
      // the fonts and two frames (jsdom has no frames: at most 100 ms), then the PDF is being made
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(view.queryByTestId('pdf-generating')).not.toBeNull()
      view.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('the view closed before the capture began: no failure is reported either', async () => {
    const got: any[] = []
    const view = render(<App matchData={fixture()} autoAction="getBlob" dataReady readOnly embedded onBlob={(out) => got.push(out)} />)
    // after the automatic start (no fixed wait since 22.11.2026; it was 500 ms),
    // inside the waits before the capture (jsdom loads no picture: picturesReady
    // waits its 3 s)
    await new Promise(r => setTimeout(r, 600))
    view.unmount()
    await new Promise(r => setTimeout(r, 400))
    expect(got).toHaveLength(0)
  })

  it('a match that is not on this device: no empty sheet is saved, the page says why', async () => {
    const view = render(<App matchData={{ match: {}, homeTeam: null, awayTeam: null, homePlayers: [], awayPlayers: [], sets: [], events: [] }} autoAction="save" dataReady matchMissing />)
    await new Promise(r => setTimeout(r, 900))
    expect(clicked).toHaveLength(0)
    expect(view.getByTestId('pdf-notice').textContent).toContain('not on this device')
  })

  it('the desktop app: the full path, with Open file and Show in folder by the download id', async () => {
    const invoke = vi.fn(async () => undefined)
    ;(window as any).__TAURI_INTERNALS__ = { invoke }
    try {
      const view = render(<App matchData={fixture()} autoAction="preview" />)
      await act(async () => { view.getByText('Save PDF').click() })
      await waitFor(() => expect(clicked).toHaveLength(1))
      const name = clicked[0].download
      expect(view.getByTestId('pdf-notice').textContent).toContain('Saving')
      const path = `/home/luca/Downloads/${name.replace('.pdf', ' (1).pdf')}`
      act(() => {
        window.dispatchEvent(new CustomEvent('ov-download-finished', { detail: { path, fileName: path.split('/').pop(), success: true, id: 42 } }))
      })
      expect(view.getByTestId('pdf-notice-path').textContent).toBe(path)
      await act(async () => { view.getByText('Open file').click() })
      await act(async () => { view.getByText('Show in folder').click() })
      expect(invoke).toHaveBeenNthCalledWith(1, 'download_open', { id: 42 })
      expect(invoke).toHaveBeenNthCalledWith(2, 'download_reveal', { id: 42 })
    } finally {
      delete (window as any).__TAURI_INTERNALS__
    }
  })
})

describe('set 5, defaults and sanctions on the sheet', () => {
  beforeAll(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })
  afterAll(() => vi.restoreAllMocks())
  afterEach(() => cleanup())

  const twoAll = [
    { index: 1, homePoints: 25, awayPoints: 20, finished: true, startTime: local(2026, 10, 7, 20, 0), endTime: local(2026, 10, 7, 20, 25) },
    { index: 2, homePoints: 20, awayPoints: 25, finished: true, startTime: local(2026, 10, 7, 20, 28), endTime: local(2026, 10, 7, 20, 52) },
    { index: 3, homePoints: 25, awayPoints: 20, finished: true, startTime: local(2026, 10, 7, 20, 55), endTime: local(2026, 10, 7, 21, 20) },
    { index: 4, homePoints: 20, awayPoints: 25, finished: true, startTime: local(2026, 10, 7, 21, 23), endTime: local(2026, 10, 7, 21, 48) }
  ]
  const set5 = (points: string) => {
    const base = fixture({ match: { set5LeftTeam: 'A', set5FirstServe: 'A' } })
    const home = [...points].filter(c => c === 'h').length
    const away = points.length - home
    return {
      ...base,
      sets: [...twoAll, { index: 5, homePoints: home, awayPoints: away, finished: false, startTime: local(2026, 10, 7, 21, 51) }],
      events: [
        ev('lineup', 5, { team: 'home', lineup: { I: 1, II: 3, III: 7, IV: 12, V: 5, VI: 6 }, isInitial: true }),
        ev('lineup', 5, { team: 'away', lineup: { I: 2, II: 4, III: 6, IV: 8, V: 9, VI: 10 }, isInitial: true }),
        ev('timeout', 5, { team: 'home' }),
        ...[...points].map(c => ev('point', 5, { team: c === 'h' ? 'home' : 'away' }))
      ]
    }
  }

  it('before the change of courts: panel 3 unused, the change box empty', () => {
    const { getByTestId, container } = render(<App matchData={set5('hhaahhah')} autoAction="preview" />)
    expect(getByTestId('set5-points-at-change').textContent).toBe('')
    expect(container.querySelectorAll('[data-mark="reverseT"]')).toHaveLength(0)
  })

  it('at the change: the points then in the box; panel 3 prints them plain, no reverse T (owner 2026-11-16)', () => {
    // home (left) 5, then away reaches 8: the change at 5:8
    const { getByTestId, container } = render(<App matchData={set5('hhhhh' + 'aaaaaaaa' + 'h')} autoAction="preview" />)
    expect(getByTestId('set5-points-at-change').textContent).toBe('5')
    // no "T" through unused numbers anywhere (owner 2026-10-07), no reverse T in panel 3 (owner 2026-11-16)
    expect(container.querySelectorAll('[data-mark="T"]')).toHaveLength(0)
    const grids = container.querySelectorAll('[data-testid="points-grid"]')
    const panel3 = grids[grids.length - 1]
    expect(container.querySelectorAll('[data-mark="reverseT"]')).toHaveLength(0)
    // 1-5 stay plain numbers, the 6th point is ticked
    const mark = (n: number) => panel3.querySelector(`[data-point="${n}"]`)?.getAttribute('data-mark')
    expect([1, 2, 3, 4, 5].map(mark)).toEqual(['', '', '', '', ''])
    expect(mark(6)).toBe('tick')
    // panels 2 and 3 print 1-30 (3 x 10), sets 1-4 print 1-48
    expect(panel3.querySelectorAll('[data-point]')).toHaveLength(30)
    expect(grids[0].querySelectorAll('[data-point]')).toHaveLength(48)
  })

  it('a finished set leaves the numbers above each team\'s score blank (owner 2026-10-13)', () => {
    // set 5: home (left) 5 at the change (5:8), then 15:8
    const data = set5('hhhhh' + 'aaaaaaaa' + 'hhhhhhhhhh')
    data.sets[4] = { ...data.sets[4], finished: true, endTime: local(2026, 10, 7, 22, 5) }
    const { container } = render(<App matchData={data} autoAction="preview" />)
    const grids = [...container.querySelectorAll('[data-testid="points-grid"]')]
    const shown = (g: Element) => [...g.querySelectorAll('[data-point]:not([data-blank])')].map(e => Number(e.getAttribute('data-point')))
    const upTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1)
    // sets 1-4 (25:20 each way): 1-25 and 1-20, the rest of 1-48 blank
    for (const set of [0, 1, 2, 3]) {
      expect([shown(grids[2 * set]), shown(grids[2 * set + 1])].map(a => a.length).sort()).toEqual([20, 25])
    }
    expect(shown(grids[0])).toEqual(upTo(shown(grids[0]).length))
    // set 5: panel 1 ends at the change (1-5), panel 2 at 8, panel 3 at 15
    const [p1, p2, p3] = grids.slice(-3)
    expect(shown(p1)).toEqual(upTo(5))
    expect(p1.querySelectorAll('[data-point]')).toHaveLength(8)
    expect(shown(p2)).toEqual(upTo(8))
    expect(shown(p3)).toEqual(upTo(15))
  })

  it('a set still running keeps every pre-printed number', () => {
    const { container } = render(<App matchData={set5('hhaahhah')} autoAction="preview" />)
    const grids = [...container.querySelectorAll('[data-testid="points-grid"]')]
    expect(grids.slice(-3).map(g => g.querySelectorAll('[data-blank]').length)).toEqual([0, 0, 0])
  })

  // A Global match may play the deciding set to another target: the teams change
  // courts at half of it rounded up (rules.courtSwitchPointOf), as the Scoreboard
  const set5To = (deciding: number, points: string, timeoutAfter?: number) => {
    const data: any = set5(points)
    data.match = { ...data.match, setTargets: { regular: 25, deciding } }
    if (timeoutAfter !== undefined) {
      // a time-out of the left team (home) after the given point of the set
      const pts = data.events.filter((e: any) => e.type === 'point')
      const to = { ...ev('timeout', 5, { team: 'home' }), seq: pts[timeoutAfter - 1].seq + 0.5 }
      data.events = [...data.events, to]
    }
    return data
  }
  const set5Panels = (c: HTMLElement) => {
    const box = c.querySelector('[data-testid="set5-box"]')!
    return {
      grids: [...box.querySelectorAll('[data-testid="points-grid"]')],
      timeouts: [...box.querySelectorAll('[data-testid="timeout-block"]')].map(b => b.textContent || '')
    }
  }

  it('a deciding set to 10 changes courts at 5, not 8: the box, the panels and the time-outs follow', () => {
    // home (left) 4, then away reaches 5: the change at 4:5; home scores, then its time-out at 5:5
    const { getByTestId, container } = render(<App matchData={set5To(10, 'hhhh' + 'aaaaa' + 'h', 10)} autoAction="preview" />)
    expect(getByTestId('set5-points-at-change').textContent).toBe('4')
    const { grids, timeouts } = set5Panels(container)
    const mark = (g: Element, n: number) => g.querySelector(`[data-point="${n}"]`)?.getAttribute('data-mark')
    // panel 1: points 1-4 ticked, the 5th (after the change) is in panel 3
    expect([1, 2, 3, 4, 5].map(n => mark(grids[0], n))).toEqual(['tick', 'tick', 'tick', 'tick', ''])
    expect(mark(grids[2], 5)).toBe('tick')
    // the time-out at 5:5 came after the change: panel 3, not panel 1
    expect(timeouts[2]).toContain('5:5')
    expect(timeouts[0]).not.toContain('5:5')
  })

  it('a deciding set to 25 changes courts at 13: panel 1 prints 1-13', () => {
    const { getByTestId, container } = render(<App matchData={set5To(25, 'h'.repeat(13) + 'a')} autoAction="preview" />)
    expect(getByTestId('set5-points-at-change').textContent).toBe('13')
    const { grids } = set5Panels(container)
    expect(grids[0].querySelectorAll('[data-point]')).toHaveLength(13)
    expect([...grids[0].querySelectorAll('[data-point]')].map(e => e.getAttribute('data-mark'))).toEqual(Array(13).fill('tick'))
  })

  it('a deciding set to 5 changes courts at 3; panel 1 still prints 1-8', () => {
    const { getByTestId, container } = render(<App matchData={set5To(5, 'hh' + 'aaa')} autoAction="preview" />)
    expect(getByTestId('set5-points-at-change').textContent).toBe('2')
    expect(set5Panels(container).grids[0].querySelectorAll('[data-point]')).toHaveLength(8)
  })

  it('a 3:0: the unplayed sets 4 and 5 and their RESULT rows are left blank, not struck off (owner 2026-10-20)', () => {
    const base = fixture({ match: { status: 'ended' } })
    const threeNil = [0, 30, 60].map((m, i) => ({ index: i + 1, homePoints: 25, awayPoints: 20, finished: true, startTime: local(2026, 10, 7, 20, m), endTime: local(2026, 10, 7, 20, m + 25) }))
    const { queryAllByTestId, container } = render(<App matchData={{ ...base, sets: threeNil }} autoAction="preview" />)
    expect(queryAllByTestId('strike-z')).toHaveLength(0)
    expect(queryAllByTestId('row-strike')).toHaveLength(0)
    expect(container.querySelectorAll('.scoresheet-container svg polyline')).toHaveLength(0)
  })

  // owner 2026-11-15: a set never played prints no numbers in its points
  // columns, not even grey; RESULT always has the five rows, a set in its own row
  const numbersOf = (g: Element) => [...g.querySelectorAll('[data-point]')].filter(e => (e.textContent || '').trim() !== '').length
  // by printed row (1 = top), not by stored set index
  const resultRow = (c: HTMLElement, row: number) => ({
    label: c.querySelector(`[data-testid="result-row"][data-row="${row}"] [data-testid="result-row-label"]`)?.textContent,
    a: c.querySelector(`[data-testid="result-team-row"][data-team="A"][data-row="${row}"]`)?.textContent,
    b: c.querySelector(`[data-testid="result-team-row"][data-team="B"][data-row="${row}"]`)?.textContent
  })

  it('best of 3 won 2:1: sets 3 and 4 print no numbers; RESULT fills rows 1, 2 and 3, rows 4 and 5 stay empty (owner 2026-11-15)', () => {
    const base = fixture({ match: { status: 'ended', bestOf: 3, set5LeftTeam: 'A', set5FirstServe: 'home' } })
    const sets = [
      { index: 1, homePoints: 25, awayPoints: 20, finished: true, startTime: local(2026, 10, 7, 20, 0), endTime: local(2026, 10, 7, 20, 25) },
      { index: 2, homePoints: 18, awayPoints: 25, finished: true, startTime: local(2026, 10, 7, 20, 30), endTime: local(2026, 10, 7, 20, 55) },
      { index: 5, homePoints: 15, awayPoints: 12, finished: true, startTime: local(2026, 10, 7, 21, 0), endTime: local(2026, 10, 7, 21, 20) }
    ]
    const { container } = render(<App matchData={{ ...base, sets }} autoAction="preview" />)
    const grids = [...container.querySelectorAll('[data-testid="points-grid"]')]
    expect(grids).toHaveLength(11)
    // sets 1 and 2: their scores; sets 3 and 4 (grids 4-7): nothing at all
    expect([0, 1, 2, 3].map(i => numbersOf(grids[i])).sort((x, y) => x - y)).toEqual([18, 20, 25, 25])
    expect([4, 5, 6, 7].map(i => numbersOf(grids[i]))).toEqual([0, 0, 0, 0])
    // the decider keeps its numbers up to the scores
    expect(grids.slice(-3).map(numbersOf).reduce((x, y) => x + y, 0)).toBeGreaterThan(0)
    // RESULT: five rows; the decider (stored as set 5) in row 3, numbered 3 as
    // its set box; rows 4 and 5 empty and unnumbered
    const rows = [...container.querySelectorAll('[data-testid="result-row"]')]
    expect(rows).toHaveLength(5)
    expect(rows.map(r => r.querySelector('[data-testid="result-row-label"]')?.textContent)).toEqual(['1', '2', '3', '', ''])
    expect([1, 2, 3, 4, 5].map(n => resultRow(container, n).label)).toEqual(['1', '2', '3', '', ''])
    expect(rows[2].getAttribute('data-set')).toBe('5')
    for (const n of [4, 5]) expect(resultRow(container, n)).toMatchObject({ a: '', b: '' })
    expect(resultRow(container, 1).a).toContain('25')
    expect(resultRow(container, 2).b).toContain('25')
    expect(resultRow(container, 3).a).toContain('15')
    expect(resultRow(container, 3).b).toContain('12')
  })

  it('best of 5 won 3:0: sets 4 and 5 print no numbers; RESULT has rows 1-5, 4 and 5 empty', () => {
    const base = fixture({ match: { status: 'ended' } })
    const threeNil = [0, 30, 60].map((m, i) => ({ index: i + 1, homePoints: 25, awayPoints: 20, finished: true, startTime: local(2026, 10, 7, 20, m), endTime: local(2026, 10, 7, 20, m + 25) }))
    const { container } = render(<App matchData={{ ...base, sets: threeNil }} autoAction="preview" />)
    const grids = [...container.querySelectorAll('[data-testid="points-grid"]')]
    expect(grids.slice(0, 6).map(numbersOf)).toEqual([25, 20, 20, 25, 25, 20])
    expect(grids.slice(6).map(numbersOf)).toEqual([0, 0, 0, 0, 0])
    expect([1, 2, 3, 4, 5].map(n => resultRow(container, n).label)).toEqual(['1', '2', '3', '4', '5'])
    expect(resultRow(container, 3).a).toContain('25')
    for (const n of [4, 5]) expect(resultRow(container, n)).toMatchObject({ a: '', b: '' })
  })

  // owner 2026-11-15: the centre's rows (Set, Duration) sat lower and were shorter
  // than the teams' where the text's line height differs (the referee view): each
  // block had rows of its own. Now one grid: a row's A, centre and B cells are
  // items of the same grid row, so their lines meet at one height in any view.
  it.each([3, 5])('RESULT is one grid: headings, the five set rows and Total share their rows across A, centre and B (best of %i)', (bestOf) => {
    const base = fixture({ match: { status: 'ended', bestOf, set5LeftTeam: 'A', set5FirstServe: 'home' } })
    const sets = [
      { index: 1, homePoints: 25, awayPoints: 20, finished: true, startTime: local(2026, 10, 7, 20, 0), endTime: local(2026, 10, 7, 20, 25) },
      { index: 2, homePoints: 18, awayPoints: 25, finished: true, startTime: local(2026, 10, 7, 20, 30), endTime: local(2026, 10, 7, 20, 55) }
    ]
    const { getByTestId } = render(<App matchData={{ ...base, sets }} autoAction="preview" />)
    const table = getByTestId('result-table')
    // fixed heading rows, five equal set rows, Total 0.7 cm
    expect(table.style.gridTemplateRows).toBe('20px 13px repeat(5, minmax(16px, 1fr)) 0.7cm')
    expect(table.style.gridTemplateColumns).toBe('1fr 80px 1fr')
    // every cell a direct item of the grid, three per row in order A, centre, B
    const items = [...table.children].map(el => {
      const id = el.getAttribute('data-testid')
      const block = el.getAttribute('data-block') ?? el.getAttribute('data-team') ?? 'C'
      return `${id}:${block}:${el.getAttribute('data-row') ?? ''}`
    })
    expect(items).toEqual([
      'result-head:A:', 'result-head:C:', 'result-head:B:',
      'result-subhead:A:', 'result-subhead:C:', 'result-subhead:B:',
      ...[1, 2, 3, 4, 5].flatMap(r => [`result-team-row:A:${r}`, `result-row:C:${r}`, `result-team-row:B:${r}`]),
      'result-total:A:', 'result-total:C:', 'result-total:B:'
    ])
    // no row of its own sizes a block: no flex-1 / min height on the rows
    for (const el of table.querySelectorAll('[data-testid="result-team-row"], [data-testid="result-row"]')) {
      expect(el.className).not.toMatch(/flex-1|min-h-\[/)
    }
  })

  it('SANCTIONS headings read W P E D: "D" for disqualification, not "DQ" (owner 2026-11-15)', () => {
    const { getByTestId, container } = render(<App matchData={fixture()} autoAction="preview" />)
    expect(getByTestId('sanctions-head-disqualification').textContent).toBe('D')
    const head = getByTestId('sanctions-head-disqualification').parentElement as HTMLElement
    expect([...head.children].slice(0, 4).map(c => c.textContent)).toEqual(['W', 'P', 'E', 'D'])
    expect(sheetText(container)).not.toMatch(/\bDQ\b/)
  })

  it('a match still running keeps the grey numbers of the sets that may still be played', () => {
    const base = fixture()
    const sets = [{ index: 1, homePoints: 25, awayPoints: 20, finished: true, startTime: local(2026, 10, 7, 20, 0), endTime: local(2026, 10, 7, 20, 25) }]
    const { container } = render(<App matchData={{ ...base, sets }} autoAction="preview" />)
    const grids = [...container.querySelectorAll('[data-testid="points-grid"]')]
    expect(grids.slice(2, 8).map(numbersOf)).toEqual([48, 48, 48, 48, 48, 48])
    expect(grids.slice(-3).map(numbersOf)).toEqual([8, 30, 30])
  })

  it('a default before the start: the grids left blank, not struck off (owner 2026-10-21), the result and the remark written', () => {
    seq = 0
    const base = fixture({ match: { status: 'ended', forfeitTeam: 'away', forfeitReason: 'forfeit' } })
    const data = {
      ...base,
      sets: [1, 2, 3].map(index => ({ index, homePoints: 25, awayPoints: 0, finished: true, forfeitCreated: index > 1, endTime: local(2026, 10, 7, 20, 5), startTime: index > 1 ? local(2026, 10, 7, 20, 5) : undefined })),
      events: [
        ...Array.from({ length: 25 }, () => ev('point', 1, { team: 'home', forfeitAwarded: true })),
        ev('forfait', 1, { team: 'away', reason: 'forfeit', scope: 'match', setIndex: 1 })
      ]
    }
    const { queryAllByTestId, getByTestId, container } = render(<App matchData={data} autoAction="preview" />)
    // sets 1-3 by default and sets 4 and 5, never played: no Z anywhere
    expect(queryAllByTestId('strike-z')).toHaveLength(0)
    expect(container.querySelectorAll('.scoresheet-container svg polyline')).toHaveLength(0)
    // no awarded point drawn as a rally (the grid stays empty)
    expect(container.querySelectorAll('[data-mark="tick"]')).toHaveLength(0)
    expect(getByTestId('remarks-text').textContent).toContain('Team B declared in default, match result 3:0 (25:0, 25:0, 25:0).')
    expect(getByTestId('results-winner').textContent).toBe('VBC Musterdorf H1')
    // the RESULT rows hold the awarded sets: 3:0 for the team that did not default
    expect(getByTestId('results-score').textContent?.replace(/\s/g, '')).toMatch(/3.*0/)
  })

  it('awarded points of an incomplete team are circled, not ticked', () => {
    seq = 0
    const base = fixture()
    const events = [
      ...Array.from({ length: 12 }, () => ev('point', 1, { team: 'away' })),
      ...Array.from({ length: 16 }, () => ev('point', 1, { team: 'home' })),
      ...Array.from({ length: 9 }, () => ev('point', 1, { team: 'home', forfeitAwarded: true })),
      ev('forfait', 1, { team: 'away', reason: 'expulsion', scope: 'set', setIndex: 1 })
    ]
    const data = { ...base, events, sets: [{ index: 1, homePoints: 25, awayPoints: 12, finished: true, startTime: local(2026, 10, 7, 20), endTime: local(2026, 10, 7, 20, 30) }] }
    const { container, getByTestId } = render(<App matchData={data} autoAction="preview" />)
    const circled = [...container.querySelectorAll('[data-mark="circle"]')].map(e => Number(e.getAttribute('data-point')))
    expect(circled).toEqual([17, 18, 19, 20, 21, 22, 23, 24, 25])
    expect(getByTestId('remarks-text').textContent).toContain('Team B, Set 1, Result 12:16: incomplete team (expulsion). Set awarded to Team A, 25:12.')
  })

  it('the point and service a going back gives the opponent is circled; cancelled points are not marked; the remark is written (owner 2026-11-09)', () => {
    seq = 0
    const base = fixture()
    const remark = 'Set 1, points 6:2: illegal substitution by team A (since 2:1, 4 points of team A cancelled, point and service to team B). New score for set 1: 2:3.'
    const events = [
      ev('point', 1, { team: 'home' }), ev('point', 1, { team: 'away' }), ev('point', 1, { team: 'home' }),
      ...Array.from({ length: 2 }, () => ev('cancelled_point', 1, { team: 'home', cancelledBy: 'rectification' })),
      ev('point', 1, { team: 'away' }),
      ...Array.from({ length: 2 }, () => ev('cancelled_point', 1, { team: 'home', cancelledBy: 'rectification' })),
      ev('point', 1, { team: 'away', rectification: true, penaltyPoint: true }),
      ev('rectification', 1, { cancel: 'home', penaltyTo: 'away', serve: 'away', autoRemark: remark })
    ]
    const { container, getByTestId } = render(<App matchData={{ ...base, events, match: { ...base.match, remarks: remark } }} autoAction="preview" />)
    const circled = [...container.querySelectorAll('[data-mark="circle"]')].map(e => Number(e.getAttribute('data-point')))
    expect(circled).toEqual([3])
    expect(getByTestId('remarks-text').textContent).toContain(remark)
  })

  it('a penalty circles the point written for it; none when a going back cancelled that point', () => {
    seq = 0
    const base = fixture()
    const linkedRun = () => {
      const pts = [ev('point', 1, { team: 'away' }), ev('point', 1, { team: 'home' })]
      const sanction = ev('sanction', 1, { team: 'home', type: 'penalty', playerNumber: 12, playerType: 'player' })
      return { pts, sanction }
    }
    const a = linkedRun()
    const kept = [...a.pts, a.sanction, ev('point', 1, { team: 'away', penaltySeq: a.sanction.seq }), ev('point', 1, { team: 'away' })]
    const one = render(<App matchData={{ ...base, events: kept }} autoAction="preview" />)
    expect([...one.container.querySelectorAll('[data-mark="circle"]')].map(e => Number(e.getAttribute('data-point')))).toEqual([2])
    cleanup()
    seq = 0
    const b = linkedRun()
    const cancelled = [
      ...b.pts, b.sanction,
      ev('cancelled_point', 1, { team: 'away', penaltySeq: b.sanction.seq, cancelledBy: 'rectification' }),
      ev('rectification', 1, { cancel: 'away', penaltyTo: null, serve: 'away', autoRemark: '' }),
      ev('point', 1, { team: 'away' })
    ]
    const two = render(<App matchData={{ ...base, events: cancelled }} autoAction="preview" />)
    expect([...two.container.querySelectorAll('[data-mark="circle"]')].map(e => Number(e.getAttribute('data-point')))).toEqual([])
  })

  it('9 sanction rows; the 10th continues in REMARKS; a bench player\'s number not circled (owner 2026-10-13)', () => {
    seq = 0
    const base = fixture()
    const events = [
      ...Array.from({ length: 8 }, (_, i) => ev('sanction', 1, { team: 'away', type: 'warning', playerNumber: i + 1, playerType: 'player' })),
      ev('sanction', 1, { team: 'away', type: 'penalty', playerNumber: 12, playerType: 'bench' }),
      ev('sanction', 1, { team: 'home', type: 'warning', playerNumber: 13, playerType: 'bench' })
    ]
    const { getAllByTestId, getByTestId, container } = render(<App matchData={{ ...base, events }} autoAction="preview" />)
    expect(getAllByTestId('sanction-row')).toHaveLength(9)
    expect(getAllByTestId('sanction-row')[8].textContent).toContain('12')
    expect(container.querySelectorAll('[data-testid="sanction-bench-circle"]')).toHaveLength(0)
    expect(getByTestId('remarks-text').textContent).toContain('Sanctions (overflow):\nTeam A, Set 1, Score 0:0, Warning, 13')
  })
})

describe('round 2 (owner review 2026-10-07)', () => {
  it('both roster headers centre the short name, the A/B circle at the outer side', () => {
    const { getAllByTestId } = render(<App matchData={fixture()} autoAction="preview" />)
    const names = getAllByTestId('roster-team-name')
    expect(names).toHaveLength(2)
    for (const n of names) expect(n.className).toContain('text-center')
  })

  it('the coin-toss signatures are in the roster boxes as soon as the match record has them', () => {
    const sig = 'data:image/png;base64,iVBORw0KGgo='
    const data = fixture({ match: { status: 'setup', homeCaptainSignature: sig, awayCoachSignature: sig, coinTossTeamA: undefined } })
    const { getAllByTestId, queryAllByTestId, rerender } = render(<App matchData={data} autoAction="preview" />)
    expect(getAllByTestId('roster-captain-signature')).toHaveLength(1)
    expect(getAllByTestId('roster-coach-signature')).toHaveLength(1)
    // removed from the record (re-sign / clear): gone from the sheet too
    rerender(<App matchData={fixture({ match: { status: 'setup' } })} autoAction="preview" />)
    expect(queryAllByTestId('roster-captain-signature')).toHaveLength(0)
  })

  it('Match Start is the actual start of set 1 (its first rally), not the scheduled time', () => {
    const base = fixture()
    const data = {
      ...base,
      // the start dialog kept the schedule (20:00); the first rally really started at 20:11
      sets: [{ index: 1, homePoints: 1, awayPoints: 0, finished: false, startTime: local(2026, 10, 7, 20, 0) }],
      events: [
        ...base.events,
        { type: 'rally_start', setIndex: 1, seq: 50, ts: local(2026, 10, 7, 20, 11), payload: {} },
        { type: 'point', setIndex: 1, seq: 51, ts: local(2026, 10, 7, 20, 12), payload: { team: 'home' } }
      ]
    }
    const { container } = render(<App matchData={data} autoAction="preview" />)
    const text = sheetText(container)
    expect(text).toContain('Start:20:11')
    expect(text).toContain('20 h 11 min')
    expect(text).not.toContain('20 h 00 min')
  })

  it('every roster player row is ruled, the remarks box has its writing lines', () => {
    const { getAllByTestId } = render(<App matchData={fixture()} autoAction="preview" />)
    expect(getAllByTestId('roster-row')).toHaveLength(28)
    for (const r of getAllByTestId('roster-row').slice(0, 13)) expect(r.className).toContain('border-b')
    expect(getAllByTestId('remarks-rule')).toHaveLength(3)
  })

  it('number circles: the service-box ring clear of its rules, every ring clear of its two-digit number', () => {
    const strokeMm = MARK_STROKE * 25.4 / 96
    const inkMm = (px: number) => TWO_DIGIT_INK_RADIUS_EM * px * 25.4 / 96
    // service boxes are ~4.6 mm wide inside their rules: >= 0.1 mm each side
    expect((4.6 - (NUMBER_CIRCLE_MM + strokeMm)) / 2).toBeGreaterThanOrEqual(0.1)
    // the final points keep the box's number size, inside the ring
    expect(NUMBER_CIRCLE_MM / 2 - strokeMm / 2).toBeGreaterThan(inkMm(SERVICE_NUMBER_PX) + 0.05)
    // a substitute who came back: the row's number size (owner 2026-10-13), a ring
    // clear of it and clear of the row's rules (~4.74 mm apart)
    const subPx = LINEUP_NUMBER_PT * 96 / 72
    expect(SUB_CIRCLE_MM / 2 - strokeMm / 2).toBeGreaterThan(inkMm(subPx) + 0.05)
    expect((4.74 - (SUB_CIRCLE_MM + strokeMm)) / 2).toBeGreaterThanOrEqual(0.05)
  })

  it('line-up and substitute numbers share one size; the circled substitute keeps it', () => {
    seq = 0
    const base = fixture()
    const lineupRow = (container: HTMLElement) => [...container.querySelectorAll('[data-testid="service-grid"]')][0]
    const { container } = render(<App matchData={base} autoAction="preview" />)
    const sizes = [...lineupRow(container).querySelectorAll('div.font-bold.tabular-nums')].map(e => (e as HTMLElement).style.fontSize)
    expect(sizes.length).toBeGreaterThan(0)
    expect(new Set(sizes)).toEqual(new Set([`${LINEUP_NUMBER_PT}pt`]))
  })
})

// Long remarks with overflow sanctions: the box stopped at its smallest font
// and cut the rest off, and the overflow sanctions (always last) went first.
// The sanctions now come before the free text, and a text that still does not
// fit is warned about and printed whole on a second PDF page.
describe('a signature in the REMARKS (SVRZ feedback 2026-11-09)', () => {
  afterEach(() => cleanup())
  it('prints beside the remark text with its role and name', () => {
    const sig = { role: 'Referee coach', name: 'Anna Muster', image: 'data:image/png;base64,AAAA', signedAt: '2026-11-09T18:00:00.000Z' }
    const { getByTestId, getAllByTestId } = render(<App matchData={fixture({ match: { remarks: 'Checked by the referee coach.', remarksSignatures: [sig] } })} autoAction="preview" />)
    expect(getByTestId('remarks-text').textContent).toContain('Checked by the referee coach.')
    const boxes = getAllByTestId('remarks-signature')
    expect(boxes).toHaveLength(1)
    expect(boxes[0].textContent).toBe('Referee coach · Anna Muster')
    expect(boxes[0].querySelector('img')?.getAttribute('src')).toBe(sig.image)
  })
  it('no signature: no column beside the text', () => {
    const { queryByTestId } = render(<App matchData={fixture()} autoAction="preview" />)
    expect(queryByTestId('remarks-signatures')).toBeNull()
  })
})

describe('REMARKS that do not fit their box', () => {
  let clicked: HTMLAnchorElement[] = []
  const tenSanctions = () => [
    ...Array.from({ length: 9 }, (_, i) => ev('sanction', 1, { team: 'away', type: 'warning', playerNumber: i + 1, playerType: 'player' })),
    ev('sanction', 1, { team: 'home', type: 'warning', playerNumber: 13, playerType: 'bench' })
  ]
  beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get () { return 1550 } })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get () { return 1085 } })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this) })
    ;(URL as any).createObjectURL = vi.fn(() => 'blob:x')
    ;(URL as any).revokeObjectURL = vi.fn()
  })
  afterAll(() => {
    delete (HTMLElement.prototype as any).offsetWidth
    delete (HTMLElement.prototype as any).offsetHeight
    delete (HTMLElement.prototype as any).scrollHeight
    vi.restoreAllMocks()
  })
  afterEach(() => { cleanup(); clicked = []; pdfCalls.length = 0; delete (HTMLElement.prototype as any).scrollHeight })

  it('the overflow sanctions come before the scorer\'s own remarks', () => {
    seq = 0
    const base = fixture({ match: { remarks: 'Ball pressure checked.' } })
    const { getByTestId, queryByTestId } = render(<App matchData={{ ...base, events: tenSanctions() }} autoAction="preview" />)
    const text = getByTestId('remarks-text').textContent || ''
    expect(text.indexOf('Sanctions (overflow):')).toBeGreaterThan(-1)
    expect(text.indexOf('Sanctions (overflow):')).toBeLessThan(text.indexOf('Ball pressure checked.'))
    // it fits (jsdom lays nothing out): no notice, no warning
    expect(text).not.toContain('Remarks continue on page 2.')
    expect(queryByTestId('remarks-clipped-warning')).toBeNull()
  })

  it('a picture that did not load (jsdom loads none) is named before the capture, the PDF is still made', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    seq = 0
    const { getByText } = render(<App matchData={fixture()} autoAction="preview" />)
    await act(async () => { getByText('Save PDF').click() })
    await waitFor(() => expect(clicked).toHaveLength(1))
    const line = warn.mock.calls.map(c => c.join(' ')).find(l => l.includes('did not load'))
    expect(line).toContain('OpenVolley')
    warn.mockRestore()
  })

  it('still too long at the smallest size: a notice, a warning, and the whole text on PDF page 2', async () => {
    // the remarks text overflows its box at every size
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get () { return (this as HTMLElement).dataset?.testid === 'remarks-text' ? 1000 : 0 }
    })
    seq = 0
    const long = 'A long remark. '.repeat(80).trim()
    const base = fixture({ match: { remarks: long } })
    const { getByTestId } = render(<App matchData={{ ...base, events: tenSanctions() }} autoAction="save" dataReady />)
    await waitFor(() => expect(getByTestId('remarks-text').textContent).toMatch(/^Remarks continue on page 2\./))
    expect(getByTestId('remarks-clipped-warning')).toBeTruthy()
    // it shrank no further than 6px (about 4.5 pt on A3) before page 2 took over (field-spec 8)
    expect(getByTestId('remarks-text').style.fontSize).toBe(`${REMARKS_MIN_PX}px`)
    expect(REMARKS_MIN_PX).toBe(6)
    await waitFor(() => expect(clicked).toHaveLength(1))
    expect(pdfCalls.some(c => c[0] === 'addPage')).toBe(true)
    const page2 = pdfCalls.filter(c => c[0] === 'text' && Array.isArray(c[1])).map(c => c[1].join('\n')).join('\n')
    expect(page2).toContain('Sanctions (overflow):\nTeam A, Set 1, Score 0:0, Warning, 13')
    expect(page2).toContain(long)
  })
})
