// A tappable (i) beside a label that opens a small explanation panel.
// Port of svrz_rc src/components/InfoHint.tsx:1-97, with the hint text passed
// in as props instead of looked up in lib/infoHints.ts.
//
// A TAP, not a hover: the reader is on a phone in a hall, where `title=` never
// appears. A real button so keyboards and screen readers reach it. Hidden in print.
//
//   <label>Spielzeit <InfoHint eyebrow="Regel 4.2">Die Pause zwischen…</InfoHint></label>
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Info, X } from 'lucide-react';
import { cn } from './cn.js';
import { FOCUS_RING } from './Button.jsx';

export function InfoHint({
  eyebrow = 'Erklärung',
  label = 'Erklärung anzeigen',
  closeLabel = 'Schliessen',
  className,
  children,
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const panel = useRef(null);
  // Pulled back inside the screen when it opens: an (i) near the right edge
  // opened its panel off the page on a phone. (InfoHint.tsx:20-33)
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    if (!open) { setShift(0); return; }
    const rect = panel.current?.getBoundingClientRect();
    if (!rect) return;
    const vv = window.visualViewport;
    const right = vv ? vv.offsetLeft + vv.width : window.innerWidth;
    const overflow = rect.right - (right - 8);
    setShift(overflow > 0 ? -Math.min(overflow, rect.left - 8) : 0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (wrap.current && !wrap.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    // Capture phase: forms below may stop propagation, and a popover that only
    // closes when you click nothing in particular is a trap.
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span ref={wrap} className={`relative inline-flex align-middle print:hidden ${className ?? ''}`}>
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v); }}
        aria-expanded={open}
        aria-label={label}
        title={label}
        className="inline-flex items-center justify-center w-4 h-4 rounded-full text-stone-400 hover:text-sky-700 hover:bg-sky-50 focus:outline-none focus:ring-2 focus:ring-sky-500/50 transition-colors"
      >
        <Info size={13} />
      </button>
      {open && (
        <span
          ref={panel}
          role="dialog"
          aria-label={label}
          style={shift ? { transform: `translateX(${shift}px)` } : undefined}
          className="absolute left-0 top-6 z-40 w-[min(20rem,calc(100vw-2.5rem))] rounded-lg border border-stone-300 bg-white p-3 text-left shadow-xl"
        >
          <span className="flex items-start justify-between gap-2 mb-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-sky-700">{eyebrow}</span>
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(false); }}
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
