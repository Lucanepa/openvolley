// A tappable (i) beside a label that opens a small explanation panel.
// Port of svrz_rc src/components/InfoHint.tsx:1-97, with the hint text passed
// in as props instead of looked up in lib/infoHints.ts.
//
// A TAP, not a hover: the reader is on a phone in a hall, where `title=` never
// appears. The 16 px icon has a 40 px tap area (before:-inset-3); p-0 /
// border-0 / bg-transparent undo the app's legacy `button {}` rule (its padding
// squeezed the icon to nothing). A real button so keyboards and screen readers reach it. Hidden in print.
//
//   <label>Spielzeit <InfoHint eyebrow="Regel 4.2">Die Pause zwischen…</InfoHint></label>
import { Info, X } from 'lucide-react';
import { cn } from './cn.js';
import { FOCUS_RING } from './Button.jsx';
import { useInfoPopover } from './infoPopover.js';

export const INFO_HINT_MAX_WIDTH = 320;

export function InfoHint({
  eyebrow = 'Erklärung',
  label = 'Erklärung anzeigen',
  closeLabel = 'Schliessen',
  className,
  children,
}) {
  // Where the panel goes and when it closes: ui/infoPopover, as for every (i)
  // (it was kept inside the screen at the right edge only: on a phone an (i)
  // near the left edge or the bottom still cut its panel off).
  const { open, close, wrapRef, triggerProps, panelProps } = useInfoPopover({ maxWidth: INFO_HINT_MAX_WIDTH });

  return (
    <span ref={wrapRef} className={`relative inline-flex align-middle print:hidden ${className ?? ''}`}>
      <button
        {...triggerProps}
        aria-label={label}
        title={label}
        className="relative box-border inline-flex items-center justify-center w-4 h-4 p-0 border-0 bg-transparent rounded-full text-stone-400 hover:text-sky-700 hover:bg-sky-50 focus:outline-none focus:ring-2 focus:ring-sky-500/50 transition-colors before:absolute before:-inset-3 before:content-['']"
      >
        <Info size={13} />
      </button>
      {/* right after the (i) in the page; its × and Escape close it, as a tap elsewhere does */}
      {open && (
        <span
          {...panelProps}
          role="dialog"
          aria-label={label}
          className="z-[1100] block w-[20rem] rounded-lg border border-stone-300 bg-white p-3 text-left shadow-xl"
        >
          <span className="flex items-start justify-between gap-2 mb-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-sky-700">{eyebrow}</span>
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); close(true); }}
              aria-label={closeLabel}
              className={cn('shrink-0 -mt-0.5 -mr-0.5 rounded text-stone-400 hover:text-stone-700', FOCUS_RING)}
            >
              <X size={13} />
            </button>
          </span>
          <span className="block text-xs leading-relaxed text-stone-700 whitespace-pre-line normal-case font-normal not-italic">
            {children}
          </span>
        </span>
      )}
    </span>
  );
}

export default InfoHint;
