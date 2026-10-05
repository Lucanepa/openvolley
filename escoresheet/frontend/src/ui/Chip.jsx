// Chips, marks and count badges. Ported from svrz_rc.
//
//   Chip      - one fact about a row, square-cornered, bordered (GameRow.tsx:221-270 "MetaChip").
//   MarkRow   - line of marks under a name inside a stacked chip (GameRow.tsx:275-277).
//   ChipLine  - forces a chip onto its own line in the chips row (GameRow.tsx:282-284).
//   Mark      - 9px uppercase micro-mark that rides after a name (CoacheeChips.tsx:3, GameMarks.tsx:92).
//   AlertMark - red "in exchange" style mark (BoerseNote.tsx:46-53).
//   CountBadge- the round count next to a card heading (AdminConsole.tsx:5626).
import { cn } from './cn.js';
import { CHIP_BASE, CHIP_TONE, CHIP_WRAP, MICRO_BADGE } from './tones.js';

// Tones and the base recipe come from tones.js (GameRow.tsx:221-253):
//   stone · me · urgent (svrz "boerse") · indigo (svrz "rc") · sky · amber ·
//   emerald · dark · violet · ghost. `alert` and `rc` are accepted as aliases.
const TONE_ALIAS = { alert: 'urgent', boerse: 'urgent', rc: 'indigo' };

/** wrap: allow a long person name to wrap. stack: children are lines (name, then MarkRow). */
export function Chip({ tone = 'stone', title, wrap = false, stack = false, className, children }) {
  return (
    <span
      title={title}
      className={cn(
        CHIP_BASE,
        wrap && CHIP_WRAP,
        stack && 'flex-col items-start gap-1',
        CHIP_TONE[TONE_ALIAS[tone] ?? tone] || CHIP_TONE.stone,
        className,
      )}
    >
      {children}
    </span>
  );
}

export function MarkRow({ children }) {
  return <span className="flex flex-wrap gap-1 [&>*]:ml-0">{children}</span>;
}

export function ChipLine({ children }) {
  return <span className="flex basis-full">{children}</span>;
}

const MARK_TONE = {
  amber: 'text-amber-800 border border-amber-200 bg-amber-100',  // highlight (CoacheeChips.tsx:10)
  amberSoft: 'text-amber-800 border border-amber-200 bg-amber-50', // info (CoacheeChips.tsx:28)
  emerald: 'border border-emerald-200 bg-emerald-50 text-emerald-800', // done (GameMarks.tsx:92)
  stone: 'text-stone-500 border border-stone-200 bg-stone-50',  // AdminConsole.tsx:1800
};

/** Inline after text: keeps its ml-1.5. Inside MarkRow the margin is removed. */
export function Mark({ tone = 'amber', title, className, children }) {
  return (
    <span
      title={title}
      className={cn(MICRO_BADGE, MARK_TONE[tone] || MARK_TONE.amber, className)}
    >
      {children}
    </span>
  );
}

export function AlertMark({ children }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-red-100 px-1.5 text-[10px] font-bold uppercase tracking-wide text-red-800">
      <span aria-hidden>⚠</span>
      {children}
    </span>
  );
}

const COUNT_TONE = {
  amber: 'bg-amber-100 text-amber-800',
  stone: 'bg-stone-100 text-stone-600',
  red: 'bg-red-50 text-red-700',
};

export function CountBadge({ tone = 'amber', className, children }) {
  return <span className={cn('rounded-full text-xs font-semibold px-2 py-0.5 tabular-nums', COUNT_TONE[tone] || COUNT_TONE.amber, className)}>{children}</span>;
}

export default Chip;
