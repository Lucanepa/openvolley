import { describe, it, expect } from 'vitest'
import {
  sanctionLabel, sanctionTarget, formatScore, teamLetter, teamLabel, describeEvent,
  scoreBeforeEvent, humanize, remarkText, describeLegacyChange, SANCTION_TYPES, tr, setTimesText
} from '../describe'
import { buildMatch, MATCH, HOME_TEAM, AWAY_TEAM, pointsFor } from './fixtures/correctionsMatch'

const ctx = { match: MATCH, homeTeam: HOME_TEAM, awayTeam: AWAY_TEAM }

describe('sanctionLabel', () => {
  it('names every sanction type in words', () => {
    expect(SANCTION_TYPES.map(s => sanctionLabel(s))).toEqual([
      'Delay warning', 'Delay penalty', 'Improper request', 'Warning', 'Penalty', 'Expulsion', 'Disqualification'
    ])
  })
  it('humanises an unknown type, never showing an underscore', () => {
    expect(sanctionLabel('some_new_type')).toBe('Some new type')
    expect(humanize('IMPROPER_REQUEST')).toBe('Improper request')
  })
  it('uses the translation when there is one', () => {
    const t = (key, opts) => (key === 'corrections.sanction.penalty' ? 'Bestrafung' : opts.defaultValue)
    expect(sanctionLabel('penalty', t)).toBe('Bestrafung')
  })
})

describe('sanctionTarget', () => {
  it.each([
    [{ playerType: 'player', playerNumber: 8 }, 'Player #8', '8'],
    [{ playerType: 'bench', playerNumber: 8 }, 'Player #8 (bench)', '(8)'],
    [{ playerType: 'libero', playerNumber: 4 }, 'Libero #4', '4'],
    [{ playerType: 'official', role: 'Coach' }, 'Coach', 'C'],
    [{ playerType: 'official', role: 'Assistant Coach 1' }, 'Assistant coach 1', 'AC1'],
    [{ playerType: 'official', role: 'Assistant Coach 2' }, 'Assistant coach 2', 'AC2'],
    [{ playerType: 'official', role: 'Physiotherapist' }, 'Physiotherapist', 'P'],
    [{ playerType: 'official', role: 'Medic' }, 'Doctor', 'M'],
    [{ type: 'delay_warning' }, 'Team', 'D'],
    [{ type: 'delay_penalty' }, 'Team', 'D'],
    [{ type: 'improper_request' }, 'Team', ''],
    // rows of the old editor
    [{ playerType: 'coach' }, 'Coach', 'C'],
    [{ playerType: 'bench_official', role: 'Physiotherapist' }, 'Physiotherapist', 'P']
  ])('%o -> %s', (payload, label, code) => {
    const r = sanctionTarget(payload)
    expect(r.label).toBe(label)
    expect(r.code).toBe(code)
  })
  it('flags a person sanction without a number as incomplete', () => {
    expect(sanctionTarget({ playerType: 'player' })).toMatchObject({ label: 'Player #?', incomplete: true })
    expect(sanctionTarget({ type: 'warning' }).incomplete).toBe(true)
  })
})

describe('teams and score', () => {
  it('takes A/B from the coin toss, home = A when it is missing', () => {
    expect(teamLetter('home', { coinTossTeamA: 'away' })).toBe('B')
    expect(teamLetter('away', { coinTossTeamA: 'away' })).toBe('A')
    expect(teamLetter('home', {})).toBe('A')
    expect(teamLabel('away', ctx)).toMatchObject({ name: 'Volley Bern', letter: 'B' })
  })
  it('writes the concerned team first, Team A first otherwise', () => {
    expect(formatScore({ home: 11, away: 17 }, 'away', ctx)).toBe('B 17:11 A')
    expect(formatScore({ home: 11, away: 17 }, 'home', ctx)).toBe('A 11:17 B')
    expect(formatScore({ home: 25, away: 23 }, null, ctx)).toBe('A 25:23 B')
    const swapped = { ...ctx, match: { ...MATCH, coinTossTeamA: 'away', coinTossTeamB: 'home' } }
    expect(formatScore({ home: 25, away: 23 }, null, swapped)).toBe('A 23:25 B')
  })
  it('formats set times with the duration', () => {
    const s = new Date(2026, 9, 3, 19, 42).toISOString()
    const e = new Date(2026, 9, 3, 20, 7).toISOString()
    expect(setTimesText(s, e)).toBe('19:42–20:07 (25 min)')
  })
})

describe('describeEvent', () => {
  const { events } = buildMatch({
    sets: [{
      points: pointsFor(25, 20),
      finished: true,
      extras: [
        { at: 3, type: 'timeout', payload: { team: 'away' } },
        { at: 5, type: 'sanction', payload: { team: 'home', type: 'improper_request' } },
        { at: 6, type: 'sanction', payload: { team: 'away', type: 'delay_warning' } },
        { at: 8, type: 'sanction', payload: { team: 'home', type: 'penalty', playerType: 'bench', playerNumber: 8 } },
        { at: 9, type: 'sanction', payload: { team: 'away', type: 'warning', playerType: 'official', role: 'Coach' } },
        { at: 10, type: 'substitution', payload: { team: 'home', playerOut: 3, playerIn: 9 } }
      ]
    }]
  })
  const find = (pred) => events.find(pred)

  it('replays the points before the event by seq, never the snapshot', () => {
    const to = find(e => e.type === 'timeout')
    to.stateSnapshot = { pointsA: 99, pointsB: 99 }
    const s = scoreBeforeEvent(events, to)
    expect(s.home + s.away).toBe(3)
  })

  it('a time-out: requesting team first', () => {
    const d = describeEvent(find(e => e.type === 'timeout'), events, ctx)
    expect(d.title).toBe('Time-out')
    expect(d.teamText).toBe('Volley Bern (B)')
    expect(d.score).toMatch(/^B \d+:\d+ A$/)
  })

  it('a bench penalty: circled number, opponent point, sanctioned team first', () => {
    const d = describeEvent(find(e => e.type === 'sanction' && e.payload.type === 'penalty'), events, ctx)
    expect(d.title).toBe('Penalty — Player #8 (bench)')
    expect(d.code).toBe('(8)')
    expect(d.detail).toBe('+1 point to Volley Bern')
    expect(d.text).toMatch(/^Penalty — Player #8 \(bench\) · VC Smash \(A\) · Set 1 · A \d+:\d+ B · \+1 point to Volley Bern$/)
  })

  it('team sanctions read "Team"', () => {
    expect(describeEvent(find(e => e.payload?.type === 'improper_request'), events, ctx).title).toBe('Improper request — Team')
    const delay = describeEvent(find(e => e.payload?.type === 'delay_warning'), events, ctx)
    expect(delay.title).toBe('Delay warning — Team')
    expect(delay.code).toBe('D')
  })

  it('a substitution reads "#9 in for #3"', () => {
    const d = describeEvent(find(e => e.type === 'substitution'), events, ctx)
    expect(d.title).toBe('Substitution')
    expect(d.detail).toBe('#9 in for #3')
  })

  it('hides the automatic rows', () => {
    expect(describeEvent(find(e => e.type === 'rally_start'), events, ctx)).toBeNull()
    expect(describeEvent(find(e => e.type === 'set_start'), events, ctx)).toBeNull()
    expect(describeEvent(find(e => e.type === 'lineup' && e.payload.liberoSubstitution === null), events, ctx)).toBeNull()
    expect(describeEvent(find(e => e.type === 'lineup' && e.payload.fromSubstitution), events, ctx)).toBeNull()
    expect(describeEvent({ type: 'libero_exit', setIndex: 1, payload: { team: 'home', reason: 'rotation_to_front_row' } }, events, ctx)).toBeNull()
  })

  it('a set end reads who won and the final score A first', () => {
    const d = describeEvent(find(e => e.type === 'set_end'), events, ctx)
    expect(d.title).toBe('Set 1 won by VC Smash')
    expect(d.score).toBe('A 25:20 B')
  })

  it('never prints "_", ": #" or "bench:" for any event of the fixture match', () => {
    const extra = [
      { id: 900, seq: 900, setIndex: 1, type: 'sanction', payload: { team: 'home', type: 'some_odd_type' } },
      { id: 901, seq: 901, setIndex: 1, type: 'sanction', payload: { team: 'home', type: 'expulsion', playerType: 'bench' } },
      { id: 902, seq: 902, setIndex: 1, type: 'weird_event_type', payload: {} },
      { id: 903, seq: 903, setIndex: 1, type: 'libero_entry', payload: { team: 'away', liberoIn: 2, playerOut: 15, liberoType: 'libero1' } },
      { id: 904, seq: 904, setIndex: 1, type: 'forfait', payload: { team: 'away', scope: 'set', reason: 'team_incomplete' } }
    ]
    const all = events.concat(extra)
    for (const e of all) {
      const d = describeEvent(e, all, ctx)
      if (!d) continue
      expect(d.text).not.toMatch(/_|: #|bench:|undefined|null/)
    }
  })

  it('names a bench injury, an incomplete team and a stopped match (the Last action cases)', () => {
    const extra = [
      { id: 910, seq: 910, setIndex: 1, type: 'bench_injury', payload: { team: 'home', playerNumber: 7 } },
      { id: 911, seq: 911, setIndex: 1, type: 'forfait', payload: { team: 'away', scope: 'match', reason: 'team_incomplete' } },
      { id: 912, seq: 912, setIndex: 1, type: 'forfait', payload: { team: 'away', scope: 'set' } },
      { id: 913, seq: 913, setIndex: 1, type: 'match_stopped', payload: { homePoints: 10, awayPoints: 8 } }
    ]
    const all = events.concat(extra)
    const title = (id) => describeEvent(all.find(e => e.id === id), all, ctx).title
    expect(title(910)).toBe('Injury: player #7 (bench)')
    expect(title(911)).toBe('Team incomplete for the match')
    expect(title(912)).toBe('Team incomplete for the set')
    expect(title(913)).toBe('Match stopped')
  })

  it('translates through t with interpolation', () => {
    const t = (key, opts) => (key === 'corrections.term.timeout' ? 'Auszeit' : key === 'corrections.term.set' ? `Satz ${opts.n}` : opts.defaultValue)
    const d = describeEvent(find(e => e.type === 'timeout'), events, { ...ctx, t })
    expect(d.title).toBe('Auszeit')
    expect(d.setLabel).toBe('Satz 1')
  })
})

describe('remarkText', () => {
  it('builds the Swiss course templates, concerned team first', () => {
    expect(remarkText('exceptionalSub', { team: 'B', set: 3, score: '16:21', out: 8, in: 3, reason: 'injury' }))
      .toBe('Team B, Set 3, Result 16:21: player no. 8 is exceptionally substituted by player no. 3 due to injury.')
    expect(remarkText('liberoUnable', { team: 'A', set: 3, score: '21:24', n: 4 }))
      .toBe('Team A, Set 3, Result 21:24: Libero no. 4 is declared unable to play.')
    expect(remarkText('delayedStart', { set: 5, time: '12:18', minutes: 5, reason: 'a broken net' }))
      .toBe("Set 5 start time 12:18 (5' delay) due to a broken net.")
  })
})

describe('describeLegacyChange', () => {
  it('prefers text, never shows raw JSON', () => {
    expect(describeLegacyChange({ text: 'Added: Time-out' })).toBe('Added: Time-out')
    expect(describeLegacyChange({ description: 'Deleted event: improper_request (seq: 4)' })).toBe('Deleted event: improper request (seq: 4)')
    expect(describeLegacyChange({ category: 'event', field: 'sanction', description: '{"a":1}' })).toBe('Event: Sanction')
  })
  it('tr never returns the bare key, and fills placeholders an uninitialised i18n leaves (0 included)', () => {
    expect(tr((k) => k, 'corrections.x', 'Default {{n}}', { n: 2 })).toBe('Default 2')
    expect(tr((k, o) => o.defaultValue, 'corrections.score', '{{first}} {{a}}:{{b}} {{second}}', { first: 'B', a: 0, b: 0, second: 'A' })).toBe('B 0:0 A')
  })
})
