// Imperative UI singletons that replace window.confirm / window.alert.
// Ported from svrz_rc src/components/ui/store.ts:1-123.
//
// Deliberately NOT a React context: call sites are plain async handlers deep
// inside screens (and possibly in separate React roots). A module-level store
// plus useSyncExternalStore gives the same reactivity with a plain function
// call: `if (!(await confirmDialog({...}))) return;` and `toast.success('...')`.
//
// Render <UiHost /> (UiHost.jsx) ONCE per React root, as a sibling of the
// routed page (svrz_rc main.tsx:265-269).

/* ── Confirm ─────────────────────────────────────────────────────────── */
// ConfirmOptions: { title: string, message?: ReactNode, confirmLabel?: string,
//                   cancelLabel?: string, tone?: 'danger' | 'default', lang?: 'DE' | 'EN' }

let seq = 0;
// A queue, not a single slot: a second confirmDialog() while one is open waits
// its turn, and every promise resolves exactly once. (store.ts:28-31)
let confirmQueue = [];
const confirmListeners = new Set();

const emitConfirm = () => { confirmListeners.forEach((l) => l()); };

export function subscribeConfirm(listener) {
  confirmListeners.add(listener);
  // A Set makes StrictMode's subscribe → unsubscribe → subscribe a no-op.
  return () => { confirmListeners.delete(listener); };
}

/** The dialog currently on screen, or null. Reference-stable between changes. */
export function getConfirmSnapshot() {
  return confirmQueue.length > 0 ? confirmQueue[0] : null;
}

/** Whether a <UiHost /> (its ConfirmDialog) is mounted to show a confirm.
 *  None after an error boundary replaced the tree with its error screen. */
export function hasConfirmHost() {
  return confirmListeners.size > 0;
}

/**
 * Ask the user to confirm something. Resolves true on confirm, false on cancel,
 * Escape or a backdrop click. Never rejects. (store.ts:48-57)
 *
 * `opts.signal` (an AbortSignal): aborting it takes the dialog away as if
 * cancelled (resolves false), e.g. a more important question replaces it.
 */
export function confirmDialog(opts) {
  const { signal, ...rest } = opts ?? {};
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(false); return; }
    const id = ++seq;
    confirmQueue = [...confirmQueue, { ...rest, id, resolve }];
    emitConfirm();
    signal?.addEventListener?.('abort', () => settleConfirm(id, false), { once: true });
  });
}

/** Settle one queued dialog. Ignores ids already gone, so a double click or a
 *  StrictMode-replayed handler cannot resolve the same promise twice. */
export function settleConfirm(id, answer) {
  const entry = confirmQueue.find((e) => e.id === id);
  if (!entry) return;
  confirmQueue = confirmQueue.filter((e) => e.id !== id);
  emitConfirm();
  entry.resolve(answer);
}

/* ── Toasts ──────────────────────────────────────────────────────────── */
// kind: 'success' | 'error' | 'info'
// ToastOptions: { duration?: number (ms; 0 or negative pins it), lang?: 'DE' | 'EN' }
// (lang is kept on the item; the dismiss label follows the app's i18n language, Toast.jsx)

// Anything past this is dropped oldest-first, so a burst cannot bury the
// screen. (store.ts:81-87)
const MAX_VISIBLE = 4;
const DEFAULT_MS = 4000;
// Errors get longer: they usually carry something the user must read.
const ERROR_MS = 6000;

let toastList = [];
const toastListeners = new Set();

const emitToasts = () => { toastListeners.forEach((l) => l()); };

export function subscribeToasts(listener) {
  toastListeners.add(listener);
  return () => { toastListeners.delete(listener); };
}

export function getToastsSnapshot() { return toastList; }

export function dismissToast(id) {
  if (!toastList.some((t) => t.id === id)) return;
  toastList = toastList.filter((t) => t.id !== id);
  emitToasts();
}

function pushToast(kind, message, opts) {
  const id = ++seq;
  const duration = opts?.duration ?? (kind === 'error' ? ERROR_MS : DEFAULT_MS);
  const next = [...toastList, { id, kind, message, duration, lang: opts?.lang ?? 'DE' }];
  toastList = next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
  emitToasts();
  return id;
}

/** Transient notices. Each call returns the toast id, for `toast.dismiss(id)`. */
export const toast = {
  success: (message, opts) => pushToast('success', message, opts),
  error: (message, opts) => pushToast('error', message, opts),
  info: (message, opts) => pushToast('info', message, opts),
  dismiss: (id) => dismissToast(id),
  clear: () => { if (toastList.length) { toastList = []; emitToasts(); } },
};
