// Headings that group lists. Ported from svrz_rc.
//
//   SectionHeader - a name on a dark rule, count on the right (GameRow.tsx:292-318).
//                   The default for grouping rows on a page. Never a filled card.
//   SectionNote   - the one-line explanation under it (App.tsx:7372, 7393).
//   ListHeader    - sticky column header inside a framed list (App.tsx:8066, 8425).
//   GroupBand     - full-width grey band between groups in a framed list (App.tsx:8956, 9047).
//   DayHeader     - date sub-heading in a framed calendar list (App.tsx:9125).
//   Eyebrow       - small grey caps label over a block of cards (RcMeetingsHome.tsx:37).
//   ShowMoreToggle- "Show past (n)" disclosure under a list (App.tsx:7568-7576).
import { ChevronDown } from 'lucide-react';
import { cn } from './cn.js';
import { FOCUS_RING } from './Button.jsx';
import { TONE_TEXT } from './tones.js';

// TONE_TEXT (GameRow.tsx:34-40) is shared from tones.js.

export function SectionHeader({ icon, title, count, tone = 'stone', hint, action, as: Tag = 'h3', className }) {
  return (
    <div className={cn('flex items-center justify-between gap-2 border-b-[1.5px] border-stone-800 pb-1.5', className)}>
      <Tag className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-stone-800">
        {icon && <span className={cn('flex items-center', TONE_TEXT[tone])}>{icon}</span>}
        {title}
        {hint}
      </Tag>
      <span className="flex shrink-0 items-center gap-2">
        {count !== undefined && count !== null && (
          <span className="text-[11px] font-semibold tabular-nums text-stone-500">{count}</span>
        )}
        {action}
      </span>
    </div>
  );
}

export function SectionNote({ className, children }) {
  return <p className={cn('mt-1.5 text-xs text-stone-500', className)}>{children}</p>;
}

/** columns: array of nodes. With 2 columns it is the Games-tab grid
 *  (grid-cols-[1fr_auto]); otherwise a flex line whose first cell grows. */
export function ListHeader({ columns, className }) {
  const base = 'sticky top-0 z-10 bg-stone-50 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-stone-500 border-b border-stone-200';
  if (columns.length === 2) {
    return (
      <div className={cn(base, 'grid grid-cols-[1fr_auto] items-center gap-2', className)}>
        <span>{columns[0]}</span>
        <span>{columns[1]}</span>
      </div>
    );
  }
  return (
    <div className={cn(base, 'flex items-center gap-4', className)}>
      {columns.map((c, i) => <span key={i} className={i === 0 ? 'flex-1' : undefined}>{c}</span>)}
    </div>
  );
}

/** A sortable column label for ListHeader. App.tsx:8067-8068 */
export function SortLabel({ active, asc, onClick, children, className }) {
  return (
    <button type="button" onClick={onClick} className={cn('cursor-pointer select-none uppercase rounded-sm', FOCUS_RING, className)}>
      {children}{active ? (asc ? ' ▲' : ' ▼') : ''}
    </button>
  );
}

export function GroupBand({ title, count, right, topBorder = false, className }) {
  return (
    <div className={cn(
      'px-4 py-2 bg-stone-100 text-xs font-bold uppercase text-stone-500 border-b border-stone-200',
      topBorder && 'border-t',
      right && 'flex items-center justify-between',
      className,
    )}>
      {right ? (
        <>
          <span>{title}{count != null && ` (${count})`}</span>
          {right}
        </>
      ) : (
        <>{title}{count != null && ` (${count})`}</>
      )}
    </div>
  );
}

export function DayHeader({ className, children }) {
  return <div className={cn('px-3 py-2 border-b bg-stone-50 text-sm font-semibold text-stone-700', className)}>{children}</div>;
}

export function Eyebrow({ as: Tag = 'h3', className, children }) {
  return <Tag className={cn('text-[11px] font-semibold uppercase tracking-wide text-stone-400', className)}>{children}</Tag>;
}

export function ShowMoreToggle({ open, onToggle, showLabel, hideLabel, className }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={cn('mt-1.5 inline-flex items-center gap-1.5 rounded text-xs font-medium text-stone-500 transition-colors hover:text-stone-800', FOCUS_RING, className)}
    >
      <ChevronDown size={13} className={cn('transition-transform', open && 'rotate-180')} />
      {open ? hideLabel : showLabel}
    </button>
  );
}

/** Same component under svrz_rc's own name (GameRow.tsx `SectionHead`). */
export const SectionHead = SectionHeader;

export default SectionHeader;
