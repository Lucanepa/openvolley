// The scorer's Set preview (Match menu): the set in play as the paper sheet
// prints it, any set so far a tap away, live with the scoreboard's data.
// The drawing itself is tested in scoresheet_pdf/__tests__/SetPreview.test.tsx.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react'
import { useState } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// t() resolves from the real English file, so the test reads what users see
vi.mock('react-i18next', async () => {
  const en = (await import('../../i18n/locales/en.json')).default
  const lookup = key => key.split('.').reduce((o, k) => (o == null ? o : o[k]), en)
  return {
    useTranslation: () => ({
      t: (key, a, b) => {
        const opts = typeof a === 'object' ? a : b
        const fallback = typeof a === 'string' ? a : opts?.defaultValue
        const text = typeof lookup(key) === 'string' ? lookup(key) : (fallback ?? key)
        return String(text).replace(/\{\{(\w+)\}\}/g, (_, k) => String(opts?.[k] ?? ''))
      },
      i18n: { language: 'en' }
    })
  }
})

import SetPreviewModal, { previewSetIndices, currentPreviewSet } from '../setPreview/SetPreviewModal.jsx'
import MenuList from '../MenuList'
import { matchMenuSections, toMenuListSections } from '../matchMenu'
import en from '../../i18n/locales/en.json'
import de from '../../i18n/locales/de.json'
import deCH from '../../i18n/locales/de-CH.json'
import fr from '../../i18n/locales/fr.json'
import it_ from '../../i18n/locales/it.json'

let seq = 0
const ev = (type, setIndex, payload) => ({ id: ++seq, matchId: 1, type, setIndex, seq, ts: new Date(Date.UTC(2026, 10, 20, 18, 0, seq)).toISOString(), payload })
const HOME = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 }
const AWAY = { I: 11, II: 12, III: 13, IV: 14, V: 15, VI: 16 }

/** The scoreboard's live data: set 1 won by home, set 2 in play (the current set). */
function scoreboardData({ bestOf = 5 } = {}) {
  seq = 0
  const events = []
  for (const s of [1, 2]) {
    events.push(ev('lineup', s, { team: 'home', lineup: HOME, isInitial: true }))
    events.push(ev('lineup', s, { team: 'away', lineup: { ...AWAY, I: 10 + s * 10 } , isInitial: true }))
    events.push(ev('point', s, { team: 'home' }))
  }
  events.push(ev('timeout', 2, { team: 'away' }))
  const sets = [
    { id: 1, matchId: 1, index: 1, homePoints: 25, awayPoints: 21, finished: true, startTime: '2026-11-20T18:00:00Z', endTime: '2026-11-20T18:24:00Z' },
    { id: 2, matchId: 1, index: 2, homePoints: 1, awayPoints: 0, finished: false, startTime: '2026-11-20T18:27:00Z' }
  ]
  return {
    match: { id: 1, status: 'live', bestOf, coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true, coinTossServeB: false, homeShortName: 'HOM', awayShortName: 'AWY' },
    homeTeam: { id: 1, name: 'Home Team' },
    awayTeam: { id: 2, name: 'Away Team' },
    homePlayers: [1, 2, 3, 4, 5, 6].map(n => ({ number: n, firstName: 'H', lastName: `${n}` })),
    awayPlayers: [11, 12, 13, 14, 15, 16, 20, 30].map(n => ({ number: n, firstName: 'A', lastName: `${n}` })),
    sets,
    set: sets[1],
    events
  }
}

const row = async () => screen.findByTestId('set-preview-row')

describe('SetPreviewModal', () => {
  beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterAll(() => vi.restoreAllMocks())
  afterEach(cleanup)

  it('opens on the set in play, with a tab for every set so far', async () => {
    render(<SetPreviewModal data={scoreboardData()} onClose={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: 'Set preview' })
    const tabs = within(dialog).getByRole('radiogroup', { name: 'Sets' })
    expect(within(tabs).getAllByRole('radio').map(r => r.textContent)).toEqual(['Set 1', 'Set 2'])
    expect(within(tabs).getByRole('radio', { name: 'Set 2' })).toHaveAttribute('aria-checked', 'true')
    expect((await row()).getAttribute('data-set-index')).toBe('2')
    // set 2's own starting line-up (away I = 30), read only: nothing to type or press in the drawing
    expect(screen.getByTestId('set-box').textContent).toContain('IIIIIIIVVVI301213141516')
    expect(within(screen.getByTestId('set-preview')).queryAllByRole('button')).toHaveLength(0)
  })

  it('the tabs switch sets; the deciding set is drawn as set 5 (SetFive)', async () => {
    const data = scoreboardData()
    data.sets.push({ id: 5, matchId: 1, index: 5, homePoints: 0, awayPoints: 0, finished: false })
    data.match.set5LeftTeam = 'A'
    render(<SetPreviewModal data={data} onClose={() => {}} />)
    await row()
    fireEvent.click(screen.getByRole('radio', { name: 'Set 1' }))
    expect((await row()).getAttribute('data-set-index')).toBe('1')
    expect(screen.getByTestId('set-box').textContent).toContain('IIIIIIIVVVI201213141516')
    fireEvent.click(screen.getByRole('radio', { name: 'Set 5' }))
    expect((await row()).getAttribute('data-set-index')).toBe('5')
    expect(screen.getByTestId('set5-box')).toBeInTheDocument()
    expect(screen.queryByTestId('set-box')).toBeNull()
  })

  it('a best-of-3 names its deciding set "Set 3"', async () => {
    const data = scoreboardData({ bestOf: 3 })
    data.sets.push({ id: 5, matchId: 1, index: 5, homePoints: 0, awayPoints: 0, finished: false })
    render(<SetPreviewModal data={data} onClose={() => {}} />)
    await row()
    expect(screen.getAllByRole('radio').map(r => r.textContent)).toEqual(['Set 1', 'Set 2', 'Set 3'])
  })

  it('updates live with the scoreboard\'s data, and follows the set in play until a set is picked', async () => {
    const data = scoreboardData()
    const { rerender } = render(<SetPreviewModal data={data} onClose={() => {}} />)
    await row()
    const blocks = () => screen.getAllByTestId('timeout-block').map(b => b.textContent)
    // the away time-out at 0:1 (its own score first), on the left in set 2
    expect(blocks()[0]).toContain('0:1')
    expect(blocks()[1]).not.toMatch(/\d:\d/)
    const next = { ...data, events: [...data.events, ev('point', 2, { team: 'home' }), ev('timeout', 2, { team: 'home' })] }
    rerender(<SetPreviewModal data={next} onClose={() => {}} />)
    expect(blocks()[1]).toContain('2:0')
    // set 3 starts: the preview moves on with it
    const set3 = { id: 3, matchId: 1, index: 3, homePoints: 0, awayPoints: 0, finished: false }
    const sets = [data.sets[0], { ...data.sets[1], homePoints: 25, awayPoints: 20, finished: true }, set3]
    rerender(<SetPreviewModal data={{ ...next, sets, set: set3 }} onClose={() => {}} />)
    expect((await row()).getAttribute('data-set-index')).toBe('3')
    // a picked set stays when the next set starts
    fireEvent.click(screen.getByRole('radio', { name: 'Set 1' }))
    const set4 = { id: 4, matchId: 1, index: 4, homePoints: 0, awayPoints: 0, finished: false }
    rerender(<SetPreviewModal data={{ ...next, sets: [...sets.slice(0, 2), { ...set3, finished: true }, set4], set: set4 }} onClose={() => {}} />)
    expect((await row()).getAttribute('data-set-index')).toBe('1')
  })

  it('zooms with the buttons and fits again; Close and Escape close it', async () => {
    const onClose = vi.fn()
    render(<SetPreviewModal data={scoreboardData()} onClose={onClose} />)
    await row()
    const scale = () => Number(screen.getByTestId('set-preview').getAttribute('data-scale'))
    // jsdom has no layout: fitted = 1
    expect(scale()).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(scale()).toBe(1.25)
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    expect(scale()).toBe(0.75)
    fireEvent.click(screen.getByTestId('set-preview-fit'))
    expect(scale()).toBe(1)
    fireEvent.click(screen.getByTestId('set-preview-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('previewSetIndices / currentPreviewSet: sets by index once each, set 1 before any; the set in play, else the last', () => {
    expect(previewSetIndices(undefined)).toEqual([1])
    expect(previewSetIndices([{ index: 2 }, { index: 1 }, { index: 2 }, { index: 9 }, null])).toEqual([1, 2])
    expect(currentPreviewSet({ sets: [{ index: 1 }, { index: 2 }], set: { index: 1 } })).toBe(1)
    expect(currentPreviewSet({ sets: [{ index: 1 }, { index: 2 }], set: null })).toBe(2)
  })
})

describe('the Match menu row', () => {
  afterEach(cleanup)
  const enT = (key, fallback) => {
    const v = key.split('.').reduce((o, k) => (o == null ? o : o[k]), en)
    return typeof v === 'string' ? v : fallback
  }

  it('sits in Match info right after the remarks, with its icon', () => {
    const sections = matchMenuSections(k => k, { showActionLog: () => {}, openRemarks: () => {}, showSetPreview: () => {}, openMatchSetup: () => {} })
    const info = sections.find(s => s.key === 'info')
    expect(info.items.map(i => i.key)).toEqual(['action-log', 'remarks', 'set-preview', 'match-setup'])
    const item = info.items.find(i => i.key === 'set-preview')
    expect(item.label).toBe('setPreview.menu')
    expect(item.Icon).toBeTruthy()
    // no handler, no row
    expect(matchMenuSections(k => k, { openRemarks: () => {} }).find(s => s.key === 'info').items.map(i => i.key)).toEqual(['remarks'])
  })

  it('"Set preview" opens the preview', async () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <MenuList buttonLabel="Match" menuTitle="Match" columns={2} sections={toMenuListSections(matchMenuSections(enT, { showSetPreview: () => setOpen(true) }))} />
          {open && <SetPreviewModal data={scoreboardData()} onClose={() => setOpen(false)} />}
        </>
      )
    }
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: /Match/ }))
    fireEvent.click(within(screen.getByRole('menu', { name: 'Match' })).getByRole('menuitem', { name: 'Set preview' }))
    expect(screen.getByRole('dialog', { name: 'Set preview' })).toBeInTheDocument()
    expect(await screen.findByTestId('set-preview-row')).toBeInTheDocument()
  })

  it('has its texts in all five languages', () => {
    for (const [lng, dict] of Object.entries({ en, de, 'de-CH': deCH, fr, it: it_ })) {
      for (const key of ['menu', 'title', 'description', 'sets', 'setTab', 'zoomOut', 'zoomIn', 'fit', 'loading']) {
        expect(typeof dict.setPreview?.[key], `${lng}: setPreview.${key}`).toBe('string')
      }
      expect(dict.setPreview.setTab, lng).toContain('{{n}}')
    }
  })

  // Scoreboard is too large to render in a unit test: the wiring is checked in its source
  it('Scoreboard: the menu action, and the dialog after the corrections dialog (tablet and phone menus share the rows)', () => {
    const sb = readFileSync(resolve(__dirname, '../Scoreboard.jsx'), 'utf8')
    expect(sb).toContain('showSetPreview: () => setShowSetPreview(true),')
    const manual = sb.indexOf('{/* Manual Changes Modal */}')
    const mount = sb.indexOf('{showSetPreview && (')
    const goBack = sb.indexOf("{/* Go back: the rules' going back in one place (Match menu) */}")
    expect(manual).toBeGreaterThan(-1)
    expect(mount).toBeGreaterThan(manual)
    expect(goBack).toBeGreaterThan(mount)
    expect(sb.slice(mount, goBack)).toContain('<SetPreviewModal data={data} onClose={() => setShowSetPreview(false)} />')
    // the phone layout's menu (the action sheet) draws the same sections
    const sheet = sb.slice(sb.indexOf('{menuModal && ('))
    expect(sheet.slice(0, 600)).toContain('{matchMenu.map(section => (')
  })
})
