/**
 * beachBracket — the double-elimination draw of a beach tournament
 * (~/ov-ops/openbeach-separation-tournaments-PLAN.md 3.2, phase T1;
 * docs/beach-tournaments-spec.md section 4). Pure: no database, no clock.
 *
 * The layout (Swiss Volley beach regulations Art. 21, FIVB double
 * elimination with crossover semifinals):
 *
 *   board B = 8, 16 or 32 (k = log2 B); n teams (4..B), seeds n+1..B are byes
 *   Winners  W1 .. W(k-1)   W1 pairs the seeds in the standard bracket order
 *                           (1-16, 8-9, 4-13, 5-12, 2-15, 7-10, 3-14, 6-11 for 16)
 *   Losers   L1             the losers of W1, in pairs
 *            then for every winners round r = 2 .. k-1:
 *              a drop round: the winners of the previous losers round against
 *              the losers of Wr. The losers of Wr come in reversed order on
 *              odd drop rounds and in order on even ones, so a team does not
 *              meet the team that just beat it (the halves cross);
 *              and, unless r = k-1, a round that halves the losers bracket.
 *   Semis    SF1 = winner of the first last-winners match vs the winner of
 *            the last losers match that took the loser of the OTHER one
 *            (crossover); SF2 the same the other way round
 *   P3       the losers of the semifinals (3rd place); F the final
 *
 * Byes: a match with an empty side is not played; its other side moves on
 * (a top seed starts in W2, the loser of a W1 match next to a bye skips L1).
 * A team that loses in the losers bracket is out, ranked by the round:
 * 5th for the last losers round, 7th for the one before, and so on (ties
 * share the rank; a round with no match gives no rank). n teams always
 * play 2n - 2 matches.
 *
 * Output: the matches in playing order (game order), each with its code
 * (W1.., L1.., SF1, SF2, P3, F), phase, round, position, wave (the earliest
 * moment it can be played: 1 + the latest wave it depends on) and its two
 * sources ('seed:4', 'winner:W3', 'loser:L2'), plus the rank its winner /
 * loser finishes on when the match ends their tournament.
 *
 * Checked by golden tests per size (tests/beachBracket.test.js and
 * tests/fixtures/beach-de/*.txt). The official Swiss Volley templates
 * (MyBeach "Tableauvorlagen", plan action A3) were not available when this
 * was written: compare the goldens with them before the first official use.
 */

export const DE_BOARD_SIZES = Object.freeze([8, 16, 32])
export const DE_MIN_TEAMS = 4
export const DE_MAX_TEAMS = 32

/** The smallest double-elimination board for n teams, or null when there is none. */
export function boardSizeFor (n) {
  if (!Number.isInteger(n) || n < DE_MIN_TEAMS || n > DE_MAX_TEAMS) return null
  return DE_BOARD_SIZES.find((b) => b >= n) ?? null
}

/** The seeds of a board in bracket order, top to bottom: [1, 16, 8, 9, 4, 13, ...] for 16. */
export function seedOrder (size) {
  let order = [1, 2]
  while (order.length < size) {
    const m = order.length * 2
    order = order.flatMap((s) => [s, m + 1 - s])
  }
  return order
}

const EMPTY = null
const PHASE_ORDER = { winners: 0, losers: 1, placement: 2, final: 3 }

/**
 * The full template of a board: every match with internal ids and sources
 * { kind: 'seed', seed } | { kind: 'winner' | 'loser', id }.
 */
function template (size) {
  const k = Math.log2(size)
  const matches = new Map()
  const add = (m) => { matches.set(m.id, m); return m }
  const W = (r, p) => `W${r}.${p}`
  const L = (j, p) => `L${j}.${p}`

  // Winners bracket
  const order = seedOrder(size)
  for (let p = 1; p <= size / 2; p++) {
    add({ id: W(1, p), phase: 'winners', round: 1, position: p, s: [{ kind: 'seed', seed: order[2 * p - 2] }, { kind: 'seed', seed: order[2 * p - 1] }] })
  }
  for (let r = 2; r <= k - 1; r++) {
    for (let p = 1; p <= size / 2 ** r; p++) {
      add({ id: W(r, p), phase: 'winners', round: r, position: p, s: [{ kind: 'winner', id: W(r - 1, 2 * p - 1) }, { kind: 'winner', id: W(r - 1, 2 * p) }] })
    }
  }

  // Losers bracket
  let j = 1
  const l1 = size / 4
  for (let p = 1; p <= l1; p++) {
    add({ id: L(1, p), phase: 'losers', round: 1, position: p, s: [{ kind: 'loser', id: W(1, 2 * p - 1) }, { kind: 'loser', id: W(1, 2 * p) }] })
  }
  let prev = { round: 1, count: l1 }
  let drop = 0
  const lastDropOf = new Map() // W(k-1) match id -> the last losers match its loser drops into
  for (let r = 2; r <= k - 1; r++) {
    drop++
    j++
    const count = size / 2 ** r
    for (let p = 1; p <= count; p++) {
      const from = drop % 2 === 1 ? count + 1 - p : p
      add({ id: L(j, p), phase: 'losers', round: j, position: p, s: [{ kind: 'winner', id: L(prev.round, p) }, { kind: 'loser', id: W(r, from) }] })
      if (r === k - 1) lastDropOf.set(W(r, from), L(j, p))
    }
    prev = { round: j, count }
    if (r < k - 1) {
      j++
      for (let p = 1; p <= count / 2; p++) {
        add({ id: L(j, p), phase: 'losers', round: j, position: p, s: [{ kind: 'winner', id: L(j - 1, 2 * p - 1) }, { kind: 'winner', id: L(j - 1, 2 * p) }] })
      }
      prev = { round: j, count: count / 2 }
    }
  }

  // Crossover semifinals, 3rd place, final
  const top = W(k - 1, 1)
  const bottom = W(k - 1, 2)
  add({ id: 'SF.1', phase: 'final', round: 1, position: 1, s: [{ kind: 'winner', id: top }, { kind: 'winner', id: lastDropOf.get(bottom) }] })
  add({ id: 'SF.2', phase: 'final', round: 1, position: 2, s: [{ kind: 'winner', id: bottom }, { kind: 'winner', id: lastDropOf.get(top) }] })
  add({ id: 'P3', phase: 'placement', round: 2, position: 1, s: [{ kind: 'loser', id: 'SF.1' }, { kind: 'loser', id: 'SF.2' }] })
  add({ id: 'F', phase: 'final', round: 2, position: 2, s: [{ kind: 'winner', id: 'SF.1' }, { kind: 'winner', id: 'SF.2' }] })
  return { matches, losersRounds: j }
}

/**
 * The double-elimination draw of n teams.
 * @param {number} n  teams (seeds 1..n)
 * @param {{boardSize?: number}} [o]  8, 16 or 32 (default: the smallest that fits)
 * @returns {{ boardSize: number, teams: number, matches: Array<{
 *   n: number, code: string, phase: string, round: number, position: number, wave: number,
 *   source1: string, source2: string, winner_rank: number|null, loser_rank: number|null }> }}
 * @throws {RangeError} for a team count or board size that does not fit
 */
export function doubleElimination (n, { boardSize } = {}) {
  if (!Number.isInteger(n) || n < DE_MIN_TEAMS || n > DE_MAX_TEAMS) {
    throw new RangeError(`double elimination needs ${DE_MIN_TEAMS} to ${DE_MAX_TEAMS} teams`)
  }
  const size = boardSize ?? boardSizeFor(n)
  if (!DE_BOARD_SIZES.includes(size) || size < n) throw new RangeError(`board size ${size} does not fit ${n} teams`)
  const { matches } = template(size)

  // Collapse the byes: resolve every source to a seed that plays, a played
  // match's winner/loser, or EMPTY.
  const outcome = new Map() // id -> { real, winner, loser }
  const resolve = (src) => {
    if (src.kind === 'seed') return src.seed <= n ? { kind: 'seed', seed: src.seed } : EMPTY
    const o = outcomeOf(src.id)
    return src.kind === 'winner' ? o.winner : o.loser
  }
  const outcomeOf = (id) => {
    if (outcome.has(id)) return outcome.get(id)
    const m = matches.get(id)
    const [a, b] = m.s.map(resolve)
    let o
    if (a && b) o = { real: true, a, b, winner: { kind: 'winner', id }, loser: { kind: 'loser', id } }
    else o = { real: false, winner: a || b || EMPTY, loser: EMPTY }
    outcome.set(id, o)
    return o
  }
  for (const id of matches.keys()) outcomeOf(id)

  // The matches that are played, with their waves
  const real = [...matches.values()].filter((m) => outcome.get(m.id).real)
  const wave = new Map()
  const waveOf = (id) => {
    if (wave.has(id)) return wave.get(id)
    const o = outcome.get(id)
    const w = 1 + Math.max(0, ...[o.a, o.b].filter((s) => s.kind !== 'seed').map((s) => waveOf(s.id)))
    wave.set(id, w)
    return w
  }
  real.forEach((m) => waveOf(m.id))
  real.sort((x, y) => wave.get(x.id) - wave.get(y.id) ||
    PHASE_ORDER[x.phase] - PHASE_ORDER[y.phase] || x.round - y.round || x.position - y.position)

  // Codes in playing order: W1.., L1.., SF1, SF2, P3, F
  const code = new Map()
  const counters = { W: 0, L: 0, SF: 0 }
  for (const m of real) {
    if (m.phase === 'winners') code.set(m.id, `W${++counters.W}`)
    else if (m.phase === 'losers') code.set(m.id, `L${++counters.L}`)
    else if (m.id.startsWith('SF')) code.set(m.id, `SF${++counters.SF}`)
    else code.set(m.id, m.id)
  }
  const text = (s) => (s.kind === 'seed' ? `seed:${s.seed}` : `${s.kind}:${code.get(s.id)}`)

  // Ranks: the losers of the last losers round are 5th, the round before
  // ranks after them, ...; a round with no played match gives no rank.
  const loserRank = new Map()
  const lRounds = [...new Set(real.filter((m) => m.phase === 'losers').map((m) => m.round))].sort((a, b) => b - a)
  let place = 5
  for (const r of lRounds) {
    const inRound = real.filter((m) => m.phase === 'losers' && m.round === r)
    for (const m of inRound) loserRank.set(m.id, place)
    place += inRound.length
  }
  loserRank.set('F', 2)
  loserRank.set('P3', 4)
  const winnerRank = new Map([['F', 1], ['P3', 3]])

  const out = real.map((m, i) => {
    const o = outcome.get(m.id)
    return {
      n: i + 1,
      code: code.get(m.id),
      phase: m.phase,
      round: m.round,
      position: m.position,
      wave: wave.get(m.id),
      source1: text(o.a),
      source2: text(o.b),
      winner_rank: winnerRank.get(m.id) ?? null,
      loser_rank: loserRank.get(m.id) ?? null
    }
  })
  return { boardSize: size, teams: n, matches: out }
}

/** One line per match, for the golden files: `n code phase round wave source1 source2 [W=rank] [L=rank]`. */
export function bracketLines (bracket) {
  return bracket.matches.map((m) => [m.n, m.code, m.phase, m.round, m.wave, m.source1, m.source2,
    ...(m.winner_rank ? [`W=${m.winner_rank}`] : []), ...(m.loser_rank ? [`L=${m.loser_rank}`] : [])].join(' '))
}

/**
 * Warnings for a draw (plan 3.2 "Draw limits", Swiss Volley Art. 46): codes
 * the manager sees before confirming; none of them blocks the draw.
 *   too_few_teams       fewer than 5 teams (8 for an A category)
 *   board_courts        a board of 32 on fewer than 4 courts, 16 on fewer than 2
 */
export function drawWarnings ({ teams, category = '', courts = null, boardSize = null }) {
  const out = []
  const isA = /^A/i.test(String(category || '').trim())
  if (teams < (isA ? 8 : 5)) out.push({ code: 'too_few_teams', min: isA ? 8 : 5 })
  const size = boardSize ?? boardSizeFor(teams)
  if (courts != null && size != null) {
    const need = size >= 32 ? 4 : size >= 16 ? 2 : 1
    if (courts < need) out.push({ code: 'board_courts', courts: need })
  }
  return out
}

/**
 * Who plays a match, given the results so far.
 * @param {string} source  'seed:4' | 'winner:W3' | 'loser:L2'
 * @param {{ seeds: Map<number, string>, results: Map<string, {winner: string, loser: string}> }} state
 *        entry ids by seed, and the finished matches by code
 * @returns {string|null} the entry id, or null while it is not known yet
 */
export function entryOfSource (source, { seeds, results }) {
  const m = /^(seed|winner|loser):(.+)$/.exec(String(source || ''))
  if (!m) return null
  if (m[1] === 'seed') return seeds.get(Number(m[2])) ?? null
  const r = results.get(m[2])
  if (!r) return null
  return (m[1] === 'winner' ? r.winner : r.loser) ?? null
}

/** The codes of the matches whose sources name `code` (the matches a result feeds). */
export function dependentsOf (matches, code) {
  const refs = new Set([`winner:${code}`, `loser:${code}`])
  return matches.filter((m) => refs.has(m.source1) || refs.has(m.source2)).map((m) => m.code)
}
