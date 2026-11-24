// Stat / metric surfaces. Ported from svrz_rc.
//
//   StatTile     - label / big tabular number / sub line (+ delta pill, sparkline) (StatsCharts.tsx:459-481).
//   StatGrid     - 2-up on phones, 4-up from lg (SeasonProgress.tsx:46-52).
//   SummaryStrip - ONE line "<big n> of <goal> done" + secondary counts + ProgressBar + footnote,
//                  instead of three tiles (App.tsx:7304-7356).
//   VerdictTile  - count whose colour IS the verdict: green at zero, amber above (AdminConsole.tsx:1805-1818).
//   MetricCard   - card with title+hint left and a hero figure right, body below (BudgetCard.tsx:135-147).
import { cn } from './cn.js';

export function StatTile({ label, value, sub, delta, deltaLabel, hero = false, spark, className }) {
  return (
    <div className={cn('rounded-xl border border-stone-200/70 bg-white px-3 py-2.5 min-w-0', className)}>
      <div className="text-[11px] text-stone-500 leading-tight">{label}</div>
      <div className={cn(hero ? 'text-3xl' : 'text-2xl', 'font-semibold text-stone-800 tabular-nums leading-tight mt-0.5')}>{value}</div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-stone-500 min-h-[1rem] leading-tight">
        {sub && <span>{sub}</span>}
        {delta && (
          <span className="inline-flex items-center rounded-full bg-stone-100 px-1.5 py-px text-[10px] font-medium text-stone-600 tabular-nums" title={deltaLabel}>
            {delta}
          </span>
        )}
      </div>
      {spark}
    </div>
  );
}

export function StatGrid({ className, children }) {
  return <div className={cn('grid grid-cols-2 lg:grid-cols-4 gap-2', className)}>{children}</div>;
}

/**
 * value/goal headline with a thin bar. `right` = muted secondary counts (wrap
 * the outstanding part in <span className="text-amber-700">). `foot` / `footRight` = the line under the bar.
 */
export function SummaryStrip({ value, suffix, right, max, complete, foot, footRight, className }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : (value > 0 ? 100 : 3);
  const done = complete ?? (max > 0 && value >= max);
  return (
    <div className={cn('rounded-lg border border-stone-200 bg-white px-3 py-2.5', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-semibold text-stone-800">
          <span className="text-base font-bold text-red-600 tabular-nums">{value}</span>
          {suffix}
        </p>
        {right && <p className="text-xs tabular-nums text-stone-500">{right}</p>}
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-stone-200">
        <div className={cn('h-full rounded-full transition-all', done ? 'bg-green-600' : 'bg-red-600')} style={{ width: `${pct}%` }} />
      </div>
      {(foot || footRight) && (
        <div className="mt-1.5 flex items-baseline justify-between gap-3 text-xs">
          <span className={done ? 'font-medium text-green-700' : 'text-stone-500'}>{foot}</span>
          {footRight && <span className="text-right text-stone-500">{footRight}</span>}
        </div>
      )}
    </div>
  );
}

export function VerdictTile({ label, n, note }) {
  return (
    <div className={cn('rounded-lg border px-3 py-2 min-w-[9rem]', n === 0 ? 'border-green-100 bg-green-50' : 'border-amber-200 bg-amber-50')}>
      <p className={cn('text-lg font-semibold leading-tight tabular-nums', n === 0 ? 'text-green-700' : 'text-amber-800')}>{n}</p>
      <p className="text-[11px] text-stone-600 leading-tight">{label}</p>
      {note && <p className="text-[10px] text-stone-400 leading-tight mt-0.5">{note}</p>}
    </div>
  );
}

/** heroLabel / heroValue on the right; `danger` turns both red-700 (over budget). */
export function MetricCard({ title, hint, heroLabel, heroValue, danger = false, className, children }) {
  return (
    <div className={cn('bg-white rounded-2xl shadow-card border border-stone-200/70 p-4 sm:p-5 mb-4', className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-stone-700">{title}</h2>
          {hint && <p className="text-xs text-stone-400 mt-0.5 max-w-xl">{hint}</p>}
        </div>
        {heroValue != null && (
          <div className="text-right">
            <p className={cn('text-[11px] font-semibold uppercase tracking-wide', danger ? 'text-red-700' : 'text-stone-400')}>{heroLabel}</p>
            <p className={cn('text-2xl font-bold tabular-nums', danger ? 'text-red-700' : 'text-stone-900')}>{heroValue}</p>
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

export default StatTile;
