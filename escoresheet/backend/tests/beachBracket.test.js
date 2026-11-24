/**
 * lib/beachBracket.js: the double-elimination draw. Golden files per size
 * (tests/fixtures/beach-de/de-<n>.txt: 8, 12, 16, 24, 32 teams, byes
 * included), and the rules every size from 4 to 32 keeps, checked by
 * playing every draw with random results.
 *
 * The golden files are the layout described in lib/beachBracket.js. Compare
 * them with the official Swiss Volley templates (plan action A3) before the
 * first official tournament; a change there is a change of these files.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  boardSizeFor, seedOrder, doubleElimination, bracketLines, drawWarnings, entryOfSource, dependentsOf
} from '../lib/beachBracket.js'

const here = dirname(fileURLToPath(import.meta.url))
const golden = (n) => readFileSync(join(here, 'fixtures', 'beach-de', `de-${n}.txt`), 'utf8')
  .split('\n').filter((l) => l && !l.startsWith('#'))

/** Plays a draw with results from `pick(match, a, b) -> winner`; returns the teams' losses, matches and ranks. */
function play (bracket, pick) {
  const seeds = new Map()
  for (let s = 1; s <= bracket.teams; s++) seeds.set(s, `T${s}`)
  const results = new Map()
  const losses = new Map()
  const played = new Map()
  const ranks = new Map()
  const waveOf = new Map()
  for (const m of bracket.matches) {
    const a = entryOfSource(m.source1, { seeds, results })
    const b = entryOfSource(m.source2, { seeds, results })
    assert.ok(a && b, `${m.code}: both teams known when it is its turn`)
    assert.notEqual(a, b, `${m.code}: two different teams`)
    for (const t of [a, b]) {
      played.set(t, (played.get(t) || 0) + 1)
      const w = waveOf.get(t) || []
      assert.ok(!w.includes(m.wave), `${t} plays twice in wave ${m.wave}`)
      waveOf.set(t, [...w, m.wave])
    }
    const winner = pick(m, a, b)
    const loser = winner === a ? b : a
    results.set(m.code, { winner, loser })
    losses.set(loser, (losses.get(loser) || 0) + 1)
    if (m.winner_rank) ranks.set(winner, m.winner_rank)
    if (m.loser_rank) ranks.set(loser, m.loser_rank)
  }
  return { losses, played, ranks }
}

/** The ranks of a draw of n teams (shared ranks: 1 2 3 4 5 5 7 7 9 9 9 9 ...). */
function expectedRanks (bracket) {
  const out = [1, 2, 3, 4]
  const byRank = new Map()
  for (const m of bracket.matches) if (m.phase === 'losers') byRank.set(m.loser_rank, (byRank.get(m.loser_rank) || 0) + 1)
  for (const [r, c] of [...byRank].sort((x, y) => x[0] - y[0])) for (let i = 0; i < c; i++) out.push(r)
  return out
}

let seed = 42
const random = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31 }

describe('beachBracket: double elimination', () => {
  it('board sizes and the seed order', () => {
    assert.equal(boardSizeFor(3), null)
    assert.equal(boardSizeFor(4), 8)
    assert.equal(boardSizeFor(8), 8)
    assert.equal(boardSizeFor(9), 16)
    assert.equal(boardSizeFor(24), 32)
    assert.equal(boardSizeFor(33), null)
    assert.deepEqual(seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6])
    assert.deepEqual(seedOrder(16), [1, 16, 8, 9, 4, 13, 5, 12, 2, 15, 7, 10, 3, 14, 6, 11])
    assert.throws(() => doubleElimination(3), RangeError)
    assert.throws(() => doubleElimination(33), RangeError)
    assert.throws(() => doubleElimination(12, { boardSize: 8 }), RangeError)
    assert.throws(() => doubleElimination(12, { boardSize: 12 }), RangeError)
  })

  for (const n of [8, 12, 16, 24, 32]) {
    it(`golden: ${n} teams`, () => {
      assert.deepEqual(bracketLines(doubleElimination(n)), golden(n))
    })
  }

  it('golden 8: the full layout, written out', () => {
    // W1-W4 first round (1-8, 4-5, 2-7, 3-6), W5/W6 winners' semis; L1/L2 the
    // first-round losers; L3/L4 take the W6/W5 losers crosswise; crossover semis.
    assert.deepEqual(golden(8), [
      '1 W1 winners 1 1 seed:1 seed:8', '2 W2 winners 1 1 seed:4 seed:5', '3 W3 winners 1 1 seed:2 seed:7', '4 W4 winners 1 1 seed:3 seed:6',
      '5 W5 winners 2 2 winner:W1 winner:W2', '6 W6 winners 2 2 winner:W3 winner:W4',
      '7 L1 losers 1 2 loser:W1 loser:W2 L=7', '8 L2 losers 1 2 loser:W3 loser:W4 L=7',
      '9 L3 losers 2 3 winner:L1 loser:W6 L=5', '10 L4 losers 2 3 winner:L2 loser:W5 L=5',
      '11 SF1 final 1 4 winner:W5 winner:L3', '12 SF2 final 1 4 winner:W6 winner:L4',
      '13 P3 placement 2 5 loser:SF1 loser:SF2 W=3 L=4', '14 F final 2 5 winner:SF1 winner:SF2 W=1 L=2'
    ])
  })

  it('golden 12: seeds 1-4 start in the second round, no first losers round', () => {
    const b = doubleElimination(12)
    assert.equal(b.boardSize, 16)
    const second = b.matches.filter((m) => m.phase === 'winners' && m.round === 2)
    assert.deepEqual(second.map((m) => m.source1), ['seed:1', 'seed:4', 'seed:2', 'seed:3'])
    assert.equal(b.matches.filter((m) => m.phase === 'losers' && m.round === 1).length, 0)
    assert.deepEqual(expectedRanks(b), [1, 2, 3, 4, 5, 5, 7, 7, 9, 9, 9, 9])
  })

  it('golden 24: seeds 1-8 start in the second round; 17th for the first losers round', () => {
    const b = doubleElimination(24)
    assert.equal(b.boardSize, 32)
    assert.equal(b.matches.filter((m) => m.phase === 'winners' && m.round === 1).length, 8)
    assert.deepEqual(expectedRanks(b), [1, 2, 3, 4, 5, 5, 7, 7, 9, 9, 9, 9, 13, 13, 13, 13, ...Array(8).fill(17)])
  })

  it('golden 16 and 32: the ranks', () => {
    assert.deepEqual(expectedRanks(doubleElimination(16)), [1, 2, 3, 4, 5, 5, 7, 7, 9, 9, 9, 9, 13, 13, 13, 13])
    assert.deepEqual(expectedRanks(doubleElimination(32)),
      [1, 2, 3, 4, 5, 5, 7, 7, 9, 9, 9, 9, 13, 13, 13, 13, ...Array(8).fill(17), ...Array(8).fill(25)])
  })

  for (let n = 4; n <= 32; n++) {
    it(`${n} teams: 2n-2 matches, every seed once, every result used once, double elimination`, () => {
      const b = doubleElimination(n)
      assert.equal(b.matches.length, 2 * n - 2)
      assert.deepEqual(b.matches.map((m) => m.n), b.matches.map((_, i) => i + 1), 'game order')
      const sources = b.matches.flatMap((m) => [m.source1, m.source2])
      const seeds = sources.filter((s) => s.startsWith('seed:')).map((s) => Number(s.slice(5))).sort((x, y) => x - y)
      assert.deepEqual(seeds, Array.from({ length: n }, (_, i) => i + 1))
      const codes = b.matches.map((m) => m.code)
      assert.equal(new Set(codes).size, codes.length, 'unique codes')
      for (const m of b.matches) {
        // a result is used once per side, never before it is played
        for (const kind of ['winner', 'loser']) {
          const uses = sources.filter((s) => s === `${kind}:${m.code}`).length
          const ends = kind === 'winner' ? m.winner_rank : m.loser_rank
          assert.equal(uses, ends ? 0 : 1, `${kind} of ${m.code}`)
        }
        for (const s of [m.source1, m.source2]) {
          const ref = /^(?:winner|loser):(.+)$/.exec(s)?.[1]
          if (ref) assert.ok(b.matches.find((x) => x.code === ref).wave < m.wave, `${m.code} after ${ref}`)
        }
      }
      for (let round = 0; round < 5; round++) {
        const { losses, played, ranks } = play(b, (m, a, x) => (random() < 0.5 ? a : x))
        // everyone but the four semifinalists is out after exactly two defeats
        for (const [team, r] of ranks) if (r >= 5) assert.equal(losses.get(team), 2, `${team} (rank ${r})`)
        for (const [team, p] of played) assert.ok(p >= 2, `${team} plays ${p}`)
        assert.equal(ranks.size, n, 'every team ranked')
        assert.deepEqual([...ranks.values()].sort((x, y) => x - y), expectedRanks(b))
      }
      // the favourites win: seed s ends on its expected place for 1..4
      const fav = play(b, (m, a, x) => (Number(a.slice(1)) < Number(x.slice(1)) ? a : x))
      for (let s = 1; s <= 4; s++) assert.equal(fav.ranks.get(`T${s}`), s)
    })
  }

  it('dependentsOf and entryOfSource', () => {
    const b = doubleElimination(8)
    assert.deepEqual(dependentsOf(b.matches, 'W1').sort(), ['L1', 'W5'])
    assert.deepEqual(dependentsOf(b.matches, 'F'), [])
    const seeds = new Map([[1, 'a']])
    const results = new Map([['W1', { winner: 'a', loser: 'h' }]])
    assert.equal(entryOfSource('seed:1', { seeds, results }), 'a')
    assert.equal(entryOfSource('seed:2', { seeds, results }), null)
    assert.equal(entryOfSource('loser:W1', { seeds, results }), 'h')
    assert.equal(entryOfSource('winner:W2', { seeds, results }), null)
    assert.equal(entryOfSource('nonsense', { seeds, results }), null)
  })

  it('draw warnings (Art. 46)', () => {
    assert.deepEqual(drawWarnings({ teams: 4, category: 'B1' }), [{ code: 'too_few_teams', min: 5 }])
    assert.deepEqual(drawWarnings({ teams: 6, category: 'A2' }), [{ code: 'too_few_teams', min: 8 }])
    assert.deepEqual(drawWarnings({ teams: 8, category: 'A1', courts: 1 }), [])
    assert.deepEqual(drawWarnings({ teams: 12, category: 'B1', courts: 1 }), [{ code: 'board_courts', courts: 2 }])
    assert.deepEqual(drawWarnings({ teams: 24, category: 'A1', courts: 3 }), [{ code: 'board_courts', courts: 4 }])
  })
})
