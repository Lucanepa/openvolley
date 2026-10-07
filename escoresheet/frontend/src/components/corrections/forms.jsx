// The guided correction forms: fields, then the live preview of what changes
// on the scoresheet, then Cancel / Confirm. Every form only PLANS
// (domain/manualCorrections); the panel writes the confirmed plan.
import { useMemo, useState } from 'react'
import { cn } from '../../ui/cn.js'
import { FOCUS_RING } from '../../ui/Button.jsx'
import { SegmentedControl } from '../../ui/SegmentedControl.jsx'
import { Textarea } from '../../ui/Textarea.jsx'
import { Input } from '../../ui/Input.jsx'
import { Checkbox } from '../../ui/Checkbox.jsx'
import { Switch } from '../../ui/Switch.jsx'
import {
  scoreTimeline, courtAt, applyPlanToEvents, planAddTimeout, planAddSubstitution, planAddSanction,
  planEditEvent, planRemoveSubstitution, planSetTimes, planAdjustFinalScore, emptyPlan
} from '../../domain/manualCorrections'
import {
  tr, formatScore, plainScore, scoreBeforeEvent, teamLabel, teamLetter, sanctionLabel, sanctionTarget,
  displaySetNumber, remarkText, remarkPrefix, setTimesText, isTeamSanctionType
} from '../../domain/describe'
import { awardsPoint } from '../../domain/sanctions'
import { scoreFromPointEvents } from '../../domain/rules'
import {
  CorrectionForm, SetPicker, TeamPicker, ScoreAtPicker, PlayerPicker, FieldGroup, CourtMini, withRemark
} from './shared.jsx'

const setOf = (e) => e?.setIndex ?? 1

/** Sets that were played (have events), in order. */
export function playedSets(sets, events) {
  const withEvents = new Set((events || []).map(setOf))
  return [...(sets || [])].filter(s => withEvents.has(s.index)).sort((a, b) => a.index - b.index)
}

/** The timeline index holding an existing event (the score before it). */
function indexOfEvent(timeline, events, ev) {
  if (!ev) return null
  const s = scoreBeforeEvent(events, ev)
  const i = timeline.findIndex(x => x.home === s.home && x.away === s.away)
  return i >= 0 ? i : null
}

/** Shared state of every "at a score" form: set, timeline, chosen score. */
function useScoreChoice({ events, mode, liveSetIndex, preset, editEvent }) {
  const initialSet = editEvent ? setOf(editEvent) : (preset?.setIndex ?? (mode === 'live' ? liveSetIndex : null))
  const [setIndex, setSetIndex] = useState(initialSet ?? null)
  const timeline = useMemo(() => (setIndex ? scoreTimeline(events, setIndex) : []), [events, setIndex])
  const defaultAt = (tl, idx) => {
    if (editEvent && idx === setOf(editEvent)) return indexOfEvent(tl, events, editEvent)
    if (!tl.length) return null
    return mode === 'live' && idx === liveSetIndex ? tl.length - 1 : 0
  }
  const [at, setAt] = useState(() => defaultAt(timeline, setIndex))
  const chooseSet = (idx) => {
    setSetIndex(idx)
    setAt(defaultAt(scoreTimeline(events, idx), idx))
  }
  const liveIdx = mode === 'live' && setIndex === liveSetIndex && timeline.length ? timeline.length - 1 : null
  return { setIndex, chooseSet, timeline, at, setAt, liveIdx }
}

function rosterOf(players, team) {
  return (team === 'home' ? players?.home : players?.away) || []
}

function asPlayer(roster, n) {
  return roster.find(p => String(p.number) === String(n)) || { number: n }
}

// ─────────────────────────────── time-out ───────────────────────────────

export function TimeoutForm({ ctx, events, sets, mode, liveSetIndex, preset = {}, editEvent = null, busy, onCancel, onConfirm, onDelegate }) {
  const t = ctx.t
  const { setIndex, chooseSet, timeline, at, setAt, liveIdx } = useScoreChoice({ events, mode, liveSetIndex, preset, editEvent })
  const [team, setTeam] = useState(editEvent?.payload?.team ?? preset.team ?? null)
  const plan = useMemo(() => {
    if (!setIndex || !team || at == null) return null
    return editEvent
      ? planEditEvent(events, editEvent.id, { setIndex, team, at }, ctx)
      : planAddTimeout(events, { setIndex, team, at }, ctx)
  }, [events, setIndex, team, at, editEvent, ctx])
  const entry = timeline[at]
  // At the live score of the set being played the live time-out (with its
  // countdown) is used, as if the scorer had pressed TO on the scoreboard.
  const delegate = !editEvent && onDelegate && liveIdx != null && at === liveIdx
  return (
    <CorrectionForm
      title={editEvent ? tr(t, 'corrections.form.editTimeout', 'Edit time-out') : tr(t, 'corrections.form.addTimeout', 'Add time-out')}
      ctx={ctx}
      plan={plan}
      busy={busy}
      onCancel={onCancel}
      onConfirm={(p) => (delegate ? onDelegate('timeout', { team }) : onConfirm(p))}
      preview={plan && !plan.error && entry && (
        <p className="text-sm text-stone-700">
          {tr(t, 'corrections.preview.paperTimeout', '"T" at {{score}} in the time-out box of {{team}}, set {{set}}.', {
            score: formatScore(entry, team, ctx), team: teamLabel(team, ctx).name, set: displaySetNumber(setIndex, ctx.match)
          })}
          {delegate && <span className="block mt-1 text-xs text-stone-500">{tr(t, 'corrections.preview.liveTimeout', 'Starts the time-out with its countdown, as the TO button does.')}</span>}
        </p>
      )}
    >
      <SetPicker sets={playedSets(sets, events)} value={setIndex} onChange={chooseSet} ctx={ctx} />
      <TeamPicker value={team} onChange={setTeam} ctx={ctx} />
      {setIndex && <ScoreAtPicker timeline={timeline} value={at} onChange={setAt} team={team} ctx={ctx} kind="timeout" liveIdx={liveIdx} />}
    </CorrectionForm>
  )
}

// ───────────────────────────── substitution ─────────────────────────────

const SUB_REASONS = ['injury', 'illness', 'expulsion', 'disqualification']

export function SubstitutionForm({ ctx, events, sets, players, mode, liveSetIndex, preset = {}, editEvent = null, busy, onCancel, onConfirm }) {
  const t = ctx.t
  // Editing: the court is read without the substitution being edited
  const base = useMemo(() => {
    if (!editEvent) return events
    const r = planRemoveSubstitution(events, editEvent.id, ctx)
    return r.error ? events : applyPlanToEvents(events, r)
  }, [events, editEvent, ctx])
  const { setIndex, chooseSet, timeline, at, setAt, liveIdx } = useScoreChoice({ events, mode, liveSetIndex, preset, editEvent })
  const p0 = editEvent?.payload || {}
  const [team, setTeam] = useState(p0.team ?? preset.team ?? null)
  const [playerOut, setPlayerOut] = useState(p0.playerOut ?? null)
  const [playerIn, setPlayerIn] = useState(p0.playerIn ?? null)
  const [exceptional, setExceptional] = useState(!!p0.isExceptional)
  const [reason, setReason] = useState(p0.exceptionalReason || 'injury')
  const [remark, setRemark] = useState(null)

  const court = useMemo(() => (setIndex && team && at != null ? courtAt(base, setIndex, team, at) : { lineup: null, libero: null }), [base, setIndex, team, at])
  const roster = rosterOf(players, team)
  const onCourt = court.lineup ? Object.values(court.lineup).map(String) : []
  const outChoices = onCourt.map(n => asPlayer(roster, n))
  if (court.libero?.playerNumber != null) outChoices.push(asPlayer(roster, court.libero.playerNumber))
  const inChoices = roster.filter(p => !p.libero && !onCourt.includes(String(p.number)))

  const rawPlan = useMemo(() => {
    if (!setIndex || !team || at == null || playerOut == null || playerIn == null) return null
    const values = { setIndex, team, at, playerOut, playerIn, exceptional, reason: exceptional ? reason : null }
    return editEvent ? planEditEvent(events, editEvent.id, values, ctx) : planAddSubstitution(events, values, ctx)
  }, [events, setIndex, team, at, playerOut, playerIn, exceptional, reason, editEvent, ctx])
  const plan = withRemark(rawPlan, remark)
  const autoRemark = rawPlan && !rawPlan.error ? rawPlan.remarkAdd?.[0] : null

  const subRow = plan && !plan.error ? (plan.add.find(r => r.type === 'substitution') || (editEvent && { payload: plan.update.find(u => u.id === editEvent.id)?.changes?.payload })) : null
  const after = plan && !plan.error ? plan.add.find(r => r.type === 'lineup')?.payload?.lineup : null
  const regularCount = plan && !plan.error
    ? applyPlanToEvents(events, plan).filter(e => e.type === 'substitution' && setOf(e) === setIndex && e.payload?.team === team && !e.payload?.isExceptional).length
    : 0
  const entry = timeline[at]

  const resetPlayers = () => { setPlayerOut(null); setPlayerIn(null); setRemark(null) }
  return (
    <CorrectionForm
      title={editEvent ? tr(t, 'corrections.form.editSubstitution', 'Edit substitution') : tr(t, 'corrections.form.addSubstitution', 'Add substitution')}
      ctx={ctx}
      plan={plan}
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
      remark={autoRemark != null ? (remark ?? autoRemark) : undefined}
      onRemarkChange={setRemark}
      preview={plan && !plan.error && subRow && entry && (
        <div className="space-y-2">
          <p className="text-sm text-stone-700">
            {tr(t, 'corrections.preview.paperSub', '{{in}} in for {{out}} at {{score}} in the line-up column of position {{position}}.', {
              in: playerIn, out: playerOut, score: formatScore(entry, team, ctx), position: subRow.payload?.position || '?'
            })}
          </p>
          {!exceptional && (
            <p className="text-xs text-stone-500">{tr(t, 'corrections.preview.subCount', 'Substitutions of {{team}} in set {{set}}: {{n}}/6', { team: teamLabel(team, ctx).name, set: displaySetNumber(setIndex, ctx.match), n: regularCount })}</p>
          )}
          {court.lineup && after && (
            <div className="flex flex-wrap gap-4">
              <CourtMini lineup={court.lineup} caption={tr(t, 'corrections.preview.lineupBefore', 'Before')} highlight={[subRow.payload?.position]} />
              <CourtMini lineup={after} caption={tr(t, 'corrections.preview.lineupAfter', 'After')} highlight={[subRow.payload?.position]} />
            </div>
          )}
        </div>
      )}
    >
      <SetPicker sets={playedSets(sets, events)} value={setIndex} onChange={(v) => { chooseSet(v); resetPlayers() }} ctx={ctx} />
      <TeamPicker value={team} onChange={(v) => { setTeam(v); resetPlayers() }} ctx={ctx} disabled={!!editEvent} />
      {setIndex && <ScoreAtPicker timeline={timeline} value={at} onChange={(v) => { setAt(v); setRemark(null) }} team={team} ctx={ctx} kind="substitution" liveIdx={liveIdx} />}
      {team && at != null && (
        <>
          <PlayerPicker ctx={ctx} label={tr(t, 'corrections.field.playerOut', 'Player out (on court)')} players={outChoices} value={playerOut} onChange={setPlayerOut} />
          <PlayerPicker ctx={ctx} label={tr(t, 'corrections.field.playerIn', 'Player in (bench)')} players={inChoices} value={playerIn} onChange={setPlayerIn} />
        </>
      )}
      <div className="flex items-center justify-between gap-3 rounded-xl border border-stone-200 px-3 py-2.5">
        <span id="ov-corr-exc" className="text-sm font-medium text-stone-700">{tr(t, 'corrections.term.exceptionalSubstitution', 'Exceptional substitution')}</span>
        <Switch checked={exceptional} onCheckedChange={(v) => { setExceptional(v); setRemark(null) }} aria-labelledby="ov-corr-exc" />
      </div>
      {exceptional && (
        <FieldGroup label={tr(t, 'corrections.field.reason', 'Reason')}>
          <SegmentedControl
            ariaLabel={tr(t, 'corrections.field.reason', 'Reason')}
            options={SUB_REASONS.map(r => ({ value: r, label: tr(t, `corrections.reasonLabel.${r}`, r[0].toUpperCase() + r.slice(1)) }))}
            value={reason}
            onChange={(v) => { setReason(v); setRemark(null) }}
          />
        </FieldGroup>
      )}
    </CorrectionForm>
  )
}

// ─────────────────────────────── sanction ───────────────────────────────

const SANCTION_ORDER = ['delay_warning', 'delay_penalty', 'improper_request', 'warning', 'penalty', 'expulsion', 'disqualification']
const OFFICIAL_ROLES = { coach: 'Coach', ac1: 'Assistant Coach 1', ac2: 'Assistant Coach 2', physio: 'Physiotherapist', doctor: 'Medic' }
const WHO = ['player', 'bench', 'libero', 'coach', 'ac1', 'ac2', 'physio', 'doctor']
const WHO_DEFAULTS = {
  player: 'Player on court', bench: 'Player on bench', libero: 'Libero',
  coach: 'Coach', ac1: 'Assistant coach 1', ac2: 'Assistant coach 2', physio: 'Physiotherapist', doctor: 'Doctor'
}

/** The card(s) a referee shows: yellow, red, both, or the delay hand signal (D). */
export function CardGlyph({ type }) {
  const y = <span className="inline-block h-3.5 w-2.5 rounded-[2px] bg-yellow-400 ring-1 ring-yellow-500/50" />
  const r = <span className="inline-block h-3.5 w-2.5 rounded-[2px] bg-red-600 ring-1 ring-red-700/50" />
  let cards
  if (type === 'warning' || type === 'delay_warning') cards = [y]
  else if (type === 'penalty' || type === 'delay_penalty') cards = [r]
  else if (type === 'expulsion') cards = [<span key="e" className="inline-flex -space-x-1">{y}{r}</span>]
  else if (type === 'disqualification') cards = [y, r]
  else cards = [<span key="x" className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-[2px] border border-stone-400 text-[9px] font-bold text-stone-600">X</span>]
  return (
    <span aria-hidden="true" className="inline-flex items-center gap-0.5">
      {cards.map((c, i) => <span key={i} className="inline-flex">{c}</span>)}
      {(type === 'delay_warning' || type === 'delay_penalty') && <span className="ml-0.5 text-[10px] font-bold text-stone-600">D</span>}
    </span>
  )
}

function whoOfPayload(p) {
  if (!p) return null
  if (p.playerType === 'official' || p.playerType === 'coach' || p.playerType === 'bench_official') {
    const role = String(p.role || '').toLowerCase()
    return Object.keys(OFFICIAL_ROLES).find(k => OFFICIAL_ROLES[k].toLowerCase() === role) || 'coach'
  }
  if (p.playerType === 'bench' || p.playerType === 'libero' || p.playerType === 'player') return p.playerType
  return p.playerNumber != null ? 'player' : null
}

const PAPER_COLUMN = { warning: 'warning', delay_warning: 'warning', penalty: 'penalty', delay_penalty: 'penalty', expulsion: 'expulsion', disqualification: 'disqualification' }

export function SanctionForm({ ctx, events, sets, players, mode, liveSetIndex, preset = {}, editEvent = null, busy, onCancel, onConfirm }) {
  const t = ctx.t
  const { setIndex, chooseSet, timeline, at, setAt, liveIdx } = useScoreChoice({ events, mode, liveSetIndex, preset, editEvent })
  const p0 = editEvent?.payload || {}
  const [team, setTeam] = useState(p0.team ?? preset.team ?? null)
  const [type, setType] = useState(p0.type ?? null)
  const [who, setWho] = useState(whoOfPayload(p0))
  const [number, setNumber] = useState(p0.playerNumber ?? null)
  const [pointChoice, setPointChoice] = useState(null) // 'given' | 'now'

  const teamSanction = type && isTeamSanctionType(type)
  const atLive = liveIdx != null && at === liveIdx
  const pointNowAllowed = mode === 'live' && atLive && !editEvent
  const pointGiven = pointChoice ? pointChoice === 'given' : !pointNowAllowed

  const court = useMemo(() => (setIndex && team && at != null ? courtAt(events, setIndex, team, at) : { lineup: null }), [events, setIndex, team, at])
  const roster = rosterOf(players, team)
  const onCourt = court.lineup ? Object.values(court.lineup).map(String) : []
  const numberChoices = who === 'player'
    ? onCourt.map(n => asPlayer(roster, n))
    : who === 'bench'
      ? roster.filter(p => !p.libero && !onCourt.includes(String(p.number)))
      : who === 'libero' ? roster.filter(p => p.libero) : []

  const target = useMemo(() => {
    if (!who || teamSanction) return {}
    if (OFFICIAL_ROLES[who]) return { playerType: 'official', role: OFFICIAL_ROLES[who] }
    return { playerType: who, playerNumber: number }
  }, [who, number, teamSanction])

  const plan = useMemo(() => {
    if (!setIndex || !team || !type || at == null) return null
    if (!teamSanction && (!who || (!OFFICIAL_ROLES[who] && number == null))) return null
    const values = { setIndex, team, type, target, at, pointAlreadyGiven: awardsPoint(type) ? pointGiven : true }
    return editEvent ? planEditEvent(events, editEvent.id, values, ctx) : planAddSanction(events, values, ctx)
  }, [events, setIndex, team, type, at, target, teamSanction, who, number, pointGiven, editEvent, ctx])

  const entry = timeline[at]
  const code = type && (teamSanction ? sanctionTarget({ type }, t).code : sanctionTarget({ type, ...target }, t).code)
  const paper = !plan || plan.error || !entry || type === 'improper_request' ? null : tr(t, 'corrections.preview.paperSanction', '{{code}} in the {{column}} column · Team {{letter}} · Set {{set}} · {{score}}', {
    code: code || '?',
    column: tr(t, `corrections.column.${PAPER_COLUMN[type]}`, sanctionLabel(PAPER_COLUMN[type], t)),
    letter: teamLetter(team, ctx.match),
    set: displaySetNumber(setIndex, ctx.match),
    score: formatScore(entry, team, ctx)
  })

  return (
    <CorrectionForm
      title={editEvent ? tr(t, 'corrections.form.editSanction', 'Edit sanction') : tr(t, 'corrections.form.addSanction', 'Add sanction')}
      ctx={ctx}
      plan={plan}
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
      preview={paper && <p className="text-sm text-stone-700">{paper}</p>}
    >
      <SetPicker sets={playedSets(sets, events)} value={setIndex} onChange={chooseSet} ctx={ctx} />
      <TeamPicker value={team} onChange={(v) => { setTeam(v); setNumber(null) }} ctx={ctx} />
      <FieldGroup label={tr(t, 'corrections.field.sanction', 'Sanction')}>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2" role="radiogroup" aria-label={tr(t, 'corrections.field.sanction', 'Sanction')}>
          {SANCTION_ORDER.map(s => {
            const on = type === s
            return (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setType(s)}
                className={cn('min-h-11 rounded-lg border px-2.5 py-2 text-left text-sm flex items-center gap-2 transition-colors', FOCUS_RING,
                  on ? 'border-slate-900 bg-slate-900 text-white' : 'border-stone-300 bg-white text-stone-800 hover:bg-stone-50')}
              >
                <CardGlyph type={s} />
                <span className="min-w-0 leading-tight">{sanctionLabel(s, t)}</span>
              </button>
            )
          })}
        </div>
      </FieldGroup>
      {type && !teamSanction && (
        <FieldGroup label={tr(t, 'corrections.field.who', 'Who')}>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={tr(t, 'corrections.field.who', 'Who')}>
            {WHO.map(w => {
              const on = who === w
              return (
                <button key={w} type="button" role="radio" aria-checked={on} onClick={() => { setWho(w); setNumber(null) }}
                  className={cn('min-h-11 rounded-lg border px-3 text-sm transition-colors', FOCUS_RING,
                    on ? 'border-slate-900 bg-slate-900 text-white' : 'border-stone-300 bg-white text-stone-800 hover:bg-stone-50')}>
                  {tr(t, `corrections.who.${w}`, WHO_DEFAULTS[w])}
                </button>
              )
            })}
          </div>
        </FieldGroup>
      )}
      {setIndex && <ScoreAtPicker timeline={timeline} value={at} onChange={setAt} team={team} ctx={ctx} kind="sanction" liveIdx={liveIdx} />}
      {type && !teamSanction && (who === 'player' || who === 'bench' || who === 'libero') && team && (
        <PlayerPicker ctx={ctx} label={tr(t, 'corrections.field.number', 'Number')} players={numberChoices} value={number} onChange={setNumber} />
      )}
      {type && awardsPoint(type) && team && (
        <FieldGroup label={tr(t, 'corrections.field.pointAlreadyGiven', 'Was the point already given to {{team}}?', { team: teamLabel(team === 'home' ? 'away' : 'home', ctx).name })}>
          <SegmentedControl
            ariaLabel={tr(t, 'corrections.field.pointAlreadyGiven', 'Was the point already given to {{team}}?', { team: teamLabel(team === 'home' ? 'away' : 'home', ctx).name })}
            options={[
              { value: 'given', label: tr(t, 'corrections.pointGiven.yes', 'Yes') },
              ...(pointNowAllowed ? [{ value: 'now', label: tr(t, 'corrections.pointGiven.no', 'No, add it now') }] : [])
            ]}
            value={pointGiven ? 'given' : 'now'}
            onChange={setPointChoice}
          />
        </FieldGroup>
      )}
    </CorrectionForm>
  )
}

// ──────────────────────────────── remark ────────────────────────────────

const TEMPLATES = ['exceptionalSub', 'liberoUnable', 'liberoRedesignated', 'delay', 'protest', 'missingSignature', 'other']
const TEMPLATE_DEFAULTS = {
  exceptionalSub: 'Exceptional substitution', liberoUnable: 'Libero unable', liberoRedesignated: 'Libero re-designated',
  delay: 'Delay / time issue', protest: 'Protest', missingSignature: 'Missing signature', other: 'Other'
}

/** + Add remark (template picker, pre-filled text) and Edit of one remark line. */
export function RemarkForm({ ctx, events, sets, mode, liveSetIndex, match, editLine = null, editIndex = null, busy, onCancel, onConfirm }) {
  const t = ctx.t
  const [template, setTemplate] = useState(editLine != null ? null : 'other')
  const { setIndex, chooseSet, timeline, at, setAt } = useScoreChoice({ events, mode, liveSetIndex, preset: {}, editEvent: null })
  const [team, setTeam] = useState(null)
  const [text, setText] = useState(editLine ?? '')
  const [dirty, setDirty] = useState(editLine != null)

  const entry = timeline[at]
  const filled = useMemo(() => {
    if (!template) return ''
    const letter = team ? teamLetter(team, ctx.match) : '_'
    const set = setIndex ? displaySetNumber(setIndex, ctx.match) : 'n'
    const score = entry ? plainScore(entry, team || 'home') : 'x:y'
    const base = { team: letter, set, score }
    switch (template) {
      case 'exceptionalSub': return remarkText('exceptionalSub', { ...base, out: '…', in: '…', reason: 'injury' }, t)
      case 'liberoUnable': return remarkText('liberoUnable', { ...base, n: '…' }, t)
      case 'liberoRedesignated': return remarkText('liberoRedesignated', { ...base, n: '…' }, t)
      case 'delay': return remarkText('delayedStart', { set, time: '…', minutes: '…', reason: '…' }, t)
      case 'protest': return remarkText('protest', base, t)
      case 'missingSignature': return remarkText('missingSignature', { team: letter, who: '…' }, t)
      default: return remarkPrefix(base, t)
    }
  }, [template, team, setIndex, entry, ctx.match, t])
  const value = dirty ? text : filled

  const lines = String(match?.remarks || '').split('\n')
  const plan = useMemo(() => {
    const v = value.trim()
    if (!v) return null
    const p = emptyPlan()
    if (editLine != null) {
      const next = [...lines]
      next[editIndex] = v
      p.remarksSet = next.join('\n')
      p.log = { action: 'editRemark', setIndex: null, team: null, before: editLine, after: v, text: tr(t, 'corrections.log.remarkChanged', 'Remark changed: "{{text}}"', { text: v }) }
    } else {
      p.remarkAdd = [v]
      p.log = { action: 'addRemark', setIndex: setIndex || null, team: team || null, before: null, after: v, text: tr(t, 'corrections.log.remarkAdded', 'Remark added: "{{text}}"', { text: v }) }
    }
    if (mode === 'review') p.log.text += tr(t, 'corrections.log.afterMatchSuffix', ' (entered after the match)')
    return p
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, editLine, editIndex, match?.remarks, setIndex, team, mode, t])

  const needsContext = template && template !== 'missingSignature'
  return (
    <CorrectionForm
      title={editLine != null ? tr(t, 'corrections.form.editRemark', 'Edit remark') : tr(t, 'corrections.form.addRemark', 'Add remark')}
      ctx={ctx}
      plan={plan}
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
      preview={plan && <p className="whitespace-pre-wrap rounded-lg bg-white px-3 py-2 text-sm text-stone-800 ring-1 ring-stone-200">{value.trim()}</p>}
    >
      {editLine == null && (
        <FieldGroup label={tr(t, 'corrections.field.template', 'Kind of remark')}>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={tr(t, 'corrections.field.template', 'Kind of remark')}>
            {TEMPLATES.map(k => {
              const on = template === k
              return (
                <button key={k} type="button" role="radio" aria-checked={on} onClick={() => { setTemplate(k); setDirty(false) }}
                  className={cn('min-h-11 rounded-lg border px-3 text-sm transition-colors', FOCUS_RING,
                    on ? 'border-slate-900 bg-slate-900 text-white' : 'border-stone-300 bg-white text-stone-800 hover:bg-stone-50')}>
                  {tr(t, `corrections.remarkTemplate.${k}`, TEMPLATE_DEFAULTS[k])}
                </button>
              )
            })}
          </div>
          {template === 'protest' && <p className="mt-1.5 text-xs text-stone-500">{tr(t, 'corrections.hint.protest', 'Dictated by the captain, with the 1st referee\'s permission.')}</p>}
        </FieldGroup>
      )}
      {editLine == null && needsContext && <SetPicker sets={playedSets(sets, events)} value={setIndex} onChange={(v) => { chooseSet(v); setDirty(false) }} ctx={ctx} />}
      {editLine == null && template && template !== 'delay' && <TeamPicker value={team} onChange={(v) => { setTeam(v); setDirty(false) }} ctx={ctx} />}
      {editLine == null && needsContext && template !== 'delay' && setIndex && <ScoreAtPicker timeline={timeline} value={at} onChange={(v) => { setAt(v); setDirty(false) }} team={team} ctx={ctx} />}
      <div>
        <label htmlFor="ov-corr-remark" className="block text-sm font-medium text-stone-700 mb-1.5">{tr(t, 'corrections.field.text', 'Text')}</label>
        <Textarea id="ov-corr-remark" rows={4} prose value={value} onChange={(e) => { setText(e.target.value); setDirty(true) }} />
      </div>
    </CorrectionForm>
  )
}

// ─────────────────────────────── set times ───────────────────────────────

function toClock(iso) {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function withClock(iso, clock, fallbackIso) {
  if (!/^\d{1,2}:\d{2}$/.test(clock || '')) return undefined
  const baseMs = Date.parse(iso || fallbackIso || '')
  const d = Number.isFinite(baseMs) ? new Date(baseMs) : new Date()
  const [h, m] = clock.split(':').map(Number)
  d.setHours(h, m, 0, 0)
  return d.toISOString()
}

export function SetTimesForm({ ctx, events, sets, setRow, match, busy, onCancel, onConfirm }) {
  const t = ctx.t
  const [start, setStart] = useState(toClock(setRow?.startTime))
  const [end, setEnd] = useState(toClock(setRow?.endTime))
  const [addRemark, setAddRemark] = useState(false)
  const [remark, setRemark] = useState(null)
  const startIso = withClock(setRow?.startTime, start, setRow?.endTime || match?.scheduledAt)
  const endIso = withClock(setRow?.endTime, end, setRow?.startTime || match?.scheduledAt)
  const base = useMemo(() => {
    const changes = {}
    if (startIso && startIso !== setRow?.startTime) changes.startTime = startIso
    if (endIso && endIso !== setRow?.endTime) changes.endTime = endIso
    if (!Object.keys(changes).length) return null
    return planSetTimes(events, sets, { setIndex: setRow.index, ...changes, scheduledAt: match?.scheduledAt }, ctx)
  }, [startIso, endIso, setRow, events, sets, match?.scheduledAt, ctx])
  const suggestion = base && !base.error ? base.suggestedRemark : null
  const plan = base && !base.error && addRemark && suggestion ? { ...base, remarkAdd: [(remark ?? suggestion).trim()].filter(Boolean) } : base
  const set = displaySetNumber(setRow?.index, ctx.match)
  return (
    <CorrectionForm
      title={tr(t, 'corrections.form.setTimes', 'Set {{set}}: start and end time', { set })}
      ctx={ctx}
      plan={plan}
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
      preview={plan && !plan.error && (
        <div className="space-y-2">
          <p className="text-sm text-stone-700">{setTimesText(startIso ?? setRow?.startTime, endIso ?? setRow?.endTime, t)}</p>
          {suggestion && (
            <Checkbox
              checked={addRemark}
              onChange={(e) => setAddRemark(e.target.checked)}
              label={tr(t, 'corrections.field.addDelayRemark', 'Add a remark about the delayed start')}
            />
          )}
          {suggestion && addRemark && (
            <Textarea size="sm" rows={2} value={remark ?? suggestion} onChange={(e) => setRemark(e.target.value)} aria-label={tr(t, 'corrections.preview.remark', 'Remark added to the scoresheet')} />
          )}
        </div>
      )}
    >
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="ov-corr-start" className="block text-sm font-medium text-stone-700 mb-1.5">{tr(t, 'corrections.field.startTime', 'Start')}</label>
          <Input id="ov-corr-start" type="time" size="lg" value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div>
          <label htmlFor="ov-corr-end" className="block text-sm font-medium text-stone-700 mb-1.5">{tr(t, 'corrections.field.endTime', 'End')}</label>
          <Input id="ov-corr-end" type="time" size="lg" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
      </div>
    </CorrectionForm>
  )
}

// ───────────────────────────── final score ─────────────────────────────

export function FinalScoreForm({ ctx, events, sets, setRow, busy, onCancel, onConfirm }) {
  const t = ctx.t
  const [choice, setChoice] = useState(null) // 'home:1' ...
  const current = scoreFromPointEvents(events, setRow.index)
  const plan = useMemo(() => {
    if (!choice) return null
    const [team, d] = choice.split(':')
    return planAdjustFinalScore(events, sets, { setIndex: setRow.index, team, delta: Number(d) }, ctx)
  }, [choice, events, sets, setRow.index, ctx])
  const nextScore = plan && !plan.error ? scoreFromPointEvents(applyPlanToEvents(events, plan), setRow.index) : null
  const set = displaySetNumber(setRow.index, ctx.match)
  const aKey = ctx.match?.coinTossTeamA === 'away' ? 'away' : 'home'
  const order = [aKey, aKey === 'home' ? 'away' : 'home']
  return (
    <CorrectionForm
      title={tr(t, 'corrections.form.finalScore', 'Set {{set}}: correct final score', { set })}
      ctx={ctx}
      plan={plan}
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
      preview={nextScore && (
        <p className="text-sm text-stone-700">
          {tr(t, 'corrections.preview.finalScore', 'Final score {{before}} becomes {{after}}.', {
            before: formatScore({ home: current.homePoints, away: current.awayPoints }, null, ctx),
            after: formatScore({ home: nextScore.homePoints, away: nextScore.awayPoints }, null, ctx)
          })}
        </p>
      )}
    >
      <p className="text-sm text-stone-600">
        {tr(t, 'corrections.hint.finalScore', 'Only the end of the set can be corrected: a point added after the last point, or the last point removed. Points missed in the middle of a set cannot be fixed (Swiss scorekeeper course).')}
      </p>
      <p className="text-sm font-semibold text-stone-900 tabular-nums">{tr(t, 'corrections.field.currentFinal', 'Now')}: {formatScore({ home: current.homePoints, away: current.awayPoints }, null, ctx)}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" role="radiogroup" aria-label={tr(t, 'corrections.form.finalScore', 'Set {{set}}: correct final score', { set })}>
        {order.flatMap(team => [1, -1].map(d => {
          const key = `${team}:${d}`
          const on = choice === key
          const lbl = teamLabel(team, ctx)
          return (
            <button key={key} type="button" role="radio" aria-checked={on} onClick={() => setChoice(key)}
              className={cn('min-h-11 rounded-lg border px-3 py-2 text-left text-sm flex items-center gap-2 transition-colors', FOCUS_RING,
                on ? 'border-slate-900 bg-slate-900 text-white' : 'border-stone-300 bg-white text-stone-800 hover:bg-stone-50')}>
              <span className="font-semibold tabular-nums w-6">{d > 0 ? '+1' : '−1'}</span>
              <span className="min-w-0 truncate">{tr(t, 'corrections.teamWithLetter', '{{name}} ({{letter}})', { name: lbl.name, letter: lbl.letter })}</span>
            </button>
          )
        }))}
      </div>
    </CorrectionForm>
  )
}

