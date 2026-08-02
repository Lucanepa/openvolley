// PROPOSAL — basketball state -> LEDbox sections, a basketball sibling of the match path in
// src/volleyballMapper.js (and of src/beachMapper.proposal.js). Standalone: nothing imports it
// yet. It targets the basketball layout `basketball_matchscore`
// (firmware/openscore/layouts-basketball/basketball_matchscore.xml) and differs from the indoor
// mapper in the ways basketball differs:
//   * A centre PERIOD indicator (Q1..Q4, OT1, OT2 ...; "FINAL" once the game is over) instead of
//     the two-number set line — a period has no per-team split.
//   * A per-side TEAM-FOUL counter (F) that goes amber one short of the bonus and dark red once a
//     side reaches the bonus/penalty (5th team foul), plus an explicit per-side bonus marker.
//   * A per-side TIMEOUT counter (T), red once the configured game total is used — exactly the
//     indoor timeout mechanic.
//   * The serve bars are reused as the POSSESSION (alternating-possession arrow) indicator.
//   * Team short names are auto-fitted to the side width, like the indoor/beach mappers.
//
// The running score, timeouts and possession all live on the same a/b fields volleyball uses, so
// toLeftRight() resolves them unchanged; team fouls ride on subs_a/b and the period on the extra
// `period`/`over` scalars the basketball source emits (see basketballSource.proposal.js). The
// idle / crest screens need NO new mapper: basketball_idle shares the team1/team2 section names
// with kscw_idle, so the existing toClubIdleSections() paints it, and basketball_crest is
// image-only. We deliberately reuse toLeftRight() and fitFontSize() from the indoor mapper
// (imported, not copied) so the a=left/b=right projection and the width-fitting stay identical.

import { toLeftRight, fitFontSize } from './volleyballMapper.js'
import { periodLabel, BASKETBALL } from './basketballSource.js'

// LEDbox SetSections WRITE shape: one { name, value:{ attrib, value } } entry per attribute.
const attr = (name, attrib, value) => ({ name, value: { attrib, value: String(value) } })
const text = (name, value, color) =>
  color ? [attr(name, 'text', value), attr(name, 'color', color)] : [attr(name, 'text', value)]
const rect = (name, color) => [attr(name, 'color', color)]
const box = (name, color) => [attr(name, 'color', '0,0,0'), attr(name, 'bordercolor', color)]

// Basketball counter / cue colours (self-contained, like the beach mapper).
export const BASKETBALL_TIMEOUTS_TOTAL = BASKETBALL.teamTimeoutsTotal
export const BONUS_AT = BASKETBALL.bonusAt
const NEUTRAL_COUNTER = '200,200,200'
const WARN_COUNTER = '255,176,0'   // amber: one foul short of the bonus
const MAXED_COUNTER = '170,0,20'   // dark red: in the bonus/penalty, or timeouts used up
const BONUS_LIT = '255,60,40'      // the per-side penalty marker, lit
const BONUS_DIM = '40,40,40'       // the penalty marker, idle
const PERIOD_COLOR = '255,255,255'
const SERVE_OFF = '30,30,30'
const TEAM_NAME_WIDTH = 62         // px available for a team short name in the top corner

// Foul counter colour: neutral, amber at (bonus-1), dark red once in the bonus/penalty.
const foulColor = (n) => (n >= BONUS_AT ? MAXED_COUNTER : n >= BONUS_AT - 1 ? WARN_COUNTER : NEUTRAL_COUNTER)

// Returns the `value` array for a SetSections command on the basketball_matchscore layout. Each
// side is painted uniformly in its team colour (name, score, box border), like the indoor mapper,
// so the board never shows one team in three different reds.
export function toBasketballSections(state, { off = SERVE_OFF, totalTimeouts = BASKETBALL_TIMEOUTS_TOTAL } = {}) {
  const v = toLeftRight(state)
  const toColor = (n) => (n >= totalTimeouts ? MAXED_COUNTER : NEUTRAL_COUNTER)
  // subs_a/b carry the per-period team fouls (see the basketball source).
  const leftFouls = v.leftSubs
  const rightFouls = v.rightSubs
  const periodText = state && state.over ? 'FINAL' : periodLabel(state ? state.period : 1)
  return [
    ...text('team1', v.leftName, v.leftColor),
    attr('team1', 'fontsize', fitFontSize(v.leftName, TEAM_NAME_WIDTH, { max: 18 })),
    ...text('team2', v.rightName, v.rightColor),
    attr('team2', 'fontsize', fitFontSize(v.rightName, TEAM_NAME_WIDTH, { max: 18 })),
    ...text('score1', v.leftPoints, v.leftColor),
    ...text('score2', v.rightPoints, v.rightColor),
    ...box('bg_score1', v.leftColor),
    ...box('bg_score2', v.rightColor),
    // Centre period indicator: Q1..Q4 / OT1... / FINAL. Fitted so "FINAL" never clips.
    ...text('period', periodText, PERIOD_COLOR),
    attr('period', 'fontsize', fitFontSize(periodText, 30, { max: 15 })),
    // Team fouls (F row) — amber one short of the bonus, red once in the penalty.
    ...text('foul1', leftFouls, foulColor(leftFouls)),
    ...text('foul2', rightFouls, foulColor(rightFouls)),
    // Explicit per-side bonus / penalty marker: lit once that side reaches the bonus threshold.
    ...text('bonus1', leftFouls >= BONUS_AT ? '•' : '', leftFouls >= BONUS_AT ? BONUS_LIT : BONUS_DIM),
    ...text('bonus2', rightFouls >= BONUS_AT ? '•' : '', rightFouls >= BONUS_AT ? BONUS_LIT : BONUS_DIM),
    // Timeouts (T row) — red once the configured game total is used.
    ...text('timeout1', v.leftTimeouts, toColor(v.leftTimeouts)),
    ...text('timeout2', v.rightTimeouts, toColor(v.rightTimeouts)),
    // Possession (alternating-possession arrow): light the bar under the side that has it.
    ...rect('serve1', v.serving === 'left' ? v.leftColor : off),
    ...rect('serve2', v.serving === 'right' ? v.rightColor : off),
  ]
}

// --------------------------------------------------------------------------------------
// Tiny self-check:  node src/basketballMapper.proposal.js
// Proves the period indicator, the foul/bonus colouring + marker, the timeout counter, and the
// possession bars all paint correctly, and that no volleyball-only sections leak onto the board.
// --------------------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  let pass = 0, fail = 0
  const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}`) } }
  const base = {
    side_a: 'left',
    team_a_short: 'LAL', team_a_color: '#552583',
    team_b_short: 'BOS', team_b_color: '#007a33',
    points_a: 0, points_b: 0, sets_won_a: 0, sets_won_b: 0,
    timeouts_a: 0, timeouts_b: 0, subs_a: 0, subs_b: 0, serving_team: 'left',
    period: 1, over: false,
  }
  const secOf = (arr, name, kind) =>
    arr.find((s) => s.name === name && (!kind || s.value.attrib === kind))
  const names = (arr) => new Set(arr.map((s) => s.name))

  // Score + period indicator (Q2).
  {
    const secs = toBasketballSections({ ...base, points_a: 58, points_b: 61, period: 2 })
    ok(secOf(secs, 'score1', 'text').value.value === '58', 'left score painted (58)')
    ok(secOf(secs, 'score2', 'text').value.value === '61', 'right score painted (61)')
    ok(secOf(secs, 'period', 'text').value.value === 'Q2', 'period indicator shows Q2')
    ok(secOf(secs, 'score1', 'color').value.value === secOf(secs, 'team1', 'color').value.value,
      'left team painted one colour (score matches name)')
  }
  // Overtime + FINAL.
  {
    ok(secOf(toBasketballSections({ ...base, period: 5 }), 'period', 'text').value.value === 'OT1',
      'period indicator shows OT1 in the first overtime')
    ok(secOf(toBasketballSections({ ...base, over: true, period: 4 }), 'period', 'text').value.value === 'FINAL',
      'period indicator shows FINAL once the game is over')
  }
  // Team fouls: neutral, amber one short of the bonus, red in the penalty.
  {
    ok(secOf(toBasketballSections({ ...base, subs_a: 2 }), 'foul1', 'color').value.value === NEUTRAL_COUNTER,
      'two team fouls: neutral')
    ok(secOf(toBasketballSections({ ...base, subs_a: 4 }), 'foul1', 'color').value.value === WARN_COUNTER,
      'four team fouls: amber (one short of the bonus)')
    const penalty = toBasketballSections({ ...base, subs_a: 5 })
    ok(secOf(penalty, 'foul1', 'color').value.value === MAXED_COUNTER, 'five team fouls: red (in the penalty)')
    ok(secOf(penalty, 'bonus1', 'text').value.value === '•', 'bonus marker lit for the team in the penalty')
    ok(secOf(penalty, 'bonus2', 'text').value.value === '', 'bonus marker blank for the team not in the penalty')
  }
  // Timeouts: red once the total is used.
  {
    const secs = toBasketballSections({ ...base, timeouts_b: 5 }, { totalTimeouts: 5 })
    ok(secOf(secs, 'timeout2', 'color').value.value === MAXED_COUNTER, 'all timeouts used shows red')
    ok(secOf(secs, 'timeout1', 'color').value.value === NEUTRAL_COUNTER, 'available timeouts neutral')
  }
  // Possession bar + no volleyball-only sections.
  {
    const secs = toBasketballSections({ ...base, serving_team: 'right' })
    ok(secOf(secs, 'serve2', 'color').value.value !== SERVE_OFF, 'possession bar lit on the right')
    ok(secOf(secs, 'serve1', 'color').value.value === SERVE_OFF, 'possession bar off on the left')
    ok(!names(secs).has('sub1') && !names(secs).has('sub2'), 'no volleyball sub sections emitted')
    ok(!names(secs).has('set1') && !names(secs).has('set2'), 'no volleyball set-line sections emitted')
  }

  console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}
