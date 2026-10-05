// volleyui — floating action button: the ONE always-reachable action of the
// app (svrz_rc: the notebook). Port of svrz_rc src/App.tsx:6370-6389.
//
// Circle (56px, icon only) on a phone, an extended pill with its label from
// sm. Sits above the BottomNav on phones/tablets, drops to the corner from lg
// where the nav is a rail. z-40: under overlays (z-50) and toasts (z-60).
// Pair with <AppPage fab> so the page foot can scroll clear of it.
import { cn } from './cn.js';
import { FOCUS_RING } from './Button.jsx';

/**
 * @param {React.ComponentType} props.icon lucide icon, drawn at 22px.
 * @param {string}  props.label  always the accessible name; visible from sm.
 * @param {boolean} [props.aboveNav=false] a BottomNav is on screen.
 * @param {number}  [props.count] red badge top-right when > 0.
 */
export function Fab({ icon: Icon, label, aboveNav = false, count, className, ...rest }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'no-print fixed z-40 right-4 sm:right-6 h-14 w-14 sm:h-12 sm:w-auto sm:px-4 rounded-full bg-slate-900 text-white shadow-lg hover:bg-slate-800 active:scale-95 transition flex items-center justify-center gap-2',
        FOCUS_RING,
        aboveNav
          ? 'bottom-[calc(5.5rem_+_env(safe-area-inset-bottom,0px))] lg:bottom-[calc(1rem_+_env(safe-area-inset-bottom,0px))]'
          : 'bottom-[calc(1rem_+_env(safe-area-inset-bottom,0px))]',
        className,
      )}
      {...rest}
    >
      {Icon && <Icon size={22} aria-hidden="true" />}
      <span className="hidden sm:inline text-sm font-semibold">{label}</span>
      {count > 0 && (
        <span aria-hidden="true" className="absolute -top-1 -right-1 min-w-[1.25rem] h-5 px-1 rounded-full bg-red-600 text-white text-[11px] font-bold flex items-center justify-center">
          {count}
        </span>
      )}
    </button>
  );
}

export default Fab;
