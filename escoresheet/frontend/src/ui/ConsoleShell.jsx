// volleyui — admin console shell: sticky white header, a left rail of
// destinations from lg, the same destinations as a sideways-scrolling bottom
// bar below lg.
// Port of svrz_rc src/components/AdminConsole.tsx:1218-1360.
//
// Use for 6+ destinations, or for any back-office screen. Every panel uses
// the whole window (AdminConsole.tsx:1240) — no max-w on <main>.
import { cn } from './cn.js';
import { FOCUS_RING } from './Button.jsx';

/** Header button, outlined (AdminConsole.tsx:1225-1226). Label hidden < sm. */
export const consoleHeaderBtn =
  `inline-flex items-center gap-1.5 h-9 px-2.5 rounded-lg border border-stone-200 text-xs font-medium text-stone-600 hover:bg-stone-100 transition-colors ${FOCUS_RING}`;
/** Header button, brand — the one strong action, e.g. Log out (AdminConsole.tsx:1227). */
export const consoleHeaderBtnPrimary =
  `inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors ${FOCUS_RING}`;

const RAIL_ITEM =
  `w-full h-10 px-3 inline-flex items-center gap-2.5 text-sm font-medium rounded-xl transition-colors text-left ${FOCUS_RING}`;
const BAR_ITEM =
  `shrink-0 min-w-[68px] px-2.5 py-1.5 inline-flex flex-col items-center gap-1 rounded-xl text-[10px] font-medium leading-none transition-colors ${FOCUS_RING}`;

/**
 * @param {object} props
 * @param {React.ReactNode} props.logo        brand mark, sized h-7 w-auto.
 * @param {string}          props.eyebrow     area name ("Admin").
 * @param {React.ReactNode} [props.badge]     e.g. <ConsoleBadge>Test mode</ConsoleBadge>.
 * @param {React.ReactNode} [props.actions]   right-aligned header buttons
 *   (consoleHeaderBtn / consoleHeaderBtnPrimary), in the order: back to app,
 *   language, log out.
 * @param {{id:string,label:string,icon:React.ReactNode}[]} props.tabs icons at 15px.
 * @param {string}   props.current
 * @param {Function} props.onSelect (id) => void
 * @param {string}   props.navLabel aria-label for both navs.
 * @param {React.ReactNode} [props.footer] e.g. the build stamp text.
 */
export function ConsoleShell({ logo, eyebrow, badge, actions, tabs, current, onSelect, navLabel, footer, children }) {
  return (
    <div className="min-h-screen bg-gradient-to-b from-stone-50 to-stone-100 pb-24 lg:pb-16">
      <header className="bg-white border-b border-stone-200/70 sticky top-0 z-20 no-print">
        <div className="px-4 py-3 flex items-center gap-3">
          {/* shrink-0: on a phone the eyebrow, badge and actions would squeeze the brand mark. */}
          <span className="shrink-0">{logo}</span>
          {/* kit: the eyebrow hides below sm so the logo keeps its size (svrz_rc shows it always). */}
          <span className="hidden sm:inline text-xs font-semibold uppercase tracking-[0.14em] text-stone-400">{eyebrow}</span>
          {badge}
          <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-3">{actions}</div>
        </div>
      </header>

      <div className="px-4 flex gap-6">
        <nav aria-label={navLabel} className="hidden lg:block w-56 shrink-0 sticky top-[68px] self-start pt-5 pb-8 space-y-1 no-print">
          {tabs.map((tb) => (
            <button
              key={tb.id}
              type="button"
              onClick={() => onSelect(tb.id)}
              aria-current={current === tb.id ? 'page' : undefined}
              className={cn(RAIL_ITEM, current === tb.id ? 'bg-slate-900 text-white' : 'text-stone-600 hover:bg-stone-200/70')}
            >
              <span className="shrink-0">{tb.icon}</span>
              <span className="truncate">{tb.label}</span>
            </button>
          ))}
        </nav>

        <main className="flex-1 min-w-0 pt-5">
          {children}
          {footer && <div className="mt-6 pb-3 text-center text-[10px] text-stone-400">{footer}</div>}
        </main>
      </div>

      {/* Phones and tablets: the same list along the bottom, scrolling
          sideways so a ninth destination costs no height. */}
      <nav
        aria-label={navLabel}
        className="lg:hidden fixed bottom-0 inset-x-0 z-20 bg-white/95 backdrop-blur border-t border-stone-200 overflow-x-auto no-print"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        <div className="flex gap-1 px-2 py-1.5 w-max min-w-full">
          {tabs.map((tb) => (
            <button
              key={tb.id}
              type="button"
              // A deep link can land on a tab parked off-screen; bring it in.
              ref={tb.id === current ? (el) => { if (el && el.scrollIntoView) el.scrollIntoView({ inline: 'center', block: 'nearest' }); } : undefined}
              onClick={() => onSelect(tb.id)}
              aria-current={current === tb.id ? 'page' : undefined}
              className={cn(BAR_ITEM, current === tb.id ? 'bg-slate-900 text-white' : 'text-stone-500 hover:bg-stone-100')}
            >
              <span className="shrink-0">{tb.icon}</span>
              <span className="whitespace-nowrap">{tb.label}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}

/** Pill beside the eyebrow for a mode flag (AdminConsole.tsx:1224). */
export function ConsoleBadge({ icon, children }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 border border-amber-300 text-amber-800 text-[11px] font-semibold px-2 py-0.5">
      {icon}{children}
    </span>
  );
}

/**
 * Keeps every panel mounted and hides the inactive ones, so data fetched on
 * first render is ready when the tab is opened (AdminConsole.tsx:1230-1233,
 * 1274-1327).
 */
export function ConsolePanel({ id, current, children }) {
  return <div hidden={id !== current}>{children}</div>;
}

export default ConsoleShell;
