// Row anatomy for flat lists, ported from svrz_rc src/components/GameRow.tsx.
//
//   RowList  - the container. It owns the hairlines between rows (GameRow.tsx:323-325).
//   Row      - one item: [leading rail] [2px tone stripe] [body: title / meta / chips / location / children]
//              [status top-right], then optional `tools` line and `action` (GameRow.tsx:385-469).
//   DateRail - the leading "when + what level" column (GameRow.tsx:112-150).
//   RowRail  - the 2px coloured stripe between rail and body (GameRow.tsx:156-158).
//   PairTitle- two-line title: primary over secondary, e.g. home over away (GameRow.tsx:169-219).
//   SimpleRow- the admin-console row: text block left, one button right (AdminConsole.tsx:4744-4766).
//   (Skeleton rows in the same shape: SkeletonRows / RowListSkeleton in Skeleton.jsx.)
//
// Tone lives on the rail and the date text, never on a filled box.
import { MapPin } from 'lucide-react';
import { cn } from './cn.js';
import { FOCUS_RING } from './Button.jsx';
import { TONE_TEXT, TONE_RAIL } from './tones.js';

// Tones (GameRow.tsx:23-48) live in tones.js: red = the user's own upcoming
// work, amber = outstanding, sky = special kind, emerald = filed/done, stone = neutral.
const ROW_TONE_TEXT = TONE_TEXT;
const ROW_TONE_RAIL = TONE_RAIL;

/** Attention wash + 1px ring for ONE row that needs a look (BoerseNote.tsx:29-36).
 *  Use on Row's className. Not the tone channel - a second meaning there is unreadable. */
export const ROW_WASH = {
  red: 'rounded-md bg-red-50/70 shadow-[0_0_0_1px_rgb(252_165_165)]',
  amber: 'rounded-md bg-amber-50/70 shadow-[0_0_0_1px_rgb(252_211_77)]',
  sky: 'rounded-md bg-sky-50/70 shadow-[0_0_0_1px_rgb(125_211_252)]',
};

/** List container. `framed` = the bordered box the Games/Coachees tabs use
 *  (App.tsx:8052, 8418); otherwise the bare hairline list under a SectionHead
 *  (App.tsx:7377). `soft` = stone-100 hairlines for lists inside a card
 *  (AdminConsole.tsx:4727, Skeleton.tsx:16, App.tsx:10751). */
export function RowList({ framed = false, soft = false, className, children, ...rest }) {
  const list = (
    <div className={cn('divide-y', soft ? 'divide-stone-100' : 'divide-stone-200', !framed && className)} {...rest}>
      {children}
    </div>
  );
  return framed ? <div className={cn('border border-stone-200 rounded', className)}>{list}</div> : list;
}

/** Leading column: weekday / date / time / small meta lines, right-aligned.
 *  GameRow.tsx:129-147. Pass `top`, `main`, `sub`, `extra`, `foot` for non-date rails. */
export function DateRail({ weekday, date, time, league, foot, tone = 'stone', className }) {
  return (
    <div className={cn('w-14 shrink-0 text-right leading-tight sm:w-[4.5rem]', className)}>
      {weekday && <div className="text-[10px] font-semibold uppercase tracking-wide text-stone-400">{weekday}</div>}
      <div className={cn('text-sm font-bold tabular-nums tracking-tight sm:text-[15px]', ROW_TONE_TEXT[tone])}>{date}</div>
      {time && <div className="text-[11px] tabular-nums text-stone-500">{time}</div>}
      {league && <div className="mt-0.5 text-[10.5px] font-medium leading-snug text-stone-500 sm:text-[11px]">{league}</div>}
      {foot && <div className="mt-0.5 text-[10px] tabular-nums leading-snug text-stone-400">{foot}</div>}
    </div>
  );
}

/** The 2px tone stripe. GameRow.tsx:156-158 */
export function RowRail({ tone = 'stone' }) {
  return <div className={cn('w-[2px] shrink-0 self-stretch rounded-full', ROW_TONE_RAIL[tone])} aria-hidden />;
}

/** Primary line over a quieter secondary line, each with an optional trailing
 *  aside (score, set points). Collapses to one column below sm. GameRow.tsx:203-218 */
export function PairTitle({ primary, secondary, primaryAside, secondaryAside, className }) {
  return (
    <div className={cn('grid min-w-0 grid-cols-1 items-baseline gap-x-2', 'sm:grid-cols-[minmax(0,1fr)_auto]', className)}>
      <p className="order-1 min-w-0 text-sm font-semibold leading-snug break-words text-stone-900 sm:text-[15px]">{primary}</p>
      {secondary != null && (
        <p className="order-2 min-w-0 text-sm leading-snug break-words text-stone-600 sm:order-3 sm:text-[15px]">{secondary}</p>
      )}
      <div className="order-3 mt-1.5 sm:order-2 sm:mt-0">{primaryAside}</div>
      <div className="order-4">{secondaryAside}</div>
    </div>
  );
}

const INTERACTIVE =
  'cursor-pointer rounded-md transition-colors hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60'; // GameRow.tsx:423

/**
 * One list item, drawn the same way in every list.
 *
 * Props
 *  - leading  : node for the left rail (usually <DateRail/>). Omit for a rail-less row.
 *  - tone     : colours the stripe (and DateRail if you pass the same tone to it).
 *  - stripe   : false hides the 2px RowRail.
 *  - title    : node or string (string -> semibold stone-900 line). Or use <PairTitle/>.
 *  - meta     : secondary line(s) in small stone text.
 *  - chips    : <Chip/>s, wrapped as blocks under the title (GameRow.tsx:403).
 *  - location : string -> map link line (GameRow.tsx:404-417). `mapsUrl` overrides the link.
 *  - status   : top-right indicator (chevron, dot, badge). NOT a control (GameRow.tsx:354, 397).
 *  - action   : one real control - beside the row from sm, full-width line under it on phones (GameRow.tsx:462-466).
 *  - tools    : the row's own toolbar line (labelled buttons) under the body (GameRow.tsx:454-461).
 *  - onOpen   : makes the body a div[role=button]; without it the row is inert text.
 *  - selected : the one OPEN row (its expansion or detail pane is showing) -> rounded-md bg-red-50
 *               (App.tsx:8102, 8436). This is the style's single named exception to "red never
 *               marks selection" and "state is never a filled row" (SKILL.md §3 Rows). Use it
 *               only for "this row is open", never for multi-select or a checked state.
 *  - toolsIndent / actionIndent: left padding that lines the line up with the body;
 *    defaults match a DateRail row (sm:pl-[6.625rem], pl-[4.25rem]). Set to 'sm:pl-2' / 'pl-1.5' for rail-less rows.
 */
export function Row({
  leading, tone = 'stone', stripe = true, title, meta, chips, location, mapsUrl, children,
  status, action, tools, onOpen, selected = false, label, className,
  toolsIndent = 'sm:pl-[6.625rem]', actionIndent = 'pl-[4.25rem]', ...rest
}) {
  const body = (
    <>
      {leading}
      {stripe && <RowRail tone={tone} />}
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            {typeof title === 'string'
              ? <p className="text-sm font-semibold leading-snug break-words text-stone-900 sm:text-[15px]">{title}</p>
              : title}
            {meta && (
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-stone-500">{meta}</div>
            )}
          </div>
          {status && <span className="mt-0.5 flex shrink-0 items-center gap-1.5">{status}</span>}
        </div>
        {chips && <div className="mt-1.5 flex flex-wrap items-stretch gap-1.5">{chips}</div>}
        {location && (
          <p className="mt-1 flex items-start gap-1.5 text-xs">
            <MapPin size={12} className="mt-0.5 shrink-0 text-red-400" />
            <a
              href={mapsUrl || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="break-words text-red-500 underline decoration-red-300 transition-colors hover:text-red-700 hover:decoration-red-500"
            >
              {location}
            </a>
          </p>
        )}
        {children}
      </div>
    </>
  );

  const bodyBase = 'flex min-w-0 flex-1 basis-0 items-stretch gap-2.5 px-1.5 py-2.5 text-left sm:gap-3 sm:px-2';

  return (
    <div className={cn('flex flex-wrap items-stretch py-0.5', selected && 'rounded-md bg-red-50', className)} {...rest}>
      {onOpen ? (
        // div[role=button], not <button>: links and controls may sit inside.
        <div
          role="button"
          tabIndex={0}
          aria-label={label}
          aria-current={selected || undefined}
          onClick={onOpen}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
          }}
          className={cn(bodyBase, INTERACTIVE)}
        >
          {body}
        </div>
      ) : (
        <div className={bodyBase}>{body}</div>
      )}
      {tools && (
        <div className={cn('flex basis-full items-center gap-1.5 px-1.5 pb-2.5 sm:gap-2 sm:pr-2', toolsIndent)}>{tools}</div>
      )}
      {action && (
        <div className={cn('flex basis-full items-center pb-2 pr-1.5 sm:basis-auto sm:pb-0 sm:pl-2 sm:pr-2', actionIndent)}>{action}</div>
      )}
    </div>
  );
}

/** Row toolbar button (labelled, equal-width on phones). App.tsx:7021.
 *  `primary` = the dark lead button (App.tsx:7104-7108). */
export function RowTool({ primary = false, className, children, ...rest }) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-8 flex-1 basis-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-1.5 text-[11px] font-medium transition-colors sm:flex-none sm:basis-auto sm:px-3 sm:text-xs',
        FOCUS_RING,
        primary ? 'bg-slate-900 text-white hover:bg-slate-800' : 'border border-stone-300 bg-white text-stone-600 hover:bg-stone-50',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Admin-console row: text block + one trailing button, no rail.
 *  AdminConsole.tsx:4744-4766 (inside a `RowList soft`). */
export function SimpleRow({ title, titleExtra, meta, trailing, className }) {
  return (
    <div className={cn('py-2 flex items-center gap-3', className)}>
      <div className="flex-1 min-w-0">
        <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-stone-800">
          <span className="truncate">{title}</span>
          {titleExtra}
        </p>
        {meta && <p className="text-xs text-stone-400 truncate">{meta}</p>}
      </div>
      {trailing && <div className="shrink-0">{trailing}</div>}
    </div>
  );
}

/** Expansion panel inside an open row (pass it as a `Row` child). App.tsx:8175-8178.
 *  svrz_rc writes `-mx-3 -mb-2.5 ... px-3` because its row there is padded `px-3 py-2.5`;
 *  the kit Row body is `px-1.5 py-2.5 sm:px-2`, so the margins here cancel that padding
 *  instead and the panel ends flush with the row (and inside a selected row's red-50). */
export function RowExpansion({ className, children }) {
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className={cn('-mx-1.5 -mb-2.5 mt-2.5 cursor-default border-t border-stone-200 bg-stone-50 px-1.5 py-2.5 sm:-mx-2 sm:px-2', className)}
    >
      {children}
    </div>
  );
}

// Skeleton rows: see SkeletonRows (alias RowListSkeleton) in Skeleton.jsx.

/** Footer pager for a framed list. App.tsx:8330-8338 */
export function ListPager({ total, page, pageCount, onPrev, onNext, unit = 'entries' }) {
  return (
    <div className="flex items-center justify-between px-3 py-2 text-xs text-stone-500 border-t border-stone-200">
      <span>{total} {unit}</span>
      <div className="flex items-center gap-2">
        <button type="button" disabled={page === 0} onClick={onPrev} className={cn('px-2 py-1 border rounded disabled:opacity-30 hover:bg-stone-50', FOCUS_RING)} aria-label="Previous page">&laquo;</button>
        <span className="tabular-nums">{page + 1} / {pageCount}</span>
        <button type="button" disabled={page + 1 >= pageCount} onClick={onNext} className={cn('px-2 py-1 border rounded disabled:opacity-30 hover:bg-stone-50', FOCUS_RING)} aria-label="Next page">&raquo;</button>
      </div>
    </div>
  );
}

export default Row;
