// Go back / rectify: the one place where the scorer puts the game back as
// the rules say when a fault is found after play went on (domain/rectify),
// or ends a set or the match for a team that cannot go on (the forfeit of
// the Scoreboard, handleForfait). The scorer picks what happened, the team at
// fault and the moment of the fault from the set's own log, sees what
// changes (points cancelled, the penalty point, the score, who serves, the
// line-up) and confirms: one correction, which Undo and the corrections can
// take back. Opened from the Match menu, on the tablet and on the phone.
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ChevronRight, History, Ban, UserX, Undo2 } from 'lucide-react'
import { cn } from '../../ui/cn.js'
import { Button, FOCUS_RING } from '../../ui/Button.jsx'
import { Banner } from '../../ui/Banner.jsx'
import { Select } from '../../ui/Select.jsx'
import { SegmentedControl } from '../../ui/SegmentedControl.jsx'
import { FormError } from '../../ui/Field.jsx'
import { tr, formatScore, teamLabel, teamNameWithLetter, displaySetNumber, describeEvent, compareBySeq, otherTeam } from '../../domain/describe'
import {
  RECTIFY_KINDS, RECTIFY_KIND_ORDER, kindText, rectifyMoments, suggestedLineup, planRectification,
  rectifyErrorText, entriesBeforeService, planIllegalEntryBeforeService, lineupNow
} from '../../domain/rectify'
import { forfeitSetPoints } from '../../domain/matchEnd'
import { POSITIONS } from '../../domain/recompute'
import { useConfirmAction } from '../../hooks/useConfirmAction'
import { TeamPicker, FieldGroup, NewIssues } from '../corrections/shared.jsx'

// The situations, grouped as the scorer meets them
const GROUPS = [
  { key: 'cancel', icon: Undo2, title: ['rectify.group.cancel', 'Points of the team at fault cancelled'], items: RECTIFY_KIND_ORDER.filter(k => RECTIFY_KINDS[k].cancels === 'team') },
  { key: 'back', icon: History, title: ['rectify.group.back', 'Back to an earlier score'], items: ['official_error'] },
  { key: 'service', icon: Ban, title: ['rectify.group.service', 'Noticed before the next service'], items: ['before_service'] },
  { key: 'forfeit', icon: UserX, title: ['rectify.group.forfeit', 'A team cannot go on'], items: ['forfeit_set', 'forfeit_match'] }
]

// The situations that are not a going back of the log
const OTHER = {
  before_service: {
    refs: 'R16.1.3, 19.3.2.9; Casebook 4.15, 5.7',
    title: ['rectify.kind.before_service', 'Illegal substitution or libero replacement noticed before the next service'],
    help: ['rectify.help.before_service', 'The entry is taken back and the team gets a delay sanction: a delay warning, or a delay penalty if it already had a delay sanction in this match.']
  },
  forfeit_set: {
    refs: 'R6.4.3, 15.8, 17.1.2; Casebook 4.11',
    title: ['rectify.kind.forfeit_set', 'Team incomplete for this set'],
    help: ['rectify.help.forfeit_set', 'A player who must leave (injury, expulsion, disqualification) cannot be replaced legally or exceptionally, or the coach gives up the set (Casebook 4.11). The opponent gets the points it needs to win the set; the incomplete team keeps its points.']
  },
  forfeit_match: {
    refs: 'R6.4.1, 6.4.2, 6.4.3',
    title: ['rectify.kind.forfeit_match', 'Team in default or incomplete for the match'],
    help: ['rectify.help.forfeit_match', 'The team refuses to play, does not appear, or cannot field six players. The opponent gets the points and the sets it needs to win the match; the sheet keeps the points played. A team in default loses 0:3 (0:25 each set): the competition records that result. A remark is asked for in the next step.']
  }
}

const RECTIFY_GROUP_KINDS = new Set(RECTIFY_KIND_ORDER)

function situationText(key, t) {
  if (RECTIFY_GROUP_KINDS.has(key)) return kindText(key, t)
  const o = OTHER[key]
  return { title: tr(t, o.title[0], o.title[1]), help: tr(t, o.help[0], o.help[1]), refs: o.refs }
}

/** A labelled native select (the moment, the entry). */
function Labelled({ id, label, children }) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-sm font-medium text-stone-700 mb-1.5">{label}</label>
      {children}
    </div>
  )
}

/** One line of the preview: a label and its value. */
function PreviewRow({ label, children }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-[11rem_1fr] sm:gap-3">
      <dt className="text-xs font-medium text-stone-500">{label}</dt>
      <dd className="m-0 text-sm text-stone-900 tabular-nums">{children}</dd>
    </div>
  )
}

function PreviewShell({ t, plan, children }) {
  return (
    <section aria-live="polite" aria-label={tr(t, 'rectify.preview.title', 'What changes')} className="rounded-xl border border-stone-200 bg-stone-50/70 p-3.5">
      <h3 className="m-0 mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500">{tr(t, 'rectify.preview.title', 'What changes')}</h3>
      {!plan ? (
        <p className="m-0 text-sm text-stone-500">{tr(t, 'rectify.preview.incomplete', 'Choose the team and the moment above.')}</p>
      ) : plan.error ? (
        <FormError>{rectifyErrorText(plan, t)}</FormError>
      ) : (
        <div className="space-y-2.5">
          {children}
          {plan.notes?.length > 0 && (
            <ul className="m-0 list-none space-y-1 p-0">
              {plan.notes.map((n, i) => (
                <li key={i} className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">{tr(t, n.key, n.text, n.params)}</li>
              ))}
            </ul>
          )}
          <NewIssues issues={plan.newIssues} t={t} />
        </div>
      )}
    </section>
  )
}

/** The six positions of the team at fault, each a select of its players. */
function LineupEditor({ lineup, onChange, players, ctx }) {
  const t = ctx.t
  const options = useMemo(() => {
    const nums = new Map()
    // the number only (as on the court): a name does not fit a phone's third
    for (const p of players || []) {
      if (p?.number == null) continue
      nums.set(String(p.number), `#${p.number}${p.libero ? ` (${tr(t, 'rectify.lineup.libero', 'libero')})` : ''}`)
    }
    for (const pos of POSITIONS) if (lineup?.[pos] != null && !nums.has(String(lineup[pos]))) nums.set(String(lineup[pos]), `#${lineup[pos]}`)
    return [...nums.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([value, label]) => ({ value, label }))
  }, [players, lineup, t])
  return (
    <div className="grid grid-cols-3 gap-2" role="group" aria-label={tr(t, 'rectify.lineup.editor', 'Line-up from the next rally')}>
      {['IV', 'III', 'II', 'V', 'VI', 'I'].map(pos => (
        <label key={pos} className="min-w-0 text-xs font-medium text-stone-600">
          <span className="mb-1 block">{pos}</span>
          <Select
            size="lg"
            block
            aria-label={tr(t, 'rectify.lineup.position', 'Player at position {{pos}}', { pos })}
            options={options}
            value={lineup?.[pos] != null ? String(lineup[pos]) : ''}
            onChange={(e) => onChange({ ...lineup, [pos]: e.target.value })}
          />
        </label>
      ))}
    </div>
  )
}

/** A rectification (domain/rectify planRectification): team, moment, line-up, preview. */
function RectifyForm({ kind, events, ctx, setIndex, players, blocked, onApply, busy }) {
  const t = ctx.t
  const def = RECTIFY_KINDS[kind]
  const needsTeam = def.cancels === 'team'
  const [team, setTeam] = useState(null)
  const [momentKey, setMomentKey] = useState(null)
  const [edited, setEdited] = useState(null) // the line-up the scorer set, or null
  const moments = useMemo(
    () => (needsTeam && !team ? [] : rectifyMoments(events, { kind, setIndex, team }, ctx)),
    [events, kind, setIndex, team, ctx, needsTeam]
  )
  // The moment offered first: the start of the set for a line-up sheet
  // discrepancy (the sheet holds from 0:0), else the newest
  const defaultMoment = def.moment === 'score' && def.cancels === 'team'
    ? moments.filter(m => m.kind === 'score').pop()
    : moments[0]
  const moment = moments.find(m => m.key === momentKey) || defaultMoment || null
  const suggestion = useMemo(
    () => (team && moment && def.lineup !== 'none' ? suggestedLineup(events, { kind, setIndex, team, moment }) : null),
    [events, kind, setIndex, team, moment, def.lineup]
  )
  const lineup = edited || (def.lineup === 'suggest' ? suggestion : null)
  const plan = useMemo(() => {
    if ((needsTeam && !team) || !moment) return null
    return planRectification(events, { kind, setIndex, team, moment, lineup }, ctx)
  }, [events, kind, setIndex, team, moment, lineup, ctx, needsTeam])
  const preview = plan && !plan.error ? plan.preview : null
  const momentId = `rectify-moment-${kind}`
  const current = team ? lineupNow(events, setIndex, team)?.lineup : null
  const scoreText = (s) => formatScore(s, null, ctx)

  return (
    <div className="space-y-4">
      {needsTeam && (
        <TeamPicker
          label={tr(t, 'rectify.field.teamAtFault', 'Team at fault')}
          value={team}
          onChange={(v) => { setTeam(v); setMomentKey(null); setEdited(null) }}
          ctx={ctx}
        />
      )}
      {(!needsTeam || team) && (
        moments.length ? (
          <Labelled id={momentId} label={kindText(kind, t).momentPrompt}>
            <Select id={momentId} size="lg" block value={moment?.key || ''} onChange={(e) => { setMomentKey(e.target.value); setEdited(null) }}
              options={moments.map(m => ({ value: m.key, label: m.label }))} />
          </Labelled>
        ) : (
          <p className="m-0 text-sm text-stone-500">{tr(t, `rectify.empty.${def.moment}`, def.moment === 'substitution' ? 'This team has no substitution in this set.' : def.moment === 'libero' ? 'This team has no libero replacement in this set.' : 'Nothing to choose in this set.')}</p>
        )
      )}
      {team && def.lineup !== 'none' && current && (
        <FieldGroup
          label={tr(t, 'rectify.field.lineup', 'Line-up of {{team}} from the next rally', { team: teamNameWithLetter(team, ctx) })}
          hint={def.lineup === 'suggest'
            ? tr(t, 'rectify.lineup.hintSuggest', 'The illegal substitution undone: the player who came in goes out, the one he replaced comes back. Change it if the referees put it right another way.')
            : tr(t, 'rectify.lineup.hintKeep', 'The app keeps the line-up sheet and the rotational order: the players go back to these positions. Change it only if the record itself was wrong.')}
        >
          <LineupEditor lineup={lineup || current} onChange={setEdited} players={players[team]} ctx={ctx} />
        </FieldGroup>
      )}
      <PreviewShell t={t} plan={plan}>
        {preview && (
          <dl className="m-0 space-y-2">
            {def.cancels === 'team' ? (
              <PreviewRow label={tr(t, 'rectify.preview.cancelled', 'Points cancelled')}>
                {preview.cancelled.length
                  ? tr(t, 'rectify.preview.cancelledList', '{{n}} of {{team}}: {{list}}', {
                    n: preview.cancelled.length,
                    team: teamLabel(team, ctx)?.name || '?',
                    list: preview.cancelled.map(c => scoreText(c.score)).join(', ')
                  })
                  : tr(t, 'rectify.preview.none', 'None')}
              </PreviewRow>
            ) : (
              <PreviewRow label={tr(t, 'rectify.preview.removed', 'Rallies taken out')}>
                {tr(t, 'rectify.preview.removedList', '{{n}}: {{list}}', { n: preview.removed.length, list: preview.removed.map(c => scoreText(c.score)).join(', ') })}
              </PreviewRow>
            )}
            <PreviewRow label={tr(t, 'rectify.preview.penalty', 'Penalty')}>
              {preview.penalty
                ? tr(t, 'rectify.preview.pointTo', 'Point and service to {{team}}', { team: teamNameWithLetter(preview.penaltyTo, ctx) })
                : tr(t, 'rectify.preview.noPoint', 'No point added')}
            </PreviewRow>
            <PreviewRow label={tr(t, 'rectify.preview.score', 'Score')}>
              <span className="font-semibold">{scoreText(preview.scoreBefore)} → {scoreText(preview.scoreAfter)}</span>
            </PreviewRow>
            <PreviewRow label={tr(t, 'rectify.preview.server', 'Serves next')}>
              {preview.serverNumber != null
                ? tr(t, 'rectify.preview.serverWithNumber', '{{team}}, #{{n}}', { team: teamNameWithLetter(preview.server, ctx), n: preview.serverNumber })
                : teamNameWithLetter(preview.server, ctx)}
            </PreviewRow>
            {preview.lineupAfter && def.lineup !== 'none' && (
              <PreviewRow label={tr(t, 'rectify.preview.lineup', 'Line-up of {{team}}', { team: teamLabel(team, ctx)?.letter || '?' })}>
                {preview.lineupText}
                {preview.lineupChanged && <span className="ml-1.5 text-xs font-medium text-amber-800">{tr(t, 'rectify.preview.lineupChanged', '(put right)')}</span>}
              </PreviewRow>
            )}
            {plan.remarkAdd?.[0] && (
              <PreviewRow label={tr(t, 'rectify.preview.remark', 'Remark on the scoresheet')}>
                <span className="text-stone-700">{plan.remarkAdd[0]}</span>
              </PreviewRow>
            )}
          </dl>
        )}
      </PreviewShell>
      <Button variant="dark" size="lg" block disabled={!preview || blocked || busy} loading={busy} onClick={() => onApply(plan)}>
        {kind === 'official_error' ? tr(t, 'rectify.action.goBack', 'Go back to this score') : tr(t, 'rectify.action.apply', 'Cancel the points and give the point')}
      </Button>
    </div>
  )
}

/** Illegal entry noticed before the next service: take it back, delay sanction. */
function BeforeServiceForm({ events, ctx, setIndex, blocked, onApply, busy }) {
  const t = ctx.t
  const [team, setTeam] = useState(null)
  const [entryId, setEntryId] = useState(null)
  const entries = useMemo(() => (team ? entriesBeforeService(events, { setIndex, team }) : []), [events, setIndex, team])
  const entry = entries.find(e => String(e.id) === String(entryId)) || entries[0] || null
  const plan = useMemo(() => (team && entry ? planIllegalEntryBeforeService(events, { setIndex, team, eventId: entry.id }, ctx) : null), [events, setIndex, team, entry, ctx])
  const ok = plan && !plan.error
  const sanction = plan?.rectification?.sanctionType
  return (
    <div className="space-y-4">
      <TeamPicker label={tr(t, 'rectify.field.teamAtFault', 'Team at fault')} value={team} onChange={(v) => { setTeam(v); setEntryId(null) }} ctx={ctx} />
      {team && (entries.length ? (
        <Labelled id="rectify-entry" label={tr(t, 'rectify.field.entry', 'Which entry?')}>
          <Select id="rectify-entry" size="lg" block value={entry ? String(entry.id) : ''} onChange={(e) => setEntryId(e.target.value)}
            options={entries.map(e => ({ value: String(e.id), label: describeEvent(e, events, ctx)?.text || e.type }))} />
        </Labelled>
      ) : (
        <p className="m-0 text-sm text-stone-500">{tr(t, 'rectify.empty.beforeService', 'This team has no substitution or libero replacement since the last rally.')}</p>
      ))}
      <PreviewShell t={t} plan={plan}>
        {ok && (
          <dl className="m-0 space-y-2">
            <PreviewRow label={tr(t, 'rectify.preview.takenBack', 'Taken back')}>{describeEvent(entry, events, ctx)?.text}</PreviewRow>
            <PreviewRow label={tr(t, 'rectify.preview.sanction', 'Sanction')}>
              {sanction === 'delay_penalty'
                ? tr(t, 'rectify.preview.delayPenalty', 'Delay penalty: point and service to {{team}}', { team: teamNameWithLetter(otherTeam(team), ctx) })
                : tr(t, 'rectify.preview.delayWarning', 'Delay warning')}
            </PreviewRow>
          </dl>
        )}
      </PreviewShell>
      <Button variant="dark" size="lg" block disabled={!ok || blocked || busy} loading={busy} onClick={() => onApply(plan)}>
        {tr(t, 'rectify.action.takeBack', 'Take back and give the delay sanction')}
      </Button>
    </div>
  )
}

/** Team incomplete for the set: the opponent wins the set (Scoreboard handleForfait, scope 'set'). */
function ForfeitSetForm({ ctx, liveSet, blocked, onForfeit, busy }) {
  const t = ctx.t
  const [team, setTeam] = useState(null)
  const [reason, setReason] = useState('injury')
  const opp = otherTeam(team)
  const pts = (k) => Number(k === 'home' ? liveSet?.homePoints : liveSet?.awayPoints) || 0
  const oppPts = team ? forfeitSetPoints(pts(team), pts(opp), liveSet?.index) : 0
  const after = team ? { [team]: pts(team), [opp]: oppPts } : null
  return (
    <div className="space-y-4">
      <TeamPicker label={tr(t, 'rectify.field.teamIncomplete', 'Team that cannot go on')} value={team} onChange={setTeam} ctx={ctx} />
      <FieldGroup label={tr(t, 'rectify.field.reason', 'Why')}>
        <SegmentedControl
          ariaLabel={tr(t, 'rectify.field.reason', 'Why')}
          value={reason}
          onChange={setReason}
          options={[
            { value: 'injury', label: tr(t, 'corrections.reason.injury', 'injury').replace(/^./, c => c.toUpperCase()) },
            { value: 'expulsion', label: tr(t, 'corrections.reason.expulsion', 'expulsion').replace(/^./, c => c.toUpperCase()) },
            { value: 'disqualification', label: tr(t, 'corrections.reason.disqualification', 'disqualification').replace(/^./, c => c.toUpperCase()) }
          ]}
        />
      </FieldGroup>
      <PreviewShell t={t} plan={team ? {} : null}>
        {team && (
          <dl className="m-0 space-y-2">
            <PreviewRow label={tr(t, 'rectify.preview.score', 'Score')}>
              <span className="font-semibold">{formatScore({ home: pts('home'), away: pts('away') }, null, ctx)} → {formatScore(after, null, ctx)}</span>
            </PreviewRow>
            <PreviewRow label={tr(t, 'rectify.preview.result', 'Result')}>
              {tr(t, 'rectify.preview.setTo', 'Set {{set}} to {{team}}; {{other}} keeps its points', {
                set: displaySetNumber(liveSet?.index, ctx.match), team: teamNameWithLetter(opp, ctx), other: teamLabel(team, ctx)?.name || '?'
              })}
            </PreviewRow>
          </dl>
        )}
      </PreviewShell>
      <Button variant="danger" size="lg" block disabled={!team || blocked || busy} loading={busy} onClick={() => onForfeit(team, reason)}>
        {tr(t, 'rectify.action.forfeitSet', 'Give the set to the opponent')}
      </Button>
    </div>
  )
}

function ForfeitMatchForm({ ctx, onForfeit, busy }) {
  const t = ctx.t
  const [team, setTeam] = useState(null)
  return (
    <div className="space-y-4">
      <TeamPicker label={tr(t, 'rectify.field.teamIncomplete', 'Team that cannot go on')} value={team} onChange={setTeam} ctx={ctx} />
      {team && (
        <p className="m-0 text-sm text-stone-700">
          {tr(t, 'rectify.preview.matchTo', '{{team}} gets the points and sets it needs to win the match; {{other}} keeps the points and sets it has. The match then ends.', {
            team: teamNameWithLetter(otherTeam(team), ctx), other: teamLabel(team, ctx)?.name || '?'
          })}
        </p>
      )}
      <Button variant="danger" size="lg" block disabled={!team || busy} loading={busy} onClick={() => onForfeit(team)}>
        {tr(t, 'rectify.action.forfeitMatch', 'Continue to the forfeit of the match')}
      </Button>
    </div>
  )
}

/**
 * @param {object} props
 * @param {Array} props.events the match log
 * @param {object} props.match
 * @param {Array} props.sets
 * @param {number|null} props.liveSetIndex the set being played
 * @param {boolean} [props.rallyInPlay] a rally is in play: nothing is written until it ends
 * @param {{ apply?: (plan) => Promise<boolean>, forfeitSet?: Function, forfeitMatch?: Function, close?: Function }} props.hooks
 */
export default function RectifyPanel({
  events, match, sets, homeTeam, awayTeam, homePlayers = [], awayPlayers = [],
  liveSetIndex = null, rallyInPlay = false, hooks = {}
}) {
  const { t } = useTranslation()
  const players = useMemo(() => ({ home: homePlayers || [], away: awayPlayers || [] }), [homePlayers, awayPlayers])
  const ctx = useMemo(() => ({ t, match, homeTeam, awayTeam, liveSetIndex, players, mode: 'live' }), [t, match, homeTeam, awayTeam, liveSetIndex, players])
  const sorted = useMemo(() => [...(events || [])].sort(compareBySeq), [events])
  const liveSet = (sets || []).find(s => s.index === liveSetIndex) || null
  const setOpen = !!liveSet && !liveSet.finished && !sorted.some(e => e.type === 'set_end' && (e.setIndex ?? 1) === liveSetIndex)
  const [choice, setChoice] = useState(null)
  const [busy, setBusy] = useState(false)
  const run = useConfirmAction(() => setBusy(false))

  // Why a situation cannot be used now (null: it can)
  const unavailable = (key) => {
    if (key === 'forfeit_match') return null
    if (!setOpen) return tr(t, 'rectify.blocked.noSet', 'Only during a set.')
    return null
  }
  const blocked = rallyInPlay
  const finish = async (fn) => {
    await run(async () => {
      setBusy(true)
      try {
        const ok = await fn()
        if (ok !== false) hooks.close?.()
      } finally {
        setBusy(false)
      }
    })
  }

  // .ov-kit: the kit's own styles, not the scoring screen's legacy button rule
  if (choice) {
    const text = situationText(choice, t)
    return (
      <div className="ov-kit space-y-4">
        <button type="button" onClick={() => setChoice(null)} className={cn('inline-flex min-h-11 items-center gap-1.5 rounded-lg px-1 text-sm font-medium text-stone-600 hover:text-stone-900', FOCUS_RING)}>
          <ArrowLeft size={16} aria-hidden="true" />
          {tr(t, 'rectify.back', 'All situations')}
        </button>
        <div>
          <h3 className="m-0 text-base font-semibold text-stone-900">{text.title}</h3>
          <p className="m-0 mt-0.5 text-xs font-medium text-stone-500">{text.refs}</p>
          <p className="m-0 mt-2 text-sm text-stone-700">{text.help}</p>
        </div>
        {blocked && choice !== 'forfeit_match' && <Banner tone="warning">{tr(t, 'rectify.blocked.rally', 'A rally is in play: finish it first.')}</Banner>}
        {RECTIFY_GROUP_KINDS.has(choice) && (
          <RectifyForm key={choice} kind={choice} events={sorted} ctx={ctx} setIndex={liveSetIndex} players={players} blocked={blocked} busy={busy}
            onApply={(plan) => finish(() => hooks.apply?.(plan))} />
        )}
        {choice === 'before_service' && (
          <BeforeServiceForm events={sorted} ctx={ctx} setIndex={liveSetIndex} blocked={blocked} busy={busy}
            onApply={(plan) => finish(() => hooks.apply?.(plan))} />
        )}
        {choice === 'forfeit_set' && (
          <ForfeitSetForm ctx={ctx} liveSet={liveSet} blocked={blocked} busy={busy}
            onForfeit={(team, reason) => finish(() => hooks.forfeitSet?.(team, reason))} />
        )}
        {choice === 'forfeit_match' && (
          <ForfeitMatchForm ctx={ctx} busy={busy} onForfeit={(team) => finish(() => hooks.forfeitMatch?.(team))} />
        )}
      </div>
    )
  }

  return (
    <div className="ov-kit space-y-4">
      <p className="m-0 text-sm text-stone-600">
        {tr(t, 'rectify.intro', 'When a fault is found after play went on, the rules take the game back. Choose what happened: you see what changes before anything is written, and Undo takes it back.')}
      </p>
      {GROUPS.map(group => (
        <section key={group.key} aria-label={tr(t, group.title[0], group.title[1])}>
          <h3 className="m-0 mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-500">
            <group.icon size={13} aria-hidden="true" />
            {tr(t, group.title[0], group.title[1])}
          </h3>
          <ul className="m-0 list-none divide-y divide-stone-100 overflow-hidden rounded-xl border border-stone-200 bg-white p-0">
            {group.items.map(key => {
              const text = situationText(key, t)
              const why = unavailable(key)
              return (
                <li key={key}>
                  <button
                    type="button"
                    disabled={!!why}
                    onClick={() => setChoice(key)}
                    className={cn('flex min-h-12 w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50', FOCUS_RING)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-stone-900">{text.title}</span>
                      <span className="block text-xs text-stone-500">{why || text.refs}</span>
                    </span>
                    <ChevronRight size={16} className="shrink-0 text-stone-400" aria-hidden="true" />
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}
