// The correction board (owner 2026-11-20: "the scoreboard with correction
// capabilities (points +-, changing the line-up directly, TOs ...), more or
// less like DataProject"): the match drawn as the scoreboard draws it, every
// element correctable, nothing written until Save.
//
// Every tap is planned by the planners of domain/manualCorrections on the
// draft the changes before it made (domain/correctionDraft), so the board
// redraws at once and the changes chain. Save writes the combined plan in one
// transaction (services/corrections/applyCorrectionPlan, one log entry per
// change); Cancel throws the changes away; Undo takes back the last one.
// The forms are the corrections panel's own (forms.jsx, moreForms.jsx): here
// their Confirm stages the change instead of writing it.
//
// The list of cards (CorrectionsPanel) stays one tap away ("List"): phones
// get it by default, and it holds what the board leaves out (Reopen set, the
// event log, the correction log).
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Plus, Minus, X, Undo2, RotateCw, RotateCcw, ArrowLeftRight, Repeat, ListChecks, LayoutList,
  AlertTriangle, Users, RectangleVertical, NotebookPen, Clock, Coins, Crown, Hash, Pencil, Trash2, ListRestart
} from 'lucide-react'
import { db } from '../../db/db'
import { cn } from '../../ui/cn.js'
import { Button } from '../../ui/Button.jsx'
import { Banner } from '../../ui/Banner.jsx'
import { Chip } from '../../ui/Chip.jsx'
import { SegmentedControl } from '../../ui/SegmentedControl.jsx'
import { confirmDialog, toast } from '../../ui/uiStore.js'
import { DialogHelpButton } from '../help/HelpButton.jsx'
import {
  describeEvent, compareBySeq, tr, teamLabel, displaySetNumber, teamAKeyOf, otherTeam, scoreBeforeEvent, plainScore
} from '../../domain/describe'
import {
  planAddPoint, planRemovePoint, planLastPointOtherTeam, planRotateTeam, planCoinToss, planSet5CoinToss,
  planRemoveTimeout, planRemoveSubstitution, planRemoveSanction, planRemoveEntry, scoreTimeline, courtAt,
  emptyPlan, errorText, entryActions
} from '../../domain/manualCorrections'
import { baseDraft, buildDraft, applyStep, combinedPlan, newIssues, stepLines, planScoreTo } from '../../domain/correctionDraft'
import { issueText } from '../../domain/recompute'
import { awardsPoint } from '../../domain/sanctions'
import { scoreFromPointEvents, getFirstServeForSet } from '../../domain/rules'
import { countSetsWon } from '../../domain/matchEnd'
import { applyCorrectionPlan, planChangesSheet, signedAfterMatch } from '../../services/corrections/applyCorrectionPlan'
import { useConfirmAction } from '../../hooks/useConfirmAction'
import { planSwitchSides, teamASide, firstServerOf } from './liveActions'
import { TeamDot, HIT } from './shared.jsx'
import { TimeoutForm, SubstitutionForm, SanctionForm, RemarkForm, SetTimesForm, playedSets } from './forms.jsx'
import { LineupForm, EntryForm, CoinTossForm, GameCaptainForm, RenumberForm } from './moreForms.jsx'

/** Where the scorer's choice of view (board or list) is kept (this device). */
export const CORRECTION_VIEW_KEY = 'ov.corrections.view'

/** 'board' (the default) or 'list'. */
export function readCorrectionView() {
  try { return localStorage.getItem(CORRECTION_VIEW_KEY) === 'list' ? 'list' : 'board' } catch { return 'board' }
}

export function saveCorrectionView(view) {
  try { localStorage.setItem(CORRECTION_VIEW_KEY, view === 'list' ? 'list' : 'board') } catch { /* private mode: not remembered */ }
}

/** The board needs a tablet in landscape or a desktop window; a phone gets the list. */
export function boardFits(win = typeof window !== 'undefined' ? window : null) {
  return !!win && win.innerWidth >= 900 && win.innerHeight >= 560
}

const COURT_ROWS = [['IV', 'III', 'II'], ['V', 'VI', 'I']]
const LIBERO_TYPES = ['libero_entry', 'libero_exit', 'libero_exchange', 'libero_unable', 'libero_recovered', 'libero_redesignation']
const setOf = (e) => e?.setIndex ?? 1

/** Changes under the board's feet: a new, removed or renumbered entry. */
function eventsFingerprint(events) {
  let maxSeq = 0
  let sum = 0
  for (const e of events || []) {
    const s = Number(e?.seq) || 0
    if (s > maxSeq) maxSeq = s
    sum += s
  }
  return `${(events || []).length}:${maxSeq}:${Math.round(sum * 1000)}`
}

/** A dialog over the board for the forms and the lists (the forms bring their own card). */
function BoardDialog({ children, onClose, width = 680, label }) {
  const ref = useRef(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    // focus inside (keyboard and screen readers start here); Escape closes,
    // unless a kit dialog (UiHost) is open above it
    const prev = document.activeElement
    // (a field inside that focused itself keeps it: the children's effects run first)
    if (ref.current && !ref.current.contains(document.activeElement)) ref.current.focus({ preventScroll: true })
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      if (document.querySelector('.ov-kit-host [role="dialog"], .ov-kit-host [role="alertdialog"]')) return
      onCloseRef.current?.()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (prev && document.contains(prev) && typeof prev.focus === 'function') prev.focus({ preventScroll: true })
    }
  }, [])
  return (
    <div ref={ref} tabIndex={-1} className="fixed inset-0 flex items-start justify-center overflow-y-auto bg-stone-900/50 p-4 outline-none backdrop-blur-sm sm:items-center"
      style={{ zIndex: 1100 }} role="dialog" aria-modal="true" aria-label={label}>
      <div className="w-full" style={{ maxWidth: width }}>{children}</div>
    </div>
  )
}

/** A white card with a heading and a close button (the board's own lists). */
function SheetCard({ title, onClose, children, footer, t }) {
  return (
    <div className="ov-kit rounded-2xl bg-white p-4 shadow-2xl sm:p-5">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="min-w-0 flex-1 text-base font-bold text-stone-900">{title}</h2>
        <Button variant="ghost" size="md" icon={X} className={cn(HIT, 'w-9 px-0')} onClick={onClose} aria-label={tr(t, 'corrections.action.close', 'Close')} />
      </div>
      {children}
      {footer && <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-stone-100 pt-3">{footer}</div>}
    </div>
  )
}

/** One position of a court: the number, the position, the libero and captain marks. */
function CourtTile({ pos, number, libero, captain, serving, changed, disabled, onClick, t }) {
  const shown = libero ? libero.liberoNumber : number
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || shown == null || shown === ''}
      data-testid={`board-tile-${pos}`}
      className={cn(
        'relative flex h-16 min-w-0 flex-col items-center justify-center rounded-xl text-2xl font-bold tabular-nums transition-colors',
        'ring-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-900',
        libero ? 'bg-amber-50 text-amber-900 ring-amber-300' : 'bg-white text-stone-900 ring-stone-200',
        changed && 'ring-2 ring-sky-500',
        !disabled && 'hover:bg-stone-50 active:bg-stone-100'
      )}
      aria-label={tr(t, 'correctionBoard.tile', 'Position {{pos}}: #{{n}}', { pos, n: shown ?? '–' })}
    >
      <span>{shown ?? '–'}</span>
      <span className="absolute bottom-1 right-1.5 text-[10px] font-medium text-stone-400">{pos}</span>
      {libero && <span className="absolute left-1.5 top-1 rounded bg-amber-500 px-1 text-[10px] font-bold leading-4 text-white">L</span>}
      {libero && <span className="absolute bottom-1 left-1.5 text-[10px] font-medium text-amber-700">#{number}</span>}
      {captain && !libero && <span className="absolute left-1.5 top-1 rounded-full border border-stone-400 px-1 text-[10px] font-bold leading-4 text-stone-600">C</span>}
      {serving && <span className="absolute right-1.5 top-1 h-3 w-3 rounded-full bg-yellow-400 ring-1 ring-yellow-600" title={tr(t, 'correctionBoard.serving', 'Serving')} />}
    </button>
  )
}

// The paper sheet's set box, drawn from the draft (loaded when first shown;
// the chunk is precached like every other script)
const SetPreview = lazy(() => import('../../../scoresheet_pdf/SetPreview'))

/**
 * Save's review: the changes as sentences, their notes and "Check these
 * entries", and the set box as the scoresheet will print it after them (the
 * sets the changes touch; the board's set when none names one).
 */
function SaveReview({ t, lines, steps, issues, draft, homeTeam, awayTeam, currentSet, busy, onBack, onSave }) {
  const notes = steps.flatMap(s => s.plan.notes || [])
  const played = new Set((draft.events || []).map(e => e?.setIndex ?? 1))
  const touched = [...new Set(steps.flatMap(s => [s.plan.log?.setIndex, ...(s.plan.affectedSets || [])]).filter(n => Number.isInteger(n) && played.has(n)))].sort((a, b) => a - b)
  const sets = touched.length ? touched : (played.has(currentSet) ? [currentSet] : [])
  const [shown, setShown] = useState(() => (sets.includes(currentSet) ? currentSet : sets[0] ?? null))
  const matchData = useMemo(() => ({
    match: draft.match, homeTeam, awayTeam, homePlayers: draft.players.home, awayPlayers: draft.players.away, sets: draft.sets, events: draft.events
  }), [draft, homeTeam, awayTeam])
  return (
    <SheetCard t={t} onClose={onBack}
      title={tr(t, 'correctionBoard.saveTitle', 'Save {{count}} changes?', { count: lines.length })}
      footer={(
        <>
          <Button variant="secondary" size="lg" onClick={onBack} disabled={busy}>{tr(t, 'correctionBoard.backToBoard', 'Back to the board')}</Button>
          <Button variant="positive" size="lg" loading={busy} onClick={onSave} data-testid="board-save-confirm">{tr(t, 'correctionBoard.save', 'Save')}</Button>
        </>
      )}>
      <div className="space-y-3 text-sm" data-testid="board-save-review">
        <ol className="list-decimal space-y-1 pl-5 text-stone-800">{lines.map(l => <li key={l.index}>{l.text}</li>)}</ol>
        {notes.map((n, i) => <p key={`n${i}`} className="text-amber-800">{tr(t, n.key, n.text, n.params)}</p>)}
        {issues.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-2">
            <p className="font-medium text-amber-900">{tr(t, 'corrections.section.issues', 'Check these entries')}</p>
            <ul className="mt-1 list-disc pl-5 text-amber-900">{issues.slice(0, 6).map(i => <li key={i.sig}>{issueText(i, t)}</li>)}</ul>
          </div>
        )}
        {shown != null && (
          <section className="space-y-2" data-testid="board-save-preview">
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="text-sm font-semibold text-stone-900">{tr(t, 'correctionBoard.previewTitle', 'On the scoresheet after your changes')}</h3>
              {sets.length > 1 && (
                <SegmentedControl ariaLabel={tr(t, 'corrections.setFilter', 'Show set')} value={String(shown)} onChange={(v) => setShown(Number(v))}
                  options={sets.map(n => ({ value: String(n), label: tr(t, 'corrections.term.set', 'Set {{n}}', { n: displaySetNumber(n, draft.match) }) }))} />
              )}
            </div>
            <div className="overflow-hidden rounded-xl border border-stone-200 bg-stone-50 p-2">
              <Suspense fallback={<p className="p-4 text-sm text-stone-500">{tr(t, 'correctionBoard.previewLoading', 'Drawing the set…')}</p>}>
                <SetPreview matchData={matchData} setIndex={shown} />
              </Suspense>
            </div>
          </section>
        )}
        <p className="text-xs text-stone-500">{tr(t, 'correctionBoard.saveHint', 'Each change is listed in the correction log for the referee.')}</p>
      </div>
    </SheetCard>
  )
}

/**
 * Type a team's score of the set (the board's score box): the difference
 * goes in as that team's points at the end of the set, one after the other.
 */
function TypeScoreCard({ t, team, set, current, onClose, onApply }) {
  const [value, setValue] = useState(String(current))
  const inputRef = useRef(null)
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select() }, [])
  const n = /^\d{1,3}$/.test(value.trim()) ? Number(value.trim()) : null
  const submit = (e) => { e?.preventDefault?.(); if (n != null && n !== current) onApply(n) }
  return (
    <form onSubmit={submit}>
      <SheetCard t={t} onClose={onClose}
        title={tr(t, 'correctionBoard.typeScoreTitle', 'Score of {{team}} · set {{set}}', { team: team?.name, set })}
        footer={(
          <>
            <Button variant="secondary" size="lg" onClick={onClose}>{tr(t, 'corrections.action.cancel', 'Cancel')}</Button>
            <Button variant="positive" size="lg" type="submit" disabled={n == null || n === current} data-testid="board-type-score-apply">{tr(t, 'correctionBoard.typeScoreApply', 'Apply')}</Button>
          </>
        )}>
        <label className="block text-sm font-medium text-stone-800" htmlFor="board-type-score-input">{tr(t, 'correctionBoard.typeScoreLabel', 'Points')}</label>
        <input id="board-type-score-input" ref={inputRef} type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="off"
          value={value} onChange={(e) => setValue(e.target.value)} data-testid="board-type-score-input"
          className="mt-1 h-14 w-32 rounded-xl border border-stone-300 bg-white px-3 text-center text-3xl font-bold tabular-nums text-stone-900 focus:border-stone-900 focus:outline-none" />
        {value.trim() !== '' && n == null && <p className="mt-2 text-sm text-red-700">{tr(t, 'correctionBoard.typeScoreInvalid', 'Enter a whole number from 0.')}</p>}
        <p className="mt-3 text-sm text-stone-600">{tr(t, 'correctionBoard.typeScoreHint', 'The difference is added or removed as points of this team at the end of the set, one after the other: the first may rotate the team, the next ones are on its serve. A point that ends the set is given with the point button.')}</p>
      </SheetCard>
    </form>
  )
}

export default function CorrectionBoard({
  mode = 'live',
  matchId,
  events,
  match,
  sets,
  homeTeam,
  awayTeam,
  homePlayers = [],
  awayPlayers = [],
  liveSetIndex = null,
  rallyInPlay = false,
  hooks = {},
  onClose,
  onShowList
}) {
  const { t } = useTranslation()
  const live = mode === 'live'
  const fingerprint = useMemo(() => eventsFingerprint(events), [events])
  const freshBase = () => ({
    draft: baseDraft({ events: [...(events || [])].sort(compareBySeq), match, sets, players: { home: homePlayers, away: awayPlayers } }),
    fp: fingerprint
  })
  // The match as it was when the board opened: the changes are planned on it
  const [base, setBase] = useState(freshBase)
  const [steps, setSteps] = useState([])
  const [form, setForm] = useState(null) // { kind, preset?, editEvent?, ... }
  const [sheet, setSheet] = useState(null) // { kind: 'player'|'timeout'|'list', ... }
  const [busy, setBusy] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  // the board's own Save changes the match too: not "changed under the board" while it writes
  const stale = base.fp !== fingerprint && !busy

  const draft = useMemo(() => buildDraft(base.draft, steps), [base, steps])
  const liberos = useMemo(() => ({
    home: (draft.players.home || []).filter(p => p?.libero).map(p => p.number),
    away: (draft.players.away || []).filter(p => p?.libero).map(p => p.number)
  }), [draft.players])
  const ctx = useMemo(() => ({ t, match: draft.match, homeTeam, awayTeam, matchId, mode, liveSetIndex, liberos, players: draft.players }),
    [t, draft.match, homeTeam, awayTeam, matchId, mode, liveSetIndex, liberos, draft.players])
  const played = useMemo(() => playedSets(draft.sets, draft.events), [draft.sets, draft.events])
  const [setIndex, setSetIndex] = useState(() => liveSetIndex ?? played[played.length - 1]?.index ?? 1)
  const issues = useMemo(() => newIssues(base.draft, draft, ctx), [base, draft, ctx])
  const lines = useMemo(() => stepLines(steps), [steps])
  const editable = !stale && !busy && !(live && rallyInPlay)

  // ── this set, as the scoreboard shows it ──
  const setRow = draft.sets.find(s => s.index === setIndex)
  const finished = !!setRow?.finished || draft.events.some(e => e.type === 'set_end' && setOf(e) === setIndex)
  const isLiveSet = live && setIndex === liveSetIndex && !finished
  const score = scoreFromPointEvents(draft.events, setIndex)
  const baseScore = scoreFromPointEvents(base.draft.events, setIndex)
  const setPoints = draft.events.filter(e => e.type === 'point' && setOf(e) === setIndex).sort(compareBySeq)
  const server = isLiveSet ? (setPoints[setPoints.length - 1]?.payload?.team || getFirstServeForSet(setIndex, draft.match)) : null
  const aKey = teamAKeyOf(draft.match)
  const leftKey = teamASide(draft.match, setIndex) === 'left' ? aKey : otherTeam(aKey)
  const rightKey = otherTeam(leftKey)
  const won = countSetsWon(draft.sets)
  const tl = scoreTimeline(draft.events, setIndex)
  const baseTl = scoreTimeline(base.draft.events, setIndex)
  const courtOf = (team) => (tl.length ? courtAt(draft.events, setIndex, team, tl.length - 1) : { lineup: null, libero: null })
  const baseCourtOf = (team) => (baseTl.length ? courtAt(base.draft.events, setIndex, team, baseTl.length - 1) : { lineup: null, libero: null })
  const rowsOf = (pred) => draft.events
    .filter(e => setOf(e) === setIndex && pred(e))
    .sort(compareBySeq)
    .map(e => ({ e, d: describeEvent(e, draft.events, ctx) }))
    .filter(r => r.d)

  // ── staging ──
  const stage = (plan, { title } = {}) => {
    if (!plan) return false
    if (plan.error) { toast.error(errorText(plan, t)); return false }
    const next = [{ plan }]
    // a sanction that gives the point now: the point is a change of its own,
    // taken back together with the sanction
    if (plan.followUp?.awardPointTo) {
      const after = applyStep(draft, plan)
      const sanctionSet = plan.add?.find(r => r.type === 'sanction')?.setIndex ?? setIndex
      const point = planAddPoint(after.events, after.sets, { setIndex: sanctionSet, team: plan.followUp.awardPointTo, penaltySeq: plan.followUp.penaltySeq ?? null }, { ...ctx, match: after.match })
      if (point.error) {
        toast.error(tr(t, 'correctionBoard.penaltyPointRefused', 'The sanction gives a point the board cannot add ({{why}}). Record the sanction on the scoreboard instead.', { why: errorText(point, t) }))
        return false
      }
      next.push({ plan: point, withPrevious: true })
    }
    setSteps(s => [...s, ...next])
    if (title) toast.success(title)
    return true
  }
  const plan = (planner) => planner(draft, ctx)
  // a typed score: the run of points as one change (Undo takes it all back)
  const applyTypedScore = (team, target) => {
    const res = planScoreTo(draft, { setIndex, team, target }, ctx)
    if (res.plans.length) setSteps(s => [...s, ...res.plans.map((plan, i) => ({ plan, withPrevious: i > 0 }))])
    if (res.error) {
      const why = errorText(res.error, t)
      if (res.plans.length) toast.error(tr(t, 'correctionBoard.typeScoreStopped', 'Stopped at {{n}}: {{why}}', { n: res.reached, why }))
      else toast.error(why)
    }
    return res.plans.length > 0 || !res.error
  }
  const undoLast = () => setSteps(s => {
    let n = s.length - 1
    while (n > 0 && s[n]?.withPrevious) n -= 1
    return s.slice(0, Math.max(0, n))
  })
  const resetAll = async () => {
    const ok = await confirmDialog({
      title: tr(t, 'correctionBoard.resetTitle', 'Undo every change?'),
      message: tr(t, 'correctionBoard.resetMessage', 'The board goes back to the match as it was when you opened it.'),
      confirmLabel: tr(t, 'correctionBoard.reset', 'Undo all'),
      cancelLabel: tr(t, 'corrections.action.cancel', 'Cancel'),
      tone: 'danger'
    })
    if (ok) setSteps([])
  }
  const startAgain = () => { setBase(freshBase()); setSteps([]) }
  // Reopen set stays the live flow (it deletes the later sets): the board closes for it
  const reopenSet = async () => {
    if (steps.length) {
      const ok = await confirmDialog({
        title: tr(t, 'correctionBoard.discardTitle', 'Discard your changes?'),
        message: tr(t, 'correctionBoard.discardMessage', '{{count}} changes are not saved. Close without saving them?', { count: lines.length }),
        confirmLabel: tr(t, 'correctionBoard.discard', 'Discard'),
        cancelLabel: tr(t, 'correctionBoard.keepEditing', 'Keep editing'),
        tone: 'danger'
      })
      if (!ok) return
    }
    hooks.reopenSet?.(setRow)
  }

  // ── closing ──
  const close = async () => {
    if (steps.length) {
      const ok = await confirmDialog({
        title: tr(t, 'correctionBoard.discardTitle', 'Discard your changes?'),
        message: tr(t, 'correctionBoard.discardMessage', '{{count}} changes are not saved. Close without saving them?', { count: lines.length }),
        confirmLabel: tr(t, 'correctionBoard.discard', 'Discard'),
        cancelLabel: tr(t, 'correctionBoard.keepEditing', 'Keep editing'),
        tone: 'danger'
      })
      if (!ok) return
    }
    onClose?.({ saved: false })
  }
  const showList = async () => {
    if (steps.length) {
      const ok = await confirmDialog({
        title: tr(t, 'correctionBoard.discardTitle', 'Discard your changes?'),
        message: tr(t, 'correctionBoard.discardForList', 'The list saves each correction on its own. {{count}} changes of the board are not saved yet: discard them?', { count: lines.length }),
        confirmLabel: tr(t, 'correctionBoard.discard', 'Discard'),
        cancelLabel: tr(t, 'correctionBoard.keepEditing', 'Keep editing'),
        tone: 'danger'
      })
      if (!ok) return
    }
    // the live default view; the match end opens the board on request only
    if (live) saveCorrectionView('list')
    onShowList?.()
  }

  // ── Save: one write ──
  const runConfirm = useConfirmAction((err) => {
    console.error('[correction board] write failed', err)
    toast.error(tr(t, 'corrections.saveError', 'The correction could not be saved: {{message}}', { message: err?.message || '' }))
  })
  // Save opens the review: the changes in words and the set as it will print
  // (scoresheet_pdf/SetPreview, drawn from the draft), then one write
  const save = () => {
    if (!steps.length || !editable) return
    setReviewing(true)
  }
  const commit = async () => {
    if (!steps.length || !editable) return
    const combined = combinedPlan(base.draft, steps)
    await runConfirm(async () => {
      if (mode === 'review' && planChangesSheet(combined) && signedAfterMatch(await db.matches.get(matchId))) {
        const clear = await confirmDialog({
          title: tr(t, 'matchEnd.signedSheetChange.title', 'Clear the signatures?'),
          message: tr(t, 'matchEnd.signedSheetChange.correction', 'The sheet was already signed or approved. This correction clears every signature and account approval of the match end: collect them again afterwards.'),
          confirmLabel: tr(t, 'matchEnd.signedSheetChange.confirm', 'Change and clear'),
          cancelLabel: tr(t, 'corrections.action.cancel', 'Cancel'),
          tone: 'danger'
        })
        if (!clear) return
      }
      setBusy(true)
      try {
        const res = await applyCorrectionPlan(combined, { matchId, db, mode, hooks })
        await hooks.afterApply?.(res, combined)
        toast.success(lines.length === 1 ? lines[0].text : tr(t, 'correctionBoard.saved', '{{count}} changes saved', { count: lines.length }))
        setReviewing(false)
        onClose?.({ saved: true })
      } finally {
        setBusy(false)
      }
    })
  }

  // ── the board's actions ──
  const changeFirstServe = () => {
    const before = firstServerOf(draft.match, setIndex)
    const after = before === 'home' ? 'away' : 'home'
    stage(plan((d, c) => (setIndex === 5 && d.match?.set5FirstServe
      ? planSet5CoinToss(d.events, { firstServe: after === aKey ? 'A' : 'B' }, c)
      : planCoinToss(d.events, { firstServe: after }, c))))
  }
  const removeEntry = async (ev) => {
    if (ev.type === 'timeout') return stage(planRemoveTimeout(draft.events, ev.id, ctx))
    if (ev.type === 'substitution') return stage(planRemoveSubstitution(draft.events, ev.id, ctx))
    if (ev.type === 'sanction') {
      let p = planRemoveSanction(draft.events, ev.id, {}, ctx)
      if (awardsPoint(ev.payload?.type) && live) {
        const withPoint = planRemoveSanction(draft.events, ev.id, { removePoint: true }, ctx)
        if (!withPoint.error) {
          const both = await confirmDialog({
            title: tr(t, 'corrections.confirm.removePointTitle', 'Remove the penalty point too?'),
            message: tr(t, 'corrections.confirm.removePoint', 'The point it gave is still the last point of this set. Remove it as well (as Undo would)?'),
            confirmLabel: tr(t, 'corrections.action.removeBoth', 'Remove the point too'),
            cancelLabel: tr(t, 'corrections.action.keepPoint', 'Keep the point')
          })
          if (both) p = withPoint
        }
      }
      return stage(p)
    }
    return stage(planRemoveEntry(draft.events, ev.id, ctx))
  }
  const removeRemark = (index) => {
    const all = String(draft.match?.remarks || '').split('\n')
    const line = all[index]
    all.splice(index, 1)
    const p = emptyPlan()
    p.remarksSet = all.join('\n')
    p.log = { action: 'removeRemark', setIndex: null, team: null, before: line, after: null, text: tr(t, 'corrections.log.remarkRemoved', 'Remark removed: "{{text}}"', { text: line }) + (mode === 'review' ? tr(t, 'corrections.log.afterMatchSuffix', ' (entered after the match)') : '') }
    stage(p)
  }
  const openPlayer = (team, pos, court) => {
    const number = court.lineup?.[pos]
    const libero = court.libero?.position === pos ? court.libero : null
    setSheet({ kind: 'player', team, pos, number, libero })
  }

  // ── forms (their Confirm stages the change) ──
  const formView = (() => {
    if (!form) return null
    const common = {
      ctx, events: draft.events, sets: draft.sets, players: draft.players, mode, liveSetIndex, busy: false,
      onCancel: () => setForm(null),
      onConfirm: (p) => { if (stage(p)) setForm(null) }
    }
    const preset = { setIndex, ...(form.preset || {}) }
    switch (form.kind) {
      case 'timeout': return <TimeoutForm {...common} preset={preset} editEvent={form.editEvent || null} />
      case 'substitution': return <SubstitutionForm {...common} preset={preset} editEvent={form.editEvent || null} />
      case 'sanction': return <SanctionForm {...common} preset={preset} editEvent={form.editEvent || null} />
      case 'lineup': return <LineupForm {...common} preset={preset} editEvent={form.editEvent || null} />
      case 'entry': return <EntryForm {...common} editEvent={form.editEvent} />
      case 'remark': return <RemarkForm {...common} match={draft.match} editLine={form.line ?? null} editIndex={form.index ?? null} />
      case 'setTimes': return <SetTimesForm {...common} match={draft.match} setRow={setRow} />
      case 'coinToss': return <CoinTossForm {...common} deciding={!!form.deciding} />
      case 'gameCaptain': return <GameCaptainForm {...common} preset={form.preset || {}} />
      case 'renumber': return <RenumberForm {...common} preset={form.preset || {}} />
      default: return null
    }
  })()
  const editOf = (ev) => {
    const kind = entryActions(ev, draft.events).edit
    if (!kind) return null
    if (kind === 'point' || kind === 'setTimes' || kind === 'set5CoinToss') return null
    return () => { setSheet(null); setForm({ kind: kind === 'coinToss' ? 'coinToss' : kind, editEvent: ev }) }
  }

  // ── a team's half of the board ──
  const teamSide = (team, side) => {
    const lbl = teamLabel(team, ctx)
    const court = courtOf(team)
    const baseCourt = baseCourtOf(team)
    const captain = draft.match?.[team === 'home' ? 'homeCourtCaptain' : 'awayCourtCaptain']
    const timeouts = draft.events.filter(e => e.type === 'timeout' && setOf(e) === setIndex && e.payload?.team === team).sort(compareBySeq)
    const subs = draft.events.filter(e => e.type === 'substitution' && setOf(e) === setIndex && e.payload?.team === team)
    const serving = server === team
    return (
      <section className={cn('min-w-0 rounded-2xl bg-white p-3 shadow-card ring-1 ring-stone-200/70', serving && 'ring-2 ring-yellow-400')} data-testid={`board-team-${side}`}>
        <header className="mb-3 flex items-center gap-2">
          <TeamDot color={lbl?.color} size={14} />
          <h3 className="min-w-0 flex-1 truncate text-base font-bold text-stone-900" title={lbl?.name}>{lbl?.name} <span className="font-semibold text-stone-500">({lbl?.letter})</span></h3>
          <span className="rounded-lg bg-stone-100 px-2 py-0.5 text-sm font-bold tabular-nums text-stone-700" title={tr(t, 'correctionBoard.setsWon', 'Sets won')}>{won[team]}</span>
        </header>
        <div className="mb-3 flex items-center gap-1.5">
          {[0, 1].map(i => {
            const to = timeouts[i]
            if (to) {
              const sc = scoreBeforeEvent(draft.events, to)
              return (
                <Button key={i} variant="toolbar" size="md" icon={Clock} className={cn(HIT, 'shrink-0 px-2.5')} disabled={!editable}
                  onClick={() => setSheet({ kind: 'timeout', event: to, team })}
                  data-testid={`board-timeout-${side}-${i}`}>
                  {tr(t, 'correctionBoard.timeoutAt', 'TO {{score}}', { score: plainScore(sc, team) })}
                </Button>
              )
            }
            return (
              <Button key={i} variant="ghost" size="md" icon={Plus} className={cn(HIT, 'shrink-0 px-2.5')} disabled={!editable || i > timeouts.length}
                onClick={() => setForm({ kind: 'timeout', preset: { team } })}
                data-testid={`board-timeout-${side}-${i}`}>
                {tr(t, 'correctionBoard.addTimeout', 'TO')}
              </Button>
            )
          })}
          {timeouts.length > 2 && <Chip tone="amber">{tr(t, 'correctionBoard.extraTimeouts', '+{{n}} TO', { n: timeouts.length - 2 })}</Chip>}
          <Button variant="toolbar" size="md" icon={Repeat} className={cn(HIT, 'ml-auto min-w-0 px-2.5 [&>span]:truncate')} disabled={!editable && !subs.length}
            onClick={() => setSheet({ kind: 'list', list: 'substitution', team })} data-testid={`board-subs-${side}`}>
            {tr(t, 'correctionBoard.substitutions', 'Subs {{n}}', { n: subs.length })}
          </Button>
        </div>
        <div className="grid grid-cols-3 gap-1.5 rounded-xl bg-stone-100 p-1.5">
          {COURT_ROWS.flat().map(pos => (
            <CourtTile key={pos} pos={pos} t={t}
              number={court.lineup?.[pos]}
              libero={court.libero?.position === pos ? court.libero : null}
              captain={captain != null && captain !== '' && String(court.lineup?.[pos]) === String(captain)}
              serving={serving && pos === 'I'}
              changed={String(court.lineup?.[pos] ?? '') !== String(baseCourt.lineup?.[pos] ?? '') || (court.libero?.position === pos) !== (baseCourt.libero?.position === pos)}
              disabled={!editable}
              onClick={() => openPlayer(team, pos, court)} />
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {isLiveSet && (
            <>
              <Button variant="secondary" size="md" icon={RotateCcw} className={HIT} disabled={!editable}
                onClick={() => stage(planRotateTeam(draft.events, { setIndex, team, direction: -1 }, ctx))}
                aria-label={tr(t, 'corrections.action.rotateBack', 'Rotate one position back')} data-testid={`board-rotate-back-${side}`} />
              <Button variant="secondary" size="md" icon={RotateCw} className={HIT} disabled={!editable}
                onClick={() => stage(planRotateTeam(draft.events, { setIndex, team, direction: 1 }, ctx))}
                aria-label={tr(t, 'corrections.action.rotateForward', 'Rotate one position forward')} data-testid={`board-rotate-forward-${side}`} />
            </>
          )}
          <Button variant="secondary" size="md" icon={ListChecks} className={cn(HIT, 'ml-auto')} disabled={!editable}
            onClick={() => setForm({ kind: 'lineup', preset: { team } })} data-testid={`board-lineup-${side}`}>
            {tr(t, 'correctionBoard.startingLineup', 'Starting line-up')}
          </Button>
        </div>
      </section>
    )
  }

  // ── the score between the two halves ──
  const scoreCol = (team) => {
    const pts = team === 'home' ? score.homePoints : score.awayPoints
    const was = team === 'home' ? baseScore.homePoints : baseScore.awayPoints
    const side = team === leftKey ? 'left' : 'right'
    return (
      <div className="flex flex-col items-center gap-2">
        <Button variant="dark" size="xl" icon={<Plus size={26} strokeWidth={2.5} aria-hidden="true" />} className={cn(HIT, 'w-16 px-0')} disabled={!editable}
          onClick={() => stage(planAddPoint(draft.events, draft.sets, { setIndex, team }, ctx))}
          aria-label={tr(t, 'correctionBoard.addPoint', 'Add a point: {{team}}', { team: teamLabel(team, ctx)?.name })} data-testid={`board-plus-${side}`} />
        <button type="button" disabled={!editable}
          onClick={() => setSheet({ kind: 'typeScore', team })}
          className={cn('flex h-20 w-24 items-center justify-center rounded-2xl bg-white text-5xl font-bold tabular-nums text-stone-900 shadow-card ring-1 ring-stone-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-900',
            pts !== was && 'ring-2 ring-sky-500', editable && 'hover:bg-stone-50 active:bg-stone-100')}
          aria-label={tr(t, 'correctionBoard.typeScoreAria', 'Type the score of {{team}}: {{n}}', { team: teamLabel(team, ctx)?.name, n: pts })}
          data-testid={`board-score-${side}`}>
          {pts}
        </button>
        <Button variant="danger-soft" size="xl" icon={<Minus size={26} strokeWidth={2.5} aria-hidden="true" />} className={cn(HIT, 'w-16 px-0')} disabled={!editable || pts === 0}
          onClick={() => stage(planRemovePoint(draft.events, draft.sets, { setIndex, team }, ctx))}
          aria-label={tr(t, 'correctionBoard.removePoint', 'Remove a point: {{team}}', { team: teamLabel(team, ctx)?.name })} data-testid={`board-minus-${side}`} />
      </div>
    )
  }

  const setOptions = played.map(s => ({ value: String(s.index), label: tr(t, 'corrections.term.set', 'Set {{n}}', { n: displaySetNumber(s.index, draft.match) }) }))
  const tools = [
    { key: 'sanction', icon: RectangleVertical, label: tr(t, 'corrections.section.sanctions', 'Sanctions'), onClick: () => setSheet({ kind: 'list', list: 'sanction' }) },
    { key: 'libero', icon: Users, label: tr(t, 'corrections.section.libero', 'Libero'), onClick: () => setSheet({ kind: 'list', list: 'libero' }) },
    { key: 'remark', icon: NotebookPen, label: tr(t, 'corrections.term.remarks', 'Remarks'), onClick: () => setSheet({ kind: 'list', list: 'remark' }) },
    ...(setRow ? [{ key: 'setTimes', icon: Clock, label: tr(t, 'corrections.action.setTimes', 'Set times'), onClick: () => setForm({ kind: 'setTimes' }) }] : []),
    { key: 'coinToss', icon: Coins, label: tr(t, 'corrections.section.coinToss', 'Coin toss'), onClick: () => setForm({ kind: 'coinToss', deciding: setIndex === 5 }) },
    { key: 'captain', icon: Crown, label: tr(t, 'corrections.action.gameCaptain', 'Change game captain'), onClick: () => setForm({ kind: 'gameCaptain' }) },
    { key: 'renumber', icon: Hash, label: tr(t, 'corrections.action.renumber', 'Change a number'), onClick: () => setForm({ kind: 'renumber' }) }
  ]

  // ── the sheets over the board ──
  const sheetView = (() => {
    if (!sheet) return null
    const closeSheet = () => setSheet(null)
    if (sheet.kind === 'player') {
      const { team, pos, number, libero } = sheet
      const lbl = teamLabel(team, ctx)
      const go = (kind, preset) => () => { setSheet(null); setForm({ kind, preset: { team, ...preset } }) }
      return (
        <BoardDialog onClose={closeSheet} width={420} label={`#${libero ? libero.liberoNumber : number}`}>
          <SheetCard t={t} onClose={closeSheet}
            title={libero
              ? tr(t, 'correctionBoard.liberoTitle', 'Libero #{{libero}} for #{{n}} · {{team}}', { libero: libero.liberoNumber, n: number, team: lbl?.name })
              : tr(t, 'correctionBoard.playerTitle', '#{{n}} · position {{pos}} · {{team}}', { n: number, pos, team: lbl?.name })}>
            <div className="grid gap-2">
              {libero ? (
                <Button variant="secondary" size="lg" icon={Users} className="justify-start" onClick={() => setSheet({ kind: 'list', list: 'libero', team })}>
                  {tr(t, 'correctionBoard.liberoEntries', 'Libero replacements')}
                </Button>
              ) : (
                <>
                  <Button variant="secondary" size="lg" icon={Repeat} className="justify-start" onClick={go('substitution', { playerOut: number })} data-testid="board-player-sub">
                    {tr(t, 'correctionBoard.substitute', 'Substitute #{{n}}', { n: number })}
                  </Button>
                  <Button variant="secondary" size="lg" icon={RectangleVertical} className="justify-start" onClick={go('sanction', { playerNumber: number })}>
                    {tr(t, 'correctionBoard.sanction', 'Sanction for #{{n}}', { n: number })}
                  </Button>
                  <Button variant="secondary" size="lg" icon={Crown} className="justify-start" onClick={go('gameCaptain', { number })}>
                    {tr(t, 'correctionBoard.makeCaptain', 'Make #{{n}} game captain', { n: number })}
                  </Button>
                </>
              )}
              <Button variant="secondary" size="lg" icon={Hash} className="justify-start" onClick={go('renumber', { playerNumber: libero ? libero.liberoNumber : number })}>
                {tr(t, 'correctionBoard.renumber', 'Change the number of #{{n}}', { n: libero ? libero.liberoNumber : number })}
              </Button>
            </div>
          </SheetCard>
        </BoardDialog>
      )
    }
    if (sheet.kind === 'typeScore') {
      const { team } = sheet
      const pts = team === 'home' ? score.homePoints : score.awayPoints
      return (
        <BoardDialog onClose={closeSheet} width={440} label={tr(t, 'correctionBoard.typeScoreTitle', 'Score of {{team}} · set {{set}}', { team: teamLabel(team, ctx)?.name, set: displaySetNumber(setIndex, draft.match) })}>
          <TypeScoreCard t={t} team={teamLabel(team, ctx)} set={displaySetNumber(setIndex, draft.match)} current={pts} onClose={closeSheet}
            onApply={(target) => { if (applyTypedScore(team, target)) closeSheet() }} />
        </BoardDialog>
      )
    }
    if (sheet.kind === 'timeout') {
      const ev = sheet.event
      const d = describeEvent(ev, draft.events, ctx)
      return (
        <BoardDialog onClose={closeSheet} width={460} label={d?.title}>
          <SheetCard t={t} onClose={closeSheet} title={d?.text}
            footer={(
              <>
                <Button variant="secondary" size="lg" icon={Pencil} onClick={() => { setSheet(null); setForm({ kind: 'timeout', editEvent: ev }) }}>
                  {tr(t, 'correctionBoard.changeScore', 'Change the score')}
                </Button>
                <Button variant="danger-outline" size="lg" icon={Trash2} onClick={() => { setSheet(null); removeEntry(ev) }} data-testid="board-timeout-remove">
                  {tr(t, 'corrections.action.remove', 'Remove')}
                </Button>
              </>
            )}>
            <p className="text-sm text-stone-600">{tr(t, 'correctionBoard.timeoutHint', 'Move the time-out to the score it was taken at, or remove it.')}</p>
          </SheetCard>
        </BoardDialog>
      )
    }
    if (sheet.kind === 'list') {
      const { list, team = null } = sheet
      if (list === 'remark') {
        const remarkLines = String(draft.match?.remarks || '').split('\n').map((line, index) => ({ line, index })).filter(r => r.line.trim())
        return (
          <BoardDialog onClose={closeSheet} label={tr(t, 'corrections.term.remarks', 'Remarks')}>
            <SheetCard t={t} onClose={closeSheet} title={tr(t, 'corrections.term.remarks', 'Remarks')}
              footer={editable && <Button variant="dark" size="lg" icon={Plus} onClick={() => { setSheet(null); setForm({ kind: 'remark' }) }}>{tr(t, 'corrections.add.remark', 'Add remark')}</Button>}>
              {remarkLines.length === 0 ? <p className="text-sm text-stone-500">{tr(t, 'corrections.empty.remarks', 'No remarks.')}</p> : (
                <ul className="divide-y divide-stone-100">
                  {remarkLines.map(r => (
                    <li key={r.index} className="flex items-start gap-2 py-2">
                      <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm text-stone-800">{r.line}</p>
                      {editable && <Button variant="secondary" size="md" icon={Pencil} className={HIT} onClick={() => { setSheet(null); setForm({ kind: 'remark', line: r.line, index: r.index }) }} aria-label={tr(t, 'corrections.action.editRemark', 'Edit remark')} />}
                      {editable && <Button variant="danger-soft" size="md" icon={X} className={cn(HIT, 'w-9 px-0')} onClick={() => removeRemark(r.index)} aria-label={tr(t, 'corrections.action.removeRemark', 'Remove remark')} />}
                    </li>
                  ))}
                </ul>
              )}
            </SheetCard>
          </BoardDialog>
        )
      }
      const types = list === 'libero' ? LIBERO_TYPES : [list]
      const rows = rowsOf(e => types.includes(e.type) && (!team || e.payload?.team === team) && !(list === 'libero' && entryActions(e, draft.events).automatic))
      const titles = {
        substitution: tr(t, 'corrections.section.substitutions', 'Substitutions'),
        sanction: tr(t, 'corrections.section.sanctions', 'Sanctions'),
        libero: tr(t, 'corrections.section.libero', 'Libero')
      }
      const title = `${titles[list]} · ${tr(t, 'corrections.term.set', 'Set {{n}}', { n: displaySetNumber(setIndex, draft.match) })}${team ? ` · ${teamLabel(team, ctx)?.name}` : ''}`
      const addLabel = list === 'substitution' ? tr(t, 'corrections.add.substitution', 'Add substitution') : list === 'sanction' ? tr(t, 'corrections.add.sanction', 'Add sanction') : null
      return (
        <BoardDialog onClose={closeSheet} label={title}>
          <SheetCard t={t} onClose={closeSheet} title={title}
            footer={editable && addLabel && <Button variant="dark" size="lg" icon={Plus} onClick={() => { setSheet(null); setForm({ kind: list, preset: team ? { team } : {} }) }}>{addLabel}</Button>}>
            {rows.length === 0 ? <p className="text-sm text-stone-500">{tr(t, 'correctionBoard.emptyList', 'Nothing recorded in this set.')}</p> : (
              <ul className="divide-y divide-stone-100" data-testid={`board-list-${list}`}>
                {rows.map(({ e, d }) => {
                  const edit = editOf(e)
                  return (
                    <li key={e.id} className="flex items-start gap-2 py-2.5">
                      <TeamDot color={d.team?.color} size={12} className="mt-1.5" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-stone-900">{d.title}</p>
                        {d.meta && <p className="text-xs tabular-nums text-stone-500">{d.meta}</p>}
                      </div>
                      {editable && edit && <Button variant="secondary" size="md" icon={Pencil} className={HIT} onClick={edit} aria-label={tr(t, 'corrections.action.editWhat', 'Edit {{what}}', { what: d.title })} />}
                      {editable && <Button variant="danger-soft" size="md" icon={X} className={cn(HIT, 'w-9 px-0')} onClick={() => removeEntry(e)} aria-label={tr(t, 'corrections.action.removeEntry', 'Remove {{what}}', { what: d.title })} />}
                    </li>
                  )
                })}
              </ul>
            )}
          </SheetCard>
        </BoardDialog>
      )
    }
    return null
  })()

  return (
    <div className="ov-kit fixed inset-0 flex flex-col bg-stone-100" style={{ zIndex: 1000 }} role="dialog" aria-modal="true"
      aria-label={tr(t, 'correctionBoard.title', 'Correction board')} data-testid="correction-board">
      {/* Top bar: title, sets, list view, close */}
      <div className="flex flex-wrap items-center gap-3 border-b border-stone-200 bg-white px-4 py-2.5">
        <h2 className="text-lg font-bold text-stone-900">{tr(t, 'correctionBoard.title', 'Correction board')}</h2>
        <div className="min-w-0 flex-1 overflow-x-auto">
          {setOptions.length > 0 && (
            <div className="max-w-xl">
            <SegmentedControl ariaLabel={tr(t, 'corrections.setFilter', 'Show set')} options={setOptions} value={String(setIndex)}
              onChange={(v) => setSetIndex(Number(v))} className="min-w-max" />
            </div>
          )}
        </div>
        <Button variant="toolbar" size="md" icon={LayoutList} onClick={showList} data-testid="board-show-list">{tr(t, 'correctionBoard.list', 'List')}</Button>
        <DialogHelpButton screen="liveCorrections" />
        <Button variant="ghost" size="md" icon={X} className={cn(HIT, 'w-9 px-0')} onClick={close} aria-label={tr(t, 'corrections.action.close', 'Close')} data-testid="board-close" />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="mx-auto max-w-6xl space-y-3">
          {stale && (
            <Banner tone="warning" action={{ label: tr(t, 'correctionBoard.startAgain', 'Start again'), onClick: startAgain }}>
              {tr(t, 'correctionBoard.stale', 'The match changed while the board was open. Start again from the match as it is now.')}
            </Banner>
          )}
          {live && rallyInPlay && !stale && (
            <Banner tone="info">{tr(t, 'correctionBoard.rallyInPlay', 'A rally is in play: record its point first, then correct.')}</Banner>
          )}

          <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-3">
            {teamSide(leftKey, 'left')}
            <div className="flex flex-col items-center gap-3 pt-1">
              <div className="flex items-start gap-3">
                {scoreCol(leftKey)}
                <div className="flex h-36 flex-col items-center justify-center text-center">
                  <span className="text-xs font-semibold uppercase tracking-wide text-stone-500">{tr(t, 'corrections.term.set', 'Set {{n}}', { n: displaySetNumber(setIndex, draft.match) })}</span>
                  <span className="text-2xl font-bold text-stone-300">:</span>
                  {finished && <Chip tone="stone">{tr(t, 'correctionBoard.finished', 'Finished')}</Chip>}
                </div>
                {scoreCol(rightKey)}
              </div>
              {live && finished && setRow && hooks.reopenSet && setIndex !== liveSetIndex && (
                <Button variant="danger-outline" size="lg" icon={ListRestart} disabled={busy || rallyInPlay} onClick={reopenSet} data-testid="board-reopen-set">
                  {tr(t, 'corrections.action.reopenSet', 'Reopen set')}
                </Button>
              )}
              {isLiveSet && (
                <div className="flex w-72 flex-col gap-2">
                  <Button variant="secondary" size="lg" icon={RotateCw} className="justify-start" disabled={!editable} onClick={changeFirstServe} data-testid="board-first-serve">
                    {tr(t, 'corrections.action.changeServe', 'Change who serves first')}
                  </Button>
                  <Button variant="secondary" size="lg" icon={Repeat} className="justify-start" disabled={!editable || setPoints.length === 0}
                    onClick={() => stage(planLastPointOtherTeam(draft.events, { setIndex }, ctx))} data-testid="board-wrong-team">
                    {tr(t, 'corrections.action.wrongTeam', 'Last point went to the wrong team')}
                  </Button>
                  <Button variant="secondary" size="lg" icon={ArrowLeftRight} className="justify-start" disabled={!editable}
                    onClick={() => stage(planSwitchSides(draft.match, setIndex, ctx))} data-testid="board-switch-sides">
                    {tr(t, 'corrections.action.switchSides', 'Switch sides')}
                  </Button>
                </div>
              )}
            </div>
            {teamSide(rightKey, 'right')}
          </div>

          <div className="flex flex-wrap gap-2">
            {tools.map(tool => (
              <Button key={tool.key} variant="toolbar" size="lg" icon={tool.icon} disabled={!editable && tool.key !== 'sanction' && tool.key !== 'libero' && tool.key !== 'remark'}
                onClick={tool.onClick} data-testid={`board-tool-${tool.key}`}>
                {tool.label}
              </Button>
            ))}
          </div>

          {issues.length > 0 && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3" data-testid="board-issues">
              <p className="flex items-center gap-2 text-sm font-semibold text-amber-900"><AlertTriangle size={16} aria-hidden="true" />{tr(t, 'corrections.section.issues', 'Check these entries')}</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-6 text-sm text-amber-900">{issues.slice(0, 6).map(i => <li key={i.sig}>{issueText(i, t)}</li>)}</ul>
            </div>
          )}
        </div>
      </div>

      {/* Changes and Save */}
      <div className="border-t border-stone-200 bg-white px-4 py-2.5">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            {lines.length === 0 ? (
              <p className="text-sm text-stone-500">{tr(t, 'correctionBoard.noChanges', 'No changes yet. Nothing is saved until you tap Save.')}</p>
            ) : (
              <details className="group">
                <summary className="flex min-w-0 cursor-pointer list-none gap-2 text-sm font-medium text-stone-800">
                  <span className="shrink-0">{tr(t, 'correctionBoard.changes', '{{count}} changes, not saved yet', { count: lines.length })}</span>
                  <span className="min-w-0 truncate font-normal text-stone-500 group-open:hidden">· {lines[lines.length - 1].text}</span>
                </summary>
                <ol className="mt-2 max-h-32 list-decimal space-y-0.5 overflow-y-auto pl-5 text-sm text-stone-700" data-testid="board-changes">
                  {lines.map(l => <li key={l.index}>{l.text}</li>)}
                </ol>
              </details>
            )}
          </div>
          <Button variant="secondary" size="lg" icon={Undo2} disabled={!steps.length || busy} onClick={undoLast} data-testid="board-undo">{tr(t, 'correctionBoard.undo', 'Undo')}</Button>
          <Button variant="ghost" size="lg" disabled={!steps.length || busy} onClick={resetAll}>{tr(t, 'correctionBoard.reset', 'Undo all')}</Button>
          <Button variant="secondary" size="lg" onClick={close} disabled={busy}>{tr(t, 'corrections.action.cancel', 'Cancel')}</Button>
          <Button variant="positive" size="lg" disabled={!steps.length || !editable} loading={busy} onClick={save} data-testid="board-save">
            {lines.length ? tr(t, 'correctionBoard.saveN', 'Save ({{count}})', { count: lines.length }) : tr(t, 'correctionBoard.save', 'Save')}
          </Button>
        </div>
      </div>

      {reviewing && (
        <BoardDialog onClose={() => { if (!busy) setReviewing(false) }} width={1080} label={tr(t, 'correctionBoard.saveTitle', 'Save {{count}} changes?', { count: lines.length })}>
          <SaveReview t={t} lines={lines} steps={steps} issues={issues} draft={draft} homeTeam={homeTeam} awayTeam={awayTeam}
            currentSet={setIndex} busy={busy} onBack={() => setReviewing(false)} onSave={commit} />
        </BoardDialog>
      )}
      {sheetView}
      {formView && <BoardDialog onClose={() => setForm(null)} label={form?.kind}>{formView}</BoardDialog>}
    </div>
  )
}
