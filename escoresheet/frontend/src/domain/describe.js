/**
 * Human descriptions of the match event log, in the words of the paper
 * scoresheet — no React, no Dexie.
 *
 * Every list in the corrections screens (during the match and at the match
 * end), the Undo confirmation and the correction log goes through here, so a
 * raw event type ("improper_request"), a raw target ("bench: #8", ": #") or a
 * home/away score never reaches the scorer.
 *
 * Conventions (Swiss Volley scorekeeper course, field-spec §7.2 / §8):
 *  - a score is written with the CONCERNED team first ("B 17:11 A"): the team
 *    that took the time-out, made the substitution or was sanctioned; with no
 *    concerned team (a point, a set result) Team A comes first ("A 25:23 B");
 *  - a bench player's sanction is a circled number "(8)", officials are
 *    C / AC1 / AC2 / P / M and a team delay is D;
 *  - remarks always start "Team A/B, Set n, Result x:y" (concerned team first).
 *
 * `t` is i18next's t (or nothing in tests): every string has its English text
 * as the default, so the en locale and the tests read the same.
 */

/** The sanction types the app records, in ladder order. */
export const SANCTION_TYPES = Object.freeze([
  'delay_warning', 'delay_penalty', 'improper_request',
  'warning', 'penalty', 'expulsion', 'disqualification'
])

/** Sanctions given to a team (no person): delays and the improper request. */
export const TEAM_SANCTION_TYPES = Object.freeze(['improper_request', 'delay_warning', 'delay_penalty'])

const SANCTION_DEFAULTS = {
  improper_request: 'Improper request',
  delay_warning: 'Delay warning',
  delay_penalty: 'Delay penalty',
  warning: 'Warning',
  penalty: 'Penalty',
  expulsion: 'Expulsion',
  disqualification: 'Disqualification'
}

// Bench official roles as stored on the sanction payload (role) -> key + paper code
const ROLE_TARGETS = [
  { match: ['coach', 'c'], key: 'coach', label: 'Coach', code: 'C' },
  { match: ['assistant coach 1', 'assistantcoach1', 'ac1', 'assistant coach'], key: 'ac1', label: 'Assistant coach 1', code: 'AC1' },
  { match: ['assistant coach 2', 'assistantcoach2', 'ac2'], key: 'ac2', label: 'Assistant coach 2', code: 'AC2' },
  { match: ['physiotherapist', 'physio', 'p'], key: 'physio', label: 'Physiotherapist', code: 'P' },
  { match: ['medic', 'doctor', 'medical doctor', 'm'], key: 'doctor', label: 'Doctor', code: 'M' }
]

/** Replace {{name}} placeholders. */
function interpolate(text, params = {}) {
  return String(text ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (params[k] ?? params[k] === 0 ? String(params[k]) : ''))
}

/**
 * Translate with an English default. Works with i18next's t and with no t at
 * all (pure tests), and never returns the bare key.
 */
export function tr(t, key, def, params = {}) {
  if (typeof t === 'function') {
    const out = t(key, { defaultValue: def, ...params })
    if (typeof out === 'string' && out && out !== key) return out
  }
  return interpolate(def, params)
}

/** "improper_request" -> "Improper request". Never leaves an underscore. */
export function humanize(value) {
  const s = String(value ?? '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim()
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : ''
}

/** Set number as the sheet prints it (best of 3: the deciding set, index 5, is set 3). */
export function displaySetNumber(setIndex, match) {
  const idx = Number(setIndex) || 1
  return (Number(match?.bestOf) || 5) === 3 && idx === 5 ? 3 : idx
}

/** True when the coin toss decided which team is A (old matches may not have it). */
export function hasTeamDesignation(match) {
  return match?.coinTossTeamA === 'home' || match?.coinTossTeamA === 'away'
}

/** 'A' or 'B' for a team key, from the coin toss (home = A when it is missing). */
export function teamLetter(teamKey, match) {
  if (teamKey !== 'home' && teamKey !== 'away') return ''
  const a = hasTeamDesignation(match) ? match.coinTossTeamA : 'home'
  return teamKey === a ? 'A' : 'B'
}

/** The team key that is Team A. */
export function teamAKeyOf(match) {
  return hasTeamDesignation(match) ? match.coinTossTeamA : 'home'
}

export function otherTeam(teamKey) {
  return teamKey === 'home' ? 'away' : teamKey === 'away' ? 'home' : null
}

/**
 * { key, name, letter, color } of a team. Rows render it as a colour dot, the
 * name and "(A)".
 */
export function teamLabel(teamKey, ctx = {}) {
  if (teamKey !== 'home' && teamKey !== 'away') return null
  const team = teamKey === 'home' ? ctx.homeTeam : ctx.awayTeam
  const letter = teamLetter(teamKey, ctx.match)
  const fallback = tr(ctx.t, 'corrections.teamLetter', 'Team {{letter}}', { letter })
  return {
    key: teamKey,
    name: team?.name || team?.shortName || fallback,
    letter,
    color: team?.color || (teamKey === 'home' ? '#3b82f6' : '#ef4444')
  }
}

/** "VC Smash (A)" */
export function teamNameWithLetter(teamKey, ctx = {}) {
  const lbl = teamLabel(teamKey, ctx)
  if (!lbl) return ''
  return tr(ctx.t, 'corrections.teamWithLetter', '{{name}} ({{letter}})', { name: lbl.name, letter: lbl.letter })
}

/** The human name of a sanction type; an unknown type is humanised, never raw. */
export function sanctionLabel(type, t) {
  if (SANCTION_DEFAULTS[type]) return tr(t, `corrections.sanction.${type}`, SANCTION_DEFAULTS[type])
  return humanize(type) || tr(t, 'corrections.term.sanction', 'Sanction')
}

/** True for the team sanctions (no person): improper request and delays. */
export function isTeamSanctionType(type) {
  return TEAM_SANCTION_TYPES.includes(type)
}

function roleTarget(role) {
  const r = String(role ?? '').trim().toLowerCase()
  if (!r) return null
  return ROLE_TARGETS.find(x => x.match.includes(r)) || null
}

const hasNumber = (n) => n !== undefined && n !== null && n !== '' && n !== '?'

/**
 * Who a sanction was given to, as a label and as its paper code.
 *   player   -> "Player #8"            code "8"
 *   bench    -> "Player #8 (bench)"    code "(8)"  (circled on paper)
 *   libero   -> "Libero #8"            code "8"
 *   official -> "Coach" / "Assistant coach 1" / ... code "C" / "AC1" / "AC2" / "P" / "M"
 *   none     -> "Team"                 code "D" for a delay
 * `incomplete` flags a person sanction with no number (rows written by the old
 * editor) so the list can offer to complete it.
 * @returns {{ kind: string, label: string, code: string, incomplete: boolean }}
 */
export function sanctionTarget(payload, t) {
  const p = payload || {}
  const type = p.type || p.sanctionType
  const pt = p.playerType
  const n = p.playerNumber

  const official = roleTarget(p.role)
  if (pt === 'official' || pt === 'coach' || pt === 'bench_official' || (official && !hasNumber(n))) {
    const target = official || (pt === 'coach' ? ROLE_TARGETS[0] : null)
    if (target) return { kind: target.key, label: tr(t, `corrections.target.${target.key}`, target.label), code: target.code, incomplete: false }
    return { kind: 'official', label: tr(t, 'corrections.target.official', 'Team official'), code: '?', incomplete: true }
  }
  if (pt === 'bench') {
    const num = hasNumber(n) ? n : '?'
    return { kind: 'bench', label: tr(t, 'corrections.target.bench', 'Player #{{n}} (bench)', { n: num }), code: `(${num})`, incomplete: !hasNumber(n) }
  }
  if (pt === 'libero') {
    const num = hasNumber(n) ? n : '?'
    return { kind: 'libero', label: tr(t, 'corrections.target.libero', 'Libero #{{n}}', { n: num }), code: String(num), incomplete: !hasNumber(n) }
  }
  if (pt === 'player' || hasNumber(n)) {
    const num = hasNumber(n) ? n : '?'
    return { kind: 'player', label: tr(t, 'corrections.target.player', 'Player #{{n}}', { n: num }), code: String(num), incomplete: !hasNumber(n) }
  }
  // No person: a team sanction (improper request, delay) — or an old row
  // that lost its target, which is still shown as the team.
  const delay = type === 'delay_warning' || type === 'delay_penalty'
  return {
    kind: 'team',
    label: tr(t, 'corrections.target.team', 'Team'),
    code: delay ? 'D' : '',
    incomplete: !!type && !isTeamSanctionType(type)
  }
}

/**
 * The one score format: the concerned team's points first, with its letter
 * ("B 17:11 A"); without a concerned team, Team A first ("A 25:23 B").
 * @param {{home:number, away:number}} score
 * @param {'home'|'away'|null} concernedTeam
 */
export function formatScore(score, concernedTeam, ctx = {}) {
  const home = Number(score?.home ?? score?.homePoints ?? 0) || 0
  const away = Number(score?.away ?? score?.awayPoints ?? 0) || 0
  const first = concernedTeam === 'home' || concernedTeam === 'away' ? concernedTeam : teamAKeyOf(ctx.match)
  const second = otherTeam(first)
  const pts = (k) => (k === 'home' ? home : away)
  return tr(ctx.t, 'corrections.score', '{{first}} {{a}}:{{b}} {{second}}', {
    first: teamLetter(first, ctx.match),
    a: pts(first),
    b: pts(second),
    second: teamLetter(second, ctx.match)
  })
}

/** The concerned team's points first, digits only ("17:11"), for remarks. */
export function plainScore(score, concernedTeam) {
  const home = Number(score?.home ?? 0) || 0
  const away = Number(score?.away ?? 0) || 0
  return concernedTeam === 'away' ? `${away}:${home}` : `${home}:${away}`
}

/** Event order of the log: seq, then the timestamp when seq is missing. */
export function compareBySeq(a, b) {
  const aSeq = a?.seq || 0
  const bSeq = b?.seq || 0
  if (aSeq !== bSeq) return aSeq - bSeq
  return tsMs(a?.ts) - tsMs(b?.ts)
}

/** A stored event time in ms (ISO string or epoch ms); 0 when it is not a time. */
export function tsMs(ts) {
  if (typeof ts === 'number') return ts > 1e11 ? ts : 0
  const v = Date.parse(ts)
  return Number.isFinite(v) ? v : 0
}

/**
 * Home/away score when `event` was logged: the points of the same set that
 * come before it in the log (seq order). The stored stateSnapshot is never
 * read — it is stale after a correction, and the scoresheet does not read it
 * either (scoresheet_pdf/utils/scoresheetModel getScoreBeforeEvent).
 */
export function scoreBeforeEvent(events, event) {
  let home = 0
  let away = 0
  const setIndex = event?.setIndex ?? 1
  for (const e of events || []) {
    if (e === event || e?.type !== 'point' || (e.id != null && e.id === event?.id)) continue
    if ((e.setIndex ?? 1) !== setIndex) continue
    if (compareBySeq(e, event) > 0) continue
    if (e.payload?.team === 'home') home++
    else if (e.payload?.team === 'away') away++
  }
  return { home, away }
}

/** Score after a point event (the point included). */
function scoreAfterPoint(events, point) {
  const s = scoreBeforeEvent(events, point)
  if (point.payload?.team === 'home') s.home++
  else if (point.payload?.team === 'away') s.away++
  return s
}

function clock(value) {
  const ms = tsMs(value)
  if (!ms) return ''
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** "19:42–20:07 (25 min)" for a set's start and end time, '' when unknown. */
export function setTimesText(startTime, endTime, t) {
  const s = clock(startTime)
  const e = clock(endTime)
  if (!s && !e) return ''
  if (s && e) {
    const minutes = Math.max(0, Math.round((tsMs(endTime) - tsMs(startTime)) / 60000))
    return tr(t, 'corrections.setTimesValue', '{{start}}–{{end}} ({{minutes}} min)', { start: s, end: e, minutes })
  }
  return s || e
}

const LIBERO_SHORT = { libero1: 'L1', libero2: 'L2', redesignated: 'LR' }

/**
 * One event of the log as the scorer reads it on paper.
 * @returns {null | {
 *   kind: string, title: string, detail: string, score: string,
 *   scoreValue: {home:number, away:number}|null, team: object|null,
 *   setIndex: number, setLabel: string, code: string, exceptional: boolean,
 *   incomplete: boolean, text: string
 * }} null for the automatic rows a scorer never wrote (rotation line-ups,
 *   rally starts, set starts, the automatic libero exit at the front row).
 */
export function describeEvent(event, events, ctx = {}) {
  if (!event) return null
  const { t } = ctx
  const p = event.payload || {}
  const setIndex = event.setIndex ?? p.setIndex ?? 1
  const setLabel = tr(t, 'corrections.term.set', 'Set {{n}}', { n: displaySetNumber(setIndex, ctx.match) })
  const team = teamLabel(p.team, ctx)
  const teamText = team ? teamNameWithLetter(p.team, ctx) : ''
  const before = scoreBeforeEvent(events, event)
  const num = (n) => (hasNumber(n) ? n : '?')

  let title = ''
  let detail = ''
  let scoreValue = before
  let concerned = p.team === 'home' || p.team === 'away' ? p.team : null
  let code = ''
  let exceptional = false
  let incomplete = false

  switch (event.type) {
    case 'rally_start':
    case 'set_start':
      return null
    case 'point': {
      title = tr(t, 'corrections.describe.point', 'Point for {{team}}', { team: team?.name || '?' })
      scoreValue = scoreAfterPoint(events, event)
      concerned = null
      break
    }
    case 'timeout':
      title = tr(t, 'corrections.term.timeout', 'Time-out')
      break
    case 'substitution': {
      exceptional = p.isExceptional === true
      title = exceptional
        ? tr(t, 'corrections.term.exceptionalSubstitution', 'Exceptional substitution')
        : tr(t, 'corrections.term.substitution', 'Substitution')
      detail = tr(t, 'corrections.describe.subInFor', '#{{in}} in for #{{out}}', { in: num(p.playerIn), out: num(p.playerOut) })
      incomplete = !hasNumber(p.playerIn) || !hasNumber(p.playerOut)
      break
    }
    case 'sanction': {
      const type = p.type || p.sanctionType
      const target = sanctionTarget(p, t)
      title = `${sanctionLabel(type, t)} — ${target.label}`
      code = target.code
      incomplete = target.incomplete
      if ((type === 'penalty' || type === 'delay_penalty') && p.team) {
        const opp = teamLabel(otherTeam(p.team), ctx)
        detail = tr(t, 'corrections.describe.pointTo', '+1 point to {{team}}', { team: opp?.name || '?' })
      }
      break
    }
    case 'lineup': {
      if (p.isInitial === true) {
        title = tr(t, 'corrections.describe.startingLineup', 'Starting line-up')
        detail = ['I', 'II', 'III', 'IV', 'V', 'VI'].map(pos => p.lineup?.[pos] ?? '?').join(' · ')
        break
      }
      if (p.fromSubstitution || p.fromRotation || p.liberoSubstitution !== undefined || p.isInitial !== false) return null
      title = tr(t, 'corrections.describe.lineupCorrected', 'Line-up corrected')
      detail = ['I', 'II', 'III', 'IV', 'V', 'VI'].map(pos => p.lineup?.[pos] ?? '?').join(' · ')
      break
    }
    case 'libero_entry':
      title = tr(t, 'corrections.describe.liberoIn', 'Libero #{{libero}} in for #{{player}}', { libero: num(p.liberoIn), player: num(p.playerOut) })
      code = LIBERO_SHORT[p.liberoType] || ''
      break
    case 'libero_exit':
      if (p.reason === 'rotation_to_front_row' || p.reason === 'rotation_to_front_row_decision_change') return null
      title = tr(t, 'corrections.describe.liberoOut', 'Libero #{{libero}} out, #{{player}} in', { libero: num(p.liberoOut), player: num(p.playerIn) })
      code = LIBERO_SHORT[p.liberoType] || ''
      break
    case 'libero_exchange':
      title = tr(t, 'corrections.describe.liberoExchange', 'Libero #{{out}} replaced by libero #{{in}}', { out: num(p.liberoOut), in: num(p.liberoIn) })
      break
    case 'libero_unable':
      title = tr(t, 'corrections.describe.liberoUnable', 'Libero #{{n}} declared unable to play', { n: num(p.liberoNumber) })
      break
    case 'libero_redesignation':
      title = tr(t, 'corrections.describe.liberoRedesignated', 'Player #{{n}} designated as new libero', { n: num(p.newLiberoNumber) })
      break
    case 'set_end': {
      const winnerKey = p.team === 'home' || p.team === 'away' ? p.team : null
      const winner = winnerKey ? teamLabel(winnerKey, ctx) : null
      title = tr(t, 'corrections.describe.setEnd', 'Set {{n}} won by {{team}}', { n: displaySetNumber(setIndex, ctx.match), team: winner?.name || (p.teamLabel ? tr(t, 'corrections.teamLetter', 'Team {{letter}}', { letter: p.teamLabel }) : '?') })
      detail = setTimesText(p.startTime, p.endTime, t)
      scoreValue = p.homePoints != null && p.awayPoints != null ? { home: p.homePoints, away: p.awayPoints } : before
      concerned = null
      break
    }
    case 'replay':
      title = tr(t, 'corrections.describe.replay', 'Rally replayed')
      concerned = null
      break
    case 'decision_change': {
      const to = teamLabel(p.toTeam, ctx)
      title = tr(t, 'corrections.describe.decisionChange', 'Decision changed: point given to {{team}}', { team: to?.name || '?' })
      concerned = null
      break
    }
    case 'coin_toss':
      title = tr(t, 'corrections.describe.coinToss', 'Coin toss')
      scoreValue = null
      break
    case 'set5_coin_toss':
      title = tr(t, 'corrections.describe.set5CoinToss', 'Coin toss for the deciding set')
      scoreValue = null
      break
    case 'remark':
      title = tr(t, 'corrections.term.remark', 'Remark')
      detail = String(p.text || '').split('\n')[0].slice(0, 80)
      scoreValue = null
      break
    case 'court_captain_designation':
      title = tr(t, 'corrections.describe.gameCaptain', 'Game captain: #{{n}}', { n: num(p.playerNumber) })
      break
    case 'bench_injury':
      title = tr(t, 'corrections.describe.benchInjury', 'Injury: player #{{n}} (bench)', { n: num(p.playerNumber) })
      break
    case 'forfait':
      title = p.scope === 'match'
        ? tr(t, 'corrections.describe.forfeitMatch', 'Team incomplete for the match')
        : tr(t, 'corrections.describe.forfeitSet', 'Team incomplete for the set')
      break
    case 'match_stopped':
      title = tr(t, 'corrections.describe.matchStopped', 'Match stopped')
      concerned = null
      break
    default:
      title = humanize(event.type) || tr(t, 'corrections.describe.unknown', 'Entry')
  }

  const score = scoreValue ? formatScore(scoreValue, concerned, ctx) : ''
  const text = [title, detail, teamText, setLabel, score].filter(Boolean).join(' · ')
  return { kind: event.type, title, detail, score, scoreValue, team, teamText, setIndex, setLabel, code, exceptional, incomplete, text }
}

/** A one-line sentence for an event (Undo confirmation, logs); '' for automatic rows. */
export function describeEventText(event, events, ctx = {}) {
  return describeEvent(event, events, ctx)?.text || ''
}

const REMARK_DEFAULTS = {
  exceptionalSub: 'Team {{team}}, Set {{set}}, Result {{score}}: player no. {{out}} is exceptionally substituted by player no. {{in}} due to {{reason}}.',
  liberoUnable: 'Team {{team}}, Set {{set}}, Result {{score}}: Libero no. {{n}} is declared unable to play.',
  liberoRedesignated: 'Team {{team}}, Set {{set}}, Result {{score}}: player no. {{n}} is designated as new Libero.',
  delayedStart: 'Set {{set}} start time {{time}} ({{minutes}}\' delay) due to {{reason}}.',
  protest: 'Team {{team}}, Set {{set}}, Result {{score}}: protest (dictated by the captain, with the 1st referee\'s permission): ',
  missingSignature: 'Team {{team}}: the signature of the {{who}} is missing.',
  manualCorrection: 'Team {{team}}, Set {{set}}, Result {{score}}: {{what}} (manual correction).'
}

const REASON_DEFAULTS = {
  injury: 'injury',
  illness: 'illness',
  expulsion: 'expulsion',
  disqualification: 'disqualification'
}

/** The reason word inside a remark (injury, illness, expulsion, disqualification). */
export function reasonLabel(reason, t) {
  if (REASON_DEFAULTS[reason]) return tr(t, `corrections.reason.${reason}`, REASON_DEFAULTS[reason])
  return humanize(reason).toLowerCase()
}

/**
 * The remark lines of the Swiss scorekeeper course, concerned team first.
 * params: { team: 'A'|'B', set, score: '16:21', out, in, reason, n, time,
 *           minutes, who, what }
 */
export function remarkText(kind, params = {}, t) {
  if (kind === 'prefix' || !REMARK_DEFAULTS[kind]) return remarkPrefix(params, t)
  const def = REMARK_DEFAULTS[kind]
  const p = { ...params }
  if (p.reason && REASON_DEFAULTS[p.reason]) p.reason = reasonLabel(p.reason, t)
  return tr(t, `corrections.remark.${kind}`, def, p)
}

/**
 * "Team B, Set 3, Result 16:21: " — the start of every remark line, for the
 * free-text templates. Built from its parts (each one a short label).
 */
export function remarkPrefix({ team, set, score } = {}, t) {
  const parts = [
    team ? tr(t, 'corrections.teamLetter', 'Team {{letter}}', { letter: team }) : '',
    set ? tr(t, 'corrections.term.set', 'Set {{n}}', { n: set }) : '',
    score ? tr(t, 'corrections.remark.result', 'Result {{score}}', { score }) : ''
  ].filter(Boolean)
  return parts.length ? `${parts.join(', ')}: ` : ''
}

/**
 * A correction-log entry as one sentence. New entries carry `text`; entries
 * written before that (manualChanges from the old editors) only have a
 * description and before/after values, which are never shown as raw JSON.
 */
export function describeLegacyChange(change, t) {
  if (!change) return ''
  if (change.text) return String(change.text)
  const desc = typeof change.description === 'string' ? change.description.trim() : ''
  if (desc && !/[{}[\]]/.test(desc)) return desc.replace(/_+/g, ' ')
  const what = [humanize(change.category), humanize(change.field)].filter(Boolean).join(': ')
  return what || tr(t, 'corrections.log.unknown', 'Correction')
}
