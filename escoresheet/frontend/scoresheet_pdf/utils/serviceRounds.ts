/**
 * Service rounds ("Aufschlagrunde") of a set, from the order of its points.
 *
 * ONE tracker for sets 1-4 and for the deciding set (it replaces two copies
 * in App_Scoresheet.tsx that had drifted apart, code-map D1-D3). Rules:
 * docs/scoresheet/field-spec.md 4.6 / 4.7 (sets 1-4) and 6 (set 5), from the
 * Swiss Volley scorekeeper course (SC p.16, 28, 32-34, 39-40, 64, 77-79).
 *
 *  - The team serving first opens box I/1 (tick) when the first rally is
 *    played. The receiving team's I/1 is crossed (X, drawn by the grid), so its
 *    first server is II/1: its k-th service round sits one slot later.
 *  - Slot of a team's k-th round (k from 0): k + (received first ? 1 : 0);
 *    position = slot % 6, round box = floor(slot / 6) + 1.
 *  - Side-out: close the server's round with its TEAM score, open the
 *    receiver's next round (tick).
 *  - When the game went back (domain/rectify, FIVB 7.7.2 / 15.9.2.3): a rally
 *    whose point was cancelled (counted[i] === false) still passes the serve
 *    and opens or closes rounds, but adds no point; a point set by hand
 *    (passes[i] === false) adds the point but passes no serve; the serve the
 *    going back gave (served[i] !== undefined) adds nothing and rotates
 *    nobody (owner, 3.0.16 test match), as on the court (domain/recompute):
 *    the team it names serves with the player at its position I, whose
 *    column is served[i] (serverColumn), else the column of its last round.
 *    That round goes in the column's next free box, and the team's later
 *    rounds follow on from it.
 *  - Set end: the winner's final points go in its current round (still ticked)
 *    or, when it won on receive, in the round it just gained (NOT ticked);
 *    both teams' last rounds are circled.
 *
 * Set 5 (splitSet5Rounds): the left team's rounds are split at the change of
 * courts into panel 1 (as it stood at the change) and panel 3 (Situation 1:
 * the open round carried over; Situation 2: the last closed round copied with
 * its score; then everything after the change).
 */

export type TeamKey = 'home' | 'away'

export interface ServiceRound {
  position: number // 0-5 for I-VI
  box: number // round number, 1-8 (1-6 in set 5)
  ticked: boolean // the round number is ticked (this position served)
  points: number | null // team score when the service was lost / at set end
  circled: boolean // final points of the set
}

export interface TrackedRound extends ServiceRound {
  /** Index of the point after which it was opened (-1: before the first rally). */
  openedAt: number
  /** Index of the point that closed it, or null while open. */
  closedAt: number | null
}

export interface TrackOptions {
  /** The scoring team of each point of the set, in order (rallies with a cancelled point included). */
  pointTeams: TeamKey[]
  /** Per rally: false when its point was cancelled (it scores nothing). Default: every rally counts. */
  counted?: boolean[]
  /** Per rally: false for a point set by hand (it passes no serve). Default: every rally passes it. */
  passes?: boolean[]
  /**
   * Per entry: set for the serve the going back gave (no rally): the column
   * (0-5) of the server, the player at position I after it (serverColumn),
   * or null when not known (the column of the team's last round). Undefined
   * for a rally.
   */
  served?: (number | null | undefined)[]
  /** The team serving the first rally. */
  firstServer: TeamKey
  /** The set is over: write and circle the finals. */
  finished: boolean
}

const other = (t: TeamKey): TeamKey => (t === 'home' ? 'away' : 'home')

/** Position and round box of a team's k-th service round. */
export function roundSlot(k: number, receivedFirst: boolean): { position: number; box: number } {
  const slot = k + (receivedFirst ? 1 : 0)
  return { position: slot % 6, box: Math.floor(slot / 6) + 1 }
}

/** Service rounds of both teams. No rally yet: no round at all (the tick comes with the first rally). */
export function trackServiceRounds({ pointTeams, firstServer, finished, counted, passes, served }: TrackOptions): Record<TeamKey, TrackedRound[]> {
  const rounds: Record<TeamKey, TrackedRound[]> = { home: [], away: [] }
  const kept = (pointTeams || [])
    .map((t, i) => ({ t, counts: counted?.[i] !== false, passes: passes?.[i] !== false, served: served?.[i] }))
    .filter(x => x.t === 'home' || x.t === 'away')
  const points = kept.map(x => x.t as TeamKey)
  if (points.length === 0) return rounds

  const receivedFirst = (t: TeamKey) => t !== firstServer
  // Each team's slot (roundSlot: its rotations) and the last box used per
  // column: a serve given by the going back can open a round in a column
  // already used (no rotation), and the column's next round goes below it.
  // The receiving team's I/1 is crossed (used).
  const slot: Record<TeamKey, number> = { home: -1, away: -1 }
  const lastBox: Record<TeamKey, number[]> = { home: [0, 0, 0, 0, 0, 0], away: [0, 0, 0, 0, 0, 0] }
  for (const t of ['home', 'away'] as TeamKey[]) {
    if (receivedFirst(t)) {
      slot[t] = 0
      lastBox[t][0] = 1
    }
  }
  const openAt = (t: TeamKey, s: number, at: number) => {
    const position = ((s % 6) + 6) % 6
    const box = Math.max(Math.floor(s / 6) + 1, lastBox[t][position] + 1)
    slot[t] = s
    lastBox[t][position] = box
    rounds[t].push({ position, box, ticked: true, points: null, circled: false, openedAt: at, closedAt: null })
  }
  const open = (t: TeamKey, at: number) => openAt(t, slot[t] + 1, at)
  // The serve given without a rally: the server's column, nearest to the
  // team's slot (no rotation: the slot itself; a team that never served:
  // its first slot)
  const openGiven = (t: TeamKey, column: number | null | undefined, at: number) => {
    const base = Math.max(slot[t], 0)
    if (column == null || !Number.isInteger(column) || column < 0 || column > 5) return openAt(t, base, at)
    let d = (((column - base) % 6) + 6) % 6
    if (d > 3) d -= 6
    openAt(t, Math.max(base + d, 0), at)
  }
  const lastOpen = (t: TeamKey) => {
    const last = rounds[t][rounds[t].length - 1]
    return last && last.closedAt === null ? last : undefined
  }

  const score: Record<TeamKey, number> = { home: 0, away: 0 }
  let server: TeamKey = firstServer
  let serverBeforeLast: TeamKey = firstServer
  open(firstServer, -1)

  points.forEach((scorer, i) => {
    serverBeforeLast = server
    const given = kept[i].served !== undefined
    if (kept[i].counts && !given) score[scorer]++
    if ((kept[i].passes || given) && scorer !== server) {
      const closing = lastOpen(server)
      if (closing) {
        closing.points = score[server]
        closing.closedAt = i
      }
      if (given) openGiven(scorer, kept[i].served, i)
      else open(scorer, i)
      server = scorer
    }
  })

  if (finished) {
    const last = points.length - 1
    const winner = points[last]
    const loser = other(winner)
    const winnerRound = lastOpen(winner)
    if (winnerRound) {
      winnerRound.points = score[winner]
      winnerRound.closedAt = last
      winnerRound.circled = true
      // won on receive: the round it just gained is written, not ticked (SC p.64)
      if (serverBeforeLast !== winner) winnerRound.ticked = false
    }
    const loserRound = rounds[loser][rounds[loser].length - 1]
    if (loserRound) {
      if (loserRound.points === null) {
        loserRound.points = score[loser]
        loserRound.closedAt = last
      }
      loserRound.circled = true
    }
  }
  return rounds
}

/**
 * The column (0-5) of a team's server: the starting position the player at
 * position I took the court from (a substitute: the starter he replaced; the
 * libero: the player he replaced), or null when it cannot be told.
 * @param startingLineup the set's starting players, positions I-VI
 * @param lineup the line-up now ({ I: 8, II: 3, ... })
 * @param substitutions the team's substitutions of the set, in order ({ playerOut, playerIn })
 * @param liberoSubstitution the libero on court ({ liberoNumber, playerNumber }), if any
 */
export function serverColumn(
  startingLineup: string[],
  lineup: Record<string, unknown> | null | undefined,
  substitutions: { playerOut?: unknown; playerIn?: unknown }[] = [],
  liberoSubstitution?: { liberoNumber?: unknown; playerNumber?: unknown } | null
): number | null {
  const key = (v: unknown) => (v === undefined || v === null || v === '' ? '' : String(v).trim())
  let player = key(lineup?.I)
  if (!player) return null
  if (liberoSubstitution && key(liberoSubstitution.liberoNumber) === player && key(liberoSubstitution.playerNumber)) {
    player = key(liberoSubstitution.playerNumber)
  }
  const starters = (startingLineup || []).map(key)
  // back through the substitutions to the starter (each taken once: no loop)
  const subs = [...(substitutions || [])]
  for (let i = subs.length - 1; i >= 0 && !starters.includes(player); i--) {
    if (key(subs[i]?.playerIn) === player && key(subs[i]?.playerOut)) player = key(subs[i].playerOut)
  }
  const column = starters.indexOf(player)
  return column >= 0 && column < 6 ? column : null
}

/** Index of the point after which a team first reached `at` points (change of courts), or null. */
export function courtChangeIndex(pointTeams: TeamKey[], at = 8, counted?: boolean[]): number | null {
  const score: Record<TeamKey, number> = { home: 0, away: 0 }
  for (let i = 0; i < (pointTeams || []).length; i++) {
    const t = pointTeams[i]
    if (t !== 'home' && t !== 'away') continue
    if (counted?.[i] === false) continue
    score[t]++
    if (score[t] >= at) return i
  }
  return null
}

const plain = ({ position, box, ticked, points, circled }: TrackedRound): ServiceRound => ({ position, box, ticked, points, circled })

/**
 * The set-5 left team's rounds split into panel 1 and panel 3 (field-spec 6).
 * Without a change of courts everything stays in panel 1.
 */
export function splitSet5Rounds(rounds: TrackedRound[], changeAt: number | null): { before: ServiceRound[]; after: ServiceRound[] } {
  if (changeAt === null) return { before: rounds.map(plain), after: [] }
  const openAtChange = (r: TrackedRound) => r.openedAt <= changeAt && (r.closedAt === null || r.closedAt > changeAt)

  // Panel 1 as it stood at the change: a round still open then has no score; no circle
  // (panel 3 carries it). A round gained on the very point that reached 8 (a side-out
  // to 8) is opened after the change, in panel 3 only (SC p.78).
  const before = rounds
    .filter(r => r.openedAt < changeAt)
    .map(r => (openAtChange(r)
      ? { position: r.position, box: r.box, ticked: r.ticked, points: null, circled: false }
      : { ...plain(r), circled: false }))

  const after: ServiceRound[] = []
  const carried = rounds.find(openAtChange)
  if (carried) {
    // Situation 1: serving at the change -> the current server's round, opened again in panel 3
    after.push(plain(carried))
  } else {
    // Situation 2: receiving at the change -> the last closed round, copied with its score
    const closed = rounds.filter(r => r.closedAt !== null && r.closedAt <= changeAt)
    const lastClosed = closed[closed.length - 1]
    if (lastClosed) after.push(plain(lastClosed))
  }
  for (const r of rounds) if (r.openedAt > changeAt) after.push(plain(r))
  return { before, after }
}
