// Go back: the one place where the scorer puts the game back as the rules
// say when a fault is found after play went on (domain/rectify). Three short
// steps (owner 2026-11-09: "Isn't it a little too much? Like when confirmed
// the error: make sure I can edit stuff"; "i can still manually adjust score
// etc"):
//   1. when: the score of the set where it went wrong;
//   2. what happens: whose points since then are cancelled (A, B, both) and
//      who gets point and service (nobody, A, B), with the rules' usual
//      answers as hints;
//   3. confirmed, everything can still be edited before play resumes: the
//      score by hand, who serves, both line-ups (a substitution taken back, a
//      player put back) and the remark. "Resume" writes it all as one
//      correction, which Undo and the corrections take back.
// Nothing is written before "Resume". Opened from the Match menu, on the
// tablet and on the phone. A team that cannot go on is not handled here: one
// link to the scorer's own forfeit (Stop the match).
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Minus, Plus } from 'lucide-react'
import { cn } from '../../ui/cn.js'
import { Button, FOCUS_RING } from '../../ui/Button.jsx'
import { Banner } from '../../ui/Banner.jsx'
import { Select } from '../../ui/Select.jsx'
import { SegmentedControl } from '../../ui/SegmentedControl.jsx'
import { Textarea } from '../../ui/Textarea.jsx'
import { FormError } from '../../ui/Field.jsx'
import { tr, formatScore, teamLabel, teamNameWithLetter, compareBySeq } from '../../domain/describe'
import { rectifyMoments, planRectification, rectifyErrorText, defaultPenaltyTo } from '../../domain/rectify'
import { POSITIONS } from '../../domain/recompute'
import { useConfirmAction } from '../../hooks/useConfirmAction'
import { FieldGroup, NewIssues } from '../corrections/shared.jsx'

const TEAMS = ['home', 'away']

function StepTitle({ n, children }) {
  return (
    <h3 className="m-0 flex items-center gap-2 text-base font-semibold text-stone-900">
      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">{n}</span>
      {children}
    </h3>
  )
}

function Notes({ plan, t }) {
  if (!plan || plan.error) return null
  return (
    <>
      {plan.notes?.length > 0 && (
        <ul className="m-0 list-none space-y-1 p-0">
          {plan.notes.map((n, i) => (
            <li key={i} className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">{tr(t, n.key, n.text, n.params)}</li>
          ))}
        </ul>
      )}
      <NewIssues issues={plan.newIssues} t={t} />
    </>
  )
}

/** The six positions of a team, each a select of its players (the number, as on the court). */
function LineupEditor({ team, lineup, onChange, players, ctx }) {
  const t = ctx.t
  const options = useMemo(() => {
    const nums = new Map()
    for (const p of players || []) {
      if (p?.number == null) continue
      nums.set(String(p.number), `#${p.number}${p.libero ? ` (${tr(t, 'rectify.lineup.libero', 'libero')})` : ''}`)
    }
    for (const pos of POSITIONS) if (lineup?.[pos] != null && !nums.has(String(lineup[pos]))) nums.set(String(lineup[pos]), `#${lineup[pos]}`)
    return [...nums.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([value, label]) => ({ value, label }))
  }, [players, lineup, t])
  const letter = teamLabel(team, ctx)?.letter || '?'
  return (
    <div className="grid grid-cols-3 gap-2" role="group" aria-label={tr(t, 'rectify.field.lineup', 'Line-up of {{team}}', { team: teamNameWithLetter(team, ctx) })}>
      {['IV', 'III', 'II', 'V', 'VI', 'I'].map(pos => (
        <label key={pos} className="min-w-0 text-xs font-medium text-stone-600">
          <span className="mb-1 block">{pos}</span>
          <Select
            size="lg"
            block
            aria-label={tr(t, 'rectify.lineup.position', '{{team}}: player at position {{pos}}', { team: letter, pos })}
            options={options}
            value={lineup?.[pos] != null ? String(lineup[pos]) : ''}
            onChange={(e) => onChange({ ...lineup, [pos]: e.target.value })}
          />
        </label>
      ))}
    </div>
  )
}

/** One team's points, by hand: minus, the number, plus. */
function ScoreStepper({ team, value, onChange, ctx }) {
  const t = ctx.t
  const name = teamNameWithLetter(team, ctx)
  return (
    <div className="flex min-w-0 items-center justify-between gap-2 rounded-xl border border-stone-200 bg-white px-3 py-2">
      <span className="min-w-0 truncate text-sm font-medium text-stone-800">{name}</span>
      <span className="flex shrink-0 items-center gap-2">
        <Button variant="secondary" size="md" icon={Minus} className="w-11 px-0" disabled={value <= 0} onClick={() => onChange(value - 1)} aria-label={tr(t, 'rectify.score.minus', 'One point less for {{team}}', { team: name })} />
        <span className="w-8 text-center text-xl font-semibold tabular-nums text-stone-900" aria-label={tr(t, 'rectify.score.value', 'Points of {{team}}', { team: name })}>{value}</span>
        <Button variant="secondary" size="md" icon={Plus} className="w-11 px-0" onClick={() => onChange(value + 1)} aria-label={tr(t, 'rectify.score.plus', 'One point more for {{team}}', { team: name })} />
      </span>
    </div>
  )
}

/**
 * @param {object} props
 * @param {Array} props.events the match log
 * @param {number|null} props.liveSetIndex the set being played
 * @param {boolean} [props.rallyInPlay] a rally is in play: nothing is written until it ends
 * @param {{ apply?: (plan) => Promise<boolean>, openStopMatch?: Function, close?: Function }} props.hooks
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

  const [step, setStep] = useState(1)
  const [momentKey, setMomentKey] = useState(null)
  const [cancel, setCancel] = useState(null)
  const [penalty, setPenalty] = useState(null) // 'none' | 'home' | 'away'; null: the usual answer
  const [edits, setEdits] = useState({})
  const [busy, setBusy] = useState(false)
  const run = useConfirmAction(() => setBusy(false))
  const lastPreview = useRef(null)

  const moments = useMemo(() => (setOpen ? rectifyMoments(sorted, { setIndex: liveSetIndex }, ctx) : []), [sorted, liveSetIndex, ctx, setOpen])
  const moment = moments.find(m => m.key === momentKey) || moments[0] || null
  const penaltyTo = penalty == null ? defaultPenaltyTo(cancel) : (penalty === 'none' ? null : penalty)
  const plan = useMemo(() => {
    if (!moment || !cancel) return null
    return planRectification(sorted, { setIndex: liveSetIndex, moment, cancel, penaltyTo, edits: step === 3 ? edits : {} }, ctx)
  }, [sorted, liveSetIndex, moment, cancel, penaltyTo, edits, step, ctx])
  const ok = !!plan && !plan.error
  if (ok) lastPreview.current = plan.preview
  const preview = ok ? plan.preview : lastPreview.current
  const blocked = rallyInPlay
  const teamName = (k) => teamNameWithLetter(k, ctx)
  const scoreText = (s) => formatScore(s, null, ctx)
  const edit = (patch) => setEdits(prev => ({ ...prev, ...patch }))

  const resume = () => run(async () => {
    if (!ok) return
    setBusy(true)
    try {
      const done = await hooks.apply?.(plan)
      if (done !== false) hooks.close?.()
    } finally {
      setBusy(false)
    }
  })

  if (!setOpen) {
    return (
      <div className="ov-kit space-y-3">
        <p className="m-0 text-sm text-stone-600">{tr(t, 'rectify.blocked.noSet', 'Only during a set.')}</p>
        <ForfeitLink t={t} hooks={hooks} />
      </div>
    )
  }

  // .ov-kit: the kit's own styles, not the scoring screen's legacy button rule
  return (
    <div className="ov-kit space-y-4">
      {blocked && <Banner tone="warning">{tr(t, 'rectify.blocked.rally', 'A rally is in play: finish it first.')}</Banner>}

      {step === 1 && (
        <section className="space-y-3" aria-label={tr(t, 'rectify.step.when', 'When did it go wrong?')}>
          <StepTitle n={1}>{tr(t, 'rectify.step.when', 'When did it go wrong?')}</StepTitle>
          <div>
            <label htmlFor="rectify-moment" className="mb-1.5 block text-sm font-medium text-stone-700">{tr(t, 'rectify.field.moment', 'Score where it went wrong')}</label>
            <Select id="rectify-moment" size="lg" block value={moment?.key || ''} onChange={(e) => setMomentKey(e.target.value)}
              options={moments.map(m => ({ value: m.key, label: m.label }))} />
            <p className="m-0 mt-1.5 text-xs text-stone-500">{tr(t, 'rectify.hint.moment', 'The points scored after this score are the ones "since then".')}</p>
          </div>
          <Button variant="dark" size="lg" block disabled={!moment} onClick={() => setStep(2)}>{tr(t, 'rectify.action.next', 'Next')}</Button>
          <ForfeitLink t={t} hooks={hooks} />
        </section>
      )}

      {step === 2 && (
        <section className="space-y-4" aria-label={tr(t, 'rectify.step.what', 'What happens')}>
          <BackLink t={t} onClick={() => setStep(1)} />
          <StepTitle n={2}>{tr(t, 'rectify.step.what', 'What happens')}</StepTitle>
          <p className="m-0 text-sm text-stone-600">
            {tr(t, 'rectify.since', 'Since {{score}}', { score: moment?.label || '' })}
            <span className="block text-xs text-stone-500">{TEAMS.map(k => teamName(k)).join(' · ')}</span>
          </p>
          <FieldGroup label={tr(t, 'rectify.field.cancel', 'Whose points since then are cancelled?')}>
            <SegmentedControl
              ariaLabel={tr(t, 'rectify.field.cancel', 'Whose points since then are cancelled?')}
              value={cancel || ''}
              onChange={(v) => { setCancel(v); setPenalty(null); setEdits({}) }}
              options={[
                { value: 'home', label: tr(t, 'rectify.teamOption', 'Team {{letter}}', { letter: teamLabel('home', ctx)?.letter || '?' }) },
                { value: 'away', label: tr(t, 'rectify.teamOption', 'Team {{letter}}', { letter: teamLabel('away', ctx)?.letter || '?' }) },
                { value: 'both', label: tr(t, 'rectify.both', 'Both') }
              ]}
            />
          </FieldGroup>
          <FieldGroup label={tr(t, 'rectify.field.penalty', 'Point and service to')}>
            <SegmentedControl
              ariaLabel={tr(t, 'rectify.field.penalty', 'Point and service to')}
              value={penaltyTo || 'none'}
              onChange={(v) => { setPenalty(v); setEdits({}) }}
              options={[
                { value: 'none', label: tr(t, 'rectify.nobody', 'Nobody') },
                { value: 'home', label: tr(t, 'rectify.teamOption', 'Team {{letter}}', { letter: teamLabel('home', ctx)?.letter || '?' }) },
                { value: 'away', label: tr(t, 'rectify.teamOption', 'Team {{letter}}', { letter: teamLabel('away', ctx)?.letter || '?' }) }
              ]}
            />
          </FieldGroup>
          <ul className="m-0 list-none space-y-1 rounded-xl border border-stone-200 bg-stone-50/70 p-3 text-xs text-stone-600">
            <li>{tr(t, 'rectify.hint.team', 'Illegal substitution found later (R15.9.2), positions not as on the line-up sheet (R7.3.5.3), wrong server (R7.7.2): the team at fault\'s points are cancelled, point and service to the opponent.')}</li>
            <li>{tr(t, 'rectify.hint.both', 'The officials gave wrong information, or a rally was played with five or seven players (Casebook 2.3, 2.4): both, nobody.')}</li>
          </ul>
          {plan?.error && <FormError>{rectifyErrorText(plan, t)}</FormError>}
          {ok && (
            <p className="m-0 text-sm text-stone-900">
              {tr(t, 'rectify.summary', '{{before}} → {{after}}', { before: scoreText(plan.preview.scoreBefore), after: scoreText(plan.preview.scoreAfter) })}
            </p>
          )}
          <Button variant="dark" size="lg" block disabled={!ok} onClick={() => { setEdits({}); setStep(3) }}>{tr(t, 'rectify.action.confirm', 'Confirm')}</Button>
        </section>
      )}

      {step === 3 && preview && (
        <section className="space-y-4" aria-label={tr(t, 'rectify.step.edit', 'Check and edit, then resume')}>
          <BackLink t={t} onClick={() => setStep(2)} />
          <StepTitle n={3}>{tr(t, 'rectify.step.edit', 'Check and edit, then resume')}</StepTitle>
          <p className="m-0 text-xs text-stone-500">{tr(t, 'rectify.hint.edit', 'Change anything the referees decided otherwise. Nothing is written before Resume.')}</p>

          <FieldGroup label={tr(t, 'rectify.field.score', 'Score')} hint={tr(t, 'rectify.hint.score', 'Was {{score}}.', { score: scoreText(preview.scoreBefore) })}>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {TEAMS.map(team => (
                <ScoreStepper key={team} team={team} ctx={ctx} value={preview.scoreAfter[team]}
                  onChange={(v) => edit({ score: { ...preview.scoreAfter, [team]: v } })} />
              ))}
            </div>
          </FieldGroup>

          <FieldGroup label={tr(t, 'rectify.field.serve', 'Serves next')}>
            <SegmentedControl
              ariaLabel={tr(t, 'rectify.field.serve', 'Serves next')}
              value={preview.serve}
              onChange={(v) => edit({ serve: v })}
              options={TEAMS.map(team => ({ value: team, label: teamName(team) }))}
            />
            {preview.serverNumber != null && <p className="m-0 mt-1 text-xs text-stone-500">{tr(t, 'rectify.server', 'Server: #{{n}} (position I)', { n: preview.serverNumber })}</p>}
          </FieldGroup>

          {TEAMS.map(team => preview.lineupState[team] && (
            <FieldGroup key={team} label={tr(t, 'rectify.field.lineup', 'Line-up of {{team}}', { team: teamName(team) })}>
              <LineupEditor team={team} ctx={ctx} players={players[team]}
                lineup={edits.lineups?.[team] || preview.lineupState[team].lineup}
                onChange={(lineup) => edit({ lineups: { ...(edits.lineups || {}), [team]: lineup } })} />
            </FieldGroup>
          ))}

          {preview.substitutions.length > 0 && (
            <FieldGroup label={tr(t, 'rectify.field.takeBack', 'Substitutions of this set')} hint={tr(t, 'rectify.hint.takeBack', 'A substitution taken back leaves the record; its players go back where they were.')}>
              <ul className="m-0 list-none space-y-1 p-0">
                {preview.substitutions.map(sub => {
                  const on = (edits.takeBack || []).includes(sub.id)
                  return (
                    <li key={sub.id}>
                      <label className={cn('flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-800', FOCUS_RING)}>
                        <input type="checkbox" className="h-4 w-4 shrink-0" checked={on}
                          onChange={() => edit({ takeBack: on ? (edits.takeBack || []).filter(id => id !== sub.id) : [...(edits.takeBack || []), sub.id], lineups: {} })} />
                        <span className="min-w-0 flex-1">{sub.text}</span>
                        <span className="shrink-0 text-xs font-medium text-stone-500">{tr(t, 'rectify.takeBack', 'Take back')}</span>
                      </label>
                    </li>
                  )
                })}
              </ul>
            </FieldGroup>
          )}

          <div>
            <label htmlFor="rectify-remark" className="mb-1.5 block text-sm font-medium text-stone-700">{tr(t, 'rectify.field.remark', 'Remark on the scoresheet')}</label>
            <Textarea id="rectify-remark" size="sm" rows={3} value={typeof edits.remark === 'string' ? edits.remark : preview.remarkDefault}
              onChange={(e) => edit({ remark: e.target.value })} />
            {typeof edits.remark === 'string' && (
              <button type="button" className={cn('mt-1 min-h-9 text-xs font-medium text-stone-600 underline', FOCUS_RING)} onClick={() => edit({ remark: undefined })}>
                {tr(t, 'rectify.remarkReset', 'Use the text the app writes')}
              </button>
            )}
          </div>

          {plan?.error && <FormError>{rectifyErrorText(plan, t)}</FormError>}
          <Notes plan={plan} t={t} />
          <Button variant="dark" size="lg" block disabled={!ok || blocked || busy} loading={busy} onClick={resume}>
            {tr(t, 'rectify.action.resume', 'Resume')}
          </Button>
        </section>
      )}
    </div>
  )
}

function BackLink({ t, onClick }) {
  return (
    <button type="button" onClick={onClick} className={cn('inline-flex min-h-11 items-center gap-1.5 rounded-lg px-1 text-sm font-medium text-stone-600 hover:text-stone-900', FOCUS_RING)}>
      <ArrowLeft size={16} aria-hidden="true" />
      {tr(t, 'rectify.back', 'Back')}
    </button>
  )
}

/** A team that cannot go on: its forfeit is the scorer's own flow. */
function ForfeitLink({ t, hooks }) {
  if (!hooks.openStopMatch) return null
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-2 text-xs text-stone-500">
      {tr(t, 'rectify.forfeit.text', 'A team cannot go on (default, incomplete)?')}
      <button type="button" onClick={() => hooks.openStopMatch()} className={cn('min-h-9 font-medium text-stone-700 underline', FOCUS_RING)}>
        {tr(t, 'rectify.forfeit.link', 'Stop the match')}
      </button>
    </p>
  )
}
