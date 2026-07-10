// Maps an OpenVolley `match_live_state` row -> LEDbox layout sections.
//
// Source of truth for the field semantics:
//   Scoreboard.jsx:1958  (how the row is built; serving_team already left/right)
//   LivescoreApp.jsx:143 (getLeftRight: side_a decides left/right; sets vs points)
//
// Target layout = the docs' `volleyball_matchscore` sections:
//   team1/team2, score1/score2 (big current-set points), set1/set2 (sets won),
//   timeout1/timeout2 (T), sub1/sub2 (S, substitution counts),
//   serve1/serve2 (rectangles lit in the serving team colour).

import { hexToRgb } from './ledboxProtocol.js'

// timeouts_a / subs_a arrive as an array (full detail, for the referee) or a
// plain number depending on the source — count either shape.
function count(t) {
  if (Array.isArray(t)) return t.length
  if (typeof t === 'number') return t
  return 0
}

// Resolve the A/B model to physical left/right using side_a, exactly like getLeftRight.
export function toLeftRight(state) {
  const isALeft = (state.side_a || 'left') === 'left'
  const pick = (a, b) => (isALeft ? a : b)
  return {
    leftName: pick(state.team_a_short || state.team_a_name, state.team_b_short || state.team_b_name) || 'TEAM A',
    rightName: pick(state.team_b_short || state.team_b_name, state.team_a_short || state.team_a_name) || 'TEAM B',
    leftColor: hexToRgb(pick(state.team_a_color, state.team_b_color)),
    rightColor: hexToRgb(pick(state.team_b_color, state.team_a_color)),
    leftPoints: pick(state.points_a, state.points_b) || 0,
    rightPoints: pick(state.points_b, state.points_a) || 0,
    leftSets: pick(state.sets_won_a, state.sets_won_b) || 0,
    rightSets: pick(state.sets_won_b, state.sets_won_a) || 0,
    leftTimeouts: count(pick(state.timeouts_a, state.timeouts_b)),
    rightTimeouts: count(pick(state.timeouts_b, state.timeouts_a)),
    leftSubs: count(pick(state.subs_a, state.subs_b)),
    rightSubs: count(pick(state.subs_b, state.subs_a)),
    serving: state.serving_team || null, // already 'left' | 'right'
  }
}

const section = (name, attrs) => ({ name, value: attrs })
const text = (name, value, color) =>
  section(name, color ? [{ attrib: 'text', value: String(value) }, { attrib: 'color', value: color }]
                      : [{ attrib: 'text', value: String(value) }])

// Returns the `value` array for a `SetSections` command.
export function toSections(state, { off = '30,30,30' } = {}) {
  const v = toLeftRight(state)
  return [
    text('team1', v.leftName, v.leftColor),
    text('team2', v.rightName, v.rightColor),
    text('score1', v.leftPoints, v.leftColor),
    text('score2', v.rightPoints, v.rightColor),
    text('set1', v.leftSets),
    text('set2', v.rightSets),
    text('timeout1', v.leftTimeouts),
    text('timeout2', v.rightTimeouts),
    text('sub1', v.leftSubs),
    text('sub2', v.rightSubs),
    // Serve indicators: light the serving side's rectangle in its team colour.
    section('serve1', [{ attrib: 'color', value: v.serving === 'left' ? v.leftColor : off }]),
    section('serve2', [{ attrib: 'color', value: v.serving === 'right' ? v.rightColor : off }]),
  ]
}
