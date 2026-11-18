// When a dropdown menu stops being a popover and becomes a centred modal.
//
// A popover hangs from its button. On a small screen there is no room for
// that: the scoring screen's Match menu opened upwards off a small tablet
// (Galaxy Tab A7 Lite, 1005x600 CSS px, 17.11.2026) and its first rows could
// not be reached, the header menu ran off the bottom. Below this size
// (CSS px, short side x long side, either orientation) every menu of the app
// opens as a modal in the middle of the screen (ui/MenuPopover.jsx): phones
// either way round and small tablets (an 8" tablet held sideways is about
// 962x601, the Tab A7 Lite 1005x600). A 10" tablet (1280x800) and a laptop,
// even in a short browser window (1366x650), keep the popovers.
//
// The scoring screen centres its court-anchored menus below the same size
// (components/scoreboard/phoneLayout.js dialogsCentred).
import { useEffect, useState } from 'react';

export const MENU_MODAL_BELOW = { short: 700, long: 1100 };

/**
 * True when menus open as a centred modal on a viewport of this size.
 * @param {{ width: number, height: number }} size CSS px
 */
export function menusAsModal({ width, height } = {}) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (!w || !h) return false;
  return Math.min(w, h) < MENU_MODAL_BELOW.short && Math.max(w, h) < MENU_MODAL_BELOW.long;
}

function viewportSize() {
  if (typeof window === 'undefined') return { width: 0, height: 0 };
  return { width: window.innerWidth || 0, height: window.innerHeight || 0 };
}

/** menusAsModal() for the window, kept up to date on resize and rotation. */
export function useMenusAsModal() {
  const [modal, setModal] = useState(() => menusAsModal(viewportSize()));
  useEffect(() => {
    const update = () => setModal(menusAsModal(viewportSize()));
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);
  return modal;
}
