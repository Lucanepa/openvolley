import React from 'react'
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { render, cleanup, act, waitFor } from '@testing-library/react'
import App from '../App_Scoresheet'
import { BRAND } from '../../src/brand.js'

// The owner's request of 2026-10-07 on the printed sheet and its PDF:
// OpenVolley instead of Swiss Volley, the new ball, "DoB" in APPROVAL, a file
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
    text (t: string) { pdfCalls.push(['text', t]) }
    output () { return new TextEncoder().encode(`%PDF-1.3\n${'x'.repeat(30_000)}\n%%EOF\n`).buffer }
  }
}))

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
      homeShortName: 'KSCW-H1', awayShortName: 'SPADA', gameNumber: '382208', league: '2L',
      scheduledAt: local(2026, 10, 7, 20, 0), city: 'Zürich', hall: 'KS Wiedikon',
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
    homeTeam: { name: 'KSC Wiedikon H1' },
    awayTeam: { name: 'Volley Spada Academica H1' },
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

  it('APPROVAL: a "DoB" column (no "Lic."), dates of birth as DD.MM.YYYY, placeholder left empty', () => {
    const { container, getByTestId } = render(<App matchData={fixture()} autoAction="preview" />)
    const text = sheetText(container)
    const approval = text.slice(text.indexOf('APPROVAL'), text.indexOf('Line Judges'))
    expect(approval).toContain('OfficialNameCountryDoBSignature')
    expect(approval).not.toContain('Lic')
    expect(getByTestId('approval-dob-0').textContent).toBe('19.04.1982')
    expect(getByTestId('approval-dob-1').textContent).toBe('02.09.1979')
    expect(getByTestId('approval-dob-2').textContent).toBe('') // 01.01.1900
    expect(getByTestId('approval-dob-3').textContent).toBe('07.06.1988')
    expect(approval).toContain('Moser, C.')
    // the line judge as entered
    expect(text).toContain('Marie Claire de la Fontaine')
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

  it('rosters: DoB | No | Name (no licence column), sorted by number, normalised dates, a short name always', () => {
    const data = fixture({ match: { awayShortName: '' } })
    const { container } = render(<App matchData={data} autoAction="preview" />)
    const text = sheetText(container)
    const home = text.slice(text.indexOf('KSCW-H1DoBNoName'))
    expect(home.startsWith('KSCW-H1DoBNoName')).toBe(true)
    // 1, 3, 7, 12 in shirt-number order, ISO dates as DD.MM.YYYY
    expect(home).toMatch(/01\.03\.19981Home1, A\.03\.03\.19983Home3, A\.07\.03\.19987Home7, A\.03\.03\.199812Home12, A\./)
    // the away short name was empty: the team name
    expect(text).toContain('Volley Spada Academica H1BDoBNoName')
    expect(text).toContain('02.03.19982Away2, X.')
    expect(text).not.toContain('Lic.')
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

  it('the automatic save waits for every query and names the file after the real teams (not match_HOME_AWAY)', async () => {
    // first render: the match row only (short names HOME / AWAY, teams not loaded yet)
    const first = fixture({ match: { homeShortName: 'HOME', awayShortName: 'AWAY' } })
    const loading = { ...first, homeTeam: null, awayTeam: null }
    const view = render(<App matchData={loading} autoAction="save" dataReady={false} />)
    await new Promise(r => setTimeout(r, 700))
    expect(clicked).toHaveLength(0)

    view.rerender(<App matchData={first} autoAction="save" dataReady />)
    await waitFor(() => expect(clicked).toHaveLength(1), { timeout: 3000 })
    expect(clicked[0].download).toBe('20261007_382208_KSC-Wiedikon-H1_vs_Volley-Spada-Academica-H1.pdf')
    // a valid A3 PDF, the sheet at its true size, with its metadata
    expect(pdfCalls.find(c => c[0] === 'new')[1]).toMatchObject({ orientation: 'landscape', unit: 'mm', format: 'a3' })
    expect(pdfCalls.find(c => c[0] === 'addImage')).toEqual(['addImage', 'JPEG', 5, 5, 410, 287])
    const props = pdfCalls.find(c => c[0] === 'setProperties')[1]
    expect(props.creator).toBe('OpenVolley eScoresheet')
    expect(props.title).toBe('OpenVolley eScoresheet: KSC Wiedikon H1 vs Volley Spada Academica H1, 07.10.2026, game 382208')
    expect(JSON.stringify(pdfCalls)).not.toMatch(/swiss/i)
    // a browser: the notice names the file and where it went
    await waitFor(() => expect(view.getByTestId('pdf-notice').textContent).toContain("browser's download folder"))
    expect(view.getByTestId('pdf-notice-path').textContent).toBe('20261007_382208_KSC-Wiedikon-H1_vs_Volley-Spada-Academica-H1.pdf')
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
      await waitFor(() => expect(clicked).toHaveLength(1), { timeout: 3000 })
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

  it('at the change: the left team\'s points only in the box, no T / reverse T in the points columns (owner 2026-10-07)', () => {
    // home (left) 5, then away reaches 8: the change at 5:8
    const { getByTestId, container } = render(<App matchData={set5('hhhhh' + 'aaaaaaaa' + 'h')} autoAction="preview" />)
    expect(getByTestId('set5-points-at-change').textContent).toBe('5')
    expect(container.querySelectorAll('[data-mark="reverseT"], [data-mark="T"]')).toHaveLength(0)
    // panel 3 (the last points grid): 1-5 stay plain, the 6th point is ticked
    const grids = container.querySelectorAll('[data-testid="points-grid"]')
    const panel3 = grids[grids.length - 1]
    const mark = (n: number) => panel3.querySelector(`[data-point="${n}"]`)?.getAttribute('data-mark')
    expect([1, 2, 3, 4, 5].map(mark)).toEqual(['', '', '', '', ''])
    expect(mark(6)).toBe('tick')
    // panels 2 and 3 print 1-30 (3 x 10), sets 1-4 print 1-48
    expect(panel3.querySelectorAll('[data-point]')).toHaveLength(30)
    expect(grids[0].querySelectorAll('[data-point]')).toHaveLength(48)
  })

  it('a default before the start: the grids struck off, the result and the remark written', () => {
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
    const { getAllByTestId, getByTestId, container } = render(<App matchData={data} autoAction="preview" />)
    // sets 1-3 by default, sets 4 and 5 never played
    expect(getAllByTestId('strike-z')).toHaveLength(5)
    // no awarded point drawn as a rally (the grid stays empty)
    expect(container.querySelectorAll('[data-mark="tick"]')).toHaveLength(0)
    expect(getByTestId('remarks-text').textContent).toContain('Team B declared in default, match result 3:0 (25:0, 25:0, 25:0).')
    expect(getByTestId('results-winner').textContent).toBe('KSC Wiedikon H1')
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

  it('9 sanction rows; the 10th continues in REMARKS; a bench player\'s number circled', () => {
    seq = 0
    const base = fixture()
    const events = [
      ...Array.from({ length: 9 }, (_, i) => ev('sanction', 1, { team: 'away', type: 'warning', playerNumber: i + 1, playerType: 'player' })),
      ev('sanction', 1, { team: 'home', type: 'warning', playerNumber: 13, playerType: 'bench' })
    ]
    const { getAllByTestId, getByTestId } = render(<App matchData={{ ...base, events }} autoAction="preview" />)
    expect(getAllByTestId('sanction-row')).toHaveLength(9)
    expect(getByTestId('remarks-text').textContent).toContain('Sanctions (overflow):\nTeam A, Set 1, Score 0:0, Warning, (13)')
  })
})
