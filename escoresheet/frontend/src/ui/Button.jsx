// Button: the one text button of the Volleyball style.
//
// Every size x variant pair below rebuilds a class string svrz_rc actually
// ships. The canonical pairs (verified class-for-class):
//   primary  md  = btnPrimary  svrz_rc src/components/AdminConsole.tsx:752
//                              (also BudgetCard.tsx:55, RcMeetingsAdmin.tsx:64)
//   ghost    sm  = btnGhost    svrz_rc src/components/BudgetCard.tsx:56
//                              (also RcMeetingsAdmin.tsx:65, CoacheeFileAdmin.tsx:80)
//   primary  xl  = full-width page CTA  CoacheeFilePage.tsx:247
//   dark     md  = "Spiel übernehmen"   App.tsx:8470 (there rounded-md; the kit keeps rounded-lg)
//   dark     lg  = dialog accept        App.tsx:10689
//   secondary lg = dialog cancel        App.tsx:10680
//   danger-outline sm = delete in an editor  RcMeetingsAdmin.tsx:168
//   danger-soft xl    = form reset           App.tsx:6694
//   positive  = non-destructive confirm      ui/ConfirmDialog.tsx:137-140
//   text      = quiet text action            App.tsx:10459
//   hero      = login submit (AuthGate)      AuthGate.tsx:151-152
//
// `bg-red-600` is the Swiss Volley brand (#e2001a): tokens.css overrides
// red-600/red-700, so "primary" and "danger" share a colour on purpose.
//
// OpenVolley deviation from the volleyui skill kit (keep on resync): every
// emerald confirm (Button `positive`, Modal `modalSaveClass`, tones
// `CONFIRM_ACCEPT.ok`) is emerald-700 / hover emerald-800, not 600 / 700.
// White on emerald-600 is 3.8:1, below AA for this text size; on 700 it is 5.5:1.
import { createElement, isValidElement } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from './cn.js';

// kit: svrz_rc buttons set no focus style and fall back to the browser outline.
// Every kit button gets one ring instead, in the brand hue (foundations §6).
export const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 focus-visible:ring-offset-1';
// The same ring drawn inside the box, for segments in an `overflow-hidden` strip
// (joined / joined-quiet / icon), where an outer ring would be clipped.
export const FOCUS_RING_INSET = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-400/60';

const BASE = cn('inline-flex items-center justify-center font-medium transition-colors', FOCUS_RING);

export const BUTTON_SIZES = {
  // micro toggles inside dense admin grids  AdminConsole.tsx:1518, :2445
  xs: 'h-6 gap-1 px-2 rounded-md text-[11px]',
  // btnGhost / row tools / editor toolbars   BudgetCard.tsx:56, RichText.tsx:77
  sm: 'h-8 gap-1.5 px-2.5 rounded-lg text-xs',
  // btnPrimary, matches Input md (h-9)       AdminConsole.tsx:751-752
  md: 'h-9 gap-1.5 px-3 rounded-lg text-sm',
  // dialog footers, full-width form submit   App.tsx:10567, :10575, :11238
  lg: 'h-10 gap-2 px-4 rounded-lg text-sm',
  // touch / page CTA, matches Input lg (h-11) CoacheeFilePage.tsx:247, App.tsx:10406
  xl: 'h-11 gap-2 px-4 rounded-xl text-sm font-semibold',
};

export const BUTTON_VARIANTS = {
  primary: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-stone-300',
  secondary: 'border border-stone-300 bg-white text-stone-700 hover:bg-stone-50 disabled:opacity-50',
  ghost: 'border border-stone-200 text-stone-600 hover:bg-stone-100 disabled:opacity-50',
  dark: 'bg-slate-900 text-white hover:bg-slate-800 disabled:bg-stone-200 disabled:text-stone-400',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-stone-300',
  'danger-outline': 'border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-50',
  'danger-soft': 'rounded-lg border border-red-100 bg-red-50 font-medium text-red-600 shadow-sm hover:bg-red-100',
  positive: 'bg-emerald-700 text-white hover:bg-emerald-800 disabled:opacity-50',
  text: 'px-0 text-xs text-stone-500 hover:text-stone-700 disabled:text-stone-300',
  toolbar: 'rounded-lg border border-stone-200 bg-white font-medium text-stone-700 shadow-sm hover:bg-stone-50',
  // AuthGate's primaryButtonClass, whole: use with block and no size.
  hero: 'h-auto gap-2 py-3 rounded-xl bg-red-600 text-white font-semibold shadow-sm shadow-red-600/20 transition-all hover:bg-red-700 active:scale-[0.99] disabled:bg-stone-300 disabled:cursor-not-allowed',
};

// Icon pixel size per button size, as svrz_rc pairs them:
// 11 on h-6 (AdminConsole.tsx:2449), 13 on btnGhost (RcMeetingsAdmin.tsx:166),
// 15 on btnPrimary (RcMeetingsAdmin.tsx:164), 16 on h-11 (CoacheeFilePage.tsx:249).
const ICON_PX = { xs: 11, sm: 13, md: 15, lg: 16, xl: 16 };

export function renderIcon(icon, px, className) {
  if (!icon) return null;
  if (isValidElement(icon)) return icon;
  return createElement(icon, { size: px, className, 'aria-hidden': true });
}

/**
 * @param {object} props
 * @param {'primary'|'secondary'|'ghost'|'dark'|'danger'|'danger-outline'|'danger-soft'|'positive'|'text'|'toolbar'|'hero'} [props.variant]
 * @param {'xs'|'sm'|'md'|'lg'|'xl'} [props.size]
 * @param {any} [props.icon]      leading icon: a lucide component (sized for you) or an element
 * @param {any} [props.iconRight] trailing icon, same rules
 * @param {boolean} [props.loading] swaps the leading icon for a spinner, disables, sets aria-busy
 * @param {boolean} [props.block] full width
 */
export function Button({
  variant = 'primary',
  size = 'md',
  icon,
  iconRight,
  loading = false,
  block = false,
  disabled,
  type = 'button',
  className,
  children,
  ...rest
}) {
  const px = ICON_PX[size] ?? 15;
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(BASE, BUTTON_SIZES[size], BUTTON_VARIANTS[variant], block && 'w-full', className)}
      {...rest}
    >
      {loading ? <Loader2 size={px} className="animate-spin" aria-hidden="true" /> : renderIcon(icon, px)}
      {children}
      {renderIcon(iconRight, px)}
    </button>
  );
}

/**
 * A row of buttons. svrz_rc's three layouts:
 *  - 'start'  editor actions, primary first, delete pushed right with ml-auto   RcMeetingsAdmin.tsx:162-168
 *  - 'end'    dialog footer, cancel then accept                                ui/ConfirmDialog.tsx:123
 *  - 'split'  two equal halves (give each child className="flex-1")            App.tsx:10679
 */
export function ButtonGroup({ align = 'start', className, children, ...rest }) {
  const layout = {
    start: 'flex flex-wrap items-center gap-2',
    end: 'flex justify-end gap-2',
    split: 'flex gap-2',
  }[align];
  return <div className={cn(layout, className)} {...rest}>{children}</div>;
}

export default Button;
