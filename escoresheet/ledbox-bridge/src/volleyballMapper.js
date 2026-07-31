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
// The score box: black fill so the big number reads, border in the team colour.
//
// `bordercolor` appears NOWHERE in the vendor app — an exhaustive scan of ledbox.dll found
// no such attribute, and the device returns ok for any name, so it looked like a no-op we
// were fooling ourselves with. It is not: removing it visibly reverted the away box to the
// layout's default red on the hardware. The firmware supports more than the vendor app
// bothers to use, so absence from the APK is not evidence of absence in the device.
const box = (name, color) => [attr(name, 'color', '0,0,0'), attr(name, 'bordercolor', color)]

// Limit colouring for the timeout and substitution counters, so the referee's table can
// read "this team has nothing left" off the board at a glance instead of doing arithmetic.
// FIVB per-set maximums: 2 timeouts (12.1) and 6 substitutions (15.6).
export const NEUTRAL_COUNTER = '200,200,200'
export const WARN_COUNTER = '255,176,0'   // amber: one short of the limit
export const MAXED_COUNTER = '170,0,20'   // dark red: none left
export const TIMEOUT_MAX = 2
export const SUB_WARN = 5
export const SUB_MAX = 6
const limitColor = (n, warnAt, maxAt) =>
  (n >= maxAt ? MAXED_COUNTER : n >= warnAt ? WARN_COUNTER : NEUTRAL_COUNTER)

// Sections for `volleyball_matchscore_timeout_02` — the device's countdown screen.
// It carries its own score1/score2/set1/set2, which are NOT the ones we paint on the match
// layout, so without this the board shows 0-0 during a timeout while the real score sits
// two points away on a screen nobody can see.
// `content` picks what fills the two BIG score boxes and the small set line beside the clock —
// different breaks want different headlines, and an irrelevant number is just noise on an LED:
//   'full' (timeout)      big = points (play resumes here) · small line = the set score
//   'sets' (set interval) big = the SET score (the headline of a set break) · small line hidden
//   'none' (warm-up)      the clock alone; no numbers yet
export function toCountdownSections(state, { timerText, label, content = 'full' } = {}) {
  const v = state ? toLeftRight(state) : null
  const out = []
  if (timerText != null) out.push(attr('timer', 'text', timerText))
  // `lbl` is a narrow box — long labels get clipped rather than shrunk (sections are fixed
  // CSS boxes), so callers should keep this short.
  if (label) out.push(attr('lbl', 'text', String(label).toUpperCase()))

  // big = the two large score boxes; small = the little set line above them.
  let bigL = '', bigR = '', smallL = '', smallR = '', sep = ''
  if (v && content === 'full') {
    bigL = v.leftPoints; bigR = v.rightPoints
    smallL = v.leftSets; smallR = v.rightSets; sep = '-'
  } else if (v && content === 'sets') {
    bigL = v.leftSets; bigR = v.rightSets // set score, shown large — the small line stays hidden
  }
  // Blank by writing an empty string: the section keeps its box, it just stops showing a number.
  out.push(...text('score1', bigL, v?.leftColor))
  out.push(...text('score2', bigR, v?.rightColor))
  out.push(...text('set1', smallL, v?.leftColor))
  out.push(...text('set2', smallR, v?.rightColor))
  out.push(attr('sep', 'text', sep))
  // Paint the box borders only when a number sits inside them (timeout + interval).
  if (v && content !== 'none') {
    out.push(...box('bg_score1', v.leftColor))
    out.push(...box('bg_score2', v.rightColor))
  }
  return out
}

// Pre-match / between-matches screen on the ordinary match layout: the two team names with
// "VS" between them, everything else blanked. No image upload needed — this is the version
// that works today. A logo screen (full-panel image) is the eventual upgrade once the board
// will accept a media upload; until then this replaces the bare "HOME 0 AWAY 0" idle look.
export function toIdleSections(state, { off = '30,30,30' } = {}) {
  const v = state ? toLeftRight(state) : null
  const left = v?.leftName || 'HOME'
  const right = v?.rightName || 'AWAY'
  return [
    ...text('team1', left, v?.leftColor),
    ...text('team2', right, v?.rightColor),
    ...text('score1', '', v?.leftColor),
    ...text('score2', '', v?.rightColor),
    ...text('set1', ''), ...text('set2', ''),
    attr('vs', 'text', 'VS'),
    ...text('timeout1', ''), ...text('timeout2', ''),
    ...text('sub1', ''), ...text('sub2', ''),
    ...rect('serve1', off), ...rect('serve2', off),
  ]
}

// Returns the `value` array for a `SetSections` command. Each side is painted uniformly
// in its team colour — name, score, set count and score-box border all match — so the
// board never shows one team in three different reds.
export function toSections(state, { off = '30,30,30', totalTimeouts = TIMEOUT_MAX, totalSubs = SUB_MAX } = {}) {
  const v = toLeftRight(state)
  // Timeouts: red at the total, no amber (there are only a couple). Subs: amber one short,
  // red at the total.
  const toColor = (n) => limitColor(n, totalTimeouts, totalTimeouts)
  const subColor = (n) => limitColor(n, totalSubs - 1, totalSubs)
  return [
    ...text('team1', v.leftName, v.leftColor),
    ...text('team2', v.rightName, v.rightColor),
    ...text('score1', v.leftPoints, v.leftColor),
    ...text('score2', v.rightPoints, v.rightColor),
    ...box('bg_score1', v.leftColor),
    ...box('bg_score2', v.rightColor),
    ...text('set1', v.leftSets, v.leftColor),
    ...text('set2', v.rightSets, v.rightColor),
    // `vs` is the tiny "-" separator between the two set counts. Always reassert it, so the
    // idle screen (which borrows it for "VS") can never leave a stray label on the scoreboard.
    attr('vs', 'text', '-'),
    ...text('timeout1', v.leftTimeouts, toColor(v.leftTimeouts)),
    ...text('timeout2', v.rightTimeouts, toColor(v.rightTimeouts)),
    ...text('sub1', v.leftSubs, subColor(v.leftSubs)),
    ...text('sub2', v.rightSubs, subColor(v.rightSubs)),
    // Serve indicators: light the serving side's rectangle in its team colour.
    ...rect('serve1', v.serving === 'left' ? v.leftColor : off),
    ...rect('serve2', v.serving === 'right' ? v.rightColor : off),
  ]
}
