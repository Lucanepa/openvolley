// Tables for homogeneous records with numeric columns. Ported from svrz_rc.
//
//   Table header styles, pick ONE per table:
//     'quiet'  - xs stone-500 semibold, sentence case (FinanceChair.tsx:56-60)
//     'caps'   - 11px bold uppercase tracking-wide stone-500 (AdminConsole.tsx:2720-2726)
//     'compact'- 10px->11px uppercase stone-400, tightened for phones (AdminConsole.tsx:5356-5363)
//   Numeric cells: text-right tabular-nums; the column header is text-right too.
//   Row lines: border-b border-stone-100 last:border-0, or tbody divide-y divide-stone-100.
//   Hover (only when a row does something): hover:bg-stone-50/70; open row: bg-stone-50/70 (AdminConsole.tsx:5370).
//   Wrap in overflow-x-auto. A table that cannot fit a phone gets a card list below sm/lg instead
//   (AdminConsole.tsx:2680 sm:hidden cards + 2716 hidden sm:block table; 1547 hidden lg:block).
import { cn } from './cn.js';

const HEAD = {
  quiet: 'border-b border-stone-200 text-left text-xs text-stone-500',
  caps: 'text-[11px] font-bold uppercase tracking-wide text-stone-500 border-b border-stone-200',
  compact: 'text-left text-[10px] sm:text-[11px] uppercase tracking-tight sm:tracking-wide text-stone-400 border-b border-stone-200',
};

/** columns: [{ key, label, numeric?, title?, className?, cellClassName? }]
 *  rows: array of records; render(row, col) -> cell content (default row[col.key]).
 *  rowKey(row) -> key. onRowClick makes rows hoverable; isOpen(row) marks the open row. */
export function Table({ columns, rows, render, rowKey, head = 'quiet', onRowClick, isOpen, className }) {
  const last = columns.length - 1;
  const pad = head === 'compact' ? 'pr-1.5 sm:pr-3' : 'pr-3';
  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="w-full text-sm">
        <thead>
          <tr className={HEAD[head] || HEAD.quiet}>
            {columns.map((c, i) => (
              <th
                key={c.key}
                title={c.title}
                className={cn('py-2', i !== last && pad, head === 'caps' ? 'font-bold' : 'font-semibold', c.numeric ? 'text-right' : 'text-left', c.className)}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr
              key={rowKey ? rowKey(r) : ri}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              className={cn(
                'border-b border-stone-100 last:border-0',
                onRowClick && 'cursor-pointer hover:bg-stone-50/70 transition-colors',
                isOpen && isOpen(r) && 'bg-stone-50/70',
              )}
            >
              {columns.map((c, i) => (
                <td
                  key={c.key}
                  className={cn(
                    'py-2',
                    i !== last && pad,
                    c.numeric ? 'text-right tabular-nums text-stone-600 whitespace-nowrap' : 'text-stone-800',
                    c.cellClassName,
                  )}
                >
                  {render ? render(r, c) : r[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default Table;
