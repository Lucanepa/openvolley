// Progress and proportion bars. Ported from svrz_rc.
//
//   ProgressBar - thin single-value bar under a summary line (App.tsx:7328-7333).
//   StackedBar  - budget-style bar: used + committed + free, with a dot legend (BudgetCard.tsx:149-157).
//   BarList     - one labelled horizontal bar per row, value right (StatsCharts.tsx:342-365).
//   ShareBar    - 100% part-to-whole bar with a count/percent legend grid (StatsCharts.tsx:117-140).
// Bars are decoration over numbers that are ALSO printed: aria-hidden on the bar,
// or role="img" with the numbers in aria-label.
import { Fragment } from 'react';
import { cn } from './cn.js';
import { fmtInt } from './format.js'; // de-CH, StatsCharts.tsx:20

const clamp = (n) => Math.max(0, Math.min(100, n));

/** value/max -> width. `complete` switches the fill to green (target reached). */
export function ProgressBar({ value, max, complete, className, label }) {
  const pct = max > 0 ? clamp(Math.round((value / max) * 100)) : (value > 0 ? 100 : 3);
  const done = complete ?? (max > 0 && value >= max);
  return (
    <div
      className={cn('h-1.5 overflow-hidden rounded-full bg-stone-200', className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max || 100}
      aria-valuenow={value}
      aria-label={label}
    >
      <div className={cn('h-full rounded-full transition-all', done ? 'bg-green-600' : 'bg-red-600')} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** segments: [{ key, label, value, className }] in order; total = the whole. Remainder shows as the track.
 *  Defaults mirror BudgetCard: bg-red-600 (used), bg-red-300 (committed), track bg-stone-200 / legend bg-stone-300. */
export function StackedBar({ segments, total, restLabel, className }) {
  let used = 0;
  const widths = segments.map((s) => {
    const w = total > 0 ? Math.min(100 - used, clamp((s.value / total) * 100)) : 0;
    used += w;
    return w;
  });
  return (
    <div className={className}>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-stone-200 flex" aria-hidden>
        {segments.map((s, i) => <div key={s.key} className={cn('h-full', s.className)} style={{ width: `${widths[i]}%` }} />)}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-stone-500">
        {segments.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1"><span className={cn('h-2 w-2 rounded-full', s.className)} />{s.label}</span>
        ))}
        {restLabel && <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-stone-300" />{restLabel}</span>}
      </div>
    </div>
  );
}

/** rows: [{ key, label, sub?, value, hint? }]. color: CSS colour for the fill (svrz SERIES[0] = '#2a78d6'). */
export function BarList({ rows, color = '#2a78d6', format = fmtInt, max: maxIn }) {
  const max = Math.max(1, maxIn ?? Math.max(0, ...rows.map((r) => r.value)));
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.key} className="grid grid-cols-[minmax(0,42%)_1fr_auto] items-center gap-2 text-xs" title={r.hint ?? `${r.label}: ${format(r.value)}`}>
          <span className="min-w-0 leading-tight">
            <span className="block truncate text-stone-700">{r.label}</span>
            {r.sub && <span className="block truncate text-[10px] text-stone-400">{r.sub}</span>}
          </span>
          <span className="h-3 rounded-r-[3px] bg-stone-100 overflow-hidden">
            <span className="block h-full rounded-r-[3px]" style={{ width: `${Math.max(r.value > 0 ? 2 : 0, (r.value / max) * 100)}%`, background: color }} />
          </span>
          <span className="tabular-nums font-medium text-stone-700 min-w-[2.5rem] text-right">{format(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

/** segments: [{ key, label, value, color }]. */
export function ShareBar({ segments, format = fmtInt }) {
  const total = segments.reduce((a, x) => a + x.value, 0);
  if (total === 0) return <p className="text-xs text-stone-400">–</p>;
  const shown = segments.filter((x) => x.value > 0);
  return (
    <div>
      <div className="flex h-5 gap-[2px] overflow-hidden rounded-[4px]" role="img" aria-label={shown.map((x) => `${x.label} ${format(x.value)}`).join(', ')}>
        {shown.map((x) => (
          <span key={x.key} style={{ width: `${(x.value / total) * 100}%`, background: x.color }} title={`${x.label}: ${format(x.value)} (${Math.round((x.value / total) * 100)} %)`} />
        ))}
      </div>
      <div className="mt-2 grid grid-cols-[auto_1fr_auto_auto] items-center gap-x-2 gap-y-1 text-xs">
        {segments.map((x) => (
          <Fragment key={x.key}>
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: x.color }} />
            <span className={x.value > 0 ? 'text-stone-700' : 'text-stone-400'}>{x.label}</span>
            <span className="tabular-nums font-medium text-stone-700 text-right">{format(x.value)}</span>
            <span className="tabular-nums text-stone-400 text-right w-10">{Math.round((x.value / total) * 100)} %</span>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

export default ProgressBar;
