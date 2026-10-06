// The branded loading spinner: a mark held still in the middle while a
// volleyball and a referee's whistle run two crossed elliptical orbits round it.
// Port of svrz_rc src/components/AppSpinner.tsx:1-136. Needs the `.svrz-orbit`
// rule from tokens.css (svrz_rc index.css:105-129).
//
// The orbits are real ellipses tilted ±45°, not circles under a rotated parent
// (a squashed spinning parent shears whatever rides on it). Each satellite
// follows a path() via CSS offset-path, so prefers-reduced-motion can stop it.
// The path coordinates are pixels in a fixed 186px box; `size` scales the whole
// thing with one transform rather than re-deriving geometry.
//
// Ball + whistle: the same icon packs as wiedisync — the ball is Phosphor's
// Volleyball (@phosphor-icons/react, MIT; wiedisync's VolleyballIcon), the
// whistle is Lucide's Whistle (lucide-react, ISC). Both are credited under
// Options -> App version (HomeOptionsModal.jsx). They replace the Game Icons
// (CC BY 3.0) artwork svrz_rc still uses.
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
const REF_ORBIT = tiltedEllipsePath(-45);

// Satellite size: big enough that the ball's seams and the whistle's
// mouthpiece survive at a glance.
const SAT = 33;

function Ball({ className }) {
  return <Volleyball size={SAT} weight="bold" className={className} aria-hidden="true" focusable="false" />;
}

// Also the referee view's entry art (RefereeApp.jsx), at a larger `size`.
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
  /** Whistle colour — the brand. svrz_rc writes `text-[#e2001a]`; the kit uses the
   *  red-600 token (tokens.css maps it to #e2001a) so re-branding the tokens re-brands it. */
  accentClassName = 'text-red-600',
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
          {/* The tracks. Faint on purpose: they explain the motion without
              competing with the mark they surround. stone-200 = #e7e5e4. */}
          <svg viewBox={`0 0 ${BOX} ${BOX}`} className="absolute inset-0 h-full w-full">
            <g fill="none" stroke="#e7e5e4" strokeWidth="1.25">
              <path d={BALL_ORBIT} />
              <path d={REF_ORBIT} />
            </g>
          </svg>

          {/* The mark first, so the satellites paint OVER it: a ball cut in
              half on the way behind the mark reads as a rendering fault. */}
          {mark && (
            <span className="absolute left-1/2 top-1/2 h-6 -translate-x-1/2 -translate-y-1/2 inline-flex items-center [&>*]:h-6 [&>*]:w-auto">
              {mark}
            </span>
          )}

          {/* Offset by half a lap so the two are never on top of each other. */}
          <span className="svrz-orbit" style={{ offsetPath: `path("${BALL_ORBIT}")` }}>
            <Ball className="text-stone-500 drop-shadow-sm" />
          </span>
          <span className="svrz-orbit" style={{ offsetPath: `path("${REF_ORBIT}")`, animationDelay: '-1.3s' }}>
            <Whistle className={`${accentClassName} drop-shadow-sm`} />
          </span>
        </div>
      </div>
      {label && <p className="text-xs font-medium text-stone-500">{label}</p>}
      <span className="sr-only">{label || srLabel}</span>
    </div>
  );
}

export default AppSpinner;
