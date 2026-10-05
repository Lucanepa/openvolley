// volleyui — the pieces of a task page (a form, a document, a sub-view):
//
// PageToolbar  — the row above the page body: Back first, then page tools.
//                svrz_rc src/App.tsx:6508.
// BackButton   — the 44px white Back button. App.tsx:6511-6517.
// PaperSheet   — a printable document: square corners, heavy shadow, prints
//                edge to edge. App.tsx:9323.
// SubmitBar    — the right-aligned send row under the sheet, with the
//                validation message above the button. App.tsx:10055-10060.
// LockedNotice — "this is filed / closed" strip in place of the SubmitBar.
//                App.tsx:10021-10043.
// StickyBottomBar — a filter / action bar pinned to the bottom of the
//                viewport while a long page scrolls, above a phone nav bar.
//                StatisticsAdmin.tsx:874-875.
import { ArrowLeft } from 'lucide-react';
import { cn } from './cn.js';
import { FOCUS_RING } from './Button.jsx';

export function PageToolbar({ className, children }) {
  return <div className={cn('mx-auto mb-6 flex flex-wrap items-center gap-2 sm:gap-3 no-print', className)}>{children}</div>;
}

/** Tool buttons in the toolbar share this finish (App.tsx:6531). */
export const toolbarBtn =
  `flex h-11 items-center gap-2 bg-white px-4 rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 transition-colors ${FOCUS_RING}`;

export function BackButton({ label = 'Back', className, ...rest }) {
  return (
    <button type="button" className={cn(toolbarBtn, className)} {...rest}>
      <ArrowLeft size={18} />
      <span>{label}</span>
    </button>
  );
}

/**
 * A document that is also the printout. Square corners on purpose: it is a
 * sheet of paper, not a card. On print the shadow, border, padding and width
 * cap all go, and the sheet fills the A4 page (tokens.css @page).
 * Inside, force the desktop layout on paper with `print:` twins of every
 * responsive class, e.g. `flex-col sm:flex-row print:flex-row`,
 * `grid-cols-1 md:grid-cols-4 print:grid-cols-4` (App.tsx:9326, 9373), and
 * hide interactive bits with `print:hidden`.
 */
export function PaperSheet({ className, children }) {
  return (
    <div className={cn('mx-auto bg-white p-4 md:p-8 shadow-xl border border-stone-200 print:shadow-none print:border-none print:p-0 print:max-w-none print:mx-0', className)}>
      {children}
    </div>
  );
}

/** @param {React.ReactNode} [props.error] the validation message, shown above. */
export function SubmitBar({ error, className, children }) {
  return (
    <div className={cn('mx-auto mt-4 flex justify-end no-print', className)}>
      <div className="flex flex-col items-end gap-2">
        {error && <p className="text-sm text-red-600 font-medium">{error}</p>}
        <div className="flex flex-wrap items-center justify-end gap-2">{children}</div>
      </div>
    </div>
  );
}

/** @param {React.ReactNode} [props.action] e.g. a "Reopen" button. */
export function LockedNotice({ action, className, children }) {
  return (
    <div className={cn('mx-auto mt-4 no-print', className)}>
      <div className="flex flex-wrap items-center justify-between gap-3 bg-stone-100 border border-stone-300 rounded-lg px-4 py-3 text-sm text-stone-600 font-medium">
        <span>{children}</span>
        {action}
      </div>
    </div>
  );
}

/**
 * @param {boolean} [props.aboveNav=true] lift it over a phone bottom bar
 *   (4rem); from lg it rests 0.75rem off the bottom edge.
 */
export function StickyBottomBar({ aboveNav = true, className, children }) {
  return (
    <div
      className={cn(
        'sticky z-10 mt-4 no-print',
        aboveNav ? 'bottom-[calc(4rem+env(safe-area-inset-bottom,0px))] lg:bottom-3' : 'bottom-[calc(0.75rem+env(safe-area-inset-bottom,0px))]',
      )}
    >
      <div className={cn('rounded-2xl border border-stone-200 bg-white/95 backdrop-blur shadow-card-lg p-2 space-y-2', className)}>
        {children}
      </div>
    </div>
  );
}

export default PageToolbar;
