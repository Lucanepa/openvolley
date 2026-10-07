import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import { cn } from '../../ui'

export const EYEBROW = 'text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400'

export function useRoleLabels() {
  const { t } = useTranslation()
  return {
    main: t('connectTablets.role.main', 'Scoretable'),
    referee: t('connectTablets.role.referee', 'Referee'),
    bench_home: t('connectTablets.role.bench_home', 'Home bench'),
    bench_away: t('connectTablets.role.bench_away', 'Away bench'),
    livescore: t('connectTablets.role.livescore', 'Livescore')
  }
}

/** "1 · How tablets connect": a step's number and name over its column. */
export function StepHeading({ n, children, id }) {
  return (
    <h3 id={id} className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-stone-800">
      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-900 text-[11px] font-bold text-white tabular-nums" aria-hidden="true">{n}</span>
      <span className="sr-only">{n} · </span>
      {children}
    </h3>
  )
}

// A live state's dot. Always next to words: the dot itself is decoration.
const DOT = {
  connected: 'bg-emerald-500',
  many: 'bg-amber-500',
  waiting: 'border-2 border-stone-400 bg-white',
  remote: 'bg-sky-500',
  nopin: 'bg-amber-500',
  off: 'bg-stone-300',
  unknown: 'bg-stone-300',
  public: 'bg-stone-300'
}

export function StatusLine({ status, children, className, testId }) {
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5 text-xs', className)} data-testid={testId} data-status={status}>
      <span aria-hidden="true" className={cn('inline-block h-2 w-2 shrink-0 rounded-full', DOT[status] || DOT.unknown)} />
      <span className="min-w-0">{children}</span>
    </span>
  )
}

/** A text button that shows or hides what follows it. */
export function Disclosure({ label, openLabel, children, className, buttonClassName, defaultOpen = false, testId, contentClassName }) {
  const [open, setOpen] = useState(defaultOpen)
  const id = useId()
  return (
    <div className={className} data-testid={testId}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(o => !o)}
        className={cn('inline-flex items-center gap-1 rounded text-xs font-medium text-stone-600 hover:text-stone-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 focus-visible:ring-offset-1', buttonClassName)}
      >
        <ChevronDown size={14} aria-hidden="true" className={cn('transition-transform', open && 'rotate-180')} />
        {open && openLabel ? openLabel : label}
      </button>
      {open && <div id={id} className={contentClassName ?? 'mt-2'}>{children}</div>}
    </div>
  )
}

/**
 * Arrow keys in a radio group of buttons: move the choice to the next or
 * previous item (and focus it), as native radios do.
 */
export function radioKeyDown(e, ids, current, select) {
  const keys = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }
  const step = keys[e.key]
  if (!step) return
  e.preventDefault()
  const i = Math.max(0, ids.indexOf(current))
  const next = ids[(i + step + ids.length) % ids.length]
  select(next)
  const group = e.currentTarget.closest('[role="radiogroup"]')
  group?.querySelector(`[data-radio-id="${next}"]`)?.focus()
}
