// Building blocks of the corrections screens: pickers that speak the
// scoresheet (set, team with its letter, "at which score" from the scores
// the set went through, players from the roster) and the form shell with the
// "What changes on the scoresheet" preview. volleyui kit parts only.
import { useId } from 'react'
import { ArrowLeft } from 'lucide-react'
import { cn } from '../../ui/cn.js'
import { Button, FOCUS_RING } from '../../ui/Button.jsx'
import { Card, CardHeading } from '../../ui/Card.jsx'
import { Select } from '../../ui/Select.jsx'
import { SegmentedControl } from '../../ui/SegmentedControl.jsx'
import { FormError } from '../../ui/Field.jsx'
import { Textarea } from '../../ui/Textarea.jsx'
import { discRing, HEADER_SURFACE } from '../../utils/teamColours'
import { formatScore, teamLabel, displaySetNumber, tr } from '../../domain/describe'
import { errorText } from '../../domain/manualCorrections'

/** Minimum touch target on a 32/36px kit button: a 44px+ hit area. */
export const HIT = 'relative after:absolute after:-inset-1.5 after:content-[""]'

export function TeamDot({ color, size = 12, className }) {
  const ring = discRing(color || '#888', HEADER_SURFACE)
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block shrink-0 rounded-full', className)}
      style={{ width: size, height: size, background: color || '#888', ...(ring ? { boxShadow: `inset 0 0 0 1.5px ${ring}` } : {}) }}
    />
  )
}

/** A labelled group of controls (fieldset + legend), kit form label look. */
export function FieldGroup({ label, hint, children, className }) {
  return (
    <fieldset className={cn('min-w-0', className)}>
      <legend className="block text-sm font-medium text-stone-700 mb-1.5">{label}</legend>
      {children}
      {hint && <p className="mt-1.5 text-xs text-stone-500">{hint}</p>}
    </fieldset>
  )
}

/** The played sets as a segmented control ("Set 1 | Set 2 | ..."). */
export function SetPicker({ sets, value, onChange, ctx }) {
  const options = (sets || []).map(s => ({
    value: String(s.index),
    label: tr(ctx.t, 'corrections.term.set', 'Set {{n}}', { n: displaySetNumber(s.index, ctx.match) })
  }))
  if (!options.length) return null
  return (
    <FieldGroup label={tr(ctx.t, 'corrections.field.set', 'Set')}>
      <SegmentedControl
        ariaLabel={tr(ctx.t, 'corrections.field.set', 'Set')}
        options={options}
        value={value != null ? String(value) : ''}
        onChange={(v) => onChange(Number(v))}
      />
    </FieldGroup>
  )
}

/** Two large team buttons: colour dot, name, (A) / (B). */
export function TeamPicker({ value, onChange, ctx, disabled = false, label }) {
  return (
    <FieldGroup label={label || tr(ctx.t, 'corrections.field.team', 'Team')}>
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={label || tr(ctx.t, 'corrections.field.team', 'Team')}>
        {['home', 'away'].map(key => {
          const lbl = teamLabel(key, ctx)
          const on = value === key
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled && !on}
              onClick={() => onChange(key)}
              className={cn(
                'min-h-12 rounded-xl border px-3 py-2 text-left text-sm font-medium flex items-center gap-2 transition-colors',
                FOCUS_RING,
                on ? 'border-slate-900 bg-slate-900 text-white' : 'border-stone-300 bg-white text-stone-800 hover:bg-stone-50',
                disabled && !on && 'opacity-50'
              )}
            >
              <TeamDot color={lbl.color} size={14} />
              <span className="min-w-0 truncate">{lbl.name}</span>
              <span className={cn('ml-auto text-xs font-semibold', on ? 'text-white/80' : 'text-stone-500')}>({lbl.letter})</span>
            </button>
          )
        })}
      </div>
    </FieldGroup>
  )
}

const KIND_HINT = {
  timeout: ['corrections.hint.timeoutHere', 'time-out already here'],
  substitution: ['corrections.hint.subHere', 'substitution already here'],
  sanction: ['corrections.hint.sanctionHere', 'sanction already here']
}

/**
 * "At which score": the scores the set went through, the chosen team first
 * ("B 10:12 A"). Entries already holding an event of the same kind say so.
 */
export function ScoreAtPicker({ timeline, value, onChange, team, ctx, kind, liveIdx = null }) {
  const id = useId()
  const options = (timeline || []).map(entry => {
    const hints = []
    if (kind && entry.kinds?.includes(kind)) hints.push(tr(ctx.t, KIND_HINT[kind][0], KIND_HINT[kind][1]))
    if (liveIdx != null && entry.index === liveIdx) hints.push(tr(ctx.t, 'corrections.hint.current', 'current score'))
    const label = formatScore(entry, team || null, ctx)
    return { value: String(entry.index), label: hints.length ? `${label} — ${hints.join(', ')}` : label }
  })
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-sm font-medium text-stone-700 mb-1.5">{tr(ctx.t, 'corrections.field.atScore', 'At score')}</label>
      <Select id={id} size="lg" block options={options} value={value != null ? String(value) : ''} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  )
}

/** Player chips (#8 and the name), one choice. */
export function PlayerPicker({ label, players, value, onChange, emptyText, ctx }) {
  return (
    <FieldGroup label={label}>
      {(players || []).length === 0 ? (
        <p className="text-xs text-stone-500">{emptyText || tr(ctx?.t, 'corrections.empty.players', 'No player to choose.')}</p>
      ) : (
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
          {players.map(p => {
            const on = value != null && String(value) === String(p.number)
            const name = p.name || [p.firstName, p.lastName].filter(Boolean).join(' ')
            return (
              <button
                key={`${p.number}-${p.id ?? ''}`}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onChange(p.number)}
                className={cn(
                  'min-h-11 min-w-11 rounded-lg border px-3 text-sm flex items-center gap-1.5 transition-colors',
                  FOCUS_RING,
                  on ? 'border-slate-900 bg-slate-900 text-white' : 'border-stone-300 bg-white text-stone-800 hover:bg-stone-50'
                )}
              >
                <span className="font-semibold tabular-nums">#{p.number}</span>
                {name && <span className={cn('max-w-32 truncate text-xs', on ? 'text-white/80' : 'text-stone-500')}>{name}</span>}
              </button>
            )
          })}
        </div>
      )}
    </FieldGroup>
  )
}

const COURT_ROWS = [['IV', 'III', 'II'], ['V', 'VI', 'I']]

/** A six-cell court picture (front row on top), highlighted cells changed. */
export function CourtMini({ lineup, highlight = [], caption }) {
  return (
    <figure className="min-w-0">
      {caption && <figcaption className="mb-1 text-[11px] font-medium text-stone-500">{caption}</figcaption>}
      <div className="grid grid-cols-3 gap-1 rounded-lg border border-stone-200 bg-stone-50 p-1.5 w-36">
        {COURT_ROWS.flat().map(pos => (
          <div
            key={pos}
            className={cn('h-8 rounded-md flex items-center justify-center text-sm font-semibold tabular-nums',
              highlight.includes(pos) ? 'bg-amber-100 text-amber-900 ring-1 ring-amber-300' : 'bg-white text-stone-800 ring-1 ring-stone-200')}
            title={pos}
          >
            {lineup?.[pos] ?? '–'}
          </div>
        ))}
      </div>
    </figure>
  )
}

/**
 * The preview box: what will be logged, what the paper shows, the remark
 * that will be added (editable), the warnings; or, in plain language, why it
 * cannot be done.
 */
export function PreviewBox({ plan, ctx, children, remark, onRemarkChange }) {
  const t = ctx.t
  const failed = !!plan?.error
  return (
    <section aria-live="polite" className="rounded-xl border border-stone-200 bg-stone-50/70 p-3.5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500 mb-2">{tr(t, 'corrections.preview.title', 'What changes on the scoresheet')}</h3>
      {!plan ? (
        <p className="text-sm text-stone-500">{tr(t, 'corrections.preview.incomplete', 'Fill in the fields above.')}</p>
      ) : failed ? (
        <FormError>{errorText(plan, t)}</FormError>
      ) : (
        <div className="space-y-2.5">
          {/* the sentence of the entry; a set-times plan keeps its times object there and shows its own preview */}
          {typeof plan.log?.after === 'string' && plan.log.after && <p className="text-sm font-medium text-stone-900">{plan.log.after}</p>}
          {children}
          {remark !== undefined && remark !== null && (
            <div>
              <label className="block text-xs font-medium text-stone-600 mb-1">{tr(t, 'corrections.preview.remark', 'Remark added to the scoresheet')}</label>
              <Textarea size="sm" rows={3} value={remark} onChange={(e) => onRemarkChange?.(e.target.value)} />
            </div>
          )}
          {plan.notes?.length > 0 && (
            <ul className="space-y-1">
              {plan.notes.map((n, i) => (
                <li key={i} className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">{tr(t, n.key, n.text, n.params)}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

/** Apply an edited remark to a plan (remark line + the autoRemark the undo uses). */
export function withRemark(plan, remark) {
  if (!plan || plan.error || remark == null || !plan.remarkAdd?.length) return plan
  const old = plan.remarkAdd[0]
  if (remark === old) return plan
  return {
    ...plan,
    remarkAdd: remark.trim() ? [remark] : [],
    add: plan.add.map(r => (r.payload?.autoRemark === old ? { ...r, payload: { ...r.payload, autoRemark: remark.trim() ? remark : undefined } } : r))
  }
}

/**
 * The form view of the panel (inline, never a modal over a modal): heading
 * with a back button, the fields, the preview, Cancel / Confirm.
 */
export function CorrectionForm({ title, ctx, onCancel, onConfirm, plan, busy, children, preview, remark, onRemarkChange, confirmLabel, danger = false }) {
  const t = ctx.t
  const blocked = !plan || !!plan.error
  return (
    <Card className="ov-kit">
      <div className="flex items-center gap-2 mb-4">
        <Button variant="ghost" size="md" icon={ArrowLeft} className={cn(HIT, 'w-9 px-0')} onClick={onCancel} aria-label={tr(t, 'corrections.action.back', 'Back')} />
        <h2 className="text-base font-bold text-stone-900">{title}</h2>
      </div>
      <div className="space-y-4">
        {children}
        <PreviewBox plan={plan} ctx={ctx} remark={remark} onRemarkChange={onRemarkChange}>{preview}</PreviewBox>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-stone-100 pt-3">
        <Button variant="secondary" size="lg" onClick={onCancel}>{tr(t, 'corrections.action.cancel', 'Cancel')}</Button>
        <Button variant={danger ? 'danger' : 'positive'} size="lg" disabled={blocked} loading={busy} onClick={() => onConfirm(plan)}>
          {confirmLabel || tr(t, 'corrections.action.confirm', 'Confirm')}
        </Button>
      </div>
    </Card>
  )
}

/** A card of the panel: heading, one "+ Add …" action, the list. */
export function SectionCard({ title, count, action, children, hint }) {
  return (
    <Card className="ov-kit" pad="default">
      <CardHeading
        title={count != null ? <span>{title} <span className="ml-1 rounded-full bg-stone-100 px-2 py-0.5 text-xs font-semibold text-stone-600 tabular-nums">{count}</span></span> : title}
        hint={hint}
        actions={action}
      />
      {children}
    </Card>
  )
}

export function EmptyLine({ children }) {
  return <p className="py-2 text-sm text-stone-500">{children}</p>
}
