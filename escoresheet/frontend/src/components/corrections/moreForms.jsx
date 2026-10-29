// The forms of the corrections that used to be refused (owner 2026-10-29:
// "let me correct everything and then change stuff accordingly"): a
// starting line-up after rallies were played, the team of a point, a libero
// replacement, a game captain, the coin toss, a player's shirt number. Each
// one only PLANS (domain/manualCorrections); the panel writes the plan, and
// everything after the corrected entry is recalculated (domain/recompute).
import { useEffect, useMemo, useState } from 'react'
import { cn } from '../../ui/cn.js'
import { Select } from '../../ui/Select.jsx'
import { Input } from '../../ui/Input.jsx'
import {
  planSetLineup, planSetPointTeam, planEditEntry, planCoinToss, planSet5CoinToss, planRenumberPlayer, planGameCaptain,
  startingLineupEvent, courtAt, entryGroupIds, ENTRY_FIELDS, scoreTimeline
} from '../../domain/manualCorrections'
import { tr, formatScore, scoreBeforeEvent, describeEvent, teamNameWithLetter } from '../../domain/describe'
import { referencedPlayerNumbers } from '../../domain/roster'
import { CorrectionForm, SetPicker, TeamPicker, ScoreAtPicker, PlayerPicker, FieldGroup, CourtMini } from './shared.jsx'
import { playedSets, rosterOf, asPlayer, indexOfEvent } from './forms.jsx'

const POSITIONS = ['I', 'II', 'III', 'IV', 'V', 'VI']
// The court as the line-up form draws it: front row on top
const COURT_ROWS = [['IV', 'III', 'II'], ['V', 'VI', 'I']]
const setOf = (e) => e?.setIndex ?? 1

function playerName(p) {
  return p?.name || [p?.firstName, p?.lastName].filter(Boolean).join(' ')
}

// ─────────────────────────────── line-up ───────────────────────────────

/**
 * The starting line-up of a set (also after rallies were played) or, with
 * editEvent, a line-up corrected later in the set: six position pickers on a
 * court, the roster's players.
 */
export function LineupForm({ ctx, events, sets, players, mode, liveSetIndex, preset = {}, editEvent = null, busy, onCancel, onConfirm }) {
  const t = ctx.t
  const [setIndex, setSetIndex] = useState(editEvent ? setOf(editEvent) : (preset.setIndex ?? (mode === 'live' ? liveSetIndex : null)))
  const [team, setTeam] = useState(editEvent?.payload?.team ?? preset.team ?? null)
  const source = useMemo(() => {
    if (editEvent) return editEvent
    if (!setIndex || !team) return null
    return startingLineupEvent(events, setIndex, team)
  }, [editEvent, events, setIndex, team])
  const current = source?.payload?.lineup || null
  const [lineup, setLineup] = useState(() => ({ ...(current || {}) }))
  // a new set or team: start from its recorded line-up
  useEffect(() => { setLineup({ ...(current || {}) }) }, [source?.id, setIndex, team]) // eslint-disable-line react-hooks/exhaustive-deps

  const roster = rosterOf(players, team)
  const options = [
    { value: '', label: '–' },
    ...[...roster].sort((a, b) => Number(a.number) - Number(b.number)).map(p => ({
      value: String(p.number),
      label: `#${p.number}${playerName(p) ? ` ${playerName(p)}` : ''}${p.libero ? ` (${tr(t, 'corrections.term.liberoShort', 'L')})` : ''}`
    }))
  ]
  const plan = useMemo(() => {
    if (!team || !setIndex) return null
    if (POSITIONS.some(pos => lineup[pos] === undefined || lineup[pos] === '')) return null
    return planSetLineup(events, { setIndex, team, lineup, id: editEvent?.id ?? null }, ctx)
  }, [events, setIndex, team, lineup, editEvent, ctx])
  const changed = POSITIONS.filter(pos => String(lineup[pos] ?? '') !== String(current?.[pos] ?? ''))
  const title = editEvent && !editEvent.payload?.isInitial
    ? tr(t, 'corrections.form.editLineupRow', 'Edit corrected line-up')
    : tr(t, 'corrections.form.editLineup', 'Starting line-up')
  return (
    <CorrectionForm
      title={title}
      ctx={ctx}
      plan={plan}
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
      preview={plan && !plan.error && (
        <div className="flex flex-wrap gap-4">
          {current && <CourtMini lineup={current} caption={tr(t, 'corrections.preview.lineupBefore', 'Before')} highlight={changed} />}
          <CourtMini lineup={lineup} caption={tr(t, 'corrections.preview.lineupAfter', 'After')} highlight={changed} />
        </div>
      )}
    >
      {!editEvent && <SetPicker sets={playedSets(sets, events)} value={setIndex} onChange={setSetIndex} ctx={ctx} />}
      <TeamPicker value={team} onChange={setTeam} ctx={ctx} disabled={!!editEvent} />
      {team && setIndex && (
        <FieldGroup label={tr(t, 'corrections.field.positions', 'Positions (front row on top)')}>
          <div className="grid grid-cols-3 gap-2 max-w-md">
            {COURT_ROWS.flat().map(pos => (
              <div key={pos} className="min-w-0">
                <label htmlFor={`ov-corr-pos-${pos}`} className="block text-xs font-medium text-stone-500 mb-1">{pos}</label>
                <Select
                  id={`ov-corr-pos-${pos}`}
                  size="lg"
                  block
                  options={options}
                  value={lineup[pos] !== undefined && lineup[pos] !== null ? String(lineup[pos]) : ''}
                  onChange={(e) => setLineup(prev => ({ ...prev, [pos]: e.target.value }))}
                  className={cn(changed.includes(pos) && 'ring-2 ring-amber-300')}
                />
              </div>
            ))}
          </div>
        </FieldGroup>
      )}
    </CorrectionForm>
  )
}

// ──────────────────────────────── point ────────────────────────────────

/** The team a point went to (the serve and the rotations after it follow). */
export function PointForm({ ctx, events, editEvent, busy, onCancel, onConfirm }) {
  const t = ctx.t
  const [team, setTeam] = useState(editEvent?.payload?.team ?? null)
  const plan = useMemo(() => (team ? planSetPointTeam(events, editEvent.id, team, ctx) : null), [events, editEvent, team, ctx])
  const before = scoreBeforeEvent(events, editEvent)
  return (
    <CorrectionForm
      title={tr(t, 'corrections.form.editPoint', 'Edit point')}
      ctx={ctx}
      plan={team === editEvent?.payload?.team ? null : plan}
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
      preview={plan && !plan.error && (
        <p className="text-sm text-stone-700">
          {tr(t, 'corrections.preview.pointTeam', 'The rally after {{score}} goes to {{team}}; the serve, the rotations and the score after it are recalculated.', {
            score: formatScore(before, null, ctx), team: teamNameWithLetter(team, ctx)
          })}
        </p>
      )}
    >
      <p className="text-sm text-stone-700">{describeEvent(editEvent, events, ctx)?.text}</p>
      <TeamPicker value={team} onChange={setTeam} ctx={ctx} label={tr(t, 'corrections.field.pointTo', 'Point to')} />
    </CorrectionForm>
  )
}

// ───────────────────────────── other entries ─────────────────────────────

const ENTRY_TITLES = {
  libero_entry: ['corrections.form.editLiberoEntry', 'Edit libero replacement'],
  libero_exit: ['corrections.form.editLiberoExit', 'Edit libero exit'],
  libero_exchange: ['corrections.form.editLiberoExchange', 'Edit libero exchange'],
  libero_unable: ['corrections.form.editLiberoUnable', 'Edit libero declared unable'],
  libero_redesignation: ['corrections.form.editRedesignation', 'Edit libero re-designation'],
  court_captain_designation: ['corrections.form.editGameCaptain', 'Edit game captain'],
  bench_injury: ['corrections.form.editInjury', 'Edit injury']
}
const FIELD_LABELS = {
  liberoIn: ['corrections.field.liberoIn', 'Libero in'],
  playerOut: ['corrections.field.playerReplaced', 'Player replaced (on court)'],
  liberoNumber: ['corrections.field.libero', 'Libero'],
  newLiberoNumber: ['corrections.field.newLibero', 'New libero'],
  playerNumber: ['corrections.field.player', 'Player']
}
const MOVABLE = new Set(['libero_entry', 'libero_exit', 'libero_exchange', 'libero_unable', 'libero_redesignation', 'court_captain_designation', 'bench_injury'])

/**
 * Edit a libero replacement, a libero declared unable or re-designated, a
 * game captain or an injury: its players and, where it makes sense, the
 * score it was recorded at. The line-ups after it are recalculated.
 */
export function EntryForm({ ctx, events, players, editEvent, busy, onCancel, onConfirm }) {
  const t = ctx.t
  const p0 = editEvent.payload || {}
  const team = p0.team
  const setIndex = setOf(editEvent)
  const fields = ENTRY_FIELDS[editEvent.type] || []
  const [values, setValues] = useState(() => Object.fromEntries(fields.map(f => [f.key, p0[f.key] ?? null])))
  // the log without this entry: the court it is recorded on
  const without = useMemo(() => {
    const ids = new Set(entryGroupIds(events, editEvent))
    return events.filter(e => !ids.has(e.id))
  }, [events, editEvent])
  const timeline = useMemo(() => scoreTimeline(without, setIndex), [without, setIndex])
  const startAt = useMemo(() => indexOfEvent(timeline, events, editEvent), [timeline, events, editEvent])
  const [at, setAt] = useState(startAt)
  const court = useMemo(() => (at != null ? courtAt(without, setIndex, team, at) : { lineup: null }), [without, setIndex, team, at])
  const roster = rosterOf(players, team)
  const choicesOf = (pick) => {
    if (pick === 'libero') return roster.filter(p => p.libero)
    if (pick === 'onCourt') return (court.lineup ? POSITIONS.map(pos => court.lineup[pos]).filter(n => n !== '' && n != null) : []).map(n => asPlayer(roster, n))
    return roster
  }
  const plan = useMemo(() => {
    if (fields.some(f => values[f.key] == null)) return null
    const v = { ...values }
    if (MOVABLE.has(editEvent.type) && at != null && at !== startAt) Object.assign(v, { setIndex, at })
    return planEditEntry(events, editEvent.id, v, ctx)
  }, [events, editEvent, values, at, startAt, setIndex, fields, ctx])
  const [key, def] = ENTRY_TITLES[editEvent.type] || ['corrections.form.editEntry', 'Edit entry']
  return (
    <CorrectionForm title={tr(t, key, def)} ctx={ctx} plan={plan} busy={busy} onCancel={onCancel} onConfirm={onConfirm}>
      <p className="text-sm text-stone-700">{describeEvent(editEvent, events, ctx)?.text}</p>
      {MOVABLE.has(editEvent.type) && <ScoreAtPicker timeline={timeline} value={at} onChange={setAt} team={team} ctx={ctx} />}
      {fields.map(f => (
        <PlayerPicker
          key={f.key}
          ctx={ctx}
          label={tr(t, ...(FIELD_LABELS[f.key] || ['corrections.field.player', 'Player']))}
          players={choicesOf(f.pick)}
          value={values[f.key]}
          onChange={(n) => setValues(prev => ({ ...prev, [f.key]: n }))}
        />
      ))}
    </CorrectionForm>
  )
}

// ────────────────────────────── coin toss ──────────────────────────────

/** Which team is A and which team serves first (sets 1-4), or the deciding set's serve. */
export function CoinTossForm({ ctx, events, deciding = false, busy, onCancel, onConfirm }) {
  const t = ctx.t
  const m = ctx.match || {}
  const aKey = m.coinTossTeamA === 'away' ? 'away' : 'home'
  const bKey = aKey === 'home' ? 'away' : 'home'
  const set5Serve = m.set5FirstServe === 'B' ? bKey : aKey
  const [teamA, setTeamA] = useState(aKey)
  const [serve, setServe] = useState(deciding ? set5Serve : (m.firstServe || 'home'))
  const plan = useMemo(() => {
    if (deciding) return serve === set5Serve ? null : planSet5CoinToss(events, { firstServe: serve === aKey ? 'A' : 'B' }, ctx)
    if (teamA === aKey && serve === (m.firstServe || 'home')) return null
    return planCoinToss(events, { teamA, firstServe: serve }, ctx)
  }, [deciding, events, teamA, serve, aKey, set5Serve, m.firstServe, ctx])
  return (
    <CorrectionForm
      title={deciding ? tr(t, 'corrections.form.set5CoinToss', 'Coin toss of the deciding set') : tr(t, 'corrections.form.coinToss', 'Coin toss')}
      ctx={ctx}
      plan={plan}
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      {!deciding && (
        <TeamPicker value={teamA} onChange={setTeamA} ctx={ctx} label={tr(t, 'corrections.field.teamA', 'Team A')} />
      )}
      <TeamPicker
        value={serve}
        onChange={setServe}
        ctx={ctx}
        label={deciding ? tr(t, 'corrections.field.firstServeSet5', 'Serves first in the deciding set') : tr(t, 'corrections.field.firstServe', 'Serves first in set 1')}
      />
      {!deciding && <p className="text-xs text-stone-500">{tr(t, 'corrections.hint.coinToss', 'Team A only changes the letters on the sheet; nothing moves on the court. The team that serves first in set 1 also serves first in set 3 and receives first in sets 2 and 4.')}</p>}
    </CorrectionForm>
  )
}

// ───────────────────────────── game captain ─────────────────────────────

/** The game captain of a team (when the team captain is not on court). */
export function GameCaptainForm({ ctx, events, players, preset = {}, busy, onCancel, onConfirm }) {
  const t = ctx.t
  const [team, setTeam] = useState(preset.team ?? null)
  const field = team === 'away' ? 'awayCourtCaptain' : 'homeCourtCaptain'
  const [number, setNumber] = useState(null)
  const roster = rosterOf(players, team).filter(p => !p.libero)
  const plan = useMemo(() => (team && number != null ? planGameCaptain(events, { team, number }, ctx) : null), [events, team, number, ctx])
  const current = team ? ctx.match?.[field] : null
  return (
    <CorrectionForm title={tr(t, 'corrections.form.gameCaptain', 'Game captain')} ctx={ctx} plan={plan} busy={busy} onCancel={onCancel} onConfirm={onConfirm}>
      <TeamPicker value={team} onChange={(v) => { setTeam(v); setNumber(null) }} ctx={ctx} />
      {team && (
        <>
          <p className="text-sm text-stone-600">
            {current != null && current !== ''
              ? tr(t, 'corrections.field.gameCaptainNow', 'Game captain now: #{{n}}', { n: current })
              : tr(t, 'corrections.field.gameCaptainNone', 'No game captain designated.')}
          </p>
          <PlayerPicker ctx={ctx} label={tr(t, 'corrections.field.player', 'Player')} players={roster} value={number} onChange={setNumber} />
        </>
      )}
    </CorrectionForm>
  )
}

// ──────────────────────────── player numbers ────────────────────────────

/**
 * Change a player's shirt number for the whole match: the roster and every
 * entry of the record, before and after, show the new number.
 */
export function RenumberForm({ ctx, events, players, preset = {}, busy, onCancel, onConfirm }) {
  const t = ctx.t
  const [team, setTeam] = useState(preset.team ?? null)
  const [playerNumber, setPlayerNumber] = useState(null)
  const [to, setTo] = useState('')
  const roster = rosterOf(players, team)
  const player = roster.find(p => String(p.number) === String(playerNumber)) || null
  const plan = useMemo(() => {
    if (!team || !player || to === '') return null
    return planRenumberPlayer(events, { team, playerId: player.id ?? null, from: player.number, to: to.trim() }, ctx)
  }, [events, team, player, to, ctx])
  const inRecord = team && player ? referencedPlayerNumbers(events, team).has(String(player.number)) : false
  // the entries whose content changes (not the stored snapshots alone)
  const entries = plan && !plan.error ? plan.update.filter(u => u.changes?.payload).length : 0
  return (
    <CorrectionForm
      title={tr(t, 'corrections.form.renumber', 'Change a player\'s number')}
      ctx={ctx}
      plan={plan}
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
      preview={plan && !plan.error && (
        <p className="text-sm text-stone-700">
          {inRecord
            ? tr(t, 'corrections.preview.renumber', '#{{from}} becomes #{{to}} in the roster and in every entry of the match ({{n}} rows), before and after now: line-ups, substitutions, liberos, sanctions, game captain, remarks. The scoresheet and the tablets show #{{to}}.', { from: player.number, to: Number(to), n: entries })
            : tr(t, 'corrections.preview.renumberRosterOnly', '#{{from}} becomes #{{to}} in the roster; the match record does not name this player yet.', { from: player.number, to: Number(to) })}
        </p>
      )}
    >
      <TeamPicker value={team} onChange={(v) => { setTeam(v); setPlayerNumber(null) }} ctx={ctx} />
      {team && (
        <PlayerPicker ctx={ctx} label={tr(t, 'corrections.field.player', 'Player')} players={[...roster].sort((a, b) => Number(a.number) - Number(b.number))} value={playerNumber} onChange={setPlayerNumber} />
      )}
      {player && (
        <div className="max-w-40">
          <label htmlFor="ov-corr-newnumber" className="block text-sm font-medium text-stone-700 mb-1.5">{tr(t, 'corrections.field.newNumber', 'New number')}</label>
          <Input id="ov-corr-newnumber" size="lg" inputMode="numeric" numeric value={to} onChange={(e) => setTo(e.target.value.replace(/[^\d]/g, '').slice(0, 2))} />
        </div>
      )}
    </CorrectionForm>
  )
}

/** "1 · 2 · 3 · 4 · 5 · 6": a team's starting line-up of a set (positions I-VI). */
export function lineupSummary(events, setIndex, team) {
  const ev = startingLineupEvent(events, setIndex, team)
  if (!ev) return null
  return POSITIONS.map(pos => ev.payload?.lineup?.[pos] ?? '?').join(' · ')
}
