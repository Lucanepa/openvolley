// Corrections: one panel for the in-match "Manual changes" modal (mode
// 'live') and the match-end page (mode 'review'). It speaks the scoresheet,
// never the event log: cards in scoresheet order, each with an obvious
// "+ Add …", every row a sentence (domain/describe), every change planned
// (domain/manualCorrections), previewed, confirmed and written in one
// transaction (services/corrections/applyCorrectionPlan).
// Every entry is correctable (owner 2026-10-29): what follows from it is
// recalculated (domain/recompute) and what no longer fits is listed under
// "Check these entries", each with its Edit, never refused.
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, X, Pencil, Undo2, Repeat, ArrowLeftRight, RotateCw, RotateCcw, ListRestart, Hash, AlertTriangle } from 'lucide-react'
import { db } from '../../db/db'
import { cn } from '../../ui/cn.js'
import { Button } from '../../ui/Button.jsx'
import { Banner } from '../../ui/Banner.jsx'
import { Chip } from '../../ui/Chip.jsx'
import { SegmentedControl } from '../../ui/SegmentedControl.jsx'
import { confirmDialog, toast } from '../../ui/uiStore.js'
import {
  describeEvent, compareBySeq, tr, teamLabel, formatScore, displaySetNumber, setTimesText,
  hasTeamDesignation, teamNameWithLetter
} from '../../domain/describe'
import {
  planRemoveTimeout, planRemoveSubstitution, planRemoveSanction, planRemoveEntry, planRotateTeam,
  planCoinToss, planSet5CoinToss, emptyPlan, errorText, describeRemoval, entryActions, startingLineupEvent
} from '../../domain/manualCorrections'
import { matchIssues, issueText } from '../../domain/recompute'
import { awardsPoint } from '../../domain/sanctions'
import { scoreFromPointEvents, getFirstServeForSet } from '../../domain/rules'
import { applyCorrectionPlan } from '../../services/corrections/applyCorrectionPlan'
import { useConfirmAction } from '../../hooks/useConfirmAction'
import { switchSides, firstServerOf, teamASide } from './liveActions'
import { SectionCard, EmptyLine, TeamDot, CourtMini, HIT, NewIssues } from './shared.jsx'
import { TimeoutForm, SubstitutionForm, SanctionForm, RemarkForm, SetTimesForm, FinalScoreForm, playedSets } from './forms.jsx'
import { LineupForm, PointForm, EntryForm, CoinTossForm, GameCaptainForm, RenumberForm, lineupSummary } from './moreForms.jsx'
import CorrectionLog from './CorrectionLog.jsx'
import EventLogAdvanced from './EventLogAdvanced.jsx'

// The live action buttons: left-aligned, a long team name wraps inside the button
const LIVE_BTN = 'justify-start text-left h-auto min-h-11 py-2 [&>svg]:shrink-0'

const LIBERO_TYPES = ['libero_entry', 'libero_exit', 'libero_exchange', 'libero_unable', 'libero_redesignation']

function AddButton({ children, onClick, disabled }) {
  return (
    <Button variant="dark" size="md" icon={Plus} className={HIT} onClick={onClick} disabled={disabled}>
      {children}
    </Button>
  )
}

/** One row: the sentence, its chips, Edit and Remove. */
function EventRow({ d, onEdit, onRemove, readOnly, t, extraChips = null }) {
  const meta = d.meta
  return (
    <li className="flex items-start gap-3 py-2.5">
      <TeamDot color={d.team?.color} size={12} className="mt-1.5" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium text-stone-900">{d.title}</span>
          {d.code && <code className="rounded border border-stone-300 bg-stone-50 px-1.5 py-px font-mono text-[11px] text-stone-700" title={tr(t, 'corrections.chip.paperCode', 'As written on the scoresheet')}>{d.code}</code>}
          {d.exceptional && <Chip tone="amber">{tr(t, 'corrections.chip.exceptional', 'Exceptional')}</Chip>}
          {d.incomplete && <Chip tone="urgent">{tr(t, 'corrections.chip.incomplete', 'Incomplete entry')}</Chip>}
          {extraChips}
        </div>
        {meta && <div className="mt-0.5 text-xs text-stone-500 tabular-nums">{meta}</div>}
      </div>
      {!readOnly && onEdit && (
        <Button variant="secondary" size="md" icon={Pencil} className={HIT} onClick={onEdit} aria-label={tr(t, 'corrections.action.editWhat', 'Edit {{what}}', { what: d.title })}>
          <span className="hidden sm:inline">{tr(t, 'corrections.action.edit', 'Edit')}</span>
        </Button>
      )}
      {!readOnly && onRemove && (
        <Button variant="danger-soft" size="md" icon={X} className={cn(HIT, 'w-9 px-0')} onClick={onRemove} aria-label={tr(t, 'corrections.action.removeEntry', 'Remove {{what}}', { what: d.title })} />
      )}
    </li>
  )
}

export default function CorrectionsPanel({
  mode = 'review',
  matchId,
  events,
  match,
  sets,
  homeTeam,
  awayTeam,
  homePlayers = [],
  awayPlayers = [],
  liveSetIndex = null,
  readOnly = false,
  onReopenForCorrections,
  hooks = {}
}) {
  const { t } = useTranslation()
  const live = mode === 'live'
  // The roster's liberos: never offered in a substitution, refused by the planner
  const liberos = useMemo(() => ({
    home: (homePlayers || []).filter(p => p?.libero).map(p => p.number),
    away: (awayPlayers || []).filter(p => p?.libero).map(p => p.number)
  }), [homePlayers, awayPlayers])
  const rosters = useMemo(() => ({ home: homePlayers || [], away: awayPlayers || [] }), [homePlayers, awayPlayers])
  const ctx = useMemo(() => ({ t, match, homeTeam, awayTeam, matchId, mode, liveSetIndex, liberos, players: rosters }), [t, match, homeTeam, awayTeam, matchId, mode, liveSetIndex, liberos, rosters])
  const sorted = useMemo(() => [...(events || [])].sort(compareBySeq), [events])
  const played = useMemo(() => playedSets(sets, sorted), [sets, sorted])
  const [filter, setFilter] = useState(live && liveSetIndex ? String(liveSetIndex) : 'all')
  const [form, setForm] = useState(null) // { kind, editEvent?, setRow?, line?, index? }
  const [busy, setBusy] = useState(false)
  const [signaturesCleared, setSignaturesCleared] = useState(false)
  const players = rosters
  // What the record says that no longer fits (a correction never refuses it)
  const issues = useMemo(() => matchIssues(sorted, ctx), [sorted, ctx])

  const inFilter = (e) => filter === 'all' || (e.setIndex ?? 1) === Number(filter)
  const rowsOf = (pred) => sorted.filter(e => pred(e) && inFilter(e)).map(e => ({ e, d: describeEvent(e, sorted, ctx) })).filter(r => r.d)
  const timeouts = rowsOf(e => e.type === 'timeout')
  const subs = rowsOf(e => e.type === 'substitution')
  const sanctions = rowsOf(e => e.type === 'sanction')
  const liberoRows = rowsOf(e => LIBERO_TYPES.includes(e.type) && !entryActions(e, sorted).automatic)
  const remarkLines = String(match?.remarks || '').split('\n').map((line, index) => ({ line, index })).filter(r => r.line.trim())

  const presetSet = filter === 'all' ? null : Number(filter)

  // ── write path ──
  // Every write goes through useConfirmAction (as the scoreboard's confirm
  // dialogs do): one write at a time, so a double tap or Enter + click on a
  // Confirm writes once, and the click that follows a confirm is swallowed.
  // The kit confirm dialogs are already closed when they resolve (close first).
  const runConfirm = useConfirmAction((err) => {
    console.error('[corrections] write failed', err)
    toast.error(tr(t, 'corrections.saveError', 'The correction could not be saved: {{message}}', { message: err?.message || '' }))
  })

  const apply = async (plan) => {
    if (!plan || plan.error) return false
    let saved = false
    await runConfirm(async () => {
      setBusy(true)
      try {
        const res = await applyCorrectionPlan(plan, { matchId, db, mode, hooks })
        if (plan.followUp?.awardPointTo) await hooks.addPoint?.(plan.followUp.awardPointTo)
        if (res.signaturesCleared) setSignaturesCleared(true)
        await hooks.afterApply?.(res, plan)
        toast.success(plan.log?.text || tr(t, 'corrections.saved', 'Correction saved'))
        setForm(null)
        saved = true
      } finally {
        setBusy(false)
      }
    })
    return saved
  }

  /** Record a correction that the live handlers wrote themselves (log only). */
  const logOnly = async (text, action, extra = {}) => {
    const p = emptyPlan()
    p.log = { action, setIndex: liveSetIndex, team: null, before: extra.before ?? null, after: extra.after ?? null, text }
    await applyCorrectionPlan(p, { matchId, db, mode, hooks })
  }

  const confirmAndApply = async (plan, { title, lines = [] }) => {
    if (plan.error) { toast.error(errorText(plan, t)); return }
    const ok = await confirmDialog({
      title,
      message: (
        <div className="space-y-1.5 text-sm">
          {lines.map((l, i) => <p key={i}>{l}</p>)}
          {(plan.notes || []).map((n, i) => <p key={`n${i}`} className="text-amber-800">{tr(t, n.key, n.text, n.params)}</p>)}
          <NewIssues issues={plan.newIssues} t={t} />
        </div>
      ),
      confirmLabel: tr(t, 'corrections.action.remove', 'Remove'),
      cancelLabel: tr(t, 'corrections.action.cancel', 'Cancel'),
      tone: 'danger'
    })
    if (ok) await apply(plan)
  }

  const removeEvent = async (ev) => {
    const d = describeEvent(ev, sorted, ctx)
    const title = tr(t, 'corrections.confirm.removeTitle', 'Remove this entry?')
    if (ev.type === 'timeout') {
      const n = sorted.filter(e => e.type === 'timeout' && (e.setIndex ?? 1) === (ev.setIndex ?? 1) && e.payload?.team === ev.payload?.team).length
      return confirmAndApply(planRemoveTimeout(sorted, ev.id, ctx), {
        title,
        lines: [d.text, tr(t, 'corrections.confirm.timeoutCount', '{{team}}\'s time-out count in set {{set}} goes from {{from}} to {{to}}.', {
          team: d.team?.name, set: displaySetNumber(ev.setIndex, match), from: n, to: n - 1
        })]
      })
    }
    if (ev.type === 'substitution') {
      return confirmAndApply(planRemoveSubstitution(sorted, ev.id, ctx), {
        title,
        lines: [d.text, tr(t, 'corrections.confirm.subRestore', '#{{out}} returns to court at position {{position}}; later line-ups are updated.', {
          out: ev.payload?.playerOut ?? '?', position: ev.payload?.position || '?'
        })]
      })
    }
    if (ev.type === 'sanction') {
      let plan = planRemoveSanction(sorted, ev.id, {}, ctx)
      if (awardsPoint(ev.payload?.type) && live) {
        const withPoint = planRemoveSanction(sorted, ev.id, { removePoint: true }, ctx)
        if (!withPoint.error) {
          const both = await confirmDialog({
            title: tr(t, 'corrections.confirm.removePointTitle', 'Remove the penalty point too?'),
            message: tr(t, 'corrections.confirm.removePoint', 'The point it gave is still the last point of this set. Remove it as well (as Undo would)?'),
            confirmLabel: tr(t, 'corrections.action.removeBoth', 'Remove the point too'),
            cancelLabel: tr(t, 'corrections.action.keepPoint', 'Keep the point')
          })
          if (both) plan = withPoint
        }
      }
      return confirmAndApply(plan, { title, lines: [d.text] })
    }
    const actions = entryActions(ev, sorted)
    if (actions.remove === 'reopen') {
      // a set end (forfeit, stopped match) is taken back with Reopen set
      const setRow = (sets || []).find(s => s.index === (ev.setIndex ?? 1))
      if (live && hooks.reopenSet && setRow && setRow.index !== liveSetIndex) return hooks.reopenSet(setRow)
      toast.error(tr(t, 'corrections.error.useReopen', 'A set end is taken back with "Reopen set".'))
      return
    }
    const plan = planRemoveEntry(sorted, ev.id, ctx)
    if (plan.error) { toast.error(errorText(plan, t)); return }
    const what = describeRemoval(sorted, plan, ctx)
    return confirmAndApply(plan, {
      title,
      lines: [tr(t, 'corrections.confirm.removes', 'Removes:'), ...what]
    })
  }

  /** Open the form that corrects an entry (the Edit of any row). */
  const editEvent = (ev) => {
    const kind = entryActions(ev, sorted).edit
    if (!kind) return
    if (kind === 'setTimes') {
      const setRow = (sets || []).find(s => s.index === (ev.setIndex ?? 1))
      if (setRow) setForm({ kind: 'setTimes', setRow })
      return
    }
    if (kind === 'coinToss' || kind === 'set5CoinToss') { setForm({ kind: 'coinToss', deciding: kind === 'set5CoinToss' }); return }
    setForm({ kind, editEvent: ev })
  }

  /** "Change who serves first" (live): the coin toss corrected, every rotation of the set recalculated. */
  const changeFirstServe = async () => {
    const before = firstServerOf(match, liveSetIndex)
    const after = before === 'home' ? 'away' : 'home'
    const aKey = match?.coinTossTeamA === 'away' ? 'away' : 'home'
    const plan = liveSetIndex === 5 && match?.set5FirstServe
      ? planSet5CoinToss(sorted, { firstServe: after === aKey ? 'A' : 'B' }, ctx)
      : planCoinToss(sorted, { firstServe: after }, ctx)
    if (plan.error) { toast.error(errorText(plan, t)); return }
    const ok = await confirmDialog({
      title: tr(t, 'corrections.action.changeServe', 'Change who serves first'),
      message: (
        <div className="space-y-1.5 text-sm">
          <p>{tr(t, 'corrections.confirm.changeServe', 'First serve in set {{set}}: {{before}} → {{after}}.', { set: displaySetNumber(liveSetIndex, match), before: teamNameWithLetter(before, ctx), after: teamNameWithLetter(after, ctx) })}</p>
          {(plan.notes || []).map((n, i) => <p key={i} className="text-amber-800">{tr(t, n.key, n.text, n.params)}</p>)}
          <NewIssues issues={plan.newIssues} t={t} />
        </div>
      ),
      confirmLabel: tr(t, 'corrections.action.confirm', 'Confirm'),
      cancelLabel: tr(t, 'corrections.action.cancel', 'Cancel')
    })
    if (ok) await apply(plan)
  }

  const removeRemark = async ({ line, index }) => {
    const lines = String(match?.remarks || '').split('\n')
    lines.splice(index, 1)
    const p = emptyPlan()
    p.remarksSet = lines.join('\n')
    p.log = { action: 'removeRemark', setIndex: null, team: null, before: line, after: null, text: tr(t, 'corrections.log.remarkRemoved', 'Remark removed: "{{text}}"', { text: line }) + (mode === 'review' ? tr(t, 'corrections.log.afterMatchSuffix', ' (entered after the match)') : '') }
    const ok = await confirmDialog({
      title: tr(t, 'corrections.confirm.removeRemarkTitle', 'Remove this remark?'),
      message: line,
      confirmLabel: tr(t, 'corrections.action.remove', 'Remove'),
      cancelLabel: tr(t, 'corrections.action.cancel', 'Cancel'),
      tone: 'danger'
    })
    if (ok) await apply(p)
  }

  const rotate = async (team, direction) => {
    const plan = planRotateTeam(sorted, { setIndex: liveSetIndex, team, direction }, ctx)
    if (plan.error) { toast.error(errorText(plan, t)); return }
    const ok = await confirmDialog({
      title: direction > 0
        ? tr(t, 'corrections.action.rotateForward', 'Rotate one position forward')
        : tr(t, 'corrections.action.rotateBack', 'Rotate one position back'),
      message: (
        <div className="flex flex-wrap gap-4">
          <CourtMini lineup={plan.before} caption={tr(t, 'corrections.preview.lineupBefore', 'Before')} />
          <CourtMini lineup={plan.after} caption={tr(t, 'corrections.preview.lineupAfter', 'After')} highlight={['I']} />
        </div>
      ),
      confirmLabel: tr(t, 'corrections.action.confirm', 'Confirm'),
      cancelLabel: tr(t, 'corrections.action.cancel', 'Cancel')
    })
    if (ok) await apply(plan)
  }

  // ── the form view (inline: never a modal over the modal) ──
  if (form) {
    const common = { ctx, events: sorted, sets, players, mode, liveSetIndex, busy, onCancel: () => setForm(null), onConfirm: apply }
    if (form.kind === 'timeout') {
      return <TimeoutForm {...common} preset={{ setIndex: presetSet }} editEvent={form.editEvent}
        onDelegate={live && hooks.openTimeout ? (_, { team }) => { setForm(null); hooks.openTimeout(team) } : undefined} />
    }
    if (form.kind === 'substitution') return <SubstitutionForm {...common} preset={{ setIndex: presetSet }} editEvent={form.editEvent} />
    if (form.kind === 'sanction') return <SanctionForm {...common} preset={{ setIndex: presetSet }} editEvent={form.editEvent} />
    if (form.kind === 'remark') return <RemarkForm {...common} match={match} editLine={form.line ?? null} editIndex={form.index ?? null} />
    if (form.kind === 'setTimes') return <SetTimesForm {...common} match={match} setRow={form.setRow} />
    if (form.kind === 'finalScore') return <FinalScoreForm {...common} setRow={form.setRow} />
    if (form.kind === 'lineup') return <LineupForm {...common} preset={form.preset || {}} editEvent={form.editEvent || null} />
    if (form.kind === 'point') return <PointForm {...common} editEvent={form.editEvent} />
    if (form.kind === 'entry') return <EntryForm {...common} editEvent={form.editEvent} />
    if (form.kind === 'coinToss') return <CoinTossForm {...common} deciding={!!form.deciding} />
    if (form.kind === 'gameCaptain') return <GameCaptainForm {...common} preset={form.preset || {}} />
    if (form.kind === 'renumber') return <RenumberForm {...common} preset={form.preset || {}} />
  }

  const filterOptions = [
    { value: 'all', label: tr(t, 'corrections.allSets', 'All sets') },
    ...played.map(s => ({ value: String(s.index), label: tr(t, 'corrections.term.set', 'Set {{n}}', { n: displaySetNumber(s.index, match) }) }))
  ]
  const liveSet = live ? (sets || []).find(s => s.index === liveSetIndex) : null
  const liveScore = liveSet ? scoreFromPointEvents(sorted, liveSetIndex) : null
  const lastPoint = live ? sorted.filter(e => e.type === 'point' && (e.setIndex ?? 1) === liveSetIndex).pop() : null
  const server = live ? (lastPoint?.payload?.team || getFirstServeForSet(liveSetIndex, match || {})) : null
  const finishedRows = played.filter(s => s.finished || sorted.some(e => e.type === 'set_end' && (e.setIndex ?? 1) === s.index))
  const editable = !readOnly
  const addPreset = (kind) => () => setForm({ kind })

  return (
    <div className="ov-kit space-y-4">
      {/* Header: set filter + help */}
      <div className="space-y-2">
        <div className="overflow-x-auto -mx-1 px-1">
          <SegmentedControl
            ariaLabel={tr(t, 'corrections.setFilter', 'Show set')}
            options={filterOptions}
            value={filter}
            onChange={setFilter}
            className="min-w-max"
          />
        </div>
        <p className="text-xs text-stone-500">{tr(t, 'corrections.help', 'Each correction is saved when you confirm it and is listed in the correction log for the referee.')}</p>
        {!hasTeamDesignation(match) && <Chip tone="amber">{tr(t, 'corrections.chip.teamsNotSet', 'Team A/B not set: home is shown as A')}</Chip>}
      </div>

      {readOnly && (
        <Banner tone="info" action={onReopenForCorrections ? { label: tr(t, 'corrections.action.reopenForCorrections', 'Back to the match end'), onClick: onReopenForCorrections } : undefined}>
          {tr(t, 'corrections.banner.readOnly', 'The match is approved: corrections are read-only.')}
        </Banner>
      )}
      {signaturesCleared && (
        <Banner tone="warning">{tr(t, 'corrections.banner.signaturesCleared', 'Signatures were cleared because the sheet changed. Collect them again at the match end.')}</Banner>
      )}

      {/* 0. What the record says that no longer fits */}
      {issues.length > 0 && (
        <SectionCard
          title={<span className="inline-flex items-center gap-2"><AlertTriangle size={16} className="text-amber-600" aria-hidden="true" />{tr(t, 'corrections.section.issues', 'Check these entries')}</span>}
          count={issues.length}
          hint={tr(t, 'corrections.hint.issues', 'After a correction these entries no longer fit what comes before them. Nothing was refused: correct them, or leave them if the referee decided so.')}
        >
          <ul className="divide-y divide-stone-100" data-testid="corrections-issues">
            {issues.map(i => {
              const ev = i.eventId != null ? sorted.find(e => e.id === i.eventId) : null
              const kind = ev ? entryActions(ev, sorted).edit : null
              return (
                <li key={i.sig} className="flex items-start gap-3 py-2.5">
                  <span className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
                  <p className="min-w-0 flex-1 text-sm text-stone-800">{issueText(i, t)}</p>
                  {editable && kind && (
                    <Button variant="secondary" size="md" icon={Pencil} className={HIT} onClick={() => editEvent(ev)} aria-label={tr(t, 'corrections.action.editWhat', 'Edit {{what}}', { what: describeEvent(ev, sorted, ctx)?.title || '' })}>
                      <span className="hidden sm:inline">{tr(t, 'corrections.action.edit', 'Edit')}</span>
                    </Button>
                  )}
                  {editable && ev && entryActions(ev, sorted).remove === 'plan' && (
                    <Button variant="danger-soft" size="md" icon={X} className={cn(HIT, 'w-9 px-0')} onClick={() => removeEvent(ev)} aria-label={tr(t, 'corrections.action.removeEntry', 'Remove {{what}}', { what: describeEvent(ev, sorted, ctx)?.title || '' })} />
                  )}
                </li>
              )
            })}
          </ul>
        </SectionCard>
      )}

      {/* 1. Score and serve */}
      <SectionCard title={live ? tr(t, 'corrections.section.scoreServe', 'Score and serve') : tr(t, 'corrections.section.sets', 'Set results')}>
        {live && liveSet && (
          <div className="mb-3 space-y-3">
            <p className="text-sm text-stone-800">
              <span className="font-semibold">{tr(t, 'corrections.term.set', 'Set {{n}}', { n: displaySetNumber(liveSetIndex, match) })}</span>
              {' · '}<span className="tabular-nums">{formatScore({ home: liveScore.homePoints, away: liveScore.awayPoints }, null, ctx)}</span>
              {server && <> {' · '}{tr(t, 'corrections.serving', '{{team}} serving', { team: teamNameWithLetter(server, ctx) })}</>}
            </p>
            {editable && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <Button variant="secondary" size="lg" icon={Undo2} className={LIVE_BTN} disabled={!hooks.canUndo} onClick={() => hooks.undo?.()}>
                  {tr(t, 'corrections.action.undoLast', 'Undo last action')}
                </Button>
                <Button variant="secondary" size="lg" icon={Repeat} className={LIVE_BTN} disabled={!lastPoint || !hooks.wrongTeam} onClick={() => hooks.wrongTeam?.()}>
                  {tr(t, 'corrections.action.wrongTeam', 'Last point went to the wrong team')}
                </Button>
                {['home', 'away'].map(team => (
                  <Button key={team} variant="secondary" size="lg" icon={Plus} className={LIVE_BTN} disabled={!hooks.addPoint}
                    onClick={async () => {
                      const name = teamNameWithLetter(team, ctx)
                      const ok = await confirmDialog({
                        title: tr(t, 'corrections.action.addMissedPoint', 'Add a missed point'),
                        message: tr(t, 'corrections.confirm.addPoint', 'Give a point to {{team}} now, with its rotation and serve, as the point button does.', { team: name }),
                        confirmLabel: tr(t, 'corrections.action.confirm', 'Confirm'),
                        cancelLabel: tr(t, 'corrections.action.cancel', 'Cancel')
                      })
                      if (!ok) return
                      await runConfirm(async () => {
                        await hooks.addPoint(team)
                        await logOnly(tr(t, 'corrections.log.missedPoint', 'Added: missed point for {{team}}', { team: name }), 'addMissedPoint')
                      })
                    }}>
                    {tr(t, 'corrections.action.addMissedPointFor', 'Add a missed point: {{team}}', { team: teamLabel(team, ctx).name })}
                  </Button>
                ))}
                <Button variant="secondary" size="lg" icon={RotateCw} className={LIVE_BTN} onClick={changeFirstServe}>
                  {tr(t, 'corrections.action.changeServe', 'Change who serves first')}
                </Button>
                <Button variant="secondary" size="lg" icon={ArrowLeftRight} className={LIVE_BTN}
                  onClick={async () => {
                    const aLeft = teamASide(match, liveSetIndex) === 'left'
                    const ok = await confirmDialog({
                      title: tr(t, 'corrections.action.switchSides', 'Switch sides'),
                      message: tr(t, 'corrections.confirm.switchSides', 'Team {{left}} moves to the right, team {{right}} to the left.', { left: aLeft ? 'A' : 'B', right: aLeft ? 'B' : 'A' }),
                      confirmLabel: tr(t, 'corrections.action.confirm', 'Confirm'),
                      cancelLabel: tr(t, 'corrections.action.cancel', 'Cancel')
                    })
                    if (!ok) return
                    await runConfirm(async () => {
                      const r = await switchSides({ db, matchId, match, setIndex: liveSetIndex })
                      await logOnly(tr(t, 'corrections.log.sides', 'Sides switched in set {{set}}', { set: displaySetNumber(liveSetIndex, match) }), 'switchSides', r)
                    })
                  }}>
                  {tr(t, 'corrections.action.switchSides', 'Switch sides')}
                </Button>
              </div>
            )}
          </div>
        )}
        {finishedRows.length === 0 ? (
          !live && <EmptyLine>{tr(t, 'corrections.empty.sets', 'No finished set yet.')}</EmptyLine>
        ) : (
          <ul className="divide-y divide-stone-100">
            {finishedRows.filter(s => filter === 'all' || s.index === Number(filter) || live).map(s => {
              const sc = scoreFromPointEvents(sorted, s.index)
              const times = setTimesText(s.startTime, s.endTime, t)
              return (
                <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
                  <div className="min-w-0 flex-1 basis-full sm:basis-auto text-sm">
                    <span className="font-semibold text-stone-900">{tr(t, 'corrections.term.set', 'Set {{n}}', { n: displaySetNumber(s.index, match) })}</span>
                    <span className="text-stone-800 tabular-nums"> · {formatScore({ home: sc.homePoints, away: sc.awayPoints }, null, ctx)}</span>
                    {times && <span className="text-stone-500 tabular-nums"> · {times}</span>}
                  </div>
                  {editable && (
                    <div className="flex flex-wrap gap-2">
                      <Button variant="secondary" size="md" className={HIT} onClick={() => setForm({ kind: 'finalScore', setRow: s })}>{tr(t, 'corrections.action.correctFinalScore', 'Correct final score')}</Button>
                      <Button variant="secondary" size="md" className={HIT} onClick={() => setForm({ kind: 'setTimes', setRow: s })}>{tr(t, 'corrections.action.setTimes', 'Set times')}</Button>
                      {live && hooks.reopenSet && s.index !== liveSetIndex && (
                        <Button variant="danger-outline" size="md" icon={ListRestart} className={HIT} onClick={() => hooks.reopenSet(s)}>{tr(t, 'corrections.action.reopenSet', 'Reopen set')}</Button>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </SectionCard>

      {/* 2. Coin toss and line-ups: correctable at any time, everything after them is recalculated */}
      <SectionCard title={tr(t, 'corrections.section.coinToss', 'Coin toss')}
        action={editable && (
          <Button variant="secondary" size="md" icon={Pencil} className={HIT} onClick={() => setForm({ kind: 'coinToss' })}>
            {tr(t, 'corrections.action.edit', 'Edit')}
          </Button>
        )}>
        <p className="text-sm text-stone-800">
          {tr(t, 'corrections.coinToss.summary', 'Team A: {{teamA}} · Serves first in set 1: {{serve}}', {
            teamA: teamLabel(match?.coinTossTeamA === 'away' ? 'away' : 'home', ctx)?.name,
            serve: teamNameWithLetter(match?.firstServe || 'home', ctx)
          })}
        </p>
        {played.some(s => s.index === 5) && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 text-sm text-stone-800">
              {tr(t, 'corrections.coinToss.set5', 'Deciding set: {{serve}} serves first', { serve: teamNameWithLetter(getFirstServeForSet(5, match || {}), ctx) })}
            </p>
            {editable && (
              <Button variant="secondary" size="md" className={HIT} onClick={() => setForm({ kind: 'coinToss', deciding: true })}>
                {tr(t, 'corrections.action.editSet5Toss', 'Edit deciding set')}
              </Button>
            )}
          </div>
        )}
      </SectionCard>

      <SectionCard title={tr(t, 'corrections.section.lineup', 'Line-up')} hint={tr(t, 'corrections.hint.lineupAny', 'Correct a starting line-up at any time, also after rallies were played: the rotations, the serve and the libero replacements after it are recalculated.')}>
        <div className="space-y-3">
          {played.filter(s => filter === 'all' || s.index === Number(filter)).map(s => (
            <div key={s.id ?? s.index} className="space-y-2">
              {(filter === 'all' || played.length > 1) && <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">{tr(t, 'corrections.term.set', 'Set {{n}}', { n: displaySetNumber(s.index, match) })}</p>}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {['home', 'away'].map(team => {
                  const lbl = teamLabel(team, ctx)
                  const summary = lineupSummary(sorted, s.index, team)
                  const isLive = live && liveSet && s.index === liveSetIndex
                  const setStarted = sorted.some(e => e.type === 'point' && (e.setIndex ?? 1) === s.index)
                  return (
                    <div key={team} className="rounded-xl border border-stone-200 p-3 space-y-2">
                      <div className="flex items-center gap-2 text-sm font-medium text-stone-800"><TeamDot color={lbl.color} />{lbl.name} ({lbl.letter})</div>
                      <p className="text-sm tabular-nums text-stone-700">{summary || tr(t, 'corrections.empty.lineup', 'No line-up recorded.')}</p>
                      {editable && (
                        <div className="flex flex-wrap gap-2">
                          <Button variant="secondary" size="md" icon={Pencil} className={HIT}
                            onClick={() => {
                              // before the first rally of the set being played: the scoreboard's line-up form
                              if (isLive && !setStarted && hooks.openManualLineup) { hooks.openManualLineup(team); return }
                              const ev = startingLineupEvent(sorted, s.index, team)
                              setForm({ kind: 'lineup', preset: { setIndex: s.index, team }, editEvent: ev || null })
                            }}>
                            {tr(t, 'corrections.action.fixLineup', 'Fix the line-up')}
                          </Button>
                          {isLive && (
                            <>
                              <Button variant="secondary" size="md" icon={RotateCw} className={HIT} onClick={() => rotate(team, 1)}>{tr(t, 'corrections.action.rotateForwardShort', 'Forward')}</Button>
                              <Button variant="secondary" size="md" icon={RotateCcw} className={HIT} onClick={() => rotate(team, -1)}>{tr(t, 'corrections.action.rotateBackShort', 'Back')}</Button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
          {played.length === 0 && <EmptyLine>{tr(t, 'corrections.empty.lineup', 'No line-up recorded.')}</EmptyLine>}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-stone-100 pt-3">
            {['home', 'away'].map(team => {
              const n = match?.[team === 'home' ? 'homeCourtCaptain' : 'awayCourtCaptain']
              return (
                <span key={team} className="text-sm text-stone-700">
                  {tr(t, 'corrections.lineup.gameCaptain', 'Game captain {{team}}: {{n}}', { team: teamLabel(team, ctx)?.letter, n: n != null && n !== '' ? `#${n}` : '–' })}
                </span>
              )
            })}
            {editable && (
              <Button variant="secondary" size="md" className={HIT} onClick={() => setForm({ kind: 'gameCaptain' })}>
                {tr(t, 'corrections.action.gameCaptain', 'Change game captain')}
              </Button>
            )}
          </div>
        </div>
      </SectionCard>

      {/* 3. Time-outs */}
      <SectionCard title={tr(t, 'corrections.section.timeouts', 'Time-outs')} count={timeouts.length}
        action={editable && <AddButton onClick={addPreset('timeout')}>{tr(t, 'corrections.add.timeout', 'Add time-out')}</AddButton>}>
        {timeouts.length === 0 ? <EmptyLine>{tr(t, 'corrections.empty.timeouts', 'No time-outs recorded.')}</EmptyLine> : (
          <ul className="divide-y divide-stone-100">
            {timeouts.map(({ e, d }) => <EventRow key={e.id} d={d} t={t} readOnly={!editable} onEdit={() => setForm({ kind: 'timeout', editEvent: e })} onRemove={() => removeEvent(e)} />)}
          </ul>
        )}
      </SectionCard>

      {/* 4. Substitutions */}
      <SectionCard title={tr(t, 'corrections.section.substitutions', 'Substitutions')} count={subs.length}
        action={editable && <AddButton onClick={addPreset('substitution')}>{tr(t, 'corrections.add.substitution', 'Add substitution')}</AddButton>}>
        {subs.length === 0 ? <EmptyLine>{tr(t, 'corrections.empty.substitutions', 'No substitutions recorded.')}</EmptyLine> : (
          <ul className="divide-y divide-stone-100">
            {subs.map(({ e, d }) => <EventRow key={e.id} d={d} t={t} readOnly={!editable} onEdit={() => setForm({ kind: 'substitution', editEvent: e })} onRemove={() => removeEvent(e)} />)}
          </ul>
        )}
      </SectionCard>

      {/* 5. Sanctions */}
      <SectionCard title={tr(t, 'corrections.section.sanctions', 'Sanctions')} count={sanctions.length}
        action={editable && <AddButton onClick={addPreset('sanction')}>{tr(t, 'corrections.add.sanction', 'Add sanction')}</AddButton>}>
        {sanctions.length === 0 ? <EmptyLine>{tr(t, 'corrections.empty.sanctions', 'No sanctions recorded.')}</EmptyLine> : (
          <ul className="divide-y divide-stone-100">
            {sanctions.map(({ e, d }) => <EventRow key={e.id} d={d} t={t} readOnly={!editable} onEdit={() => setForm({ kind: 'sanction', editEvent: e })} onRemove={() => removeEvent(e)} />)}
          </ul>
        )}
      </SectionCard>

      {/* 6. Remarks */}
      <SectionCard title={tr(t, 'corrections.term.remarks', 'Remarks')} count={remarkLines.length}
        action={editable && <AddButton onClick={() => setForm({ kind: 'remark' })}>{tr(t, 'corrections.add.remark', 'Add remark')}</AddButton>}>
        {remarkLines.length === 0 ? <EmptyLine>{tr(t, 'corrections.empty.remarks', 'No remarks.')}</EmptyLine> : (
          <ul className="divide-y divide-stone-100">
            {remarkLines.map(r => (
              <li key={r.index} className="flex items-start gap-3 py-2.5">
                <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm text-stone-800">{r.line}</p>
                {editable && (
                  <>
                    <Button variant="secondary" size="md" icon={Pencil} className={HIT} onClick={() => setForm({ kind: 'remark', line: r.line, index: r.index })} aria-label={tr(t, 'corrections.action.editRemark', 'Edit remark')}>
                      <span className="hidden sm:inline">{tr(t, 'corrections.action.edit', 'Edit')}</span>
                    </Button>
                    <Button variant="danger-soft" size="md" icon={X} className={cn(HIT, 'w-9 px-0')} onClick={() => removeRemark(r)} aria-label={tr(t, 'corrections.action.removeRemark', 'Remove remark')} />
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {/* 7. Libero */}
      <SectionCard title={tr(t, 'corrections.section.libero', 'Libero')} count={liberoRows.length}
        hint={tr(t, 'corrections.hint.liberoEdit', 'Edit or remove a libero replacement: the line-ups after it are recalculated.')}>
        {liberoRows.length === 0 ? <EmptyLine>{tr(t, 'corrections.empty.libero', 'No libero replacements recorded.')}</EmptyLine> : (
          <ul className="divide-y divide-stone-100">
            {liberoRows.map(({ e, d }) => (
              <EventRow key={e.id} d={d} t={t} readOnly={!editable}
                onEdit={entryActions(e, sorted).edit ? () => editEvent(e) : undefined}
                onRemove={() => removeEvent(e)} />
            ))}
          </ul>
        )}
      </SectionCard>

      {/* 7b. Player numbers */}
      <SectionCard title={tr(t, 'corrections.section.numbers', 'Player numbers')}
        hint={tr(t, 'corrections.hint.numbers', 'A number changed here is changed for the whole match: every entry before and after shows the new number, on the scoresheet and on the tablets.')}
        action={editable && (
          <Button variant="secondary" size="md" icon={Hash} className={HIT} onClick={() => setForm({ kind: 'renumber' })}>
            {tr(t, 'corrections.action.renumber', 'Change a number')}
          </Button>
        )}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {['home', 'away'].map(team => (
            <div key={team} className="min-w-0">
              <p className="flex items-center gap-2 text-sm font-medium text-stone-800"><TeamDot color={teamLabel(team, ctx)?.color} />{teamLabel(team, ctx)?.name}</p>
              <p className="mt-0.5 text-sm text-stone-600 tabular-nums">
                {[...(players[team] || [])].map(p => p.number).sort((a, b) => Number(a) - Number(b)).map(n => `#${n}`).join(' ') || '–'}
              </p>
            </div>
          ))}
        </div>
      </SectionCard>

      {/* 8. Correction log */}
      <CorrectionLog changes={match?.manualChanges} ctx={ctx} />

      {/* 9. Advanced: event log */}
      <EventLogAdvanced events={sorted} filterSet={filter} ctx={ctx} readOnly={!editable} onRemove={removeEvent} onEdit={editEvent}
        canReopen={(ev) => live && !!hooks.reopenSet && (ev.setIndex ?? 1) !== liveSetIndex} />
    </div>
  )
}
