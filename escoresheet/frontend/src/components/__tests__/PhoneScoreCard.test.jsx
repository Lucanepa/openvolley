// The phone layout's score cards (PhoneScoreboard): the team, the SERVE pill
// and the sets won stand beside the score. At 360px a card has 138px inside,
// and a two-digit score at 52px took 72 of them: "Gewonnene Sätze: 0" ran
// 61px into the score, "AUFSCHLAG" 33px, "Sets gagnés : 0" 30px, even
// "Sets won: 0" 7px (and German still 35px at 412). The score is now a touch
// smaller on a narrow phone, the pill tighter, the sets won shorter, and the
// info column clips what still does not fit rather than run into the score.
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '../../i18n'
import PhoneScoreboard from '../scoreboard/PhoneScoreboard.jsx'

afterEach(() => cleanup())

const team = (side, label) => ({
  side, teamKey: side === 'left' ? 'home' : 'away', label, name: `${label} team`, shortName: label, color: side === 'left' ? '#dc2626' : '#2563eb',
  setsWon: 2, points: 22, timeouts: 0, subs: 0, lineupSet: true, court: [], liberos: [], benchPlayers: [], officials: [],
  improperRequestDone: false, delayWarned: false, needsRedesignation: false
})
const props = {
  setNumber: 5, teams: { left: team('left', 'A'), right: team('right', 'B') }, serving: 'left',
  rally: { status: 'idle', isFirstRally: false, startDisabled: false, canReplayRally: false, isRallyReplayed: false },
  centre: null, recent: [], canUndo: false, actions: new Proxy({}, { get: () => () => {} })
}

describe('PhoneScoreboard: the score cards on a narrow phone', () => {
  it('the score gets smaller with the phone, down to 40px', async () => {
    // (jsdom drops container units from a style, so the source is read)
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(__dirname, '../scoreboard/PhoneScoreboard.jsx'), 'utf8')
    expect(src).toMatch(/data-testid=\{`phone-score-\$\{team\.side\}`\} style=\{\{ flex: 'none', fontSize: 'clamp\(40px, 12cqw, 52px\)'/)
  })

  it('the info column clips rather than running into the score', () => {
    render(<PhoneScoreboard {...props} />)
    const info = screen.getByTestId('phone-score-left').previousElementSibling
    expect(info.style.overflow).toBe('hidden')
    expect(info.style.minWidth).toBe('0px')
    for (const line of info.children) {
      expect(line.style.maxWidth).toBe('100%')
      expect(line.style.textOverflow).toBe('ellipsis')
    }
  })

  it('the sets won fit beside a two-digit score at 360px, in every locale', async () => {
    // about 79px left at 11px semibold: "Sets won: 0" is the longest that fits
    for (const lang of ['en', 'de', 'de-CH', 'fr', 'it']) {
      const { default: locale } = await import(`../../i18n/locales/${lang}.json`)
      const text = locale.scoreboard.phone.setsWon.replace('{{count}}', '0')
      expect(text.length, `${lang}: ${text}`).toBeLessThanOrEqual(11)
    }
  })
})
