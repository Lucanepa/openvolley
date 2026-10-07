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
  /** The scoring team of each point of the set, in order. */
  pointTeams: TeamKey[]
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
export function trackServiceRounds({ pointTeams, firstServer, finished }: TrackOptions): Record<TeamKey, TrackedRound[]> {
  const rounds: Record<TeamKey, TrackedRound[]> = { home: [], away: [] }
  const points = (pointTeams || []).filter((t): t is TeamKey => t === 'home' || t === 'away')
  if (points.length === 0) return rounds

  const receivedFirst = (t: TeamKey) => t !== firstServer
  const open = (t: TeamKey, at: number) => {
    const { position, box } = roundSlot(rounds[t].length, receivedFirst(t))
    rounds[t].push({ position, box, ticked: true, points: null, circled: false, openedAt: at, closedAt: null })
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
    score[scorer]++
    if (scorer !== server) {
      const closing = lastOpen(server)
      if (closing) {
        closing.points = score[server]
        closing.closedAt = i
      }
      open(scorer, i)
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

/** Index of the point after which a team first reached `at` points (change of courts), or null. */
export function courtChangeIndex(pointTeams: TeamKey[], at = 8): number | null {
  const score: Record<TeamKey, number> = { home: 0, away: 0 }
  for (let i = 0; i < (pointTeams || []).length; i++) {
    const t = pointTeams[i]
    if (t !== 'home' && t !== 'away') continue
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
