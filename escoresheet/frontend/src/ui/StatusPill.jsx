// Status pills and dots. Ported from svrz_rc.
//
//   StatusPill - rounded-full tinted pill, no border, for an item's STATE (App.tsx:3656-3678, 8140-8149).
//   OutlinePill- quiet bordered pill for a label / scope note (AdminConsole.tsx:1535).
//   FlagPill   - bordered amber pill with an icon for a mode flag (AdminConsole.tsx:1224).
//   StatusDot  - coloured dot in a row's status slot, always with a title (App.tsx:3686-3697, 9150-9154).
//   DeltaPill  - tiny change chip on a stat tile (StatsCharts.tsx:476).
import { cn } from './cn.js';

export const STATUS_TONE = {
  done: 'bg-emerald-100 text-emerald-800',
  planned: 'bg-sky-100 text-sky-800',
  todo: 'bg-amber-100 text-amber-800',
  attention: 'bg-orange-100 text-orange-800',
  neutral: 'bg-stone-100 text-stone-600',
  brand: 'bg-red-50 text-red-700',
}; // App.tsx:3665, 3672, 3674, 3677

export function StatusPill({ tone = 'neutral', title, className, children }) {
  return (
    <span title={title} className={cn('inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded-full', STATUS_TONE[tone] || STATUS_TONE.neutral, className)}>
      {children}
    </span>
  );
}

/** A cluster of pills, stacked under the title on phones, right-capped from sm.
 *  Empty -> a pale dash. App.tsx:8140-8149
 *
 *  Place it directly in a sized flex row beside the title (as svrz_rc's game row does):
 *  `sm:max-w-[45%]` measures against that row. In a shrink-to-fit slot such as
 *  SimpleRow `trailing` the percentage has nothing to measure and the pills stack;
 *  pass `fit` there to drop the cap. */
export function StatusPills({ children, empty = '–', fit = false, className }) {
  const has = Array.isArray(children) ? children.some(Boolean) : !!children;
  return (
    <div className={cn('flex flex-wrap items-center gap-1 sm:pt-0.5 sm:shrink-0 sm:justify-end', !fit && 'sm:max-w-[45%]', className)}>
      {has ? children : <span className="text-xs text-stone-300">{empty}</span>}
    </div>
  );
}

export function OutlinePill({ className, children }) {
  return <span className={cn('text-[11px] text-stone-400 border border-stone-200 rounded-full px-2.5 py-1', className)}>{children}</span>;
}

export function FlagPill({ icon, className, children }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full bg-amber-100 border border-amber-300 text-amber-800 text-[11px] font-semibold px-2 py-0.5', className)}>
      {icon}{children}
    </span>
  );
}

export const DOT_TONE = {
  todo: 'bg-yellow-400',
  waiting: 'bg-orange-500',
  done: 'bg-emerald-500',
  none: 'bg-stone-300',
  on: 'bg-green-500',
}; // App.tsx:3686-3697, 9151

/** size 'md' = h-3 w-3 (primary state), 'sm' = h-2.5 w-2.5 (secondary). `title` is required:
 *  a dot never stands alone without words for hover and screen readers. */
export function StatusDot({ tone = 'none', size = 'md', title, className }) {
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      className={cn('inline-block rounded-full', size === 'sm' ? 'h-2.5 w-2.5' : 'h-3 w-3', DOT_TONE[tone] || DOT_TONE.none, className)}
    />
  );
}

export function DeltaPill({ title, children }) {
  return (
    <span className="inline-flex items-center rounded-full bg-stone-100 px-1.5 py-px text-[10px] font-medium text-stone-600 tabular-nums" title={title}>
      {children}
    </span>
  );
}

export default StatusPill;
