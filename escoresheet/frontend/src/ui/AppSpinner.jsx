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
// Ball + whistle artwork: Game Icons (game-icons.net), CC BY 3.0 — the app owes
// a visible credit (svrz_rc puts it in the footer, App.tsx:10844-10856). Do not
// ship these icons without it.
//
// `mark` is what sits in the middle — svrz_rc renders its logo there
// (AppSpinner.tsx:121, `h-6`). Pass an <img className="h-6 w-auto" /> or your
// wordmark; it is centred for you.

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
  return (
    <svg viewBox="0 0 512 512" width={SAT} height={SAT} fill="currentColor" className={className} aria-hidden="true">
      <path d="M465.506 158.69c-7.138-15.368-15.758-29.567-25.59-42.534-79.844-32.376-162.79-47.333-241.834-28.292-.137 19.33 3.188 40.914 11.305 64.778 70.284-9.598 160.966-24.52 268.618 39.385-3.26-11.245-7.413-22.386-12.5-33.337zm18.203 58.117c-107.69-70.687-194.512-57.03-267.76-46.902 9.848 23.498 24.222 49.02 44.244 76.587 70.258-7.422 118.49-1.61 153.922 12.618 30.108 12.09 50.54 30.325 66.713 50.185 7.1-29.894 8.275-61.334 2.88-92.488zm-69.896-129.6C359.93 36.814 284.106 14.612 210.56 29.46c-5.302 11.677-9.29 24.886-11.21 39.638 71.034-15.765 144.075-5.9 214.464 18.108zm60.815 243.53c-6.477-8.88-13.35-17.292-21.234-25.016-21.66 58.178-65.025 121.3-123.31 169.086 7.814-2.658 15.567-5.747 23.224-9.303 59.5-27.636 101.667-77.3 121.32-134.765zm-35.86-37.554c-8.967-6.636-19.227-12.496-31.36-17.37-11.717-4.704-25.292-8.457-41.19-10.96-32.206 124.328-98.617 181.332-160.352 216.69 25.82 5.753 52.735 7.112 79.583 3.643 74.39-48.188 130.225-125.46 153.32-192.003zm-90.565-30.525c-23.448-2.084-51.307-1.765-84.702 1.68-9.487 42.888-40.296 85.676-75.02 117.702-18.286 16.867-37.704 30.693-56.217 39.685-9.17 4.454-18.15 7.824-26.79 9.61 22.383 19.208 48.125 33.814 75.663 43.25 63.77-33.438 133.133-83.017 167.065-211.927zM189.09 34.885c-10.246 3.118-20.402 6.967-30.397 11.61-16.593 7.706-31.83 17.133-45.616 27.957-5.89 87.158 20.142 182.194 93.732 261.375 19.46-24.644 34.454-52.15 39.635-77.65-68.615-94.02-75.7-169.977-57.355-223.292zM94.333 90.902c-16.992 16.624-31.13 35.613-42.11 56.184l.81.353c-3.846 8.868-4.613 27.78-1.037 50.583 3.576 22.803 10.945 49.684 20.782 76.314 18.458 49.964 46.624 99.226 71.283 119.88 10.69-7.05 21.652-15.663 32.22-25.41 6.485-5.98 12.812-12.396 18.854-19.124-73.19-77.916-102.486-171.463-100.8-258.78zm-61.037 103.59c-14.097 50.973-10.85 107.033 13.2 158.815 10.717 23.072 24.754 43.528 41.265 61.087 8.89 1.098 21.96-1.727 36.642-8.86 1.09-.528 2.19-1.082 3.297-1.655-28.57-26.227-53.71-74.316-71.807-123.305C45.707 253 38.038 225.2 34.213 200.812c-.335-2.138-.635-4.238-.917-6.32z" />
    </svg>
  );
}

function Whistle({ className }) {
  return (
    <svg viewBox="0 0 512 512" width={SAT} height={SAT} fill="currentColor" className={className} aria-hidden="true">
      <path d="M93.75 81.443c-5.38 0-12.368 2.49-22.358 8.967 3.966 4.682 8.167 9.687 16.47 19.256 5.782 6.663 11.618 13.29 16.026 18.088.038.042.055.055.092.096l30.894-17.932-14.652-14.148c-11.292-9.404-18.644-13.866-25.418-14.293-.345-.022-.696-.034-1.055-.034zm120.08 15.082c-.885-.01-1.767-.006-2.643.01-10.46.193-20.2 2.23-26.742 5.424l-67.262 39.038c2.45.544 4.885 1.196 7.287 2.02 17.275 5.923 33.093 18.223 49.568 34.7l216.44 213.5 80.978-44.433L258.54 111.38c-8.656-7.84-22.49-12.908-36.693-14.394-2.677-.28-5.363-.43-8.018-.46zM58.192 102.74c-17.543 20.723-20.57 37.186-15.326 57.004.692 2.618 3.057 6.357 6.373 10.47 2.195-3.144 4.55-6.304 7.086-9.478 3.99-4.995 8.385-9.183 13.085-12.558l-.106-.2 2.768-1.61c1.354-.862 2.73-1.66 4.13-2.393l11.868-6.89c-4.175-4.618-8.94-10.017-13.803-15.622-5.956-6.864-11.732-13.62-16.074-18.723zm184.093 13.438l58.415 61.67c-46.086-5.037-56.79 13.2-69.027 34.2l-57.334-59.304 67.946-36.566zM103.702 157.23c-.714-.016-1.43-.016-2.15.002-6.976.18-14.207 2.058-22.252 5.885-3.035 2.29-5.99 5.196-8.91 8.852-25.77 32.264-30.45 59.135-25.484 83.477 4.965 24.343 20.536 46.656 37.916 66.455 13.314 15.168 28.86 23.992 48.472 27.93 19.614 3.94 43.438 2.708 71.98-3.475 33.246-7.2 66.01 8.42 95.81 27.665 26.118 16.868 50.676 37.09 70.98 49.95l8.79-18.935-217.52-214.57-.022-.022c-15.524-15.524-29.565-25.905-42.682-30.402-5.02-1.722-9.925-2.695-14.928-2.813zm367.08 210.456l-73.45 40.304-10.48 22.567 70.833-38.41 13.096-24.46z" />
    </svg>
  );
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
