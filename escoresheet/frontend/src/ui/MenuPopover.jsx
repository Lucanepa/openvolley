// The one dropdown surface of the app: every menu and info popover opened
// from a button (the scoring screen's Match and Scoresheet menus, the header
// menus, the coin toss signatures, the connection and tablet popovers ...).
//
// Two faces, chosen by the screen size (ui/menuLayout.js):
//   - popover: a panel hanging from its button. It opens on the side with
//     more room when it does not fit on the preferred one, never leaves the
//     window (8px margin) and scrolls inside when it is taller than the room
//     it has. The room is measured from window.innerHeight, not 100vh: on an
//     Android tablet 100vh is taller than the visible page, and the Match menu
//     was pushed upwards off the screen (17.11.2026).
//   - modal: on phones and small tablets a centred modal (white rounded-2xl
//     panel, its name and a 44px close button on top, scrolling body) over the
//     menu scrim of the kit's ActionSheet (`bg-slate-900/40`, no blur).
//
// Both are rendered into document.body (a portal), so no ancestor with a
// transform, a filter or a container query can move or clip them.
//
// Closing: Escape (the focus goes back to the button), a press outside the
// panel (popover; the button itself and `insideRefs` do not count) or a tap
// on the scrim / the close button (modal). Arrow keys, Home and End move
// between the `[role=menuitem]` rows. The caller owns `open` and closes the
// menu when a row is chosen.
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from './cn.js';
import { FOCUS_RING } from './Button.jsx';
import { backdropDismiss } from './backdropDismiss.js';
import { useMenusAsModal } from './menuLayout.js';

const MARGIN = 8;
const GAP = 6;
const NAV_KEYS = ['ArrowDown', 'ArrowUp', 'Home', 'End'];

/** Popover panel (svrz anchored menu: rounded-xl, hairline, shadow-card-lg). */
export const MENU_POPOVER_PANEL = 'rounded-xl border border-stone-200 bg-white p-1.5 shadow-card-lg text-stone-700';

const MODAL_SIZES = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-2xl',
};

const contains = (ref, node) => !!(ref && ref.current && node && ref.current.contains(node));

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {(reason: 'escape'|'outside'|'close') => void} props.onClose
 * @param {{ current: HTMLElement|null }} props.anchorRef the button (or its wrapper) the popover hangs from
 * @param {string} props.label accessible name; also the modal's title unless `title` is given
 * @param {import('react').ReactNode} [props.title] the modal's visible title
 * @param {'start'|'center'|'end'} [props.align] popover edge lined up with the button
 * @param {'bottom'|'top'} [props.side] preferred side of the button
 * @param {'menu'|'dialog'|'group'} [props.role] role of the rows' container
 * @param {boolean} [props.keepMounted] keep the content mounted (hidden) while closed
 * @param {boolean|'auto'} [props.modal] force a face; 'auto' follows the screen size
 * @param {'sm'|'md'|'lg'} [props.modalSize] the modal's max width
 * @param {Array<{ current: HTMLElement|null }>} [props.insideRefs] more elements a press on does not close the popover
 * @param {boolean} [props.autoFocus] focus the first row when it opens (opened from the keyboard)
 * @param {string} [props.className] extra classes for the popover panel
 * @param {string} [props.bodyClassName] extra classes for the rows' container
 * @param {object} [props.panelProps] extra attributes for the panel (data-*, id)
 * @param {string} [props.closeLabel]
 * @param {number} [props.zIndex]
 */
export function MenuPopover({
  open,
  onClose,
  anchorRef,
  label,
  title,
  align = 'end',
  side = 'bottom',
  role = 'menu',
  keepMounted = false,
  modal = 'auto',
  modalSize = 'sm',
  insideRefs = [],
  autoFocus = false,
  className,
  bodyClassName,
  panelProps = {},
  closeLabel = 'Close',
  zIndex = 1000,
  children,
}) {
  const smallScreen = useMenusAsModal();
  const asModal = modal === 'auto' ? smallScreen : !!modal;
  const panelRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const insideRef = useRef(insideRefs);
  insideRef.current = insideRefs;

  const close = useCallback((reason) => onCloseRef.current?.(reason), []);

  // Popover: hang from the button, on the side with room, inside the window.
  const place = useCallback(() => {
    const panel = panelRef.current;
    const anchor = anchorRef?.current;
    if (!panel || asModal) return;
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    panel.style.maxHeight = '';
    const h = panel.offsetHeight;
    const w = panel.offsetWidth;
    const a = anchor ? anchor.getBoundingClientRect() : { top: MARGIN, bottom: MARGIN, left: vw - MARGIN, right: vw - MARGIN, width: 0 };
    const below = vh - MARGIN - (a.bottom + GAP);
    const above = a.top - GAP - MARGIN;
    let down = side !== 'top';
    if (down && h > below && above > below) down = false;
    else if (!down && h > above && below > above) down = true;
    let room = Math.max(0, down ? below : above);
    let top;
    if (room < Math.min(h, 160)) {
      // No useful room on either side (a button in the middle of a low
      // window): cover the window instead, still scrolling inside.
      room = Math.max(0, vh - 2 * MARGIN);
      top = Math.max(MARGIN, Math.min(a.bottom + GAP, vh - MARGIN - Math.min(h, room)));
    } else {
      top = down ? a.bottom + GAP : a.top - GAP - Math.min(h, room);
    }
    if (h > room) panel.style.maxHeight = `${Math.floor(room)}px`;
    let left = align === 'start' ? a.left : align === 'center' ? a.left + a.width / 2 - w / 2 : a.right - w;
    left = Math.min(Math.max(MARGIN, left), Math.max(MARGIN, vw - MARGIN - w));
    panel.style.top = `${Math.round(top)}px`;
    panel.style.left = `${Math.round(left)}px`;
    panel.style.opacity = '1';
  }, [anchorRef, asModal, align, side]);

  // Modal: never taller than the visible window (innerHeight, see above).
  const fitModal = useCallback(() => {
    const panel = panelRef.current;
    if (!panel || !asModal) return;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    if (vh) panel.style.maxHeight = `${Math.max(0, vh - 24)}px`;
  }, [asModal]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const update = () => { place(); fitModal(); };
    update();
    const panel = panelRef.current;
    const ro = typeof ResizeObserver === 'function' && panel ? new ResizeObserver(update) : null;
    // the content changes size (a language list folded out): place again
    if (ro && panel) {
      ro.observe(panel);
      if (panel.firstElementChild) ro.observe(panel.firstElementChild);
    }
    window.addEventListener('resize', update);
    if (!asModal) window.addEventListener('scroll', update, true);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, asModal, place, fitModal]);

  // Escape, arrow keys, a press outside (popover).
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      const panel = panelRef.current;
      if (!panel) return;
      if (e.key === 'Escape') {
        // A dialog opened over the menu owns its own Escape
        const top = document.activeElement?.closest?.('[aria-modal="true"]');
        if (top && !panel.contains(top) && top !== panel) return;
        e.stopPropagation();
        e.preventDefault();
        const hadFocus = panel.contains(document.activeElement);
        close('escape');
        if (hadFocus || asModal) anchorRef?.current?.focus?.();
        return;
      }
      if (!NAV_KEYS.includes(e.key)) return;
      const rows = [...panel.querySelectorAll('[role="menuitem"]:not([disabled])')];
      if (!rows.length) return;
      e.preventDefault();
      const at = rows.indexOf(document.activeElement);
      let next = 0;
      if (e.key === 'End') next = rows.length - 1;
      else if (e.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % rows.length;
      else if (e.key === 'ArrowUp') next = at < 0 ? rows.length - 1 : (at - 1 + rows.length) % rows.length;
      rows[next].focus();
    };
    const onPress = (e) => {
      if (asModal) return; // the scrim closes the modal (backdropDismiss)
      const target = e.target;
      if (contains(panelRef, target) || contains(anchorRef, target)) return;
      if ((insideRef.current || []).some((ref) => contains(ref, target))) return;
      close('outside');
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPress, true);
    document.addEventListener('mousedown', onPress, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPress, true);
      document.removeEventListener('mousedown', onPress, true);
    };
  }, [open, asModal, anchorRef, close]);

  // Focus: the first row when opened from the keyboard; the modal itself
  // otherwise (a screen reader lands in it, no focus ring is drawn).
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const first = panel.querySelector('[role="menuitem"]:not([disabled]), button:not([disabled])');
    if (autoFocus && first) first.focus();
    else if (asModal) panel.focus?.();
  }, [open, asModal, autoFocus]);

  if (!open && !keepMounted) return null;
  if (typeof document === 'undefined') return null;

  const bodyRole = role === 'dialog' ? undefined : role;

  if (asModal) {
    return createPortal(
      <div
        className={cn('ov-kit no-print fixed inset-0 items-center justify-center p-3', open ? 'flex' : 'hidden')}
        style={{ zIndex }}
        data-menu-modal=""
        onClick={(e) => e.stopPropagation()}
      >
        <div aria-hidden="true" className="absolute inset-0 bg-slate-900/40" {...backdropDismiss(() => close('outside'))} />
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label={label}
          tabIndex={-1}
          data-menu-popover="modal"
          {...panelProps}
          className={cn('relative flex max-h-full w-full flex-col rounded-2xl border border-stone-200 bg-white text-stone-700 shadow-xl outline-none', MODAL_SIZES[modalSize] || MODAL_SIZES.sm)}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-stone-100 py-1 pl-4 pr-1">
            <p className="m-0 min-w-0 truncate text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{title ?? label}</p>
            <button
              type="button"
              onClick={() => close('close')}
              aria-label={closeLabel}
              title={closeLabel}
              data-modal-close=""
              className={cn('inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-stone-500 hover:bg-stone-100', FOCUS_RING)}
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>
          <div role={bodyRole} aria-label={bodyRole ? label : undefined} className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5', bodyClassName)}>
            {children}
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      ref={panelRef}
      role={role}
      aria-label={label}
      data-menu-popover="popover"
      {...panelProps}
      onClick={(e) => e.stopPropagation()}
      // Transparent (not hidden) until placed: a hidden panel cannot take the focus.
      style={{ position: 'fixed', top: 0, left: 0, opacity: 0, zIndex }}
      className={cn(
        'ov-kit no-print w-max max-w-[calc(100vw-16px)] overflow-y-auto overscroll-contain',
        open ? 'flex flex-col' : 'hidden',
        MENU_POPOVER_PANEL,
        className,
        bodyClassName,
      )}
    >
      {children}
    </div>,
    document.body,
  );
}

export default MenuPopover;
