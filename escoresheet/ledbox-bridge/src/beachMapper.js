// PROPOSAL — beach volleyball state -> LEDbox sections, a beach sibling of the match path in
// src/volleyballMapper.js. Standalone: nothing imports it yet. It targets the beach layout
// `beach_matchscore` (firmware/openscore/layouts-beach/beach_matchscore.xml) and differs from
// the indoor mapper in exactly the ways beach differs:
//   * NO sub row (beach has no substitutions) — so the sub1/sub2 sections are never sent.
//   * ONE team timeout per set (default) — the T counter goes dark red once it is used.
//   * A centre `switch` cue that lights amber when the current points sum sits on a court-
//     change boundary (every 7 in sets 1-2, every 5 in the deciding set), so the table can
//     see a change of ends is due without doing the arithmetic.
//   * Pair short names are auto-fitted to the side width, since two surnames are wider than a
//     3-letter club code.
//
// The idle / crest screens need NO new mapper: beach_idle shares the team1/team2 section names
// with kscw_idle, so the existing toClubIdleSections() paints it, and beach_crest is image-only.
// We deliberately reuse toLeftRight() and fitFontSize() from the indoor mapper (imported, not
// copied) so the a=left/b=right projection and the width-fitting stay identical.

import { toLeftRight, fitFontSize } from './volleyballMapper.js'

// LEDbox SetSections WRITE shape: one { name, value:{ attrib, value } } entry per attribute.
const attr = (name, attrib, value) => ({ name, value: { attrib, value: String(value) } })
const text = (name, value, color) =>
  color ? [attr(name, 'text', value), attr(name, 'color', color)] : [attr(name, 'text', value)]
const rect = (name, color) => [attr(name, 'color', color)]
const box = (name, color) => [attr(name, 'color', '0,0,0'), attr(name, 'bordercolor', color)]

// Beach counter/cue colours.
export const BEACH_TIMEOUTS_PER_SET = 1
const NEUTRAL_COUNTER = '200,200,200'
const MAXED_COUNTER = '170,0,20'   // a used-up team timeout (beach: only one per set)
const SWITCH_CUE = '255,176,0'     // amber "SWITCH" when a change of ends is due
const SWITCH_DIM = '60,60,60'      // idle cue colour (matches the layout default)
const SERVE_OFF = '30,30,30'
const TEAM_NAME_WIDTH = 78         // px available for a pair short name before the centre column

// Is the current points sum on a court-change boundary? Every 7 points in sets 1-2, every 5
// in the deciding (1-1) set. Stateless — derived from the score itself, so the cue shows for
// exactly as long as the board sits on that score (i.e. during the change of ends).
export function switchDue(v) {
  const deciding = v.leftSets === 1 && v.rightSets === 1
  const cadence = deciding ? 5 : 7
  const total = (v.leftPoints || 0) + (v.rightPoints || 0)
  return total > 0 && total % cadence === 0
}

// Returns the `value` array for a SetSections command on the beach_matchscore layout. Each
// side is painted uniformly in its pair colour (name, score, set count, box border), like the
// indoor mapper, so the board never shows one pair in three different reds.
export function toBeachSections(state, { off = SERVE_OFF, totalTimeouts = BEACH_TIMEOUTS_PER_SET } = {}) {
  const v = toLeftRight(state)
  const toColor = (n) => (n >= totalTimeouts ? MAXED_COUNTER : NEUTRAL_COUNTER)
  const due = switchDue(v)
  return [
    ...text('team1', v.leftName, v.leftColor),
    attr('team1', 'fontsize', fitFontSize(v.leftName, TEAM_NAME_WIDTH, { max: 18 })),
    ...text('team2', v.rightName, v.rightColor),
    attr('team2', 'fontsize', fitFontSize(v.rightName, TEAM_NAME_WIDTH, { max: 18 })),
    ...text('score1', v.leftPoints, v.leftColor),
    ...text('score2', v.rightPoints, v.rightColor),
    ...box('bg_score1', v.leftColor),
    ...box('bg_score2', v.rightColor),
    ...text('set1', v.leftSets, v.leftColor),
    ...text('set2', v.rightSets, v.rightColor),
    attr('vs', 'text', '-'),
    // Court-change cue: amber "SWITCH" on a boundary, blank (dim) otherwise.
    ...text('switch', due ? 'SWITCH' : '', due ? SWITCH_CUE : SWITCH_DIM),
    // One team timeout per set — red once used. No sub row on the beach layout.
    ...text('timeout1', v.leftTimeouts, toColor(v.leftTimeouts)),
    ...text('timeout2', v.rightTimeouts, toColor(v.rightTimeouts)),
    // Serve indicators: light the serving side's bar in its pair colour.
    ...rect('serve1', v.serving === 'left' ? v.leftColor : off),
    ...rect('serve2', v.serving === 'right' ? v.rightColor : off),
  ]
}

// --------------------------------------------------------------------------------------
// Tiny self-check:  node src/beachMapper.proposal.js
// Proves the switch cue lights on a boundary, no sub sections are emitted, and each side
// stays in its own colour.
// --------------------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  let pass = 0, fail = 0
  const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}`) } }
  const base = {
    side_a: 'left',
    team_a_short: 'MOL/SOR', team_a_color: '#2563eb',
    team_b_short: 'ART/DAL', team_b_color: '#ff4500',
    sets_won_a: 0, sets_won_b: 0, timeouts_a: 0, timeouts_b: 1, serving_team: 'left',
  }
  const secOf = (arr, name, kind) =>
    arr.find((s) => s.name === name && (!kind || s.value.attrib === kind))
  const names = (arr) => new Set(arr.map((s) => s.name))

  // Sum 7 in a normal set -> the SWITCH cue is lit amber.
  {
    const secs = toBeachSections({ ...base, points_a: 4, points_b: 3 })
    ok(secOf(secs, 'switch', 'text').value.value === 'SWITCH', 'switch cue text lit at sum 7')
    ok(secOf(secs, 'switch', 'color').value.value === SWITCH_CUE, 'switch cue is amber at sum 7')
  }
  // Sum 6 -> no cue.
  {
    const secs = toBeachSections({ ...base, points_a: 3, points_b: 3 })
    ok(secOf(secs, 'switch', 'text').value.value === '', 'switch cue blank off a boundary (sum 6)')
  }
  // Deciding set switches every 5: 3-2 (sum 5) lights the cue.
  {
    const secs = toBeachSections({ ...base, sets_won_a: 1, sets_won_b: 1, points_a: 3, points_b: 2 })
    ok(secOf(secs, 'switch', 'text').value.value === 'SWITCH', 'deciding-set cue lit at sum 5')
  }
  // No substitution sections are ever emitted, and a used timeout goes red.
  {
    const secs = toBeachSections({ ...base, points_a: 4, points_b: 3 })
    ok(!names(secs).has('sub1') && !names(secs).has('sub2'), 'no sub sections emitted (beach has none)')
    ok(secOf(secs, 'timeout2', 'color').value.value === MAXED_COUNTER, 'used team timeout shows red')
    ok(secOf(secs, 'timeout1', 'color').value.value === NEUTRAL_COUNTER, 'available team timeout neutral')
    ok(secOf(secs, 'score1', 'color').value.value === secOf(secs, 'team1', 'color').value.value,
      'left pair painted one colour (score matches name)')
  }

  console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}
