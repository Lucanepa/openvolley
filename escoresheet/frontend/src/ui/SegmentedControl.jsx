// SegmentedControl (pick one of 2-5) and FilterPill (toggle filters).
//
// Selection is shown in INVERTED NEUTRAL (slate-900 / white card), never in the
// brand red: red means "act", slate means "chosen".
//
//   track   iOS-style: stone track, white raised segment   StatisticsAdmin.tsx:876-884
//           (role=radiogroup / radio + aria-checked)
//   joined  bordered strip of text segments, slate when on App.tsx:6581-6597 (lg, h-11)
//           NotebookSheet.tsx:452-454 (md, h-9)         (role=group + aria-pressed)
//   icon    h-8 icon-only view switch (list / calendar)  App.tsx:7866-7878
//   pill    white frame, h-7 segments, slate when on    StatisticsAdmin.tsx:590-594 (role switch
//           on a Block aside, slate-900). The DE/EN switch at InfosPage.tsx:115-127 and
//           CoacheeFilePage.tsx:215 uses stone-900; the kit settles on slate-900 for every
//           selected segment (SKILL.md "Reconciled decisions").
//   joined-quiet  fused h-9 buttons, stone-800 when on  AdminConsole.tsx:3986-3996 (Live / History
//           in a card heading). Admin-console variant; prefer `joined` elsewhere.
//
//   FilterPill  rounded-full chip, slate when on        StatisticsAdmin.tsx:867-870
//               row: `flex gap-1.5 overflow-x-auto`      StatisticsAdmin.tsx:892
//   FilterPill shape="square"  h-8 rounded-lg tab-chip  AdminConsole.tsx:5675-5678
import { useRef } from 'react';
import { cn } from './cn.js';
import { FOCUS_RING, FOCUS_RING_INSET, renderIcon } from './Button.jsx';

const COLS = { 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-4', 5: 'grid-cols-5' };

const JOINED = {
  md: {
    // inline-flex: the strip hugs its segments instead of stretching to the row.
    wrap: 'inline-flex flex-wrap rounded-lg border border-stone-300 bg-white shadow-sm overflow-hidden',
    seg: 'px-3 h-9 text-xs font-medium transition-colors',
  },
  lg: {
    wrap: 'flex h-11 shrink-0 rounded-lg border border-stone-300 bg-white shadow-sm overflow-hidden',
    seg: 'flex flex-1 items-center justify-center gap-1.5 px-3 text-sm font-medium transition-colors',
  },
};

/**
 * @param {object} props
 * @param {Array<{value: string, label?: any, icon?: any, title?: string}>} props.options
 * @param {string} props.value
 * @param {(value: string) => void} props.onChange
 * @param {string} props.ariaLabel  name of the group (required: segments alone don't say what they choose).
 *   `label` is accepted as an alias.
 * @param {'track'|'joined'|'joined-quiet'|'pill'|'icon'} [props.variant]
 * @param {'md'|'lg'} [props.size]  joined only
 */
export function SegmentedControl({ options, value, onChange, ariaLabel: ariaLabelProp, label, variant = 'track', size = 'md', className }) {
  const refs = useRef([]);
  const ariaLabel = ariaLabelProp ?? label;

  if (variant === 'track') {
    // Arrow keys move the choice, as a radiogroup should (svrz_rc leaves this to Tab).
    const onKeyDown = (e, i) => {
      const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const next = (i + step + options.length) % options.length;
      onChange(options[next].value);
      refs.current[next]?.focus();
    };
    return (
      <div role="radiogroup" aria-label={ariaLabel} className={cn('grid gap-1 rounded-xl bg-stone-100 p-1', COLS[options.length] ?? 'grid-flow-col auto-cols-fr', className)}>
        {options.map((o, i) => {
          const on = o.value === value;
          return (
            <button
              key={o.value}
              ref={(el) => { refs.current[i] = el; }}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              title={o.title}
              onClick={() => onChange(o.value)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={cn('h-9 rounded-lg px-3 text-xs font-medium whitespace-nowrap transition-colors', FOCUS_RING, on ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-600 hover:bg-stone-200/60', o.icon && 'inline-flex items-center justify-center gap-1.5')}
            >
              {renderIcon(o.icon, 14)}
              {o.label}
            </button>
          );
        })}
      </div>
    );
  }

  if (variant === 'pill' || variant === 'joined-quiet') {
    const pill = variant === 'pill';
    return (
      <div
        role="group"
        aria-label={ariaLabel}
        className={cn(pill ? 'inline-flex rounded-lg border border-stone-200 bg-white p-0.5 text-xs' : 'inline-flex rounded-lg border border-stone-200 overflow-hidden', className)}
      >
        {options.map((o) => {
          const on = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={on}
              title={o.title}
              onClick={() => onChange(o.value)}
              className={pill
                ? cn('h-7 px-2.5 rounded-md text-xs font-semibold transition-colors', FOCUS_RING, on ? 'bg-slate-900 text-white' : 'text-stone-500 hover:text-stone-800')
                : cn('h-9 px-3 text-xs font-medium transition-colors', FOCUS_RING_INSET, on ? 'bg-stone-800 text-white' : 'bg-white text-stone-600 hover:bg-stone-100')}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    );
  }

  if (variant === 'icon') {
    return (
      <div role="group" aria-label={ariaLabel} className={cn('h-8 shrink-0 flex items-center rounded border border-stone-300 p-0.5', className)}>
        {options.map((o) => {
          const on = o.value === value;
          const name = o.title ?? (typeof o.label === 'string' ? o.label : undefined);
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={on}
              aria-label={name}
              title={name}
              onClick={() => onChange(o.value)}
              className={cn('h-full px-2 flex items-center rounded-sm transition-colors', FOCUS_RING_INSET, on ? 'bg-slate-900 text-white' : 'text-stone-400 hover:text-stone-600')}
            >
              {renderIcon(o.icon, 16)}
            </button>
          );
        })}
      </div>
    );
  }

  const j = JOINED[size] ?? JOINED.md;
  return (
    <div role="group" aria-label={ariaLabel} className={cn(j.wrap, className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(j.seg, FOCUS_RING_INSET, on ? 'bg-slate-900 text-white' : 'text-stone-600 hover:bg-stone-50')}
          >
            {renderIcon(o.icon, size === 'lg' ? 16 : 14)}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A filter you switch on and off. Several can be on at once; for "exactly one",
 * use SegmentedControl. Put them in a scrolling row:
 * <div className="flex gap-1.5 overflow-x-auto">…</div>
 * @param {object} props
 * @param {boolean} props.active
 * @param {'pill'|'square'} [props.shape]
 * @param {any} [props.icon]
 * @param {any} [props.count] trailing number in tabular figures
 */
export function FilterPill({ active, shape = 'pill', icon, count, className, children, ...rest }) {
  const cls = shape === 'square'
    ? cn('h-8 px-2.5 rounded-lg border text-xs font-medium transition-colors inline-flex items-center gap-1.5',
        active ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-stone-600 border-stone-200 hover:bg-stone-100')
    : cn('shrink-0 h-9 px-3.5 rounded-full border text-xs font-medium whitespace-nowrap transition-colors',
        icon || count != null ? 'inline-flex items-center gap-1.5' : null,
        active ? 'bg-slate-900 border-slate-900 text-white' : 'bg-white border-stone-200 text-stone-600 hover:bg-stone-100');
  return (
    // Inset ring: FilterPills live in an `overflow-x-auto` row, which clips an outer ring.
    <button type="button" aria-pressed={active} className={cn(cls, FOCUS_RING_INSET, className)} {...rest}>
      {renderIcon(icon, 13)}
      {children}
      {count != null && <span className="tabular-nums opacity-70">{count}</span>}
    </button>
  );
}

/** The shell port's name for the same control. */
export const Segmented = SegmentedControl;

export default SegmentedControl;
