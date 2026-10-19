import { describe, it, expect } from 'vitest'
import {
  shirtNumber, defaultShortName, easyLiberoNumbers, easyLiberoErrors, EASY_LIBERO_ERRORS,
  easyRosterChanges, liberoSlotEditable, newPlayerMayEnter, newPlayerError, NEW_PLAYER_ERRORS,
  easyMatchPrefill, playedAsPlayer, liberoUsed, easyLiberosLocked, easyReferencedNumbers, isEasyStray
} from '../easyMatch'
import { lineupEntryErrors, LINEUP_ERRORS } from '../lineupEntry'

const at = (values) => values.map(v => (v == null ? '' : String(v)))
const P = (id, number, extra = {}) => ({ id, teamId: 7, number, libero: '', isCaptain: false, ...extra })
const lineupEvent = (team, numbers, setIndex = 1) => ({
  type: 'lineup',
  setIndex,
  payload: { team, lineup: Object.fromEntries(['I', 'II', 'III', 'IV', 'V', 'VI'].map((pos, i) => [pos, numbers[i]])) }
})
const sub = (team, playerOut, playerIn, setIndex = 1) => ({ type: 'substitution', setIndex, payload: { team, playerOut, playerIn } })

describe('shirtNumber', () => {
  it('takes 1 to 99, typed or as a number', () => {
    expect(shirtNumber('7')).toBe(7)
    expect(shirtNumber(' 07 ')).toBe(7)
    expect(shirtNumber(99)).toBe(99)
  })
  it('refuses 0, 100, blanks and anything else', () => {
    for (const v of ['0', '100', '', null, undefined, '4a', '-3', '1.5']) expect(shirtNumber(v)).toBe(null)
  })
})

describe('defaultShortName', () => {
  it('works like Match Setup', () => {
    expect(defaultShortName('VBC Zürich')).toBe('VBC')
    expect(defaultShortName('Wiedikon')).toBe('WIED')
    expect(defaultShortName('')).toBe('')
  })
})

describe('lineupEntryErrors with allowUnknown (easy match)', () => {
  it('accepts numbers that are no player yet', () => {
    expect(lineupEntryErrors({ lineup: at([4, 3, 2, 6, 7, 9]), players: [], allowUnknown: true, requireAll: true })).toEqual({})
  })
  it('still flags duplicates, blanks and an impossible number', () => {
    const errors = lineupEntryErrors({ lineup: at([4, 4, '', 6, 7, 100]), players: [], allowUnknown: true, requireAll: true })
    expect(errors).toEqual({ 0: LINEUP_ERRORS.duplicate, 1: LINEUP_ERRORS.duplicate, 2: LINEUP_ERRORS.required, 5: LINEUP_ERRORS.invalidNumber })
  })
  it('still refuses a named libero in the six', () => {
    const errors = lineupEntryErrors({ lineup: at([4, 3, 2, 6, 7, 12]), players: [P(1, 12, { libero: 'libero1' })], allowUnknown: true })
    expect(errors).toEqual({ 5: LINEUP_ERRORS.libero })
  })
  it('without allowUnknown nothing changes: not on roster', () => {
    expect(lineupEntryErrors({ lineup: at([4, 3, 2, 6, 7, 9]), players: [] })[0]).toBe(LINEUP_ERRORS.notOnRoster)
  })
})

describe('easy liberos', () => {
  it('reads the named liberos by slot', () => {
    expect(easyLiberoNumbers([P(1, 5, { libero: 'libero2' }), P(2, 3)])).toEqual(['', '5'])
  })

  it('flags a bad number, a duplicate and a libero that is in the six', () => {
    const lineup = at([1, 2, 3, 4, 5, 6])
    expect(easyLiberoErrors({ liberos: ['0', ''], lineup, team: 'home' })).toEqual({ 0: EASY_LIBERO_ERRORS.invalid })
    expect(easyLiberoErrors({ liberos: ['9', '9'], lineup, team: 'home' })).toEqual({ 0: EASY_LIBERO_ERRORS.duplicate, 1: EASY_LIBERO_ERRORS.duplicate })
    expect(easyLiberoErrors({ liberos: ['3', ''], lineup, team: 'home' })).toEqual({ 0: EASY_LIBERO_ERRORS.inLineup })
  })

  it('refuses as libero a number that already played as a player', () => {
    const events = [lineupEvent('home', [1, 2, 3, 4, 5, 6])]
    const lineup = at([1, 2, 3, 4, 5, 8]) // set 2: 6 no longer in the six
    expect(easyLiberoErrors({ liberos: ['6', ''], lineup, events, team: 'home' })).toEqual({ 0: EASY_LIBERO_ERRORS.played })
    expect(easyLiberoErrors({ liberos: ['6', ''], lineup, events, team: 'away' })).toEqual({})
  })

  it('a libero box can change until that libero did something', () => {
    const players = [P(1, 12, { libero: 'libero1' })]
    expect(liberoSlotEditable({ players, events: [], team: 'home', slot: 'libero1' })).toBe(true)
    const entered = [{ type: 'libero_entry', payload: { team: 'home', playerOut: 4, liberoIn: 12 } }]
    expect(liberoUsed(entered, 'home', 12)).toBe(true)
    expect(liberoSlotEditable({ players, events: entered, team: 'home', slot: 'libero1' })).toBe(false)
    expect(liberoSlotEditable({ players, events: entered, team: 'home', slot: 'libero2' })).toBe(true)
  })
})

describe('easyRosterChanges', () => {
  const now = '2026-10-19T12:00:00.000Z'

  it('adds every line-up number that is no player yet, once', () => {
    const players = [P(1, 4)]
    const { add, update, remove } = easyRosterChanges({ teamId: 7, team: 'home', players, lineup: at([4, 3, 2, 6, 7, 9]), now })
    expect(add.map(p => p.number)).toEqual([3, 2, 6, 7, 9])
    expect(add[0]).toMatchObject({ teamId: 7, libero: '', easy: true, test: true, isCaptain: false, createdAt: now })
    expect(update).toEqual([])
    expect(remove).toEqual([])
  })

  it('names liberos: a new number is added with its slot', () => {
    const { add } = easyRosterChanges({ teamId: 7, team: 'home', players: [], lineup: at([1, 2, 3, 4, 5, 6]), liberos: ['12', '15'], now })
    expect(add.filter(p => p.libero).map(p => [p.number, p.libero])).toEqual([[12, 'libero1'], [15, 'libero2']])
  })

  it('a libero box left as it was changes nothing', () => {
    const players = [P(1, 12, { libero: 'libero1' }), ...[1, 2, 3, 4, 5, 6].map((n, i) => P(10 + i, n))]
    expect(easyRosterChanges({ teamId: 7, team: 'home', players, lineup: at([1, 2, 3, 4, 5, 6]), liberos: ['12', ''], now }))
      .toEqual({ add: [], update: [], remove: [] })
  })

  it('a mistyped libero that did nothing is replaced (the typo removed)', () => {
    const players = [P(1, 21, { libero: 'libero1', easy: true })]
    const { add, remove } = easyRosterChanges({ teamId: 7, team: 'home', players, lineup: at([1, 2, 3, 4, 5, 6]), liberos: ['12', ''], now })
    expect(remove).toEqual([1])
    expect(add.find(p => p.number === 12)).toMatchObject({ libero: 'libero1' })
  })

  it('emptying a libero box unnames that libero', () => {
    const players = [P(1, 21, { libero: 'libero2', easy: true })]
    const { remove, add } = easyRosterChanges({ teamId: 7, team: 'home', players, lineup: at([1, 2, 3, 4, 5, 6]), liberos: ['', ''], now })
    expect(remove).toEqual([1])
    expect(add.some(p => p.libero)).toBe(false)
  })

  it('a libero who already played stays (its box is read-only)', () => {
    const players = [P(1, 12, { libero: 'libero1' })]
    const events = [{ type: 'libero_entry', payload: { team: 'home', playerOut: 4, liberoIn: 12 } }]
    const { add, update, remove } = easyRosterChanges({ teamId: 7, team: 'home', players, events, lineup: at([]), liberos: ['15', ''], now })
    expect([add, update, remove]).toEqual([[], [], []])
  })

  it('an existing bench player who never played can become libero', () => {
    const players = [P(3, 18)]
    const { update, add } = easyRosterChanges({ teamId: 7, team: 'home', players, lineup: at([]), liberos: ['18', ''], now })
    expect(update).toEqual([{ id: 3, changes: { libero: 'libero1' } }])
    expect(add).toEqual([])
  })

  it('swapping the two liberos between the boxes only moves the flags', () => {
    const players = [P(1, 5, { libero: 'libero1', easy: true }), P(2, 8, { libero: 'libero2', easy: true })]
    const { add, update, remove } = easyRosterChanges({ teamId: 7, team: 'home', players, lineup: at([]), liberos: ['8', '5'], now })
    expect(remove).toEqual([])
    expect(add).toEqual([])
    expect(update).toEqual([{ id: 1, changes: { libero: 'libero2' } }, { id: 2, changes: { libero: 'libero1' } }])
  })

  it('moving libero 1 to the second box keeps it, and the old libero 2 goes', () => {
    const players = [P(1, 5, { libero: 'libero1', easy: true }), P(2, 8, { libero: 'libero2', easy: true })]
    const { add, update, remove } = easyRosterChanges({ teamId: 7, team: 'home', players, lineup: at([]), liberos: ['', '5'], now })
    expect(remove).toEqual([2])
    expect(update).toEqual([{ id: 1, changes: { libero: 'libero2' } }])
    expect(add).toEqual([])
  })

  it('a libero declared unable or a re-designation locks the boxes', () => {
    const players = [P(1, 5, { libero: 'unable', easy: true }), P(2, 8, { libero: 'libero2', easy: true })]
    expect(easyLiberosLocked(players)).toBe(true)
    expect(liberoSlotEditable({ players, events: [], team: 'home', slot: 'libero1' })).toBe(false)
    expect(easyRosterChanges({ teamId: 7, team: 'home', players, lineup: at([]), liberos: ['9', ''], now }))
      .toEqual({ add: [], update: [], remove: [] })
  })

  it('a libero_unable event makes that libero used', () => {
    expect(liberoUsed([{ type: 'libero_unable', payload: { team: 'home', liberoNumber: 12 } }], 'home', 12)).toBe(true)
  })

  it('a number no event names any more (a line-up undone) goes with the next line-up', () => {
    // 71 was typed in an undone line-up: its row stayed, no event names it
    const players = [P(1, 71, { easy: true }), P(2, 4, { easy: true }), P(3, 12, { libero: 'libero1', easy: true })]
    const events = [lineupEvent('home', [4, 3, 2, 5, 6, 1])]
    const { remove } = easyRosterChanges({ teamId: 7, team: 'home', players, events, lineup: at([4, 3, 2, 5, 6, 17]), liberos: ['12', ''], now })
    expect(remove).toEqual([1])
  })

  it('strays: only easy, non-libero players that no event names', () => {
    const events = [lineupEvent('home', [1, 2, 3, 4, 5, 6]), sub('home', 4, 9), { type: 'sanction', payload: { team: 'home', playerNumber: 11 } }]
    const referenced = easyReferencedNumbers(events, 'home')
    expect([...referenced].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 9, 11])
    expect(isEasyStray(P(1, 71, { easy: true }), referenced)).toBe(true)
    expect(isEasyStray(P(2, 9, { easy: true }), referenced)).toBe(false)
    expect(isEasyStray(P(3, 71), referenced)).toBe(false) // a roster player
    expect(isEasyStray(P(4, 71, { easy: true, libero: 'libero1' }), referenced)).toBe(false)
  })

  it('playedAsPlayer reads line-ups and substitutions of that team only', () => {
    const events = [lineupEvent('home', [1, 2, 3, 4, 5, 6]), sub('away', 4, 11)]
    expect(playedAsPlayer(events, 'home', 6)).toBe(true)
    expect(playedAsPlayer(events, 'home', 11)).toBe(false)
    expect(playedAsPlayer(events, 'away', 11)).toBe(true)
  })
})

describe('new substitutes', () => {
  it('a new player may replace a starter while substitutions are left', () => {
    expect(newPlayerMayEnter({ substitutions: [], playerOut: 4, regularSubstitutionsUsed: 0 })).toBe(true)
    expect(newPlayerMayEnter({ substitutions: [], playerOut: 4, regularSubstitutionsUsed: 6 })).toBe(false)
  })
  it('not for a player who came in as a substitute (only the replaced one comes back)', () => {
    const substitutions = [sub('home', 4, 9)]
    expect(newPlayerMayEnter({ substitutions, playerOut: 9, regularSubstitutionsUsed: 1 })).toBe(false)
    expect(newPlayerMayEnter({ substitutions, playerOut: 9, regularSubstitutionsUsed: 1, exceptional: true })).toBe(true)
  })
  it('checks the typed number', () => {
    const players = [P(1, 4), P(2, 12, { libero: 'libero1' }), P(3, 8)]
    expect(newPlayerError({ value: '15', players, onCourt: [4, 1, 2, 3, 5, 6] })).toBe(null)
    expect(newPlayerError({ value: '0', players })).toBe(NEW_PLAYER_ERRORS.invalid)
    expect(newPlayerError({ value: '4', players, onCourt: [4] })).toBe(NEW_PLAYER_ERRORS.onCourt)
    expect(newPlayerError({ value: '12', players })).toBe(NEW_PLAYER_ERRORS.libero)
    expect(newPlayerError({ value: '8', players })).toBe('existing')
  })
})

describe('easyMatchPrefill', () => {
  it('is null without ?easy', () => {
    expect(easyMatchPrefill('?home=A')).toBe(null)
    expect(easyMatchPrefill('')).toBe(null)
  })
  it('reads the teams, colours, format and game', () => {
    const p = easyMatchPrefill('?easy=1&home=KSC+Wiedikon&away=VBC%20Z%C3%BCrich&bestOf=3&homeColor=%23DC2626&awayColor=blue&homeShort=kscw&league=3L&game=406201&hall=KWI')
    expect(p).toEqual({
      homeName: 'KSC Wiedikon', awayName: 'VBC Zürich', homeShort: 'KSCW', awayShort: '',
      homeColor: '#dc2626', awayColor: null, bestOf: 3, league: '3L', gameNumber: '406201', hall: 'KWI'
    })
  })
  it('best of 5 unless it says 3', () => {
    expect(easyMatchPrefill('?easy&bestOf=7').bestOf).toBe(5)
  })
})
