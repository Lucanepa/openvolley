// Maps an OpenVolley `match_live_state` row -> LEDbox layout sections.
//
// Source of truth for the field semantics:
//   Scoreboard.jsx:1958  (how the row is built; serving_team already left/right)
//   LivescoreApp.jsx:143 (getLeftRight: side_a decides left/right; sets vs points)
//
// Target layout = the device's `volleyball_matchscore_02` sections:
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

// The LEDbox SetSections WRITE shape is one { name, value: { attrib, value } } entry
// PER attribute — this differs from the GetSections READ shape, which nests attribs
// in an array. To set both text and colour on a section, emit that section name twice.
// (Confirmed against a real Tech4Sport LedBox C0270, firmware 0.551, on 2026-07-30.)
const attr = (name, attrib, value) => ({ name, value: { attrib, value: String(value) } })
const text = (name, value, color) =>
  color ? [attr(name, 'text', value), attr(name, 'color', color)] : [attr(name, 'text', value)]
const rect = (name, color) => [attr(name, 'color', color)]
// The score box: keep the fill black (so the big number reads) and match the border to
// the team colour. `bordercolor` is honoured by the device when supported and a harmless
// no-op otherwise (an unknown attrib returns ok). Setting the fill also heals any stray
// colour left on the private bg_score section.
const box = (name, color) => [attr(name, 'color', '0,0,0'), attr(name, 'bordercolor', color)]

// Returns the `value` array for a `SetSections` command. Each side is painted uniformly
// in its team colour — name, score, set count and score-box border all match — so the
// board never shows one team in three different reds.
export function toSections(state, { off = '30,30,30' } = {}) {
  const v = toLeftRight(state)
  return [
    ...text('team1', v.leftName, v.leftColor),
    ...text('team2', v.rightName, v.rightColor),
    ...text('score1', v.leftPoints, v.leftColor),
    ...text('score2', v.rightPoints, v.rightColor),
    ...box('bg_score1', v.leftColor),
    ...box('bg_score2', v.rightColor),
    ...text('set1', v.leftSets, v.leftColor),
    ...text('set2', v.rightSets, v.rightColor),
    ...text('timeout1', v.leftTimeouts),
    ...text('timeout2', v.rightTimeouts),
    ...text('sub1', v.leftSubs),
    ...text('sub2', v.rightSubs),
    // Serve indicators: light the serving side's rectangle in its team colour.
    ...rect('serve1', v.serving === 'left' ? v.leftColor : off),
    ...rect('serve2', v.serving === 'right' ? v.rightColor : off),
  ]
}
