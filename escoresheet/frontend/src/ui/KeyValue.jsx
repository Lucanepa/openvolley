// Key-value / definition lists. Ported from svrz_rc. Always a real <dl>.
//
//   variant 'split'   - label left, value right-aligned; numbers tabular (StatisticsAdmin.tsx:163-173).
//   variant 'detail'  - label left, value right, value wraps; inside an expanded row (App.tsx:8183-8209).
//   variant 'summary' - 1/3 label, 2/3 value, on a sunken band at the top of a sheet (App.tsx:10505-10519).
//   variant 'stats'   - small label over value, 2-3 columns of facts (AdminConsole.tsx:4865-4880).
//   variant 'stacked' - label over long free text, one per block (AdminConsole.tsx:3540-3547).
//   LedgerLine        - money/amount line: label + muted detail, amount right (BudgetCard.tsx:124-132).
import { Fragment } from 'react';
import { cn } from './cn.js';

/** items: [{ label, value, tone?: 'danger' | 'strong' }] */
export function KeyValue({ items, variant = 'split', className }) {
  const valueTone = (t) => (t === 'danger' ? 'text-red-700 font-semibold' : t === 'strong' ? 'font-semibold' : '');

  if (variant === 'stats') {
    return (
      <dl className={cn('grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3', className)}>
        {items.map((it) => (
          <div key={String(it.label)}>
            <dt className="text-stone-400">{it.label}</dt>
            <dd className={cn('text-stone-700', valueTone(it.tone))}>{it.value}</dd>
          </div>
        ))}
      </dl>
    );
  }

  if (variant === 'stacked') {
    return (
      <dl className={cn('flex flex-col gap-3', className)}>
        {items.map((it) => (
          <div key={String(it.label)}>
            <dt className="text-xs text-stone-400 leading-snug">{it.label}</dt>
            <dd className="text-sm text-stone-800 whitespace-pre-wrap mt-0.5">{it.value}</dd>
          </div>
        ))}
      </dl>
    );
  }

  if (variant === 'summary') {
    return (
      <dl className={cn('px-5 py-4 grid grid-cols-3 gap-x-3 gap-y-2 text-sm border-b border-stone-200 bg-stone-50/60', className)}>
        {items.map((it) => (
          <Fragment key={String(it.label)}>
            <dt className="col-span-1 text-stone-500">{it.label}</dt>
            <dd className={cn('col-span-2 text-stone-800 break-words', valueTone(it.tone))}>{it.value}</dd>
          </Fragment>
        ))}
      </dl>
    );
  }

  if (variant === 'detail') {
    return (
      <dl className={cn('grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs', className)}>
        {items.map((it) => (
          <Fragment key={String(it.label)}>
            <dt className="text-stone-500">{it.label}</dt>
            <dd className={cn('m-0 break-words text-right', it.tone === 'danger' ? 'font-medium text-red-600' : 'text-stone-800')}>{it.value}</dd>
          </Fragment>
        ))}
      </dl>
    );
  }

  // 'split'
  return (
    <dl className={cn('grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 text-xs', className)}>
      {items.map((it) => (
        <Fragment key={String(it.label)}>
          <dt className="text-stone-500 leading-snug">{it.label}</dt>
          <dd className={cn('text-stone-800 font-medium tabular-nums text-right leading-snug', valueTone(it.tone))}>{it.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** Link value inside a 'detail' list (tel:/mailto:). App.tsx:8192, 8200 */
export function KvLink({ href, children }) {
  return <a href={href} className="font-medium text-red-600 hover:underline">{children}</a>;
}

/** One ledger line. Wrap several in <div className="divide-y divide-stone-100 border-t border-stone-100">.
 *  `total` = the closing line (BudgetCard.tsx:203-206). `minus` prefixes "− " to positive amounts. */
export function LedgerLine({ label, detail, amount, minus = false, total = false, danger = false, className }) {
  // svrz prints "− " only when the subtracted amount is above zero (BudgetCard.tsx:130);
  // pass `minus` accordingly and `amount` already formatted (e.g. chf(n)).
  const shown = minus ? `− ${amount}` : amount;
  return (
    <div className={cn('flex items-baseline justify-between gap-3', total ? 'py-2' : 'py-1.5', className)}>
      <span className="min-w-0">
        <span className={total ? 'text-sm font-semibold text-stone-900' : 'text-sm text-stone-700'}>{label}</span>
        {detail && <span className="ml-2 text-xs text-stone-400">{detail}</span>}
      </span>
      <span className={cn(
        'text-sm tabular-nums whitespace-nowrap',
        total ? 'font-bold' : '',
        danger ? 'text-red-700' : total ? 'text-stone-900' : 'text-stone-700',
      )}>
        {shown}
      </span>
    </div>
  );
}

export default KeyValue;
