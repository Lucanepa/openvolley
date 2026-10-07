import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import PlayerDisc from '../referee/PlayerDisc.jsx'
import DraggedPlayerOverlay from '../DraggedPlayerOverlay.jsx'
import { liberoColour, readableTextOn, discRing, TEXT_DARK, TEXT_LIGHT } from '../../utils/teamColours'

// jsdom normalises inline colours to rgb()
const rgb = (hex) => {
  const h = hex.replace('#', '')
  return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`
}

let bundle = null
vi.mock('../../utils/serverDataSync', () => ({ getMatchData: vi.fn(async () => bundle) }))
vi.mock('../../hooks/useRealtimeConnection', () => ({ useRealtimeConnection: () => ({}) }))
vi.mock('../../db/db', () => ({ db: { matches: { get: vi.fn(async () => null), update: vi.fn(async () => 0) } } }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k, d, o) => (typeof d === 'string' ? d : (o?.defaultValue || k)), i18n: { language: 'en' } }) }))

const { default: MatchEntry } = await import('../MatchEntry.jsx')

const disc = { number: 7, position: 'III', capPx: 90, side: 'left' }

describe('referee PlayerDisc colours', () => {
  it('wears the given fill and number colour, with the outline and ring when given', () => {
    const { container } = render(<PlayerDisc {...disc} background="#ffffff" color={TEXT_DARK} ring="#82817f" textShadow="0 0 1px #000" />)
    const el = container.querySelector('[data-player-disc]')
    expect(el.style.background).toBe(rgb('#ffffff'))
    expect(el.style.color).toBe(rgb(TEXT_DARK))
    expect(el.style.border).toBe(`2px solid ${rgb('#82817f')}`)
    expect(container.querySelector('[data-disc-number]').style.textShadow).toBe('0 0 1px #000')
  })

  it('keeps the hairline edge without a ring and the orange ring while flashing', () => {
    const plain = render(<PlayerDisc {...disc} background="#e2001a" color={TEXT_LIGHT} />).container.querySelector('[data-player-disc]')
    expect(plain.style.border).toBe('1px solid var(--border)')
    const flash = render(<PlayerDisc {...disc} background="#fdba74" color="#000" ring="#82817f" flash />).container.querySelector('[data-player-disc]')
    expect(flash.style.border).toBe(`3px solid ${rgb('#f97316')}`)
  })

  it('turns the blue libero mark dark on a blue shirt', () => {
    const onRed = render(<PlayerDisc {...disc} background="#e2001a" color={TEXT_LIGHT} liberoLabel="L" />).container
    expect(onRed.querySelector('[data-disc-badge="libero"]').style.background).toBe(rgb('#3b82f6'))
    const onBlue = render(<PlayerDisc {...disc} background="#3b82f6" color={TEXT_DARK} liberoLabel="L" />).container
    expect(onBlue.querySelector('[data-disc-badge="libero"]').style.background).toBe(rgb('#0f172a'))
  })
})

describe('drag overlay', () => {
  it('uses the disc paint and shows the dragged number', () => {
    render(<DraggedPlayerOverlay player={{ playerNumber: 12, isLibero: false }} position={{ x: 100, y: 100 }} colors={{ bg: '#ffffff', text: TEXT_DARK, ring: '#82817f' }} />)
    const el = [...document.body.querySelectorAll('div')].find(d => d.textContent === '12')
    expect(el.style.background).toBe(rgb('#ffffff'))
    expect(el.style.color).toBe(rgb(TEXT_DARK))
    expect(el.style.border).toBe(`3px solid ${rgb('#82817f')}`)
  })

  it('outlines the number only, and turns the L mark dark on a blue libero shirt', () => {
    const outline = '-1px 0 rgba(28, 25, 23, 0.85)'
    const { unmount } = render(<DraggedPlayerOverlay player={{ playerNumber: 5, isLibero: true }} position={{ x: 100, y: 100 }} colors={{ bg: '#1d4ed8', text: TEXT_LIGHT, textShadow: outline }} />)
    const el = [...document.body.querySelectorAll('div')].find(d => d.textContent === '5L')
    expect(el.style.textShadow).toContain('rgba(28, 25, 23, 0.85)')
    const mark = el.querySelector('span')
    expect(mark.style.background).toBe(rgb('#0f172a'))
    expect(mark.style.textShadow).toBe('none')
    unmount()
    render(<DraggedPlayerOverlay player={{ playerNumber: 6, isLibero: true }} position={{ x: 100, y: 100 }} colors={{ bg: '#1c1917', text: TEXT_LIGHT }} />)
    const onBlack = [...document.body.querySelectorAll('div')].find(d => d.textContent === '6L')
    expect(onBlack.querySelector('span').style.background).toBe(rgb('#3b82f6'))
  })
})

function benchBundle(homeColor, awayColor) {
  const players = (list) => list.map(([number, extra]) => ({ number, firstName: 'A', lastName: `P${number}`, ...(extra || {}) }))
  return {
    success: true,
    match: { id: 'm1', status: 'live', coinTossTeamA: 'home', coinTossTeamB: 'away', firstServe: 'home', bestOf: 5 },
    homeTeam: { name: 'Home', color: homeColor },
    awayTeam: { name: 'Away', color: awayColor },
    homePlayers: players([[1], [10, { isCaptain: true }], [88], [14], [99], [12], [7, { libero: 'libero1' }]]),
    awayPlayers: players([[2], [11], [55], [66], [98], [13]]),
    sets: [{ index: 1, homePoints: 3, awayPoints: 2, finished: false }],
    events: [
      { type: 'lineup', setIndex: 1, ts: 1, payload: { team: 'home', lineup: { I: 10, II: 88, III: 7, IV: 99, V: 12, VI: 1 } } },
      { type: 'lineup', setIndex: 1, ts: 1, payload: { team: 'away', lineup: { I: 2, II: 11, III: 55, IV: 66, V: 98, VI: 13 } } }
    ]
  }
}

async function benchDiscs() {
  const { container } = render(<MatchEntry matchId="m1" team="home" onBack={() => {}} embedded />)
  await waitFor(() => expect(container.querySelectorAll('.court-player').length).toBe(6))
  const byNumber = {}
  for (const el of container.querySelectorAll('.court-player')) {
    const n = [...el.childNodes].filter(c => c.nodeType === 3).map(c => c.textContent).join('').trim()
    byNumber[n] = el
  }
  return byNumber
}

describe('bench tablet court discs', () => {
  beforeEach(() => { bundle = null })

  it('wear the team colour with a readable number and a contrasting libero', async () => {
    bundle = benchBundle('#e2001a', '#3b82f6')
    const d = await benchDiscs()
    for (const n of ['10', '88', '99', '12', '1']) {
      expect(d[n].style.background, n).toBe(rgb('#e2001a'))
      expect(d[n].style.color, n).toBe(rgb(readableTextOn('#e2001a')))
    }
    const lib = liberoColour('#e2001a', '#3b82f6')
    expect(d['7'].style.background).toBe(rgb(lib))
    expect(d['7'].style.color).toBe(rgb(readableTextOn(lib)))
    expect(lib).not.toBe('#e2001a')
  })

  it('white shirts get dark numbers and a ring on the light court; the libero is not white', async () => {
    bundle = benchBundle('#ffffff', '#1c1917')
    const d = await benchDiscs()
    expect(d['10'].style.background).toBe(rgb('#ffffff'))
    expect(d['10'].style.color).toBe(rgb(TEXT_DARK))
    expect(d['10'].style.borderColor).toBe(rgb(discRing('#ffffff')))
    expect(d['7'].style.background).not.toBe(rgb('#ffffff'))
    expect(d['7'].style.background).not.toBe(rgb('#1c1917'))
  })

  it('keeps the neutral look without a team colour (cream libero)', async () => {
    bundle = benchBundle(undefined, undefined)
    const d = await benchDiscs()
    expect(d['10'].style.background).toBe('')
    expect(d['7'].style.background).toBe(rgb('#fff8e7'))
  })
})
