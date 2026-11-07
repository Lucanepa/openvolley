import { useEffect, useRef, type RefObject } from 'react';
import { flushSync } from 'react-dom';

interface Fingers {
  length: number;
  [index: number]: { clientX: number; clientY: number };
}

const spread = (t: Fingers) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
const middle = (t: Fingers) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });

interface PinchZoomOptions {
  /** the element that scrolls; its touch-action leaves two fingers to the page */
  scrollRef: RefObject<HTMLElement | null>;
  /** the box of the sheet's scaled size: what stays under the fingers */
  boxRef: RefObject<HTMLElement | null>;
  zoom: number;
  setZoom: (zoom: number) => void;
  min: number;
  max: number;
}

/**
 * Two fingers zoom the sheet, one a frame, and the place between them stays there. The sheet
 * is the app's own scale, as with its zoom buttons, so it is redrawn sharp at the new size.
 */
export function usePinchZoom({ scrollRef, boxRef, zoom, setZoom, min, max }: PinchZoomOptions) {
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const setZoomRef = useRef(setZoom);
  setZoomRef.current = setZoom;

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return undefined;
    let start: { spread: number; zoom: number; rx: number; ry: number } | null = null;
    let latest: { zoom: number; x: number; y: number } | null = null;
    let frame = 0;

    const commit = () => {
      frame = 0;
      if (!start || !latest) return;
      const { zoom: next, x, y } = latest;
      flushSync(() => setZoomRef.current(next));
      const box = boxRef.current?.getBoundingClientRect();
      if (box?.width) {
        scroller.scrollLeft += box.left + start.rx * box.width - x;
        scroller.scrollTop += box.top + start.ry * box.height - y;
      }
    };
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      const apart = spread(e.touches);
      if (!apart) return;
      e.preventDefault();
      const box = boxRef.current?.getBoundingClientRect();
      const { x, y } = middle(e.touches);
      start = {
        spread: apart,
        zoom: zoomRef.current,
        rx: box?.width ? (x - box.left) / box.width : 0,
        ry: box?.height ? (y - box.top) / box.height : 0,
      };
    };
    const onMove = (e: TouchEvent) => {
      if (!start || e.touches.length !== 2) return;
      e.preventDefault();
      const scaled = (start.zoom * spread(e.touches)) / start.spread;
      latest = { zoom: Math.round(Math.min(max, Math.max(min, scaled)) * 100) / 100, ...middle(e.touches) };
      if (!frame) frame = requestAnimationFrame(commit);
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) start = null;
    };

    scroller.addEventListener('touchstart', onStart, { passive: false });
    scroller.addEventListener('touchmove', onMove, { passive: false });
    scroller.addEventListener('touchend', onEnd);
    scroller.addEventListener('touchcancel', onEnd);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      scroller.removeEventListener('touchstart', onStart);
      scroller.removeEventListener('touchmove', onMove);
      scroller.removeEventListener('touchend', onEnd);
      scroller.removeEventListener('touchcancel', onEnd);
    };
  }, [scrollRef, boxRef, min, max]);
}
