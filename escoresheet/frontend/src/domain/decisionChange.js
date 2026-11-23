/**
 * What the decision change dialog's options leave, for its preview (the new
 * score and who serves). Pure: no React, no Dexie.
 *
 *  - swap:          the last point goes to the other team, who serve next;
 *  - replay:        the last point is taken back and its rally replayed: the
 *                   team that served it serves again. After a side-out that is
 *                   the other team, not the point's (the preview named the
 *                   point's team, plan of 22.11.2026);
 *  - record_replay: continuous play's third option, the rally played since
 *                   the last point was replayed: nothing changes.
 */
import { servingTeamFromLog } from './rules'

const otherTeam = (team) => (team === 'home' ? 'away' : 'home')

/**
 * @param {{ events: Array, point: object, score: { home: number, away: number }, match?: object }} args
 *   events: the match's events; point: the last point (the dialog's);
 *   score: the set score now
 * @returns {{ swap: { home: number, away: number, serve: 'home'|'away' },
 *   replay: { home: number, away: number, serve: 'home'|'away' },
 *   record_replay: { home: number, away: number, serve: 'home'|'away' } }}
 */
export function decisionChangeOutcomes({ events, point, score, match = null }) {
  const team = point?.payload?.team === 'away' ? 'away' : 'home'
  const setIndex = point?.setIndex ?? 1
  const home = Number(score?.home) || 0
  const away = Number(score?.away) || 0
  const base = Math.floor(point?.seq || 0)
  // the log before the point and the rows it wrote (N.x)
  const before = (events || []).filter(e => e && e !== point && Math.floor(e.seq || 0) < base)
  const serveBefore = servingTeamFromLog(before, setIndex, match || {})
  const serveNow = servingTeamFromLog(events, setIndex, match || {})
  const minus = (n) => Math.max(0, n - 1)
  return {
    swap: {
      home: team === 'home' ? minus(home) : home + 1,
      away: team === 'away' ? minus(away) : away + 1,
      serve: otherTeam(team)
    },
    replay: {
      home: team === 'home' ? minus(home) : home,
      away: team === 'away' ? minus(away) : away,
      serve: serveBefore
    },
    record_replay: { home, away, serve: serveNow }
  }
}
