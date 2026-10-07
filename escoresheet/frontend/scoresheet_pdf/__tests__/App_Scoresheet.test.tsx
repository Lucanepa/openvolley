import React from 'react'
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { render } from '@testing-library/react'
import App from '../App_Scoresheet'
import { LiberoControlSheet } from '../components/LiberoControlSheet'
import { Results } from '../components/FooterSection'

// Fixture: best-of-3, Team A = home. Set 1 finished 25:20 with a rotation, an open
// substitution (5 -> 9) and an exceptional one; set 2 finished; deciding set (index 5) started.
let seq = 0
const ev = (type: string, setIndex: number, payload: Record<string, unknown>) => ({
  type, setIndex, seq: ++seq, ts: new Date(Date.UTC(2026, 9, 5, 18, 0, seq)).toISOString(), payload
})
const HOME_START = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 }
const AWAY_START = { I: 11, II: 12, III: 13, IV: 14, V: 15, VI: 16 }

function buildMatch() {
  seq = 0
  const events: any[] = []
  for (const setIndex of [1, 2, 5]) {
    events.push(ev('lineup', setIndex, { team: 'home', lineup: HOME_START, isInitial: true }))
    events.push(ev('lineup', setIndex, { team: 'away', lineup: AWAY_START, isInitial: true }))
  }
  // Set 1
  events.push(ev('point', 1, { team: 'away' }))
  events.push(ev('lineup', 1, { team: 'away', lineup: { I: 12, II: 13, III: 14, IV: 15, V: 16, VI: 11 } }))
  events.push(ev('point', 1, { team: 'home' }))
  events.push(ev('lineup', 1, { team: 'home', lineup: { I: 2, II: 3, III: 4, IV: 5, V: 6, VI: 1 } }))
  events.push(ev('substitution', 1, { team: 'home', playerOut: 5, playerIn: 9, position: 'IV' }))
  events.push(ev('lineup', 1, { team: 'home', lineup: { I: 2, II: 3, III: 4, IV: 9, V: 6, VI: 1 }, fromSubstitution: true }))
  events.push(ev('substitution', 1, { team: 'home', playerOut: 3, playerIn: 17, position: 'II', isExceptional: true }))
  events.push(ev('sanction', 1, { team: 'away', type: 'warning', playerNumber: 14 }))
  // Deciding set: a sanction recorded there must print as set 3
  events.push(ev('point', 5, { team: 'home' }))
  events.push(ev('sanction', 5, { team: 'away', type: 'warning', playerNumber: 16 }))

  return {
    match: {
      id: 'm1', status: 'live', bestOf: 3,
      coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true, coinTossServeB: false,
      set5LeftTeam: 'A', set5FirstServe: 'A',
      homeShortName: 'HOM', awayShortName: 'AWY'
    },
    homeTeam: { name: 'Home Team' },
    awayTeam: { name: 'Away Team' },
    homePlayers: [1, 2, 3, 4, 5, 6, 9, 17].map(n => ({ number: n, firstName: 'H', lastName: `${n}` })),
    awayPlayers: [11, 12, 13, 14, 15, 16].map(n => ({ number: n, firstName: 'A', lastName: `${n}` })),
    sets: [
      { index: 1, homePoints: 25, awayPoints: 20, finished: true, startTime: '2026-10-05T18:00:00Z', endTime: '2026-10-05T18:25:00Z' },
      { index: 2, homePoints: 20, awayPoints: 25, finished: true, startTime: '2026-10-05T18:30:00Z', endTime: '2026-10-05T18:55:00Z' },
      { index: 5, homePoints: 1, awayPoints: 0, finished: false, startTime: '2026-10-05T19:00:00Z' }
    ],
    events
  }
}

describe('App_Scoresheet', () => {
  beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterAll(() => vi.restoreAllMocks())

  // Assertions run on the flattened sheet text, sliced between section headings.
  const between = (text: string, from: string, to: string) => {
    const i = text.indexOf(from)
    const j = text.indexOf(to, i + from.length)
    expect(i).toBeGreaterThanOrEqual(0)
    expect(j).toBeGreaterThan(i)
    return text.slice(i, j)
  }

  it('prints starting lineups, open substitutions, decider set number and results from the event log', () => {
    const { container } = render(<App matchData={buildMatch()} autoAction="preview" />)
    const text = container.querySelector('.scoresheet-container')?.textContent || ''

    const set1 = between(text, 'SET1', 'SET2')
    // Starting players row = initial lineups, not the rotated/substituted ones (2 3 4 9 6 1 / 12 ... 11)
    expect(set1).toContain('IIIIIIIVVVI123456')
    expect(set1).toContain('IIIIIIIVVVI111213141516')
    expect(set1).not.toContain('IIIIIIIVVVI234961')
    // Open substitution 5 -> 9 at 1:1 drawn under position V (starter 5); columns I-IV and VI
    // stay empty ("::" each), so the exceptional 3 -> 17 is not drawn either
    expect(set1).toContain('IIIIIIIVVVI123456::::::::91:1:::')

    // Sanctions: set-1 warning and the deciding-set warning printed as set 3 (never 5)
    const sanctions = between(text, 'SANCTIONS', 'REMARKS')
    expect(sanctions).toContain('14B11:1')
    expect(sanctions).toContain('16B30:1')
    expect(sanctions).not.toContain('16B5')

    // RESULT table: Team A set 1 = T0 S2 W1 P25 (S counts the exceptional substitution
    // too, field-spec 9 / SC p.71: "4 standard + 1 exceptional" = 5)
    const results = between(text, 'RESULT', 'Start')
    expect(results).toContain('02125')

    // Match not finished: final RESULT box stays empty instead of a live "1:1"
    expect(text).toContain('WINNERRESULTAHOM')
  })

  it('prints a pre-rally line-up rectification (FIVB 7.3.4) and the later substitution of the rectified-in player', () => {
    const data = buildMatch()
    // Set 2: before the first rally, home rectifies position I from 1 to 17 (LineupModal mode 'manual');
    // after a point, 17 is substituted by 9.
    data.events.push(ev('lineup', 2, { team: 'home', lineup: { ...HOME_START, I: 17 }, isInitial: false }))
    data.events.push(ev('point', 2, { team: 'away' }))
    data.events.push(ev('substitution', 2, { team: 'home', playerOut: 17, playerIn: 9, position: 'I' }))
    data.events.push(ev('lineup', 2, { team: 'home', lineup: { ...HOME_START, I: 9 }, fromSubstitution: true }))
    const { container } = render(<App matchData={data} autoAction="preview" />)
    const text = container.querySelector('.scoresheet-container')?.textContent || ''

    const set2 = between(text, 'SET2', 'SET3')
    expect(set2).toContain('IIIIIIIVVVI1723456')
    expect(set2).not.toContain('IIIIIIIVVVI123456')
    // 17 -> 9 at 0:1 drawn in column I (first column right after the starting row)
    expect(set2).toMatch(/IIIIIIIVVVI17234569/)
  })
})

describe('LiberoControlSheet', () => {
  const lcsData = {
    teamALiberos: [{ number: 7, type: 'libero1' }],
    teamBLiberos: [{ number: 10, type: 'libero1' }],
    sets: [1, 2, 3, 4, 5].map(setNumber => ({ setNumber, teamAReplacements: [], teamBReplacements: [], teamAReplacements_After: [], teamBReplacements_After: [] })),
    redesignations: [
      { team: 'A' as const, outNumber: 7, inNumber: 3, setNumber: 2, score: '4:6' },
      { team: 'A' as const, outNumber: 3, inNumber: 9, setNumber: 5, score: '10:12' }
    ]
  }

  it('best-of-3: prints sets 1, 2, 3 (deciding set relabelled) and every redesignation', () => {
    const { container } = render(
      <LiberoControlSheet match={{ bestOf: 3 }} teamAName="Home" teamBName="Away" teamAKey="home" lcsData={lcsData} bestOf={3} />
    )
    const text = container.textContent || ''
    expect(text).toContain('SET 1')
    expect(text).toContain('SET 2')
    expect(text).toContain('SET 3')
    expect(text).not.toContain('SET 4')
    expect(text).not.toContain('SET 5')
    // first redesignation in team A's slot, the second (deciding set = set 3) in the remarks line
    expect(text).toContain('7/3')
    expect(text).toContain('Re-designation team A: 3/9, Set 3, Points 10 : 12')
  })

  it('best-of-5: prints sets 1-5', () => {
    const { container } = render(
      <LiberoControlSheet teamAName="Home" teamBName="Away" teamAKey="home" lcsData={lcsData} bestOf={5} />
    )
    const text = container.textContent || ''
    for (const n of [1, 2, 3, 4, 5]) expect(text).toContain(`SET ${n}`)
    expect(text).toContain('Set 5, Points 10 : 12')
  })
})

describe('Results', () => {
  const setResults = [
    { setNumber: 1, teamATimeouts: 0, teamASubstitutions: 0, teamAWon: 1, teamAPoints: 25, teamBTimeouts: 0, teamBSubstitutions: 0, teamBWon: 0, teamBPoints: 20, duration: '' },
    { setNumber: 2, teamATimeouts: 0, teamASubstitutions: 0, teamAWon: 1, teamAPoints: 25, teamBTimeouts: 0, teamBSubstitutions: 0, teamBWon: 0, teamBPoints: 18, duration: '' }
  ] as any
  const resultBox = (container: HTMLElement) => {
    const label = Array.from(container.querySelectorAll('span')).find(el => el.textContent === 'RESULT' && el.className.includes('absolute'))
    return label?.parentElement?.textContent?.replace('RESULT', '') || ''
  }

  it('keeps the live set count by default (MatchEntry view)', () => {
    const { container } = render(<Results setResults={setResults} bestOf={3} />)
    expect(resultBox(container)).toBe('2:0')
  })

  it('stays blank on the official sheet until the match is finished', () => {
    const { container } = render(<Results setResults={setResults} bestOf={3} blankResultUntilFinished />)
    expect(resultBox(container)).toBe('')
  })

  it('prints the final result when given', () => {
    const { container } = render(<Results setResults={setResults} bestOf={3} result="2-0" blankResultUntilFinished />)
    expect(resultBox(container)).toBe('2:0')
  })
})
