import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { readFileSync, existsSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import App from '../App_Scoresheet'
import { FitText } from '../components/FitText'

// The sheet carries its own base styles wherever it is mounted (field-spec
// 17.13): the manager's Rebuild PDF drew it under the app's CSS (13px, line
// height 1.3, Inter Display, black inner rules), and in WebKit at a fractional
// device pixel ratio cells with a background painted over their row's rule.

const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(resolve(here, '..', p), 'utf8')
const sheetCss = read('sheet.css')

afterEach(cleanup)

const p = (n: number, extra: Record<string, unknown> = {}) => ({ number: n, firstName: 'Anna', lastName: `Player${n}`, dob: '2005-10-02', ...extra })
const data = () => ({
  match: {
    id: 1, status: 'ended', bestOf: 3, coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true,
    homeShortName: 'HOME', awayShortName: 'AWAY', gameNumber: '1', league: 'X', scheduledAt: new Date(2026, 10, 15, 15, 0).toISOString(),
    bench_home: [{ role: 'Coach', firstName: 'S', lastName: 'Loos', dob: '1997-09-20' }],
    bench_away: [], officials: []
  },
  homeTeam: { name: 'Home Team' }, awayTeam: { name: 'Away Team' },
  homePlayers: [...[2, 3, 4, 5, 6, 7].map(n => p(n)), p(38, { libero: 'libero1' }), p(19, { libero: 'libero2' })],
  awayPlayers: [...[2, 3, 4, 5, 6, 7].map(n => p(n)), p(14, { libero: 'libero1' })],
  sets: [], events: []
})

/** Every top-level rule of the CSS text: its prelude (selector or at-rule) and body. */
function rules(css: string): Array<{ prelude: string, body: string }> {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: Array<{ prelude: string, body: string }> = []
  let i = 0
  while (i < text.length) {
    const open = text.indexOf('{', i)
    const semi = text.indexOf(';', i)
    if (open < 0) break
    if (semi >= 0 && semi < open) { out.push({ prelude: text.slice(i, semi).trim(), body: '' }); i = semi + 1; continue }
    let depth = 1, j = open + 1
    while (j < text.length && depth) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++ }
    out.push({ prelude: text.slice(i, open).trim(), body: text.slice(open + 1, j - 1) })
    i = j
  }
  return out.filter(r => r.prelude)
}

describe('the sheet\'s own base styles (sheet.css)', () => {
  it('App_Scoresheet imports them itself, so every host gets them', () => {
    expect(read('App_Scoresheet.tsx')).toMatch(/^import '\.\/sheet\.css';$/m)
  })

  it('holds the .ss-rule hairline (#6b6b6b, field-spec 1), no longer only the standalone page\'s CSS', () => {
    expect(sheetCss).toMatch(/\.ss-rule\s*\{\s*border-color:\s*#6b6b6b;/)
    expect(read('scoresheet.css')).not.toMatch(/\.ss-rule\s*\{/)
  })

  it('reaches nothing outside the sheet: every selector is scoped to it', () => {
    const selectors: string[] = []
    const walk = (css: string) => {
      for (const r of rules(css)) {
        if (/^@layer\b/.test(r.prelude)) { if (r.body) walk(r.body); continue }
        if (/^@font-face\b/.test(r.prelude)) continue
        selectors.push(...r.prelude.split(/,(?![^(]*\))/).map(s => s.trim()))
      }
    }
    walk(sheetCss)
    expect(selectors.length).toBeGreaterThan(10)
    for (const s of selectors) expect(s).toMatch(/^(:where\(\.scoresheet-container, \.ss-sheet\)|\.ss-rule$)/)
  })

  it('sets the sheet\'s text as the standalone page did: 10px, line height 1.5, letter spacing normal, its own font', () => {
    const base = /:where\(\.scoresheet-container, \.ss-sheet\)\s*\{([^}]*)\}/.exec(sheetCss)![1]
    expect(base).toMatch(/font-family:\s*'OV Sheet Inter'/)
    expect(base).toMatch(/font-size:\s*10px/)
    expect(base).toMatch(/line-height:\s*1\.5/)
    expect(base).toMatch(/letter-spacing:\s*normal/)
    expect(base).toMatch(/font-variation-settings:\s*normal/)
    // the preflight inside the sheet: border-box, replaced elements as blocks
    expect(sheetCss).toMatch(/box-sizing:\s*border-box/)
    expect(sheetCss).toMatch(/:where\(img, svg, video, canvas, audio, iframe, embed, object\)\s*\{\s*display:\s*block/)
  })

  it('bundles the font: a family of its own, every file present', () => {
    const faces = rules(sheetCss).filter(r => r.prelude === '@font-face')
    expect(faces.length).toBeGreaterThanOrEqual(2)
    for (const f of faces) {
      expect(f.body).toMatch(/font-family:\s*'OV Sheet Inter'/)
      const url = /url\(([^)]+)\)/.exec(f.body)![1]
      expect(existsSync(resolve(here, '..', url)), url).toBe(true)
    }
    // never the app's "Inter Variable" (its opsz build would be replaced on the host page)
    expect(sheetCss).not.toMatch(/font-family:\s*'Inter Variable'/)
  })

  it('the sheet and the libero control sheet carry the scope classes', () => {
    const { container } = render(<App matchData={data() as any} autoAction="preview" />)
    expect(container.querySelector('.scoresheet-container')).not.toBeNull()
    expect(read('App_Scoresheet.tsx')).toMatch(/className="ss-sheet flex flex-col items-center gap-4"/)
  })
})

describe('bordered boxes keep their rules in the PDF (WebKit, fractional DPR)', () => {
  it('the roster, its LIBERO and BENCH OFFICIALS blocks, their rows and the signatures clip what overflows', () => {
    const { getAllByTestId } = render(<App matchData={data() as any} autoAction="preview" />)
    for (const id of ['roster-home', 'roster-away', 'roster-row', 'roster-libero-row', 'roster-official-row']) {
      for (const el of getAllByTestId(id)) expect(el.className, id).toContain('overflow-clip')
    }
    const roster = getAllByTestId('roster-home')[0]
    const blocks = [...roster.children] as HTMLElement[]
    // LIBERO, BENCH OFFICIALS, the signatures: the last three blocks
    for (const b of blocks.slice(-3)) {
      expect(b.className).toContain('overflow-clip')
      expect(b.className).not.toMatch(/\bbg-white\b/)
    }
  })

  it('no cell of a libero or official row has a background of its own (the box is white already)', () => {
    const { getAllByTestId } = render(<App matchData={data() as any} autoAction="preview" />)
    for (const row of [...getAllByTestId('roster-libero-row'), ...getAllByTestId('roster-official-row')]) {
      for (const cell of row.querySelectorAll('*')) expect(String((cell as HTMLElement).className)).not.toMatch(/\bbg-white\b/)
    }
  })

  it('REMARKS, APPROVAL and RESULT clip at their border, the winner band has no background of its own', () => {
    const { getByTestId, container } = render(<App matchData={data() as any} autoAction="preview" />)
    const box = (el: Element) => { let e: Element | null = el; while (e && !/\bborder border-black bg-white\b/.test(String((e as HTMLElement).className))) e = e.parentElement; return e as HTMLElement }
    expect(box(getByTestId('results-winner')).className).toContain('overflow-clip')
    expect(box(getByTestId('remarks-text')).className).toContain('overflow-clip')
    const approval = [...container.querySelectorAll('div')].find(d => d.textContent === 'APPROVAL')!
    expect(box(approval).className).toContain('overflow-clip')
    const band = getByTestId('results-winner').closest('.h-14') as HTMLElement
    expect(band.className).not.toMatch(/\bbg-white\b/)
  })
})

describe('FitText fits again once a font has loaded', () => {
  it('re-measures on document.fonts loadingdone', () => {
    const listeners: Array<() => void> = []
    const fonts = { addEventListener: (t: string, f: () => void) => { if (t === 'loadingdone') listeners.push(f) }, removeEventListener: () => {} }
    const had = Object.getOwnPropertyDescriptor(document, 'fonts')
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts })
    try {
      let wide = false
      const { getByText } = render(<FitText max={9} min={5}>Anna Player</FitText>)
      const el = getByText('Anna Player')
      // jsdom measures nothing: the text "overflows" only once the font has come
      Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => 40 })
      Object.defineProperty(el, 'scrollWidth', { configurable: true, get: () => (wide ? 40 * parseFloat(el.style.fontSize) / 7 : 40) })
      expect(el.style.fontSize).toBe('9px')
      wide = true
      expect(listeners).toHaveLength(1)
      act(() => listeners[0]())
      expect(el.style.fontSize).toBe('7px')
    } finally {
      if (had) Object.defineProperty(document, 'fonts', had)
      else delete (document as any).fonts
    }
  })
})

describe('descenders', () => {
  // FitText clips its box (overflow hidden): a one-line FitText with line height 1
  // cut the g and y of "Nguyen" in the APPROVAL names (owner 2026-11-16)
  it('no one-line FitText has leading-none', () => {
    for (const file of ['FooterSection.tsx', 'StandardSet.tsx', 'SetFive.tsx', 'HeaderSection.tsx']) {
      const path = resolve(here, '../components', file)
      if (!existsSync(path)) continue
      const tags = readFileSync(path, 'utf8').match(/<FitText\b[^>]*>/g) || []
      const bad = tags.filter(t => !/\bmultiline\b/.test(t) && /\bleading-none\b/.test(t))
      expect(bad, file).toEqual([])
    }
  })
})
