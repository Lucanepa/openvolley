// volleyui — the app page frame.
// Port of the root <div> of svrz_rc src/App.tsx:6114 plus the scroll-padding
// effect at App.tsx:5212-5224.
//
// svrz_rc has NO top app bar on its main screens. The page is a warm stone
// gradient; the first thing in it is a title card (see PageHeader.jsx
// TitleCard), the navigation is a bottom bar on phones that becomes a left
// rail from lg (see BottomNav.jsx), and the user menu is an Options sheet
// (OptionsSheet in Modal.jsx). This component only owns the frame: gutters, the room
// the bottom bar / FAB need, and the lg offset for the rail.
import { useEffect } from 'react';
import { cn } from './cn.js';

/**
 * Keeps whatever is scrolled into view (keyboard focus, scrollIntoView, a row
 * opened near the foot of the page) above a fixed bottom bar on phones. From
 * lg (64rem) the bar is a side rail and there is nothing to stop above.
 * Port of App.tsx:5215-5224.
 */
export function useBottomNavScrollPadding(active) {
  useEffect(() => {
    const root = document.documentElement;
    const wide = window.matchMedia ? window.matchMedia('(min-width: 64rem)') : null;
    const apply = () => {
      root.style.scrollPaddingBottom = active && !(wide && wide.matches)
        ? 'calc(6rem + env(safe-area-inset-bottom, 0px))'
        : '';
    };
    apply();
    if (wide && wide.addEventListener) wide.addEventListener('change', apply);
    return () => {
      if (wide && wide.removeEventListener) wide.removeEventListener('change', apply);
      root.style.scrollPaddingBottom = '';
    };
  }, [active]);
}

/**
 * The page frame.
 *
 * @param {object}  props
 * @param {boolean} [props.bottomNav=false] a <BottomNav> is on screen: pads the
 *   foot for the bar (pb-28) on phones/tablets and the left edge for the rail
 *   (lg:pl-[15rem] = 14rem rail + 1rem gutter) on desktop.
 * @param {boolean} [props.fab=false] a <Fab> floats over the page: extra foot room
 *   so the last control can scroll clear of it.
 * @param {string}  [props.width] optional cap for the content column, e.g.
 *   'max-w-5xl'. svrz_rc's list/admin screens use the FULL width
 *   (App.tsx:1811 `sheetWidth = 'max-w-none'`); cap only reading pages.
 */
export function AppPage({ bottomNav = false, fab = false, width, className, children }) {
  useBottomNavScrollPadding(bottomNav);
  return (
    <div
      className={cn(
        'min-h-screen bg-gradient-to-b from-stone-50 to-stone-100 py-6 sm:py-8 px-4 print:bg-white print:p-0',
        fab && 'pb-24',
        bottomNav && (fab ? 'pb-44 lg:pb-24' : 'pb-28 lg:pb-8'),
        bottomNav && 'pt-3 sm:pt-6 lg:pl-[15rem]',
        className,
      )}
    >
      {width ? <div className={cn('mx-auto w-full', width)}>{children}</div> : children}
    </div>
  );
}

/**
 * The build stamp that closes every svrz_rc screen (App.tsx:10842,
 * AdminConsole.tsx:1328). Small, centred, never printed.
 */
export function AppFooter({ children, className }) {
  return (
    <p className={cn('mx-auto mt-6 pb-3 text-center text-[10px] text-stone-400 no-print', className)}>
      {children}
    </p>
  );
}

/**
 * A full-width strip at the top of the page for a mode the user must not
 * forget they are in. Port of the demo strip (App.tsx:6404-6433) and the
 * test-mode strip (App.tsx:6498-6503).
 *
 * @param {'brand'|'amber'} [props.tone='brand']
 * @param {React.ReactNode} [props.icon]
 * @param {React.ReactNode} [props.actions] buttons on the right; use
 *   ModeBannerButton for the brand tone.
 */
export function ModeBanner({ tone = 'brand', icon, actions, children, className }) {
  return (
    <div className={cn('mx-auto mb-3 no-print', className)}>
      <div
        className={cn(
          tone === 'brand'
            ? 'flex items-center justify-between gap-3 rounded-xl bg-red-600 text-white text-xs font-semibold px-3 py-2 shadow-sm'
            : 'flex items-center gap-2 rounded-xl bg-amber-100 border border-amber-300 text-amber-800 text-xs font-semibold px-3 py-2',
        )}
      >
        <span className="flex items-center gap-2">{icon}{children}</span>
        {actions && <span className="shrink-0 flex items-center gap-1.5">{actions}</span>}
      </div>
    </div>
  );
}

/** A button inside a brand ModeBanner (App.tsx:6413-6430). */
export function ModeBannerButton({ className, children, ...rest }) {
  return (
    <button
      type="button"
      // White ring, not FOCUS_RING: a red ring would vanish on the brand banner.
      className={cn('inline-flex items-center gap-1 rounded-lg bg-white/15 hover:bg-white/25 px-2.5 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80', className)}
      {...rest}
    >
      {children}
    </button>
  );
}

export default AppPage;
