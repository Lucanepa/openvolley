/**
 * Recalculation of everything that follows from the entries of the match
 * log — pure, no React, no Dexie. Used by every manual correction (owner
 * 2026-10-29: "let me correct everything and then change stuff
 * accordingly"): a correction changes the entries the scorer wrote, this
 * module rebuilds what the app derives from them, and lists what has become
 * inconsistent instead of refusing the correction.
 *
 * THE ENTRIES (what the scorer recorded, kept as written):
 *   lineup (starting / corrected), point, substitution, libero_entry,
 *   libero_exit (by hand, injury, expulsion ...), libero_exchange, plus the
 *   coin toss on the match row (who serves first in each set).
 * WHAT FOLLOWS FROM THEM (rewritten here, as the live scoreboard would have
 * written it, when an earlier entry changed):
 *   - the rotation line-up a point writes for the team that wins the serve
 *     (N.x sub-row of the point) and the automatic libero exit when the
 *     rotation takes the libero to the front row;
 *   - the line-up sub-row of a substitution / libero replacement (N.x);
 *   - the court position on substitutions and libero replacements, the
 *     libero and the returning player of a libero exit / exchange;
 *   - a line-up corrected after the first rally ("rotate forward"), replayed
 *     relative to the line-up it corrected;
 *   - the running score on each point, the winner on each set end.
 * Serve, time-out / substitution counts, sanction levels and set scores are
 * always read from the entries (rules.js, sanctions.js, scoreFromPointEvents)
 * and need no rewrite; the scoresheet derives its rows from the entries too.
 *
 * The rebuild is a NO-OP on a log the scoreboard wrote: every comparison is
 * by meaning (numbers as strings, a missing libero record = null), a row is
 * only rewritten when what it says changes, and a rewritten value keeps its
 * stored type.
 *
 * INCONSISTENCIES never block a correction: they are returned as `issues`
 * ({ key, params, text, eventId, setIndex, sig }) for the panel's
 * "Check these entries" list, each pointing at the entry to fix.
 */
import { compareBySeq, formatScore, teamLabel, displaySetNumber, tr, sanctionLabel, isTeamSanctionType, otherTeam } from './describe'
import { getFirstServeForSet, getSetResult, isDecidingSet } from './rules'
import { rotateLineup } from './rotation'
import { resolveSanction, isDelaySanction, validateMemberSanction } from './sanctions'
import { MAX_SUBSTITUTIONS_PER_SET } from './substitutions'
import { setsToWin } from '../utils/matchFormat'

export const POSITIONS = ['I', 'II', 'III', 'IV', 'V', 'VI']
const FRONT_ROW = ['II', 'III', 'IV']
// Where each position goes when the team rotates (II serves next)
const ROTATION_MOVE = { I: 'VI', II: 'I', III: 'II', IV: 'III', V: 'IV', VI: 'V' }

const baseOf = (e) => Math.floor(e?.seq || 0)
const isSubRow = (e) => (e?.seq || 0) !== baseOf(e)
const setOf = (e) => e?.setIndex ?? 1
const has = (n) => n !== undefined && n !== null && n !== '' && n !== '?'
const same = (a, b) => has(a) && has(b) && String(a) === String(b)
const round3 = (x) => Math.round(x * 1000) / 1000
const isTeam = (t) => t === 'home' || t === 'away'

/** A value with the stored value's type (line-ups hold numbers or digit strings). */
function typedLike(sample, value) {
  if (!has(value)) return value
  if (typeof sample === 'number') return Number.isNaN(Number(value)) ? value : Number(value)
  if (typeof sample === 'string') return String(value)
  return value
}

/** A libero exit the rotation wrote (the libero reached the front row). */
export function isRotationLiberoExit(e) {
  return e?.type === 'libero_exit' && /^rotation_to_front_row/.test(String(e.payload?.reason || ''))
}

/** Entries whose line-up sub-row (N.x) is rebuilt here. */
const OWNER_TYPES = new Set(['point', 'substitution', 'libero_entry', 'libero_exit', 'libero_exchange'])

function isOwner(e) {
  if (!OWNER_TYPES.has(e?.type)) return false
  if (e.type === 'libero_exit' && isRotationLiberoExit(e)) return false
  return isTeam(e.payload?.team)
}

/** Positions I-VI of a line-up, values as stored ('' for an empty one). */
function cleanLineup(lineup) {
  const out = {}
  for (const pos of POSITIONS) out[pos] = lineup && has(lineup[pos]) ? lineup[pos] : ''
  return out
}

export function sameLineup(a, b) {
  return POSITIONS.every(pos => String(a?.[pos] ?? '') === String(b?.[pos] ?? ''))
}

function sameLiberoSub(a, b) {
  if (!a && !b) return true
  if (!a || !b) return false
  return a.position === b.position && String(a.liberoNumber ?? '') === String(b.liberoNumber ?? '') && String(a.playerNumber ?? '') === String(b.playerNumber ?? '')
}

function positionOf(lineup, n) {
  return POSITIONS.find(pos => same(lineup?.[pos], n)) || null
}

/** The line-up with the stored row's value types (a rewrite keeps them). */
function typedLineup(computed, stored) {
  const out = {}
  for (const pos of POSITIONS) {
    const sample = stored?.[pos] !== undefined && stored?.[pos] !== '' ? stored[pos] : computed[pos]
    out[pos] = typedLike(sample, computed[pos])
  }
  return out
}

/**
 * One rotation of a team's state (FIVB 7.6): the line-up rotated, the
 * libero's record moved with it, and the libero taken off when he reaches
 * the front row (the player he replaced comes back there).
 */
export function rotateState({ lineup, ls }) {
  const rotated = rotateLineup(cleanLineup(lineup))
  let nextLs = null
  let exit = null
  if (ls) {
    const pos = ROTATION_MOVE[ls.position]
    if (pos && FRONT_ROW.includes(pos)) {
      rotated[pos] = typedLike(rotated[pos], ls.playerNumber)
      exit = { position: pos, liberoOut: ls.liberoNumber, playerIn: ls.playerNumber, liberoType: ls.liberoType }
    } else if (pos) {
      nextLs = { ...ls, position: pos }
    }
  }
  return { lineup: rotated, ls: nextLs, exit }
}

const ISSUE_DEFAULTS = {
  noLineup: 'Set {{set}}: no line-up of {{team}} is recorded before its first point.',
  lineupIncomplete: 'Set {{set}}: the starting line-up of {{team}} has no player at position {{position}}.',
  lineupDuplicate: 'Set {{set}}, {{score}}: #{{n}} stands twice in the line-up of {{team}}.',
  liberoInLineup: 'Set {{set}}: libero #{{n}} is in the starting line-up of {{team}}.',
  notOnRoster: '#{{n}} of {{team}} is not on the roster (set {{set}}).',
  subOutNotOnCourt: 'Set {{set}}, {{score}}: substitution of {{team}}, #{{in}} for #{{out}}: #{{out}} is not on court.',
  subInOnCourt: 'Set {{set}}, {{score}}: substitution of {{team}}, #{{in}} for #{{out}}: #{{in}} is already on court.',
  subLiberoReplaced: 'Set {{set}}, {{score}}: substitution of {{team}}, #{{in}} for #{{out}}: #{{out}} is replaced by libero #{{libero}} at that moment.',
  subLimit: 'Set {{set}}, {{score}}: {{team}} has {{n}} regular substitutions in this set (6 allowed).',
  subInTwice: 'Set {{set}}, {{score}}: #{{n}} of {{team}} comes in a second time in this set.',
  subOutTwice: 'Set {{set}}, {{score}}: #{{n}} of {{team}} goes out a second time in this set.',
  subPairing: 'Set {{set}}, {{score}}: #{{out}} of {{team}} came on for #{{starter}}: only #{{starter}} may replace #{{out}}.',
  liberoEntryNotOnCourt: 'Set {{set}}, {{score}}: libero #{{libero}} in for #{{n}} ({{team}}): #{{n}} is not on court.',
  liberoAlreadyOnCourt: 'Set {{set}}, {{score}}: libero #{{libero}} in ({{team}}): libero #{{other}} is already on court.',
  liberoFrontRow: 'Set {{set}}, {{score}}: libero #{{libero}} replaces #{{n}} of {{team}} in the front row (position {{position}}).',
  notALibero: 'Set {{set}}, {{score}}: #{{n}} of {{team}} replaces a player as libero but is not a libero on the roster.',
  liberoExitNone: 'Set {{set}}, {{score}}: libero exit of {{team}}: no libero is on court.',
  liberoExchangeNone: 'Set {{set}}, {{score}}: libero exchange of {{team}}: no libero is on court.',
  timeoutLimit: 'Set {{set}}, {{score}}: {{team}} has {{n}} time-outs in this set (2 allowed).',
  sanctionLadder: 'Set {{set}}, {{score}}: {{what}} of {{team}}: by the rules this is a {{expected}}.',
  sameSanctionTwice: 'Set {{set}}, {{score}}: {{what}} of {{team}}: this person already has this sanction.',
  teamAlreadyWarned: 'Set {{set}}, {{score}}: {{what}} of {{team}}: the team was already warned.',
  pointsAfterWin: 'Set {{set}} was already won at {{score}}; {{n}} more point(s) follow.',
  setScoreInvalid: 'Set {{set}} ended {{score}}: not a possible final score.',
  setWinnerChanged: 'Set {{set}} is now won by {{team}} ({{score}}).',
  matchNotDecided: 'The match is over but no team has won {{n}} sets ({{result}}).',
  setsAfterMatchWon: 'Set {{set}} is played after the match was already won ({{result}}).'
}

/** The English sentence of an issue key (the panel translates `key`). */
export function issueText(issue, t) {
  const k = String(issue?.key || '').replace(/^corrections\.issue\./, '')
  return tr(t, `corrections.issue.${k}`, ISSUE_DEFAULTS[k] || k, issue?.params || {})
}

function isValidFinalScore(winnerPts, loserPts, setIndex) {
  const toWin = isDecidingSet(setIndex) ? 15 : 25
  return (winnerPts === toWin && loserPts <= toWin - 2) || (winnerPts > toWin && winnerPts - loserPts === 2)
}

/**
 * Rebuild what follows from the entries, for every set of the log.
 * @param {Array} events the match log (after the correction)
 * @param {{ match?: object, players?: {home?: Array, away?: Array}, t?: Function, homeTeam?: object, awayTeam?: object, matchId?: any }} ctx
 * @returns {{ add: Array, update: Array<{id:any, changes:object}>, remove: Array, issues: Array }}
 */
export function recomputeMatch(events, ctx = {}) {
  const out = { add: [], update: [], remove: [], issues: [] }
  const all = [...(events || [])].sort(compareBySeq)
  const sets = [...new Set(all.map(setOf))].sort((a, b) => a - b)
  const roster = rosterNumbers(ctx.players)
  // a player re-designated as libero (FIVB 19.4) played as a regular player before it
  for (const e of all) {
    const r = e.type === 'libero_redesignation' ? roster[e.payload?.team] : null
    if (!r || !has(e.payload?.newLiberoNumber)) continue
    r.redesignatedAt = r.redesignatedAt || new Map()
    if (!r.redesignatedAt.has(String(e.payload.newLiberoNumber))) r.redesignatedAt.set(String(e.payload.newLiberoNumber), e)
  }
  const seenIssue = new Set()
  const issue = (key, params, e, setIndex, extraSig = '') => {
    const sig = `${key}:${e?.id ?? ''}:${setIndex ?? ''}:${extraSig}`
    if (seenIssue.has(sig)) return
    seenIssue.add(sig)
    const full = { key: `corrections.issue.${key}`, params, eventId: e?.id ?? null, setIndex: setIndex ?? null, sig }
    full.text = issueText(full, ctx.t)
    out.issues.push(full)
  }
  for (const setIndex of sets) recomputeSet(all.filter(e => setOf(e) === setIndex), setIndex, ctx, out, issue, roster)
  checkSanctions(all, ctx, issue)
  checkMatchResult(all, ctx, issue)
  return out
}

function rosterNumbers(players) {
  const of = (list) => (Array.isArray(list) && list.length ? {
    all: new Set(list.map(p => String(p?.number))),
    liberos: new Set(list.filter(p => p?.libero && p.libero !== 'unable').map(p => String(p.number))),
    everLiberos: new Set(list.filter(p => p?.libero).map(p => String(p.number)))
  } : null)
  return { home: of(players?.home), away: of(players?.away) }
}

function recomputeSet(rows, setIndex, ctx, out, issue, roster) {
  const match = ctx.match || {}
  const set = displaySetNumber(setIndex, match)
  const label = (team) => teamLabel(team, ctx)?.name || '?'
  const state = { home: { lineup: null, ls: null }, away: { lineup: null, ls: null } }
  const storedPrev = { home: null, away: null } // the last stored line-up row (as written)
  const score = { home: 0, away: 0 }
  let server = getFirstServeForSet(setIndex, match)
  if (!isTeam(server)) server = 'home'
  const firstPoint = rows.find(e => e.type === 'point')
  let wonAt = null
  let afterWin = 0
  const subs = { home: [], away: [] }
  const timeouts = { home: 0, away: 0 }
  const noLineupFlag = { home: false, away: false }
  const scoreText = (team) => formatScore(score, isTeam(team) ? team : null, ctx)
  const checkRoster = (team, n, e) => {
    const r = roster[team]
    if (!r || !has(n) || r.all.has(String(n))) return
    issue('notOnRoster', { n, team: label(team), set }, e, setIndex, `${team}:${n}`)
  }
  const checkDuplicates = (team, lineup, e) => {
    const seen = new Map()
    for (const pos of POSITIONS) {
      const v = lineup?.[pos]
      if (!has(v)) continue
      const k = String(v)
      if (seen.has(k)) issue('lineupDuplicate', { n: v, team: label(team), set, score: scoreText(team) }, e, setIndex, `${team}:${k}`)
      seen.set(k, pos)
    }
  }

  // Group the rows by base seq; within a group the owner (point,
  // substitution, libero entry ...) claims the line-up / rotation exit
  // sub-rows of its team that follow it.
  const groups = []
  for (const e of rows) {
    const b = baseOf(e)
    const g = groups[groups.length - 1]
    if (g && g.base === b) g.rows.push(e)
    else groups.push({ base: b, rows: [e] })
  }

  for (const g of groups) {
    let maxSub = g.rows.reduce((m, e) => Math.max(m, Math.round(((e.seq || 0) - g.base) * 10)), 0)
    const nextSeq = () => { maxSub += 1; return round3(g.base + maxSub / 10) }
    let owner = null

    const flush = () => {
      if (!owner) return
      const { e, expected, lineups, exits } = owner
      const team = e.payload.team
      if (expected.keep) { owner = null; return }
      // the line-up sub-row
      if (expected.lineup) {
        const [first, ...extra] = lineups
        if (first) {
          const p = first.payload || {}
          const nextLineup = typedLineup(expected.lineup.lineup, p.lineup)
          const lsChanged = !sameLiberoSub(p.liberoSubstitution || null, expected.lineup.liberoSubstitution || null)
          if (!sameLineup(p.lineup, nextLineup) || lsChanged) {
            const payload = { ...p, lineup: nextLineup }
            if (lsChanged || 'liberoSubstitution' in p) payload.liberoSubstitution = expected.lineup.liberoSubstitution || null
            out.update.push({ id: first.id, changes: { payload } })
          }
        } else {
          out.add.push(newRow(ctx, { type: 'lineup', setIndex, seq: nextSeq(), ts: e.ts, payload: { team, ...expected.lineup } }))
        }
        for (const x of extra) out.remove.push(x.id)
      } else {
        for (const x of lineups) out.remove.push(x.id)
      }
      // the automatic libero exit (rotation to the front row)
      if (expected.exit) {
        const [first, ...extra] = exits
        const want = { team, ...expected.exit }
        if (first) {
          const p = first.payload || {}
          if (p.position !== want.position || !same(p.liberoOut, want.liberoOut) || !same(p.playerIn, want.playerIn)) {
            out.update.push({ id: first.id, changes: { payload: { ...p, position: want.position, liberoOut: typedLike(p.liberoOut, want.liberoOut), playerIn: typedLike(p.playerIn, want.playerIn) } } })
          }
        } else {
          out.add.push(newRow(ctx, { type: 'libero_exit', setIndex, seq: nextSeq(), ts: e.ts, payload: { ...want, reason: 'rotation_to_front_row' } }))
        }
        for (const x of extra) out.remove.push(x.id)
      } else {
        for (const x of exits) out.remove.push(x.id)
      }
      owner = null
    }

    for (const e of g.rows) {
      const p = e.payload || {}
      const team = p.team
      if (e.type === 'lineup' && isTeam(team)) {
        const claimable = owner && owner.e.payload.team === team && isSubRow(e) && p.isInitial !== true && p.mode !== 'manual' && !owner.expected.keep
        if (claimable) {
          owner.lineups.push(e)
          storedPrev[team] = p
          continue
        }
        // a rotation the point once wrote for the other team (its team was
        // changed since): that team did not rotate on this point
        if (owner && owner.e.type === 'point' && owner.e.payload.team !== team && isSubRow(e) && p.isInitial !== true && p.mode !== 'manual' && !p.fromSubstitution) {
          out.remove.push(e.id)
          continue
        }
        // an entered line-up: the starting one, a pre-rally rectification,
        // or a correction after the first rally (replayed relative to the
        // line-up it corrected)
        const beforeFirstPoint = !firstPoint || compareBySeq(e, firstPoint) < 0
        if (p.isInitial === true || beforeFirstPoint || !storedPrev[team] || !state[team].lineup) {
          state[team] = { lineup: cleanLineup(p.lineup), ls: p.liberoSubstitution || null }
          if (p.isInitial === true || beforeFirstPoint) {
            const lu = p.lineup || {}
            for (const pos of POSITIONS) {
              if (!has(lu[pos])) issue('lineupIncomplete', { team: label(team), set, position: pos }, e, setIndex, pos)
              else {
                checkRoster(team, lu[pos], e)
                const r = roster[team]
                const redesignation = r?.redesignatedAt?.get(String(lu[pos]))
                const liberoThen = r && r.everLiberos.has(String(lu[pos])) && !(redesignation && compareBySeq(e, redesignation) < 0)
                if (liberoThen) issue('liberoInLineup', { n: lu[pos], team: label(team), set }, e, setIndex, String(lu[pos]))
              }
            }
          }
        } else {
          const mapped = relativeLineup(p, storedPrev[team], state[team])
          if (!sameLineup(p.lineup, mapped.lineup) || !sameLiberoSub(p.liberoSubstitution || null, mapped.ls || null)) {
            const payload = { ...p, lineup: typedLineup(mapped.lineup, p.lineup) }
            if ('liberoSubstitution' in p || mapped.ls) payload.liberoSubstitution = mapped.ls || null
            out.update.push({ id: e.id, changes: { payload } })
          }
          state[team] = { lineup: mapped.lineup, ls: mapped.ls }
        }
        storedPrev[team] = p
        checkDuplicates(team, state[team].lineup, e)
        continue
      }
      if (isRotationLiberoExit(e)) {
        if (owner && owner.e.type === 'point' && owner.e.payload.team === team && !owner.expected.keep) owner.exits.push(e)
        else out.remove.push(e.id)
        continue
      }
      if (isOwner(e)) {
        flush()
        owner = { e, expected: {}, lineups: [], exits: [] }
        applyOwner(owner, { state, score, ctx, setIndex, set, label, scoreText, issue, out, roster, subs, checkRoster, checkDuplicates, getServer: () => server, setServer: (s) => { server = s }, noLineupFlag })
        if (e.type === 'point' && isTeam(team)) {
          if (wonAt) afterWin += 1
          const res = getSetResult(score.home, score.away, setIndex)
          if (res.winner && !wonAt) wonAt = { ...score, e }
        }
        continue
      }
      if (e.type === 'timeout' && isTeam(team)) {
        timeouts[team] += 1
        if (timeouts[team] > 2) issue('timeoutLimit', { team: label(team), set, n: timeouts[team], score: scoreText(team) }, e, setIndex)
        continue
      }
      if (e.type === 'set_end') {
        flush()
        checkSetEnd(e, { score, setIndex, set, ctx, issue, out, label })
      }
    }
    flush()
  }

  if (wonAt && afterWin > 0) {
    issue('pointsAfterWin', { set, score: formatScore(wonAt, null, ctx), n: afterWin }, wonAt.e, setIndex)
  }
}

/** A line-up corrected after the first rally, replayed on the new state. */
function relativeLineup(payload, storedPrevPayload, current) {
  const prev = cleanLineup(storedPrevPayload?.lineup)
  const src = payload.lineup || {}
  const lineup = {}
  for (const pos of POSITIONS) {
    const v = src[pos]
    const from = has(v) ? positionOf(prev, v) : null
    lineup[pos] = from ? current.lineup[from] : (has(v) ? v : '')
  }
  let ls = payload.liberoSubstitution || null
  if (ls) {
    const pos = positionOf(lineup, ls.liberoNumber) || ls.position
    const prevLs = storedPrevPayload?.liberoSubstitution
    const playerNumber = prevLs && same(prevLs.playerNumber, ls.playerNumber) && current.ls ? current.ls.playerNumber : ls.playerNumber
    ls = { ...ls, position: pos, playerNumber: typedLike(ls.playerNumber, playerNumber) }
  }
  return { lineup, ls }
}

function applyOwner(owner, env) {
  const { state, score, setIndex, set, label, scoreText, issue, out, roster, subs, checkRoster, checkDuplicates } = env
  const e = owner.e
  const p = e.payload || {}
  const team = p.team
  const st = state[team]
  const headUpdate = (changes) => {
    const payload = { ...p }
    let changed = false
    for (const [k, v] of Object.entries(changes)) {
      const nv = typedLike(p[k], v)
      if (String(p[k] ?? '') !== String(nv ?? '')) { payload[k] = nv; changed = true }
    }
    if (changed) out.update.push({ id: e.id, changes: { payload } })
    return payload
  }

  if (e.type === 'point') {
    // the running score the point carries
    if (team === 'home') score.home += 1
    else score.away += 1
    if (p.score && (Number(p.score.home) !== score.home || Number(p.score.away) !== score.away)) {
      out.update.push({ id: e.id, changes: { payload: { ...p, score: { ...p.score, home: score.home, away: score.away } } } })
    }
    // an awarded point (forfeit) has no rally: no rotation
    if (p.forfeitAwarded) { owner.expected = { keep: true }; return }
    const server = env.getServer()
    env.setServer(team)
    if (server === team) { owner.expected = {}; return }
    if (!st.lineup) {
      if (!env.noLineupFlag[team]) {
        env.noLineupFlag[team] = true
        // an easy match plays without line-ups when it likes (domain/easyMatch)
        if (env.ctx.match?.easy !== true) issue('noLineup', { team: label(team), set }, e, setIndex, team)
      }
      owner.expected = { keep: true }
      return
    }
    const r = rotateState(st)
    state[team] = { lineup: r.lineup, ls: r.ls }
    owner.expected = { lineup: { lineup: r.lineup, liberoSubstitution: r.ls }, exit: r.exit }
    return
  }

  if (!st.lineup) {
    if (!env.noLineupFlag[team]) {
      env.noLineupFlag[team] = true
      if (env.ctx.match?.easy !== true) issue('noLineup', { team: label(team), set }, e, setIndex, team)
    }
    owner.expected = { keep: true }
    return
  }
  const lineup = { ...st.lineup }
  let ls = st.ls ? { ...st.ls } : null
  const sc = scoreText(team)

  if (e.type === 'substitution') {
    const exceptional = !!(p.isExceptional || p.isExpelled || p.isDisqualified || p.isLiberoReplacementSub)
    let pos = positionOf(lineup, p.playerOut)
    if (!pos && ls && same(ls.playerNumber, p.playerOut)) {
      // the player the libero replaced is substituted (expulsion with the
      // libero on court): the libero stays, the substitute is the player
      // who comes back when he leaves
      if (!exceptional) issue('subLiberoReplaced', { team: label(team), set, score: sc, in: p.playerIn, out: p.playerOut, libero: ls.liberoNumber }, e, setIndex)
      ls = { ...ls, playerNumber: typedLike(ls.playerNumber, p.playerIn) }
    } else {
      if (!pos) {
        issue('subOutNotOnCourt', { team: label(team), set, score: sc, in: p.playerIn, out: p.playerOut }, e, setIndex)
        if (POSITIONS.includes(p.position) && !(ls && ls.position === p.position)) pos = p.position
      }
      if (pos) {
        if (POSITIONS.some(x => x !== pos && same(lineup[x], p.playerIn))) issue('subInOnCourt', { team: label(team), set, score: sc, in: p.playerIn, out: p.playerOut }, e, setIndex)
        lineup[pos] = typedLike(lineup[pos], p.playerIn)
        headUpdate({ position: pos })
      }
    }
    checkRoster(team, p.playerIn, e)
    checkRoster(team, p.playerOut, e)
    // the substitution rules (FIVB 15.5-15.6), as validateManualSubstitution
    if (!exceptional) {
      const prior = subs[team].filter(s => !s.payload?.isExceptional)
      const n = prior.length + 1
      if (n > MAX_SUBSTITUTIONS_PER_SET) issue('subLimit', { team: label(team), set, score: sc, n }, e, setIndex)
      if (prior.some(s => same(s.payload?.playerIn, p.playerIn))) issue('subInTwice', { team: label(team), set, score: sc, n: p.playerIn }, e, setIndex)
      if (prior.some(s => same(s.payload?.playerOut, p.playerOut))) issue('subOutTwice', { team: label(team), set, score: sc, n: p.playerOut }, e, setIndex)
      const cameOnAs = prior.find(s => same(s.payload?.playerIn, p.playerOut))
      if (cameOnAs && !same(cameOnAs.payload?.playerOut, p.playerIn)) {
        issue('subPairing', { team: label(team), set, score: sc, out: p.playerOut, starter: cameOnAs.payload?.playerOut }, e, setIndex)
      }
    }
    subs[team].push(e)
    state[team] = { lineup, ls }
    checkDuplicates(team, lineup, e)
    owner.expected = { lineup: { lineup, ...(ls ? { liberoSubstitution: ls } : {}), fromSubstitution: true } }
    return
  }

  if (e.type === 'libero_entry') {
    const r = roster[team]
    if (r && has(p.liberoIn) && !r.everLiberos.has(String(p.liberoIn))) issue('notALibero', { team: label(team), set, score: sc, n: p.liberoIn }, e, setIndex)
    if (ls) issue('liberoAlreadyOnCourt', { team: label(team), set, score: sc, libero: p.liberoIn, other: ls.liberoNumber }, e, setIndex)
    let pos = positionOf(lineup, p.playerOut)
    if (!pos) {
      issue('liberoEntryNotOnCourt', { team: label(team), set, score: sc, libero: p.liberoIn, n: p.playerOut }, e, setIndex)
      if (POSITIONS.includes(p.position)) pos = p.position
    }
    if (pos) {
      if (FRONT_ROW.includes(pos)) issue('liberoFrontRow', { team: label(team), set, score: sc, libero: p.liberoIn, n: p.playerOut, position: pos }, e, setIndex)
      lineup[pos] = has(lineup[pos]) && typeof lineup[pos] === 'number' ? Number(p.liberoIn) : String(p.liberoIn)
      ls = { position: pos, liberoNumber: p.liberoIn, playerNumber: p.playerOut, ...(p.liberoType !== undefined ? { liberoType: p.liberoType } : {}) }
      headUpdate({ position: pos })
    }
    checkRoster(team, p.liberoIn, e)
    checkRoster(team, p.playerOut, e)
    state[team] = { lineup, ls }
    checkDuplicates(team, lineup, e)
    owner.expected = { lineup: { lineup, liberoSubstitution: ls } }
    return
  }

  if (e.type === 'libero_exit') {
    if (!ls) {
      issue('liberoExitNone', { team: label(team), set, score: sc }, e, setIndex)
    } else {
      const pos = positionOf(lineup, ls.liberoNumber) || ls.position
      lineup[pos] = typedLike(lineup[pos], ls.playerNumber)
      headUpdate({ position: pos, liberoOut: ls.liberoNumber, playerIn: ls.playerNumber })
      ls = null
    }
    state[team] = { lineup, ls }
    checkDuplicates(team, lineup, e)
    owner.expected = { lineup: { lineup, fromSubstitution: true, liberoSubstitution: null } }
    return
  }

  if (e.type === 'libero_exchange') {
    if (!ls) {
      issue('liberoExchangeNone', { team: label(team), set, score: sc }, e, setIndex)
    } else {
      const pos = positionOf(lineup, ls.liberoNumber) || ls.position
      lineup[pos] = typedLike(lineup[pos], p.liberoIn)
      headUpdate({ position: pos, liberoOut: ls.liberoNumber, playerNumber: ls.playerNumber })
      ls = { ...ls, position: pos, liberoNumber: p.liberoIn, ...(p.liberoInType !== undefined ? { liberoType: p.liberoInType } : {}) }
    }
    checkRoster(team, p.liberoIn, e)
    state[team] = { lineup, ls }
    checkDuplicates(team, lineup, e)
    owner.expected = { lineup: { lineup, liberoSubstitution: ls } }
  }
}

function checkSetEnd(e, { score, setIndex, set, ctx, issue, out, label }) {
  const p = e.payload || {}
  if (p.reason === 'forfait') return
  const res = getSetResult(score.home, score.away, setIndex)
  const final = formatScore(score, null, ctx)
  if (!res.winner) {
    issue('setScoreInvalid', { set, score: final }, e, setIndex)
    return
  }
  const loser = otherTeam(res.winner)
  if (!isValidFinalScore(score[res.winner], score[loser], setIndex)) issue('setScoreInvalid', { set, score: final }, e, setIndex)
  if (isTeam(p.team) && p.team !== res.winner) {
    const letter = teamLabel(res.winner, ctx)?.letter
    out.update.push({ id: e.id, changes: { payload: { ...p, team: res.winner, ...(p.teamLabel !== undefined || letter ? { teamLabel: letter } : {}) } } })
    issue('setWinnerChanged', { set, team: label(res.winner), score: final }, e, setIndex)
  }
}

/** Sanction levels across the match (the delay ladder, one warning per team). */
function checkSanctions(all, ctx, issue) {
  const prior = []
  for (const e of all) {
    if (e.type !== 'sanction') continue
    const p = e.payload || {}
    const type = p.type || p.sanctionType
    const team = p.team
    if (!type || !isTeam(team)) { prior.push(e); continue }
    const setIndex = setOf(e)
    const set = displaySetNumber(setIndex, ctx.match)
    const before = scoreAt(all, e)
    const sc = formatScore(before, team, ctx)
    const what = sanctionLabel(type, ctx.t)
    const name = teamLabel(team, ctx)?.name || '?'
    const teamPrior = prior.filter(x => x.payload?.team === team)
    if (isTeamSanctionType(type)) {
      const expected = resolveSanction(type, {
        priorDelayCount: teamPrior.filter(x => isDelaySanction(x.payload?.type)).length,
        priorImproperCount: teamPrior.filter(x => x.payload?.type === 'improper_request').length
      })
      if (expected !== type) issue('sanctionLadder', { set, score: sc, what, team: name, expected: sanctionLabel(expected, ctx.t).toLowerCase() }, e, setIndex)
    } else {
      const v = validateMemberSanction(prior, { team, playerNumber: p.playerNumber, role: p.role, type })
      if (!v.legal) issue(v.reason, { set, score: sc, what, team: name }, e, setIndex)
    }
    prior.push(e)
  }
}

function scoreAt(all, ev) {
  const s = { home: 0, away: 0 }
  for (const e of all) {
    if (e === ev) break
    if (e.type !== 'point' || setOf(e) !== setOf(ev)) continue
    if (e.payload?.team === 'home') s.home++
    else if (e.payload?.team === 'away') s.away++
  }
  return s
}

/** The match result from the set ends: decided once, and only once. */
function checkMatchResult(all, ctx, issue) {
  const match = ctx.match || {}
  if (match.forfeitTeam || match.stoppedReason) return
  const need = setsToWin(Number(match.bestOf) === 3 ? 3 : 5)
  const won = { home: 0, away: 0 }
  const ends = all.filter(e => e.type === 'set_end').sort((a, b) => setOf(a) - setOf(b) || compareBySeq(a, b))
  const scoreOf = (setIndex) => {
    const s = { home: 0, away: 0 }
    for (const e of all) if (e.type === 'point' && setOf(e) === setIndex) s[e.payload?.team === 'home' ? 'home' : 'away'] += isTeam(e.payload?.team) ? 1 : 0
    return s
  }
  const resultText = () => `${won[teamAKey(match)]}:${won[otherTeam(teamAKey(match))]}`
  let decided = false
  for (const e of ends) {
    const setIndex = setOf(e)
    if (decided) {
      issue('setsAfterMatchWon', { set: displaySetNumber(setIndex, match), result: resultText() }, e, setIndex)
      continue
    }
    const s = scoreOf(setIndex)
    const w = e.payload?.reason === 'forfait' && isTeam(e.payload?.team) ? e.payload.team : getSetResult(s.home, s.away, setIndex).winner
    if (w) won[w] += 1
    if (won.home >= need || won.away >= need) decided = true
  }
  if (match.status === 'ended' && !decided && ends.length > 0) {
    issue('matchNotDecided', { n: need, result: resultText() }, null, null)
  }
}

function teamAKey(match) {
  return match?.coinTossTeamA === 'away' ? 'away' : 'home'
}

let tempCounter = 0
function newRow(ctx, fields) {
  tempCounter += 1
  return { matchId: ctx?.matchId, stateSnapshot: null, manual: true, recomputed: true, tempKey: `rc:${tempCounter}`, ...fields }
}

/** The event log after a plan (new rows get their temp key as id). Pure. */
export function applyPlanToEvents(events, plan) {
  const removed = new Set(plan?.remove || [])
  const upd = new Map()
  for (const u of plan?.update || []) upd.set(u.id, { ...(upd.get(u.id) || {}), ...u.changes })
  const kept = (events || [])
    .filter(e => !removed.has(e.id))
    .map(e => (upd.has(e.id) ? { ...e, ...upd.get(e.id) } : e))
  const added = (plan?.add || []).filter(r => !removed.has(r.tempKey)).map(r => ({ ...r, id: r.id ?? r.tempKey }))
  return kept.concat(added).sort(compareBySeq)
}

/** The inconsistencies of a log as it is now (the panel's "Check these entries"). */
export function matchIssues(events, ctx = {}) {
  return recomputeMatch(events, ctx).issues
}

/**
 * Complete a correction plan with everything that follows from it: the
 * rebuilt rows merged into the plan (a rebuilt row of a row the plan adds
 * is folded into that row), the sets whose score changed, and the issues
 * the correction leaves (plan.issues: all of them; plan.newIssues: those
 * that were not there before, shown in the preview).
 * The match the rebuild reads is the match after plan.matchPatch.
 */
export function finalizePlan(events, plan, ctx = {}) {
  if (!plan || plan.error) return plan
  const match = { ...(ctx.match || {}), ...(plan.matchPatch || {}) }
  const rctx = { ...ctx, match }
  const after = applyPlanToEvents(events, plan)
  const rc = recomputeMatch(after, rctx)

  const addedByKey = new Map((plan.add || []).map(r => [r.tempKey, r]))
  const updates = new Map()
  for (const u of plan.update || []) updates.set(u.id, { ...(updates.get(u.id) || {}), ...u.changes })
  for (const u of rc.update) {
    const row = addedByKey.get(u.id)
    if (row) Object.assign(row, u.changes)
    else updates.set(u.id, { ...(updates.get(u.id) || {}), ...u.changes })
  }
  const removed = new Set(plan.remove || [])
  for (const id of rc.remove) {
    if (addedByKey.has(id)) addedByKey.delete(id)
    else removed.add(id)
  }
  plan.add = [...addedByKey.values(), ...rc.add]
  plan.remove = [...removed]
  plan.update = [...updates.entries()].filter(([id]) => !removed.has(id)).map(([id, changes]) => ({ id, changes }))

  // sets whose score changed: their set row, set end and cloud copy follow
  const afterAll = applyPlanToEvents(events, plan)
  const affected = new Set(plan.affectedSets || [])
  const scoreKey = (list, s) => list.filter(e => e.type === 'point' && setOf(e) === s).map(e => e.payload?.team).join('')
  for (const s of new Set([...events.map(setOf), ...afterAll.map(setOf)])) {
    if (scoreKey(events, s) !== scoreKey(afterAll, s)) affected.add(s)
  }
  plan.affectedSets = [...affected].sort((a, b) => a - b)

  const beforeSigs = new Set(recomputeMatch(events, { ...ctx }).issues.map(i => i.sig))
  plan.issues = rc.issues
  plan.newIssues = rc.issues.filter(i => !beforeSigs.has(i.sig))
  plan.recomputed = { added: rc.add.length, updated: rc.update.length, removed: rc.remove.length }
  return plan
}
