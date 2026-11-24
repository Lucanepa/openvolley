// Card surfaces and the dashboard grid, ported from svrz_rc.
// (Merged from the "surfaces" and "shell" research ports; class strings unchanged.)
//
//   Card        — the page/content card. AdminConsole.tsx:1362-1364,
//                 StatisticsAdmin.tsx:31-33, BudgetCard.tsx:135.
//                 pad: default p-4 sm:p-5 · 'list' p-3 sm:p-6 (App.tsx:6759)
//                      · 'roomy' p-5 (AdminConsole.tsx:3528) · 'flush' none (tables).
//   CardHeader  — title + hint left, key figure right. BudgetCard.tsx:136-147.
//   CardHeading — admin title row: h2 left, actions pushed right, hint under.
//                 AdminConsole.tsx:1719-1727, 3984-3985, 5600 (strong).
//   CardMeta    — the meta strip at the top of a record card. AdminConsole.tsx:3529.
//   CardFooter  — hairline-topped action row. AdminConsole.tsx:1624, 2346.
//   Section     — a card that always carries its own heading. StatisticsAdmin.tsx:36-46.
//   Grid        — 12 columns from lg, one below. StatisticsAdmin.tsx:48-51.
//   Block       — the tinted panel INSIDE a card (never a card in a card).
//                 StatisticsAdmin.tsx:54-66.
//   SplitCard   — flush card with a heading strip and divided columns.
//                 GuidePage.tsx:156-158.
//   HeroCard    — the one big centred card on an auth / gate screen.
//                 AuthGate.tsx:455-456 (with the brand top bar), 398 (without).
//
// Needs the shadow-card / shadow-card-lg utilities from tokens.css
// (svrz_rc index.css:15-16).
import { cn } from './cn.js';

const CARD_PAD = {
  default: 'p-4 sm:p-5',
  list: 'p-3 sm:p-6',
  roomy: 'p-5',
  flush: '',
};

/**
 * @param {object} props
 * @param {'default'|'list'|'roomy'|'flush'} [props.pad='default']
 * @param {boolean} [props.stack=true] mb-4 for cards in a vertical stack; pass
 *   false inside a grid (use gap-3 there).
 * @param {string|import('react').ElementType} [props.as='div']
 */
export function Card({ as: Tag = 'div', pad = 'default', stack = true, className, children, ...rest }) {
  return (
    <Tag
      className={cn(
        'bg-white rounded-2xl shadow-card border border-stone-200/70',
        CARD_PAD[pad] ?? CARD_PAD.default,
        stack && 'mb-4',
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/**
 * Title + optional hint on the left, an optional aside (a key figure, a button
 * group) on the right. Wraps under the title on a phone. BudgetCard.tsx:136-147.
 */
export function CardHeader({ title, hint, aside, className }) {
  return (
    <div className={cn('flex flex-wrap items-baseline justify-between gap-3', className)}>
      <div>
        <h2 className="text-sm font-semibold text-stone-700">{title}</h2>
        {hint && <p className="text-xs text-stone-400 mt-0.5 max-w-xl">{hint}</p>}
      </div>
      {aside && <div className="text-right">{aside}</div>}
    </div>
  );
}

/**
 * The admin card's title row. AdminConsole.tsx:1719-1727.
 * @param {boolean} [props.strong] `text-base font-bold text-stone-900` for a card
 *   that is the page's only subject (AdminConsole.tsx:5600).
 * @param {import('react').ReactNode} [props.icon] 15px lucide icon before the title.
 */
export function CardHeading({ title, hint, actions, strong = false, icon, className }) {
  return (
    <div className={cn('mb-3', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className={cn(strong ? 'text-base font-bold text-stone-900' : 'text-sm font-semibold text-stone-700', icon && 'inline-flex items-center gap-1.5')}>
          {icon}{title}
        </h2>
        {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {hint && <p className="mt-1 text-xs text-stone-400 max-w-prose">{hint}</p>}
    </div>
  );
}

/** The meta strip at the top of a record card (name · date · tags). AdminConsole.tsx:3529. */
export function CardMeta({ className, children }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 pb-3 mb-3 border-b border-stone-100', className)}>
      {children}
    </div>
  );
}

/** Actions or totals below the body, divided by a hairline. AdminConsole.tsx:1624. */
export function CardFooter({ className, children }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 mt-3 pt-3 border-t border-stone-100', className)}>
      {children}
    </div>
  );
}

/** One group of related content: a card with its own heading. StatisticsAdmin.tsx:36-46. */
export function Section({ title, hint, className, children, ...rest }) {
  return (
    <section className={cn('bg-white rounded-2xl shadow-card border border-stone-200/70 p-4 sm:p-5', className)} {...rest}>
      <header className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h2 className="text-sm font-semibold text-stone-800">{title}</h2>
        {hint && <p className="text-xs text-stone-400">{hint}</p>}
      </header>
      {children}
    </section>
  );
}

/** 1 column on phones, 12 from lg. Each Block sets its own `span`. StatisticsAdmin.tsx:48-51. */
export function Grid({ className, children }) {
  return <div className={cn('grid grid-cols-1 lg:grid-cols-12 gap-3 items-stretch', className)}>{children}</div>;
}

/**
 * A tinted panel inside a card: rounded-xl, sunken stone, NO shadow.
 * StatisticsAdmin.tsx:54-66.
 * @param {string} [props.span] lg column span inside a Grid, written out in full
 *   so Tailwind sees it, e.g. 'lg:col-span-5'.
 * @param {import('react').ReactNode} [props.aside] a control top-right (a SegmentedControl, a select).
 */
export function Block({ title, hint, aside, span, className, children, ...rest }) {
  return (
    <div className={cn('rounded-xl border border-stone-200/70 bg-stone-50/60 p-3.5 min-w-0 flex flex-col', span, className)} {...rest}>
      {(title || aside) && (
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            {title && <h3 className="text-xs font-semibold text-stone-700">{title}</h3>}
            {hint && <p className="text-[11px] text-stone-400">{hint}</p>}
          </div>
          {aside}
        </div>
      )}
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

/**
 * Flush card: heading strip, then full-bleed content (columns, a table, media).
 * GuidePage.tsx:156-158. Children own their padding (`p-5`; a muted column
 * adds `bg-stone-50/70`).
 */
export function SplitCard({ title, className, children }) {
  return (
    <section className={cn('mb-8 rounded-2xl bg-white shadow-card border border-stone-200/70 overflow-hidden', className)}>
      {title && <h2 className="px-5 pt-4 pb-3 text-sm font-semibold text-stone-800">{title}</h2>}
      <div className="grid sm:grid-cols-2 border-t border-stone-200/70 divide-y sm:divide-y-0 sm:divide-x divide-stone-200/70">
        {children}
      </div>
    </section>
  );
}

/**
 * The single centred card of a gate screen (login, no-connection, PIN), page
 * included. AuthGate.tsx:453-456. `accent` draws the 4px brand bar along the top.
 * For a gate with logo / eyebrow / corner toggle / footer use GateScreen
 * (ReadingPage.jsx), which is the same card with those slots.
 */
export function HeroCard({ accent = true, className, children }) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-stone-100 via-stone-50 to-stone-100 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className={cn('relative overflow-hidden bg-white rounded-3xl shadow-card-lg border border-stone-200/70 p-8', className)}>
          {accent && <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-red-600 to-red-500" />}
          {children}
        </div>
      </div>
    </div>
  );
}

export default Card;
