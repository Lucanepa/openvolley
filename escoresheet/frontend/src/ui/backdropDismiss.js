// Close an overlay when its backdrop is tapped, and only then.
//
// A plain `onClick={onClose}` on a backdrop also fires when a press starts
// INSIDE the dialog and ends over the backdrop: the browser sends `click` to
// the nearest common ancestor of the press and the release, which is the
// backdrop. Selecting a whole password with the mouse, dragging a slider or a
// signature stroke past the panel edge then closed the dialog and threw away
// what was typed. `e.stopPropagation()` on the panel does not help — the click
// never reaches the panel.
//
// backdropDismiss() returns props for the backdrop element. It dismisses only
// when the press AND the release both landed on the backdrop itself (not a
// child), and not while text inside the overlay is selected. A tap on the
// backdrop still closes it on touch screens (pointerdown/pointerup and the
// compatibility mousedown/mouseup/click all hit the backdrop); a touch-drag
// selection that ends on it does not.
//
//   <div className="fixed inset-0 ..." {...backdropDismiss(onClose)}>
//     <div role="dialog">...</div>
//   </div>
//
// Options:
//   enabled          false = a click on the backdrop never dismisses.
//   stopPropagation  true = call e.stopPropagation() on every click on the backdrop,
//                    dismissing or not (for overlays that used to do that inline).
//
// Escape and close buttons are not handled here; keep them as they are.
//
// Press state lives on the element (WeakMap), not in a hook, so this works in
// class components, inside .map() and in the long conditional JSX of the
// scoring screens without new hooks.

const presses = new WeakMap();

function isOnBackdrop(e) {
  return e.target === e.currentTarget;
}

/** A non-empty text selection anchored inside `el` (e.g. a dragged selection in the dialog). */
function hasSelectionWithin(el) {
  try {
    const sel = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null;
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
    if (String(sel).length === 0) return false;
    const node = sel.anchorNode;
    return !!node && el.contains(node);
  } catch {
    return false;
  }
}

/**
 * Props for a backdrop that dismisses on a real tap/click on itself.
 * @param {(e: Event) => void} onDismiss
 * @param {{ enabled?: boolean, stopPropagation?: boolean }} [options]
 */
export function backdropDismiss(onDismiss, options = {}) {
  const { enabled = true, stopPropagation = false } = options;

  const press = (e) => {
    presses.set(e.currentTarget, { down: isOnBackdrop(e), up: false });
  };
  const release = (e) => {
    const p = presses.get(e.currentTarget);
    if (p) p.up = isOnBackdrop(e);
  };
  const forget = (e) => {
    presses.delete(e.currentTarget);
  };

  // Capture phase: the backdrop records every press and release in its
  // subtree before any child handler runs, so a child that stops propagation
  // (a canvas, a slider) cannot leave an old "press on the backdrop" behind
  // for a later drag out of it to complete.
  return {
    onPointerDownCapture: press,
    onMouseDownCapture: press,
    onPointerUpCapture: release,
    onMouseUpCapture: release,
    // A press that turned into a scroll / gesture never completes a tap.
    onPointerCancelCapture: forget,
    onClick: (e) => {
      if (stopPropagation) e.stopPropagation();
      const el = e.currentTarget;
      const p = presses.get(el);
      presses.delete(el);
      if (!enabled || typeof onDismiss !== 'function') return;
      if (!isOnBackdrop(e)) return;
      if (!p || !p.down || !p.up) return;
      if (hasSelectionWithin(el)) return;
      onDismiss(e);
    },
  };
}

export default backdropDismiss;
