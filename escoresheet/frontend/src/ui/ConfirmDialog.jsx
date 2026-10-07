// The promise-based confirm dialog. Faithful port of svrz_rc
// src/components/ui/ConfirmDialog.tsx:1-148. Rendered by <UiHost />; opened with
// `await confirmDialog({ title, message, confirmLabel, tone: 'danger' })`.
// With `input: { label, defaultValue, placeholder, type, inputMode }` it asks
// for a line of text instead (window.prompt's replacement): the confirm button
// and Enter resolve the typed string, Cancel / Escape / the backdrop false.
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { cn } from './cn.js';
import { getConfirmSnapshot, settleConfirm, subscribeConfirm } from './uiStore.js';
import { CONFIRM_ACCEPT } from './tones.js';
import { FOCUS_RING } from './Button.jsx';
import { Input } from './Input.jsx';
import { backdropDismiss } from './backdropDismiss.js';

// Everything a Tab can land on. The message is a ReactNode, so it may well
// contain a link — trapping only the two buttons would skip it.
const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function ConfirmDialog() {
  const entry = useSyncExternalStore(subscribeConfirm, getConfirmSnapshot, getConfirmSnapshot);
  const panelRef = useRef(null);
  const acceptRef = useRef(null);
  const inputRef = useRef(null);
  const [text, setText] = useState('');
  // Backdrop dismissal needs two guards: backdropDismiss() demands the press
  // START and END on the backdrop (a text selection dragged out of the panel
  // does not answer "no"); `openedAtRef` ignores the backdrop for 400ms after
  // opening, so the second click of a double-click on the opener cannot cancel.
  const openedAtRef = useRef(0);
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const messageId = `${baseId}-message`;
  const inputId = `${baseId}-input`;
  const open = !!entry;
  const id = entry ? entry.id : 0;

  // Keyed on `open`, not on the entry: the body stays locked while the queue
  // drains from one dialog straight into the next; focus returns to the opener.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused && document.contains(previouslyFocused) && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
  }, [open]);

  const asksText = !!entry?.input;
  const defaultText = entry?.input?.defaultValue ?? '';
  // A fresh field per dialog.
  useEffect(() => { setText(defaultText); }, [id, defaultText]);

  // Focus the field, or else the confirm button, per dialog, so a queued second
  // one does not leave focus stranded on the first one's (now gone) button.
  useEffect(() => {
    if (!open) return;
    if (asksText) inputRef.current?.focus();
    else acceptRef.current?.focus();
  }, [open, id, asksText]);

  useEffect(() => { if (open) { openedAtRef.current = Date.now(); } }, [open, id]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        // Capture phase + stopPropagation: one Escape closes THIS dialog only,
        // never this dialog and the screen/modal behind it.
        e.stopPropagation();
        e.preventDefault();
        settleConfirm(id, false);
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const nodes = Array.from(panel.querySelectorAll(FOCUSABLE));
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      const inside = !!active && panel.contains(active);
      if (e.shiftKey ? (active === first || !inside) : (active === last || !inside)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, id]);

  if (!entry) return null;

  const de = (entry.lang ?? 'DE') === 'DE';
  const confirmLabel = entry.confirmLabel ?? (de ? 'Bestätigen' : 'Confirm');
  const cancelLabel = entry.cancelLabel ?? (de ? 'Abbrechen' : 'Cancel');
  const hasMessage = entry.message !== undefined && entry.message !== null && entry.message !== '';
  const accept = () => settleConfirm(entry.id, asksText ? text : true);

  return (
    <div
      className="fixed inset-0 bg-stone-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 no-print"
      {...backdropDismiss(() => {
        if (Date.now() - openedAtRef.current < 400) return;
        settleConfirm(entry.id, false);
      })}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hasMessage ? messageId : undefined}
        data-testid="confirm-dialog"
        // max-h/overflow: the body is scroll-locked, so a panel taller than the
        // viewport would otherwise push the buttons out of reach.
        className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-6 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={titleId} data-testid="confirm-title" className={cn('text-lg font-bold text-stone-900', hasMessage || asksText ? 'mb-3' : 'mb-6')}>
          {entry.title}
        </h3>
        {hasMessage && (
          <div id={messageId} data-testid="confirm-message" className={cn('text-sm text-stone-600 whitespace-pre-line', asksText ? 'mb-3' : 'mb-6')}>
            {entry.message}
          </div>
        )}
        {asksText && (
          <form
            className="mb-6"
            onSubmit={(e) => { e.preventDefault(); accept(); }}
          >
            {entry.input.label && (
              <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium text-stone-700">{entry.input.label}</label>
            )}
            <Input
              ref={inputRef}
              id={inputId}
              data-testid="confirm-input"
              type={entry.input.type ?? 'text'}
              inputMode={entry.input.inputMode}
              placeholder={entry.input.placeholder}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label={entry.input.label ? undefined : entry.title}
            />
          </form>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            data-testid="confirm-cancel"
            onClick={() => settleConfirm(entry.id, false)}
            className={cn('px-4 py-2 text-sm rounded-lg border border-stone-300 hover:bg-stone-50 transition-colors', FOCUS_RING)}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            ref={acceptRef}
            data-testid="confirm-accept"
            onClick={accept}
            className={cn(
              'px-4 py-2 text-sm rounded-lg font-medium transition-colors text-white',
              FOCUS_RING,
              entry.tone === 'danger' ? CONFIRM_ACCEPT.danger : CONFIRM_ACCEPT.ok,
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmDialog;
