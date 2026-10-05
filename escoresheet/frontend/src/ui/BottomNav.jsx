// volleyui — main navigation: a thumb-reach bar on phones and tablets that
// becomes a left rail from lg.
// Port of svrz_rc src/App.tsx:6123-6196.
//
// Use with <AppPage bottomNav> (AppShell.jsx), which pads the page for it.
// 3-5 destinations. The last slot is usually "Options" (OptionsSheet in Modal.jsx) —
// language, admin link, calendar, switch user, log out live there, not in a
// header user menu. For 6+ destinations use ConsoleShell.jsx instead.
import { cn } from './cn.js';
import { FOCUS_RING } from './Button.jsx';

const COLS = { 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-4', 5: 'grid-cols-5' };

// One string for every item, phone and rail (App.tsx:6137).
const ITEM =
  'h-14 w-full px-1 text-xs font-medium rounded-xl transition-colors flex flex-col items-center justify-center text-center gap-1 lg:h-10 lg:flex-row lg:justify-start lg:gap-2.5 lg:px-3 lg:text-sm lg:text-left';
// Selection is inverted neutral — never the brand red (App.tsx:6139-6140).
const ACTIVE = 'bg-slate-900 text-white';
const IDLE = 'text-stone-600 hover:bg-stone-100';
// The Options trigger while its sheet is open (App.tsx:6189).
const OPEN = 'bg-stone-200 text-stone-900';

/**
 * @param {object} props
 * @param {string} props.label aria-label of the <nav> ("Main navigation").
 * @param {number} [props.count=5] number of items, for the phone grid (2-5).
 *   Pass it explicitly: Tailwind needs the static grid-cols-N class, and a
 *   conditionally hidden item must not leave an empty column (App.tsx:6129).
 */
export function BottomNav({ label, count = 5, className, children }) {
  return (
    <nav
      aria-label={label}
      className={cn(
        'no-print fixed inset-x-0 bottom-0 z-40 border-t border-stone-200 bg-white/95 backdrop-blur lg:inset-x-auto lg:left-0 lg:top-0 lg:w-56 lg:border-t-0 lg:border-r',
        className,
      )}
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <div className={cn('mx-auto max-w-5xl grid gap-1.5 px-2 py-2 lg:flex lg:flex-col lg:gap-1 lg:px-3 lg:pt-8', COLS[count] || 'grid-cols-5')}>
        {children}
      </div>
    </nav>
  );
}

/**
 * One destination. Icon at 20px over the label on a phone, beside it in the rail.
 *
 * @param {boolean} [props.active] this is the current screen.
 * @param {boolean} [props.open] a sheet this item opens is showing (Options).
 * @param {React.ComponentType} props.icon a lucide-react icon component.
 */
export function BottomNavItem({ icon: Icon, active = false, open = false, className, children, ...rest }) {
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      className={cn(ITEM, FOCUS_RING, active ? ACTIVE : open ? OPEN : IDLE, className)}
      {...rest}
    >
      {Icon && <Icon size={20} aria-hidden="true" />}
      {children}
    </button>
  );
}

export default BottomNav;
