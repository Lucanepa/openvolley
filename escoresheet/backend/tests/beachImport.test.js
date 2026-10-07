/**
 * The Excel/CSV import planner (lib/beachImport.js; plan 3.4, phase T2):
 * values, rows, the diff against a tournament, the brackets and schedule of
 * a Matches sheet, and the hash. Pure; the HTTP side is in
 * beachImport.e2e.test.js.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  IMPORT_MAX_ENTRIES, importHash, normalizeImport, parseCourt, parseDate, parseGame, parseGender, parsePhase, parseSeed,
  parseTime, parseYesNo, planImport
} from '../lib/beachImport.js'

const TOUR = { id: 't', starts_on: '2026-07-11', ends_on: '2026-07-12', day_start: '09:00', day_end: '19:00' }
const player = (last, licence = null, first = '') => ({ first, last, licence, country: null })
function state (over = {}) {
  return { tournament: TOUR, draws: [], entries: [], courts: [{ id: 'c1', number: 1 }, { id: 'c2', number: 2 }], matches: [], savedPairs: [], ...over }
}
const draw = (id, category, gender, over = {}) => ({ id, category, gender, status: 'entries', board_size: null, slot_minutes: 50, rest_minutes: 0, ...over })
const entry = (id, drawId, seed, l1, l2, over = {}) => ({
  id, draw_id: drawId, seed, team_id: null, name: `${l1}/${l2}`, player1: player(l1, `${l1}-lic`), player2: player(l2, `${l2}-lic`),
  wildcard: false, status: 'registered', ...over
})
const row = (n, draw, gender, l1, l2, extra = {}) => ({
  row: n, draw, gender, p1_last: l1, p1_licence: `${l1}-lic`, p2_last: l2, p2_licence: `${l2}-lic`, ...extra
})
const plan = (st, body) => {
  const input = normalizeImport(body)
  assert.equal(input.error, undefined, input.error)
  return planImport(st, input)
}
const codes = (r) => r.messages.map((m) => m.code)

describe('import values', () => {
  it('reads seeds, courts, games, genders and yes/no in the five languages', () => {
    assert.deepEqual(['3', '#3', 'Seed 3', 'S3', '3.', '3.0'].map(parseSeed), [3, 3, 3, 3, 3, 3])
    assert.deepEqual(['0', '129', 'x', 'W3'].map(parseSeed), [null, null, null, null])
    assert.deepEqual(['3', 'Court 3', 'Platz 3', 'Terrain 3', 'Campo 3'].map(parseCourt), [3, 3, 3, 3, 3])
    assert.equal(parseCourt('100'), null)
    assert.deepEqual(['12', '#12', 'Game 12', 'Spiel 12', '12.0'].map(parseGame), [12, 12, 12, 12, 12])
    assert.equal(parseGame('0'), null)
    assert.deepEqual(['M', 'Herren', 'Hommes', 'Uomini', 'Männer'].map(parseGender), ['men', 'men', 'men', 'men', 'men'])
    assert.deepEqual(['W', 'F', 'D', 'Damen', 'Femmes', 'Donne', 'Frauen'].map(parseGender), Array(7).fill('women'))
    assert.deepEqual(['X', 'Mixed', 'Mixte', 'Misto'].map(parseGender), Array(4).fill('mixed'))
    assert.equal(parseGender('Kids'), null)
    assert.deepEqual(['yes', 'Ja', 'oui', 'sì', 'x', '1', 'TRUE'].map(parseYesNo), Array(7).fill(true))
    assert.deepEqual(['no', 'Nein', 'non', '0', '-'].map(parseYesNo), Array(5).fill(false))
    assert.equal(parseYesNo('maybe'), null)
  })

  it('reads dates and times as written in Switzerland', () => {
    assert.deepEqual(['2026-07-11', '11.07.2026', '11.7.2026', '11/7/2026', '11.7.26', '2026/7/11'].map(parseDate), Array(6).fill('2026-07-11'))
    assert.deepEqual(['31.02.2026', 'tomorrow', '2026-13-01'].map(parseDate), [null, null, null])
    assert.deepEqual(['9:30', '09:30', '9.30', '9h30', '09:30:00'].map(parseTime), Array(5).fill(570))
    assert.deepEqual(['24:00', '9', '9:5'].map(parseTime), [null, null, null])
    assert.deepEqual(['Winners', 'Hoffnungsrunde', 'Halbfinal', 'Petite finale'].map(parsePhase), ['winners', 'losers', 'final', 'placement'])
    // the console's own phase names (tournaments.phases.* in the five locales; the template's example)
    assert.deepEqual(['Gewinnerseite', 'Verliererseite', 'Finalspiele', 'Spiel um Platz 3'].map(parsePhase), ['winners', 'losers', 'final', 'placement'])
    assert.deepEqual(['Tableau des gagnants', 'Tableau des perdants', 'Finales', 'Match pour la 3e place'].map(parsePhase), ['winners', 'losers', 'final', 'placement'])
    assert.deepEqual(['Tabellone vincenti', 'Tabellone perdenti', 'Finali', 'Finale per il 3° posto'].map(parsePhase), ['winners', 'losers', 'final', 'placement'])
  })

  it('refuses a body that is not rows (400), and checks every row', () => {
    assert.match(normalizeImport(null).error, /object/)
    assert.match(normalizeImport({}).error, /at least one row/)
    assert.match(normalizeImport({ entries: 'x' }).error, /list/)
    assert.match(normalizeImport({ entries: [1] }).error, /object/)
    assert.match(normalizeImport({ entries: Array(IMPORT_MAX_ENTRIES + 1).fill({}) }).error, /at most/)
    const input = normalizeImport({
      entries: [{ draw: 'A1', gender: 'Kids', p1_last: 'A', p2_last: { x: 1 }, p1_country: 'CH', seed: 'x', wildcard: 'perhaps', team: 'y'.repeat(201) }],
      matches: [{ game: 'g', date: '11.07.2026' }, { game: '3', time: '25:00', court: 'centre' }]
    })
    const e = input.entries[0]
    assert.equal(e.row, 2)
    assert.deepEqual(e.msgs.map((m) => m.code).sort(), ['bad_country', 'bad_gender', 'bad_seed', 'bad_value', 'bad_yes_no', 'required', 'too_long'])
    assert.deepEqual(input.matches[0].msgs.map((m) => m.code), ['bad_game', 'date_time_pair'])
    assert.deepEqual(input.matches[1].msgs.map((m) => m.code), ['bad_time', 'date_time_pair', 'bad_court'])
  })

  it('refuses control characters in a cell (NUL would fail on the apply), keeps tabs and line breaks as spaces', () => {
    const input = normalizeImport({
      entries: [
        { draw: 'Z9', gender: 'W', p1_last: 'Mu\u0000ster', p2_last: 'B' },
        { draw: 'Z9', gender: 'W', p1_last: 'C', p2_last: 'D', team: 'Te\u0000am' },
        { draw: 'Z9', gender: 'W', p1_last: 'E\u001Fx', p2_last: 'F\uFFFF' },
        { draw: 'Z9', gender: 'W', p1_last: 'Mus\tter', p2_last: 'Bei\r\nspiel' }
      ]
    })
    assert.deepEqual(input.entries.map((r) => r.msgs.filter((m) => m.level === 'error').map((m) => [m.code, m.field])), [
      [['bad_char', 'p1_last'], ['required', 'p1_last']],
      [['bad_char', 'team']],
      [['bad_char', 'p1_last'], ['bad_char', 'p2_last'], ['required', 'p1_last'], ['required', 'p2_last']],
      []
    ])
    assert.deepEqual([input.entries[3].p1.last, input.entries[3].p2.last], ['Mus ter', 'Bei spiel'])
    const p = planImport(state(), input)
    assert.equal(p.can_apply, false)
    assert.deepEqual(p.rows.entries.map((r) => r.status), ['error', 'error', 'error', 'warning'])
  })

  it('takes the time from a date cell that has one, as Zurich time', () => {
    const [m] = normalizeImport({ matches: [{ game: '1', date: '2026-07-11 14:20' }] }).matches
    assert.deepEqual(m.msgs, [])
    assert.equal(m.scheduled_at, '2026-07-11T12:20:00.000Z')
  })
})

describe('import entries', () => {
  it('creates the draws and pairs of a new file; licences link saved pairs (season first)', () => {
    const st = state({
      savedPairs: [
        { id: 'sp-old', name: 'Old', season: '2025', licences: ['A-lic', 'B-lic'] },
        { id: 'sp-new', name: 'New', season: '2026', licences: ['B-lic', 'A-lic'] }
      ]
    })
    const p = plan(st, {
      entries: [
        row(2, 'A1', 'Damen', 'A', 'B', { seed: '1', team: 'Team AB' }),
        row(3, 'A1', 'W', 'C', 'D', { seed: '2', wildcard: 'ja', p1_country: 'sui' }),
        row(4, 'B2', 'Herren', 'E', 'F')
      ]
    })
    assert.equal(p.can_apply, true)
    assert.deepEqual(p.summary, {
      draws_new: 2, entries_new: 3, entries_changed: 0, entries_unchanged: 0, entries_removed: 0, brackets: 0,
      matches_changed: 0, matches_unchanged: 0, courts_new: 0, errors: 0, warnings: 0
    })
    assert.deepEqual(p.draws.map((d) => [d.category, d.gender, d.op]), [['A1', 'women', 'new'], ['B2', 'men', 'new']])
    const [ab, cd] = p.entries
    assert.equal(ab.values.name, 'Team AB')
    assert.equal(ab.values.team_id, 'sp-new')
    assert.equal(ab.saved_pair, 'New')
    assert.deepEqual(cd.values, {
      name: 'C/D', seed: 2, wildcard: true, team_id: null,
      player1: { first: '', last: 'C', licence: 'C-lic', country: 'SUI' }, player2: { first: '', last: 'D', licence: 'D-lic', country: null }
    })
    assert.deepEqual(p.rows.entries.map((r) => [r.row, r.status, r.op, r.category]), [[2, 'ok', 'new', 'A1'], [3, 'ok', 'new', 'A1'], [4, 'ok', 'new', 'B2']])
  })

  it('finds a pair by both licences, else by both names in either order; blank cells keep; missing pairs are withdrawn', () => {
    const st = state({
      draws: [draw('d1', 'A1', 'women', { status: 'seeded' })],
      entries: [
        entry('e1', 'd1', 1, 'Alpha', 'Beta', { player1: { first: 'Ann', last: 'Alpha', licence: '111', country: 'SUI' }, player2: { first: 'Bea', last: 'Beta', licence: '222', country: 'SUI' } }),
        entry('e2', 'd1', 2, 'Gamma', 'Delta', { player1: player('Gamma', null, 'Gil'), player2: player('Delta', null, 'Dan') }),
        entry('e3', 'd1', 3, 'Gone', 'Away'),
        entry('e4', 'd1', null, 'Back', 'Again', { status: 'withdrawn' })
      ]
    })
    const p = plan(st, {
      entries: [
        // the other way round, a new country for Alpha, no first names: kept
        { row: 2, draw: 'a1', gender: 'women', p1_last: 'Beta', p1_licence: '222', p2_last: 'Alpha', p2_licence: '111', p2_country: 'GER' },
        { row: 3, draw: 'A1', gender: 'women', p1_last: 'Delta', p1_first: 'Dan', p2_last: 'Gamma', p2_first: 'Gil' },
        row(4, 'A1', 'women', 'Back', 'Again')
      ]
    })
    const byId = new Map(p.entries.map((e) => [e.entry_id, e]))
    assert.deepEqual(byId.get('e1').changes, [{
      field: 'player1',
      from: { first: 'Ann', last: 'Alpha', licence: '111', country: 'SUI' },
      to: { first: 'Ann', last: 'Alpha', licence: '111', country: 'GER' }
    }])
    assert.equal(byId.has('e2'), false, 'the same pair by name: unchanged')
    assert.deepEqual(byId.get('e3').changes, [{ field: 'status', from: 'registered', to: 'withdrawn' }])
    assert.equal(byId.get('e3').op, 'removed')
    assert.deepEqual(byId.get('e4').changes, [{ field: 'status', from: 'withdrawn', to: 'registered' }])
    assert.equal(p.summary.entries_unchanged, 1)
    assert.equal(p.summary.entries_removed, 1)
    assert.equal(p.summary.entries_changed, 2)
    assert.deepEqual(p.draws.map((d) => [d.op, d.draw_id]), [['existing', 'd1']])
  })

  it('seeds: the file\'s when any row of the draw has one (blank = none), else the pairs keep theirs', () => {
    const st = state({ draws: [draw('d1', 'A1', 'women', { status: 'seeded' })], entries: [entry('e1', 'd1', 1, 'A', 'B'), entry('e2', 'd1', 2, 'C', 'D')] })
    const keep = plan(st, { entries: [row(2, 'A1', 'women', 'A', 'B'), row(3, 'A1', 'women', 'C', 'D')] })
    assert.equal(keep.can_apply, false, 'nothing changes')
    assert.equal(keep.summary.entries_unchanged, 2)
    const swap = plan(st, { entries: [row(2, 'A1', 'women', 'A', 'B', { seed: '2' }), row(3, 'A1', 'women', 'C', 'D')] })
    assert.deepEqual(swap.entries.map((e) => [e.entry_id, e.changes]), [
      ['e1', [{ field: 'seed', from: 1, to: 2 }]],
      ['e2', [{ field: 'seed', from: 2, to: null }]]
    ])
  })

  it('refuses duplicates in the file', () => {
    const p = plan(state(), {
      entries: [
        row(2, 'A1', 'women', 'A', 'B', { seed: '1' }),
        row(3, 'A1', 'women', 'B', 'A'),
        row(4, 'A1', 'women', 'C', 'D', { seed: '1' }),
        row(5, 'A1', 'women', 'E', 'A'),
        row(6, 'A1', 'women', 'G', 'H', { p2_licence: 'G-lic' }),
        row(7, 'B1', 'women', 'A', 'B')
      ]
    })
    assert.deepEqual(p.rows.entries.map((r) => [r.row, codes(r)]), [
      [2, []], [3, ['duplicate_pair']], [4, ['duplicate_seed']], [5, ['player_twice']], [6, ['player_twice']],
      // the same two licences in another draw: allowed, with notice
      [7, ['licence_other_draw', 'licence_other_draw']]
    ])
    assert.deepEqual(p.rows.entries[5].messages.map((m) => [m.level, m.licence, m.category, m.first_row]), [['warning', 'A-lic', 'A1', 2], ['warning', 'B-lic', 'A1', 2]])
    assert.equal(p.rows.entries[1].messages[0].first_row, 2)
    assert.equal(p.can_apply, false)
    assert.equal(p.summary.errors, 4)
  })

  it('a pair without licences keeps its first names when the file has none (no withdraw + re-entry)', () => {
    const anna = { first: 'Anna', last: 'Muster', licence: null, country: 'SUI' }
    const bea = { first: 'Bea', last: 'Beispiel', licence: null, country: null }
    const stored = (status) => state({
      draws: [draw('d1', 'A1', 'women', { status })],
      entries: [{ id: 'e1', draw_id: 'd1', seed: 1, team_id: 'saved-1', name: 'Muster/Beispiel', player1: anna, player2: bea, wildcard: false, status: 'registered' }]
    })
    const file = (over = {}) => ({ entries: [{ row: 2, draw: 'A1', gender: 'W', p1_last: 'Muster', p2_last: 'Beispiel', seed: '1', ...over }] })
    for (const body of [file(), file({ p1_last: 'Beispiel', p2_last: 'Muster' }), file({ p2_first: 'Bea', p2_licence: '777' })]) {
      const p = plan(stored('entries'), body)
      assert.equal(p.rows.entries[0].op, body.entries[0].p2_licence ? 'changed' : 'unchanged', JSON.stringify(body))
      assert.equal(p.summary.entries_new, 0)
      assert.equal(p.summary.entries_removed, 0)
      for (const e of p.entries) assert.equal(e.entry_id, 'e1')
    }
    // the licence fills in; the first names and the country stay
    const p = plan(stored('entries'), file({ p2_first: 'Bea', p2_licence: '777' }))
    assert.deepEqual(p.entries[0].changes, [{ field: 'player2', from: bea, to: { ...bea, licence: '777' } }])
    // a drawn bracket: the same file is no error
    const drawn = plan(stored('drawn'), file())
    assert.equal(drawn.summary.errors, 0)
    assert.deepEqual(drawn.warnings, [])
    assert.equal(drawn.rows.entries[0].op, 'unchanged')
    // another first name is another player: a new pair
    const other = plan(stored('entries'), file({ p1_first: 'Alma' }))
    assert.deepEqual(other.entries.map((e) => e.op), ['new', 'removed'])
  })

  it('warns of a player in two pairs of a draw, by name when unlicensed, and of a disqualified pair named again', () => {
    const p = plan(state(), {
      entries: [
        { row: 2, draw: 'A1', gender: 'W', p1_first: 'Anna', p1_last: 'Muster', p2_last: 'B' },
        { row: 3, draw: 'A1', gender: 'W', p1_first: 'Anna', p1_last: 'Muster', p2_last: 'C' },
        { row: 4, draw: 'A1', gender: 'W', p1_last: 'Muster', p2_last: 'D' },
        // namesakes with two different licences are two players
        row(5, 'A1', 'women', 'Same', 'E', { p1_first: 'Eva' }),
        row(6, 'A1', 'women', 'Same', 'F', { p1_first: 'Eva', p1_licence: 'other-lic' })
      ]
    })
    assert.deepEqual(p.rows.entries.map((r) => [r.row, codes(r)]), [
      [2, ['no_licence']], [3, ['no_licence', 'name_twice']], [4, ['no_licence', 'name_twice']], [5, []], [6, []]
    ])
    assert.deepEqual(p.rows.entries[1].messages[1], { level: 'warning', code: 'name_twice', name: 'Anna Muster', first_row: 2 })
    assert.equal(p.summary.errors, 0)

    for (const status of ['dq', 'replaced']) {
      const st = state({ draws: [draw('d1', 'A1', 'women')], entries: [entry('e1', 'd1', 1, 'A', 'B', { status })] })
      const q = plan(st, { entries: [row(2, 'A1', 'women', 'A', 'B', { seed: '1' })] })
      assert.equal(q.rows.entries[0].status, 'warning')
      assert.deepEqual(q.rows.entries[0].messages, [{ level: 'warning', code: 'reinstated', status }])
      assert.deepEqual(q.entries[0].changes, [{ field: 'status', from: status, to: 'registered' }])
    }
    // a withdrawn pair comes back without notice
    const w = plan(state({ draws: [draw('d1', 'A1', 'women')], entries: [entry('e1', 'd1', 1, 'A', 'B', { status: 'withdrawn' })] }),
      { entries: [row(2, 'A1', 'women', 'A', 'B', { seed: '1' })] })
    assert.equal(w.rows.entries[0].status, 'ok')
  })

  it('a licence in a draw the file leaves alone is a warning too', () => {
    const st = state({ draws: [draw('d1', 'A1', 'women'), draw('d2', 'A1', 'mixed')], entries: [entry('e1', 'd2', 1, 'A', 'X')] })
    const p = plan(st, { entries: [row(2, 'A1', 'women', 'A', 'B')] })
    assert.deepEqual(p.rows.entries[0].messages, [{ level: 'warning', code: 'licence_other_draw', licence: 'A-lic', category: 'A1', gender: 'mixed', first_row: null }])
  })

  it('refuses rows of a category and gender that two draws share (any case), instead of picking one', () => {
    const st = state({
      draws: [draw('d1', 'A1', 'women'), draw('d2', 'a1', 'women'), draw('d3', 'B1', 'women')],
      entries: [entry('e1', 'd1', 1, 'A', 'B')],
      matches: [{ id: 'm1', draw_id: 'd1', game_n: 1, code: 'W1', phase: 'winners', source1: 'seed:1', source2: 'seed:4', entry1_id: null, entry2_id: null, court_id: null, scheduled_at: null, duration_min: 50, status: 'scheduled', match_id: null, referee: null, scorer: null }]
    })
    const p = plan(st, {
      entries: [row(2, 'A1', 'women', 'A', 'B'), row(3, 'B1', 'women', 'C', 'D')],
      matches: [{ row: 2, draw: 'a1', gender: 'W', game: '1', court: '1' }]
    })
    assert.deepEqual(p.rows.entries.map((r) => [r.row, r.status, codes(r)]), [[2, 'error', ['ambiguous_draw']], [3, 'ok', []]])
    assert.deepEqual(p.rows.entries[0].messages[0], { level: 'error', code: 'ambiguous_draw', category: 'A1', gender: 'women', count: 2 })
    assert.deepEqual(codes(p.rows.matches[0]), ['ambiguous_draw'])
    // nothing of the two draws is planned: no new pair, no withdrawal
    assert.deepEqual(p.entries.map((e) => [e.op, e.key]), [['new', 'b1|women']])
    assert.equal(p.can_apply, false)
  })

  it('a drawn bracket takes names, players and wildcards only; its missing pairs stay', () => {
    const st = state({
      draws: [draw('d1', 'A1', 'women', { status: 'drawn' })],
      entries: [entry('e1', 'd1', 1, 'A', 'B'), entry('e2', 'd1', 2, 'C', 'D'), entry('e3', 'd1', 3, 'E', 'F'), entry('e4', 'd1', 4, 'G', 'H')]
    })
    const ok = plan(st, { entries: [row(2, 'A1', 'women', 'A', 'B', { team: 'Renamed' }), row(3, 'A1', 'women', 'C', 'D', { wildcard: 'yes' })] })
    assert.equal(ok.can_apply, true)
    assert.deepEqual(ok.entries.map((e) => [e.op, e.changes.map((c) => c.field)]), [['changed', ['name']], ['changed', ['wildcard']]])
    assert.deepEqual(ok.warnings, [{ level: 'warning', code: 'kept_drawn', category: 'A1', gender: 'women', count: 2 }])
    const bad = plan(st, { entries: [row(2, 'A1', 'women', 'A', 'B', { seed: '2' }), row(3, 'A1', 'women', 'X', 'Y')] })
    assert.deepEqual(bad.rows.entries.map(codes), [['draw_drawn'], ['draw_drawn']])
  })
})

describe('import matches', () => {
  const four = (drawId, status = 'seeded') => [1, 2, 3, 4].map((i) => entry(`e${i}`, drawId, i, `L${i}`, `M${i}`))
  const games = (drawId, first, list) => list.map((code, i) => ({
    id: `m${first + i}`, draw_id: drawId, game_n: first + i, code, phase: 'winners', source1: 'seed:1', source2: 'seed:4',
    entry1_id: null, entry2_id: null, court_id: null, scheduled_at: null, duration_min: 50, status: 'scheduled', match_id: null, referee: null, scorer: null
  }))

  it('draws the bracket of a draw named in the Matches sheet (games after the other draws) and plans its slots', () => {
    const st = state({
      draws: [draw('d0', 'B1', 'men', { status: 'drawn' }), draw('d1', 'A1', 'women')],
      entries: [...four('d0').map((e) => ({ ...e, id: `x${e.id}` })), entry('e1', 'd1', 2, 'A', 'B'), entry('e2', 'd1', null, 'C', 'D'), entry('e3', 'd1', null, 'E', 'F')],
      matches: games('d0', 1, ['W1', 'W2', 'W3', 'L1', 'SF1', 'F'])
    })
    const p = plan(st, {
      entries: [row(2, 'A1', 'women', 'A', 'B'), row(3, 'A1', 'women', 'G', 'H'), row(4, 'A1', 'women', 'C', 'D'), row(5, 'A1', 'women', 'E', 'F')],
      matches: [
        { row: 2, draw: 'A1', gender: 'women', game: '7', date: '11.07.2026', time: '09:00', court: '1', team1: '#1', team2: '4', referee: 'Rita Ref', scorer: 'Sam' },
        { row: 3, draw: 'A1', gender: 'women', game: '8', date: '11.07.2026', time: '09:00', court: '3', team1: 'Nobody/Here' }
      ]
    })
    assert.deepEqual(p.draws[0].bracket, { teams: 4, board_size: 8, first_game: 7, last_game: 12 })
    // every pair seeded: the seeded one first (its seed was kept), then the file's order
    assert.deepEqual(p.warnings.map((w) => [w.code, w.count ?? null]), [['seeds_assigned', 4], ['too_few_teams', null]])
    const seeds = new Map(p.entries.map((e) => [e.entry_id ?? e.name, e.op === 'new' ? e.values.seed : e.changes.find((c) => c.field === 'seed')?.to]))
    assert.deepEqual([...seeds], [['e1', 1], ['G/H', 2], ['e2', 3], ['e3', 4]])
    assert.equal(p.summary.brackets, 1)
    assert.deepEqual(p.courts, [{ number: 3 }])
    assert.deepEqual(p.matches.map((m) => [m.game_n, m.code, m.tmatch_id, m.set]), [
      [7, 'W1', null, { court: 1, scheduled_at: '2026-07-11T07:00:00.000Z', referee: 'Rita Ref', scorer: 'Sam' }],
      [8, 'W2', null, { court: 3, scheduled_at: '2026-07-11T07:00:00.000Z' }]
    ])
    // W1 of 4 on a board of 8 is seed 1 vs seed 4 (no warning); W2 is seed 2 vs seed 3
    assert.deepEqual(p.rows.matches.map((r) => [r.row, r.status, codes(r)]), [[2, 'ok', []], [3, 'warning', ['team_mismatch']]])
    assert.equal(p.rows.matches[1].messages[0].expected, 'G/H')
    assert.equal(p.can_apply, true)
  })

  it('finds existing games by number; checks their draw, the begun ones, duplicates and clashes', () => {
    const st = state({
      draws: [draw('d1', 'A1', 'women', { status: 'playing' })],
      entries: four('d1'),
      matches: games('d1', 1, ['W1', 'W2', 'W3']).map((m, i) => (i === 2 ? { ...m, status: 'in_progress', court_id: 'c1', scheduled_at: new Date('2026-07-11T08:00:00Z') } : m))
    })
    const p = plan(st, {
      matches: [
        { row: 2, game: '1', date: '11.07.2026', time: '10:00', court: '1', phase: 'Hoffnungsrunde' },
        { row: 3, draw: 'B1', gender: 'men', game: '2' },
        { row: 4, draw: 'A1', gender: 'women', game: '2', date: '12.07.2026', time: '20:00' },
        { row: 5, game: '3', court: '2', scorer: 'Late' },
        { row: 6, game: '1', court: '2' },
        { row: 7, game: '9' }
      ]
    })
    assert.deepEqual(p.rows.matches.map((r) => [r.row, r.status, codes(r)]), [
      [2, 'warning', ['phase_mismatch', 'slot_conflict']],
      [3, 'error', ['unknown_draw']],
      [4, 'warning', ['slot_conflict']],
      [5, 'error', ['match_begun']],
      [6, 'error', ['duplicate_game']],
      [7, 'error', ['unknown_game']]
    ])
    assert.equal(p.rows.matches[0].messages[1].reason, 'court')
    assert.equal(p.rows.matches[0].messages[1].game, 3)
    assert.equal(p.rows.matches[2].messages[0].reason, 'hours')
    assert.equal(p.can_apply, false)
  })

  it('refuses a date on no day of the tournament (another year, Excel\'s 1899 of a time-only cell); a day just played stays', () => {
    const st = state({
      draws: [draw('d1', 'A1', 'women', { status: 'drawn' })],
      entries: four('d1'),
      matches: games('d1', 1, ['W1', 'W2', 'W3', 'W4']).map((m, i) => (i === 3 ? { ...m, scheduled_at: new Date('2026-07-01T07:00:00Z') } : m))
    })
    const p = plan(st, {
      matches: [
        { row: 2, game: '1', date: '11.7.62', time: '09:00' },
        { row: 3, game: '2', date: '1899-12-30 09:00' },
        { row: 4, game: '3', date: '12.07.2026', time: '09:00' },
        // the stored (old) start, unchanged: not written, no error
        { row: 5, game: '4', date: '01.07.2026', time: '09:00' }
      ]
    })
    assert.deepEqual(p.rows.matches.map((r) => [r.row, r.status, codes(r)]), [
      [2, 'error', ['date_outside']], [3, 'error', ['date_outside']], [4, 'ok', []], [5, 'ok', []]
    ])
    assert.deepEqual(p.rows.matches[0].messages[0], { level: 'error', code: 'date_outside', date: '2062-07-11', starts_on: '2026-07-11', ends_on: '2026-07-12' })
    assert.equal(p.can_apply, false)
  })

  it('names the draw of a game in another draw', () => {
    const st = state({ draws: [draw('d1', 'A1', 'women', { status: 'drawn' }), draw('d2', 'A1', 'men', { status: 'drawn' })], matches: games('d1', 1, ['W1']) })
    const p = plan(st, { matches: [{ row: 2, draw: 'A1', gender: 'men', game: '1', court: '1' }] })
    assert.deepEqual(p.rows.matches[0].messages, [{ level: 'error', code: 'game_other_draw', game: 1, category: 'A1', gender: 'women', match_code: 'W1' }])
  })

  it('seeds a draw that is not in the Entries sheet in its own order', () => {
    const st = state({
      draws: [draw('d1', 'A1', 'women')],
      entries: [entry('e1', 'd1', null, 'A', 'B'), entry('e2', 'd1', 5, 'C', 'D'), entry('e3', 'd1', null, 'E', 'F'), entry('e4', 'd1', null, 'G', 'H', { status: 'withdrawn' }), entry('e5', 'd1', null, 'I', 'J')]
    })
    const p = plan(st, { matches: [{ row: 2, draw: 'A1', gender: 'women', game: '1', court: '2' }] })
    assert.deepEqual(p.entries.map((e) => [e.entry_id, e.changes]), [
      ['e2', [{ field: 'seed', from: 5, to: 1 }]],
      ['e1', [{ field: 'seed', from: null, to: 2 }]],
      ['e3', [{ field: 'seed', from: null, to: 3 }]],
      ['e5', [{ field: 'seed', from: null, to: 4 }]]
    ])
    assert.equal(p.summary.entries_changed, 4)
    assert.equal(p.can_apply, true)
  })

  it('refuses a bracket for a draw with too few pairs', () => {
    const st = state({ draws: [draw('d1', 'A1', 'women')], entries: [entry('e1', 'd1', 1, 'A', 'B')] })
    const p = plan(st, { matches: [{ row: 2, draw: 'A1', gender: 'women', game: '1' }] })
    assert.deepEqual(p.rows.matches[0].messages.map((m) => m.code), ['draw_size', 'unknown_game'])
  })
})

describe('import hash', () => {
  it('is the same for the same file and tournament, and changes with either', () => {
    const st = state({ draws: [draw('d1', 'A1', 'women')], entries: [entry('e1', 'd1', 1, 'A', 'B')] })
    const body = { entries: [row(2, 'A1', 'women', 'A', 'B'), row(3, 'A1', 'women', 'C', 'D')] }
    const h = importHash(plan(st, body))
    assert.match(h, /^[0-9a-f]{64}$/)
    assert.equal(importHash(plan(st, body)), h)
    assert.notEqual(importHash(plan(st, { entries: [...body.entries, row(4, 'A1', 'women', 'E', 'F')] })), h)
    assert.notEqual(importHash(plan({ ...st, entries: [entry('e1', 'd1', 1, 'A', 'B', { name: 'Renamed' })] }, body)), h)
  })
})
