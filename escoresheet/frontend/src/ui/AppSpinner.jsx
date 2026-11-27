// The branded loading spinner: a volleyball running an elliptical orbit round
// the middle, where an optional mark is held still.
// Port of svrz_rc src/components/AppSpinner.tsx:1-136. Needs the `.svrz-orbit`
// rule from tokens.css (svrz_rc index.css:105-129).
//
// The orbit is a real ellipse tilted 45°, not a circle under a rotated parent
// (a squashed spinning parent shears whatever rides on it). The ball follows a
// path() via CSS offset-path, so prefers-reduced-motion can stop it.
// The path coordinates are pixels in a fixed 186px box; `size` scales the whole
// thing with one transform rather than re-deriving geometry.
//
// Ball only (owner 27.11.2026: "the whistle does not spin, take it out and its
// orbit, only the ball"). A referee's whistle (Lucide) ran a second orbit,
// crossed with the ball's, half a lap behind it. Its inline animation-delay
// matched the animations-off rule in tailwind.css (html[data-no-motion]
// [style*='animation']), so with Options › Effects and speed › animations off
// the whistle stood still on its track while the ball went round (Chromium,
// 27.11.2026).
//
// The ball is Phosphor's Volleyball (@phosphor-icons/react, MIT), credited
// under Options -> App version (HomeOptionsModal.jsx). It replaces the Game
// Icons (CC BY 3.0) artwork svrz_rc still uses.
//
// `mark` is what sits in the middle — svrz_rc renders its logo there
// (AppSpinner.tsx:121, `h-6`). Pass an <img className="h-6 w-auto" /> or your
// wordmark; it is centred for you.

import { Volleyball } from '@phosphor-icons/react';
import { Whistle as LucideWhistle } from 'lucide-react';

const BOX = 186;
const CENTRE = BOX / 2;
const RX = 78;
const RY = 32;

// An ellipse tilted by `deg`, drawn as two arcs between the ends of its major axis.
function tiltedEllipsePath(deg) {
  const rad = (deg * Math.PI) / 180;
  const dx = RX * Math.cos(rad);
  const dy = RX * Math.sin(rad);
  const ax = (CENTRE - dx).toFixed(2);
  const ay = (CENTRE - dy).toFixed(2);
  const bx = (CENTRE + dx).toFixed(2);
  const by = (CENTRE + dy).toFixed(2);
  return `M ${ax},${ay} A ${RX},${RY} ${deg} 1 0 ${bx},${by} A ${RX},${RY} ${deg} 1 0 ${ax},${ay}`;
}

const BALL_ORBIT = tiltedEllipsePath(45);

// Ball size: big enough that its seams survive at a glance.
const SAT = 33;

function Ball({ className }) {
  return <Volleyball size={SAT} weight="bold" className={className} aria-hidden="true" focusable="false" />;
}

// The referee view's entry art (RefereeApp.jsx), at a larger `size`. No
// longer part of the spinner.
export function Whistle({ className, size = SAT, strokeWidth = 2.5 }) {
  return <LucideWhistle size={size} strokeWidth={strokeWidth} className={className} aria-hidden="true" focusable="false" />;
}

export function AppSpinner({
  /** Rendered width/height in px. The geometry is scaled, never recomputed. */
  size = BOX,
  /** Announced to screen readers and shown under the mark when present. */
  label,
  /** Fallback screen-reader text when there is no visible label. */
  srLabel = 'Wird geladen…',
  /** Centre mark (logo/wordmark). Optional. */
  mark,
  className = '',
}) {
  const scale = size / BOX;
  return (
    <div className={`flex flex-col items-center gap-3 ${className}`} role="status" aria-busy="true">
      <div style={{ width: size, height: size }} className="relative shrink-0" aria-hidden="true">
        <div
          style={{ width: BOX, height: BOX, transform: `scale(${scale})`, transformOrigin: 'top left' }}
          className="absolute left-0 top-0"
        >
          {/* The track. Faint on purpose: it explains the motion without
              competing with the mark it surrounds. stone-200 = #e7e5e4. */}
          <svg viewBox={`0 0 ${BOX} ${BOX}`} className="absolute inset-0 h-full w-full">
            <path d={BALL_ORBIT} fill="none" stroke="#e7e5e4" strokeWidth="1.25" />
          </svg>

          {/* The mark first, so the ball paints OVER it: a ball cut in half
              on the way behind the mark reads as a rendering fault. */}
          {mark && (
            <span className="absolute left-1/2 top-1/2 h-6 -translate-x-1/2 -translate-y-1/2 inline-flex items-center [&>*]:h-6 [&>*]:w-auto">
              {mark}
            </span>
          )}

          {/* No inline animation property here: tailwind.css stops every
              element whose style names one when the animations are off, and
              the spinner keeps turning then (a wait should not look frozen). */}
          <span className="svrz-orbit" style={{ offsetPath: `path("${BALL_ORBIT}")` }}>
            <Ball className="text-stone-500 drop-shadow-sm" />
          </span>
        </div>
      </div>
      {label && <p className="text-xs font-medium text-stone-500">{label}</p>}
      <span className="sr-only">{label || srLabel}</span>
    </div>
  );
}

export default AppSpinner;
