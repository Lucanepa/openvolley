// Modals, sheets and the options action sheet, ported from svrz_rc.
//
// svrz_rc hand-rolls every modal inline in App.tsx; the class strings below are
// copied from those call sites. The behaviour (scroll lock, focus restore, Tab
// trap, press-started-on-backdrop guard, 400ms open guard) is ConfirmDialog.tsx
// :14-99 generalised to any modal. Escape closes the TOPMOST modal only — the
// job App.tsx:4372-4390 does with one hand-ordered window listener, done here
// with a module-level stack so nothing has to be listed by hand.
//
//   layout="plain"     title row with a × + padded body.        App.tsx:10326-10336
//   layout="sections"  header / scrolling body / footer, ruled. App.tsx:6436-6494
//   sheet              bottom sheet on a phone, centred on sm+. App.tsx:768-807,
//                      NotebookSheet.tsx:396-401
//   ActionSheet        the "Options" menu sheet (= OptionsSheet). App.tsx:6198-6364
//
// Scrims: content dialogs and sheets `bg-stone-900/50 backdrop-blur-sm`; decision
// dialogs (`decision` prop, ConfirmDialog) `bg-stone-900/60 backdrop-blur-sm`; the
// ActionSheet menu `bg-slate-900/40` with no blur, so the page reads through
// (App.tsx:6204).
import { Fragment, useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import { cn } from './cn.js';
import { FOCUS_RING } from './Button.jsx';
import { backdropDismiss } from './backdropDismiss.js';

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

const SIZES = {
  xs: 'max-w-xs', //  App.tsx:10588 (a short list of choices)
  sm: 'max-w-sm', //  App.tsx:10237, ConfirmDialog.tsx:112
  md: 'max-w-md', //  App.tsx:10327 (default)
  lg: 'max-w-lg', //  App.tsx:6437, 10496
  xl: 'max-w-2xl', // App.tsx:10704, 10743, 771 (sheet)
};

// Static strings so Tailwind's scanner sees them (a template `sm:${w}` would not be generated).
const SHEET_SIZES = {
  xs: 'sm:max-w-xs',
  sm: 'sm:max-w-sm',
  md: 'sm:max-w-md',
  lg: 'sm:max-w-lg',
  xl: 'sm:max-w-2xl',
};

// Open modals, oldest first. Only the last one answers Escape and traps Tab.
const stack = [];

/**
 * The overlay mechanics shared by Modal and ActionSheet.
 * Returns props for the backdrop element.
 */
function useOverlay({ open, onClose, panelRef, dismissible = true }) {
  const openedAtRef = useRef(0);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const token = useRef({});

  useEffect(() => {
    if (!open) return;
    const me = token.current;
    stack.push(me);
    openedAtRef.current = Date.now();
    const previouslyFocused = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // First field that asked for it, else the panel itself (tabIndex=-1).
    const panel = panelRef.current;
    const auto = panel?.querySelector('[autofocus],[data-autofocus]');
    (auto || panel)?.focus?.();

    const onKey = (e) => {
      if (stack[stack.length - 1] !== me) return;
      // A confirmDialog() raised over this modal owns the keyboard: it handles
      // Escape in the capture phase itself, and Tab inside it is none of ours.
      const owner = document.activeElement?.closest?.('[aria-modal="true"]');
      const panelEl = panelRef.current;
      if (owner && panelEl && !owner.contains(panelEl) && !panelEl.contains(owner)) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onCloseRef.current?.();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const nodes = Array.from(panelRef.current.querySelectorAll(FOCUSABLE));
      if (nodes.length === 0) { e.preventDefault(); return; }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      const inside = !!active && panelRef.current.contains(active);
      if (e.shiftKey ? (active === first || !inside) : (active === last || !inside)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const i = stack.indexOf(me);
      if (i >= 0) stack.splice(i, 1);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused && document.contains(previouslyFocused) && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
  }, [open, panelRef]);

  // Press and release must both land on the backdrop (backdropDismiss.js), and
  // the first 400ms after opening are ignored so the second click of a
  // double-click on the opener cannot close it.
  return backdropDismiss(() => {
    if (Date.now() - openedAtRef.current < 400) return;
    onCloseRef.current?.();
  }, { enabled: dismissible });
}

/**
 * <Modal open onClose title="Kalender-Abo" icon={CalendarDays} footer={...}>
 *
 * - layout="plain" (default): `p-5` panel, title row with the × glyph.
 * - layout="sections": ruled header / scrolling body / footer.
 * - sheet: bottom sheet below sm (rounded-t-2xl, 92dvh), centred dialog on sm+.
 *   Always sectioned.
 * - dismissible={false}: backdrop click does nothing (forms with unsaved input);
 *   Escape and the × still close.
 * - decision: a dialog that asks for a decision or holds a form (take over, sign, reset) gets the
 *   darker `bg-stone-900/60` scrim (App.tsx:10122, 10495, 10587, 10703). Content
 *   dialogs and sheets keep `/50` (App.tsx:768, 10236, 10326). confirmDialog() is
 *   always a decision.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  icon: Icon,
  size = 'md',
  layout = 'plain',
  sheet = false,
  dismissible = true,
  decision = false,
  footer,
  closeLabel = 'Schliessen',
  className,
  bodyClassName,
  children,
}) {
  const panelRef = useRef(null);
  const titleId = useId();
  const backdrop = useOverlay({ open, onClose, panelRef, dismissible });
  if (!open) return null;

  const sectioned = sheet || layout === 'sections';
  const width = SIZES[size] ?? SIZES.md;

  const overlayClass = sheet
    ? 'no-print fixed inset-0 z-50 bg-stone-900/50 backdrop-blur-sm flex items-end sm:items-center justify-center sm:p-4'
    : cn('fixed inset-0 backdrop-blur-sm flex items-center justify-center p-4 z-50 no-print', decision ? 'bg-stone-900/60' : 'bg-stone-900/50');

  const panelClass = sheet
    // App.tsx:771 — sm:max-w-* replaces the size; phone gets the full width.
    ? cn('bg-white w-full h-[92dvh] sm:h-auto sm:max-h-[85vh] rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col', SHEET_SIZES[size] ?? SHEET_SIZES.xl)
    : sectioned
      // App.tsx:6437
      ? cn('bg-white rounded-2xl shadow-xl w-full max-h-[85vh] flex flex-col', width)
      // App.tsx:10327
      : cn('bg-white rounded-2xl shadow-2xl w-full p-5 max-h-[85vh] overflow-auto', width);

  return (
    <div className={overlayClass} {...backdrop}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={cn(panelClass, 'outline-none', className)}
      >
        {sectioned ? (
          <>
            {title && (
              // App.tsx:6438-6445 (sheet header: App.tsx:772 uses px-4 py-3)
              <div className={cn('flex items-center justify-between gap-3 border-b border-stone-200', sheet ? 'px-4 py-3' : 'px-5 py-4')}>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {Icon && <Icon size={16} className="shrink-0 text-red-600" />}
                    <h2 id={titleId} className={cn('text-sm text-stone-800', sheet ? 'font-semibold' : 'font-bold')}>{title}</h2>
                  </div>
                  {description && <p className="text-xs text-stone-500 mt-1">{description}</p>}
                </div>
                <button type="button" onClick={onClose} className={cn('rounded text-stone-400 hover:text-stone-600', FOCUS_RING)} aria-label={closeLabel}>
                  <X size={18} />
                </button>
              </div>
            )}
            {/* App.tsx:6451 */}
            <div className={cn('flex-1 overflow-y-auto px-5 py-4 space-y-4', sheet && 'px-4 py-3', bodyClassName)}>{children}</div>
            {footer && (
              // App.tsx:6490 / 799 — `text-right` became flex so several buttons line up.
              <div className={cn('border-t border-stone-200 flex items-center justify-end gap-2', sheet ? 'px-4 py-3' : 'px-5 py-3')}>
                {footer}
              </div>
            )}
          </>
        ) : (
          <>
            {title && (
              // App.tsx:10328-10334
              <div className="flex items-start justify-between mb-3">
                <h3 id={titleId} className="text-base font-bold text-stone-900 flex items-center gap-2">
                  {Icon && <Icon size={17} className="text-red-600" />}
                  {title}
                </h3>
                <button type="button" onClick={onClose} aria-label={closeLabel} className={cn('rounded text-stone-400 hover:text-stone-600 text-2xl leading-none -mt-1 -mr-1 px-1', FOCUS_RING)}>&times;</button>
              </div>
            )}
            {description && <p className="text-sm text-stone-600 mb-4">{description}</p>}
            <div className={bodyClassName}>{children}</div>
            {footer && (
              // App.tsx:10563 — Cancel left, primary right, both h-10.
              <div className="flex items-center justify-end gap-2 mt-4">{footer}</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ── Footer buttons used inside modals (svrz_rc strings + the kit FOCUS_RING) ── */

/** Secondary / cancel. App.tsx:10567 */
export const modalCancelClass =
  `h-10 px-4 rounded-lg border border-stone-200 text-sm font-medium text-stone-600 hover:bg-stone-50 transition-colors ${FOCUS_RING}`;
/** Brand-neutral primary ("Done", "Close"). App.tsx:806; full-width variant App.tsx:10689 */
export const modalPrimaryClass =
  `h-10 px-5 rounded-xl bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 transition-colors ${FOCUS_RING}`;
/** Positive commit ("Save"). App.tsx:10214-10221, ConfirmDialog.tsx:139-140.
 *  emerald-700, not the kit's 600: an OpenVolley AA deviation (see Button.jsx header). */
export const modalSaveClass =
  `h-10 px-4 rounded-lg bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-800 transition-colors ${FOCUS_RING}`;
/** Destructive commit ("Delete", "Reset"). App.tsx:10220, ConfirmDialog.tsx:139 */
export const modalDangerClass =
  `h-10 px-4 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors ${FOCUS_RING}`;

/**
 * A read-only record on a sunken band, flush between a sectioned modal's
 * header and its form. App.tsx:10506-10520. Use with bodyClassName="p-0 space-y-0"
 * and wrap the rest of the body in <div className="p-5">.
 */
export function ModalRecord({ rows }) {
  return (
    <dl className="px-5 py-4 grid grid-cols-3 gap-x-3 gap-y-2 text-sm border-b border-stone-200 bg-stone-50/60">
      {rows.map(([label, value]) => (
        <Fragment key={label}>
          <dt className="col-span-1 text-stone-500">{label}</dt>
          <dd className="col-span-2 text-stone-800 break-words">{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/* ── Action sheet (the "Options" menu) ───────────────────────────────────── */

/**
 * Bottom sheet of full-width menu rows. App.tsx:6198-6240.
 * On lg it docks as a card beside a 14.5rem side rail (`railOffset`).
 */
export function ActionSheet({ open, onClose, title, closeLabel = 'Schliessen', railOffset = true, children }) {
  const panelRef = useRef(null);
  const overlay = useOverlay({ open, onClose, panelRef });
  if (!open) return null;
  return (
    <div
      className={cn(
        'no-print fixed inset-0 z-50 flex items-end justify-center',
        railOffset ? 'lg:items-start lg:justify-start lg:pl-[14.5rem] lg:pt-8' : 'lg:items-center',
      )}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      {/* A real (but untabbable) button as the scrim: App.tsx:6200-6206 */}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="absolute inset-0 bg-slate-900/40"
        {...overlay}
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative w-full max-w-md rounded-t-2xl lg:rounded-2xl border border-stone-200 bg-white p-2 shadow-xl max-h-[80vh] overflow-y-auto outline-none"
        style={{ paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom, 0px))' }}
      >
        <div className="flex items-center justify-between pl-4 pt-1">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-400">{title}</p>
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className={cn('h-11 w-11 inline-flex items-center justify-center rounded-full text-stone-500 hover:bg-stone-100', FOCUS_RING)}
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex flex-col">{children}</div>
      </div>
    </div>
  );
}

/**
 * One row of an ActionSheet. App.tsx:6216-6223 (Options rows App.tsx:6225-6364).
 * Renders a <button> by default; pass `as="label"` for a file-picker row and put
 * the <input className="sr-only"> in children (App.tsx:6331-6348), or `as="a"` with href.
 *
 * @param {import('react').ComponentType} [props.icon] lucide icon, drawn at 18px.
 * @param {import('react').ReactNode} [props.trailing] trailing value ("DE", "Ready"). `value` is an alias.
 * @param {string} [props.valueClassName] colour for the value: 'text-emerald-600' ready,
 *   'text-amber-600' incomplete, 'text-stone-400' pending (App.tsx:6273-6274).
 * @param {import('react').ReactNode} [props.trailingIcon] e.g. <ArrowLeftRight size={16}/> for
 *   "switch user" (App.tsx:6324).
 * Row order in an Options sheet: language, admin, calendar, offline readiness,
 * switch user, import file, Log out last.
 */
export function ActionSheetItem({ as = 'button', icon: Icon, trailing, value, valueClassName, trailingIcon, className, children, ...rest }) {
  const Tag = as;
  const extra = Tag === 'button' ? { type: 'button' } : {};
  const shown = trailing ?? value;
  return (
    <Tag
      className={cn('w-full min-h-12 inline-flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium text-stone-700 hover:bg-stone-100 transition-colors cursor-pointer', FOCUS_RING, Tag === 'button' && 'disabled:cursor-default', className)}
      {...extra}
      {...rest}
    >
      {Icon && <Icon size={18} aria-hidden="true" />}
      <span className="min-w-0 flex-1 truncate text-left">{children}</span>
      {shown != null && <span className={cn('text-xs font-semibold text-stone-500', valueClassName)}>{shown}</span>}
      {trailingIcon && <span className="shrink-0 text-stone-400" aria-hidden="true">{trailingIcon}</span>}
    </Tag>
  );
}

/** svrz_rc's user menu is this sheet (App.tsx:6198-6364): same components, its own names. */
export const OptionsSheet = ActionSheet;
export const OptionsRow = ActionSheetItem;

export default Modal;
