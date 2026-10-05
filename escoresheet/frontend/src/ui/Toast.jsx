// Toast stack. Faithful port of svrz_rc src/components/ui/Toast.tsx:1-94.
// Rendered by <UiHost />; fired with toast.success / toast.error / toast.info.
import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AlertCircle, Check, Info, X } from 'lucide-react';
import { cn } from './cn.js';
import { FOCUS_RING } from './Button.jsx';
import { dismissToast, getToastsSnapshot, subscribeToasts } from './uiStore.js';
import { TOAST_ACCENT } from './tones.js';

const ICONS = { success: Check, error: AlertCircle, info: Info };

// Accent per kind (Toast.tsx:8-12) lives in tones.js.
const ACCENT = TOAST_ACCENT;

function ToastRow({ item }) {
  const [paused, setPaused] = useState(false);
  // Banked so that leaving the pointer restarts the remainder, not the whole
  // duration — hovering to read should not make a toast immortal either.
  const remainingRef = useRef(item.duration);
  const startedRef = useRef(0);

  useEffect(() => {
    if (paused || item.duration <= 0) return;
    startedRef.current = Date.now();
    const timer = window.setTimeout(() => dismissToast(item.id), Math.max(0, remainingRef.current));
    return () => {
      window.clearTimeout(timer);
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedRef.current));
    };
  }, [paused, item.id, item.duration]);

  const Icon = ICONS[item.kind];
  const accent = ACCENT[item.kind];

  return (
    <div
      data-testid="toast"
      data-toast-kind={item.kind}
      // NO role/aria-live on the card: the container is already role="status";
      // nesting role="alert" made screen readers announce errors twice. Errors
      // must ALSO land inline — the toast is a supplement, not the only signal.
      // Pause on a real mouse only: a tap fires pointerenter with no
      // pointerleave, which used to park the toast on screen for good.
      onPointerEnter={(e) => { if (e.pointerType === 'mouse') setPaused(true); }}
      onPointerLeave={(e) => { if (e.pointerType === 'mouse') setPaused(false); }}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={cn(
        // pointer-events-none below sm: the stack sits over row buttons on a
        // phone, and a 4-second toast must never eat a tap. The dismiss button
        // re-enables events for itself.
        'pointer-events-none sm:pointer-events-auto w-full sm:w-auto sm:min-w-[15rem] max-w-sm bg-white rounded-xl shadow-lg',
        'border border-stone-200 border-l-4 flex items-start gap-2.5 py-3 pl-3 pr-2',
        accent.border,
      )}
    >
      <Icon size={18} className={cn('shrink-0 mt-px', accent.icon)} />
      <p className="flex-1 text-sm text-stone-700 leading-snug break-words">{item.message}</p>
      <button
        type="button"
        data-testid="toast-dismiss"
        aria-label={item.lang === 'EN' ? 'Dismiss notification' : 'Meldung schliessen'}
        onClick={() => dismissToast(item.id)}
        className={cn('pointer-events-auto shrink-0 h-10 w-10 sm:h-7 sm:w-7 -my-1.5 sm:my-0 inline-flex items-center justify-center rounded text-stone-400 hover:text-stone-700 hover:bg-stone-100 transition-colors', FOCUS_RING)}
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function ToastStack() {
  const items = useSyncExternalStore(subscribeToasts, getToastsSnapshot, getToastsSnapshot);

  // Rendered even when empty: a live region has to be in the DOM BEFORE its
  // content changes, or screen readers announce nothing for the first toast.
  // z-[60] keeps it above the confirm dialog (z-50).
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      className="fixed inset-x-0 bottom-0 sm:inset-x-auto sm:right-0 z-[60] no-print pointer-events-none flex flex-col items-center sm:items-end gap-2 p-4"
    >
      {items.map((item) => <Fragment key={item.id}><ToastRow item={item} /></Fragment>)}
    </div>
  );
}

export default ToastStack;
