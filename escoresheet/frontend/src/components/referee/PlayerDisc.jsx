import ballFallback from '../../ball_fallback.png'
import { DISC, discCssVars } from './discSizing.js'
import { markColourOn } from '../../utils/teamColours.js'

// Primary ball image (with a bundled copy as fallback)
// The bundled, content-hashed ball (brand/ball.svg): an unhashed /ball.png could
// stay cached (old green ball) after an update
const ballImage = ballFallback

// Corner badge: a square of --disc-badge, inside the disc's box (never outset,
// so nothing on a disc can leave its column or the court).
const badgeBase = {
  position: 'absolute',
  boxSizing: 'border-box',
  minWidth: 'var(--disc-badge)',
  height: 'var(--disc-badge)',
  padding: '0 calc(var(--disc-badge) * 0.08)',
  borderRadius: 'calc(var(--disc-badge) * 0.2)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 'calc(var(--disc-badge) * 0.6)',
  fontWeight: 700,
  lineHeight: 1,
  whiteSpace: 'nowrap',
  fontVariantNumeric: 'tabular-nums'
}

// Card widths leave the bottom row room for LC / LR on the left even with
// all three sanctions on a 36 px disc (the smallest one)
const card = (color, widthShare = 0.38) => ({
  width: `calc(var(--disc-badge) * ${widthShare})`,
  height: 'calc(var(--disc-badge) * 0.72)',
  background: color,
  borderRadius: 2
})

const YELLOW = '#fde047'
const RED = '#ef4444'
const LIBERO_BLUE = '#3b82f6'
const SLATE = '#0f172a'

/**
 * One player on the referee court: a disc with the shirt number, the
 * position (top left), the player it replaced (top right: white for a
 * libero replacement, yellow for a substitution), libero and captain marks
 * (bottom left), sanction cards (bottom right), the LFP mark (top centre)
 * and the serve ball beside it. All sizes are shares of the disc diameter
 * (discSizing.js), so the disc, its number and its marks scale together with
 * the court.
 *
 * @param {object} props
 * @param {string|number} props.number
 * @param {string} props.position I..VI
 * @param {number} props.capPx largest diameter in px (discCapPx)
 * @param {'left'|'right'} props.side court half: the ball goes to the end-line side
 * @param {string} props.background disc fill (the team's shirt colour, see utils/teamColours.js)
 * @param {string} props.color number colour
 * @param {string} [props.textShadow] outline for the number on a mid-tone fill
 * @param {string|null} [props.ring] edge colour for a fill that would melt into the court (white, yellow...)
 * @param {boolean} [props.flash] recently substituted in: orange flashing ring
 * @param {boolean} [props.showBall]
 * @param {string|number|null} [props.replacedNumber]
 * @param {boolean} [props.replacedByLibero]
 * @param {string|null} [props.liberoLabel] L, L1, L2 (null: not a libero, or shown as LC)
 * @param {boolean} [props.liberoRedesignated]
 * @param {boolean} [props.liberoUnable]
 * @param {null|'C'|'GC'|'LC'|'LGC'} [props.captain] C captain, GC game captain, LC libero captain, LGC libero game captain
 * @param {{ warning?: boolean, penalty?: boolean, expulsion?: boolean, disqualification?: boolean }} [props.sanctions]
 * @param {null|boolean} [props.lfp] null: LFP tracking off; true/false: LFP / !LFP
 */
export default function PlayerDisc({
  number, position, capPx, side, background, color, textShadow, ring = null, flash = false, showBall = false,
  replacedNumber = null, replacedByLibero = false, liberoLabel = null, liberoRedesignated = false, liberoUnable = false,
  captain = null, sanctions = {}, lfp = null
}) {
  const { warning, penalty, expulsion, disqualification } = sanctions
  const hasSanction = warning || penalty || expulsion || disqualification
  const liberoCaptain = captain === 'LC' || captain === 'LGC'
  // The blue libero mark stays apart from a blue shirt
  const liberoMark = markColourOn(background, LIBERO_BLUE, SLATE)
  return (
    <div
      data-player-disc={position}
      style={{
        ...discCssVars(capPx, { lfp: lfp !== null }),
        position: 'relative',
        boxSizing: 'border-box',
        width: 'var(--disc)',
        height: 'var(--disc)',
        flexShrink: 0,
        border: flash ? '3px solid #f97316' : ring ? `2px solid ${ring}` : '1px solid var(--border)',
        borderRadius: '50%',
        background,
        color,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 'var(--disc-number)',
        lineHeight: 1,
        fontWeight: flash ? 900 : 700,
        fontVariantNumeric: 'tabular-nums',
        boxShadow: '0 3px 12px rgba(0, 0, 0, 0.5)',
        animation: flash ? 'recentSubFlash 0.5s ease-in-out infinite' : undefined
      }}
    >
      {showBall && (
        <img
          data-disc-ball=""
          src={ballImage}
          onError={(e) => { e.currentTarget.src = ballFallback }}
          alt="Ball"
          style={{
            position: 'absolute',
            // End-line side of the server's disc, inside the court: the ball
            // shrinks when the court is narrow (discSizing.js: --disc-ball).
            left: side === 'right' ? 'calc(100% + var(--disc-ball-gap))' : 'auto',
            right: side === 'left' ? 'calc(100% + var(--disc-ball-gap))' : 'auto',
            top: '50%',
            transform: 'translateY(-50%)',
            width: 'var(--disc-ball)',
            height: 'var(--disc-ball)',
            filter: 'drop-shadow(0 3px 8px rgba(0, 0, 0, 0.5))'
          }}
        />
      )}

      {/* Top left: position */}
      <span data-disc-badge="position" style={{
        ...badgeBase,
        top: 0,
        left: 0,
        background: 'rgba(15, 23, 42, 0.95)',
        border: '2px solid var(--border)',
        color: '#fff'
      }}>
        {position}
      </span>

      {/* Top centre: LFP */}
      {lfp !== null && (
        <span data-disc-badge="lfp" style={{
          ...badgeBase,
          top: 0,
          left: '50%',
          transform: 'translateX(-50%)',
          // Narrow enough to sit between the position and replaced-player
          // badges on the top row
          minWidth: 0,
          height: 'calc(var(--disc-badge) * 0.75)',
          padding: '0 calc(var(--disc-badge) * 0.06)',
          fontSize: `calc(var(--disc-badge) * ${DISC.lfp})`,
          letterSpacing: '-0.02em',
          background: lfp ? 'rgba(249, 115, 22, 0.95)' : 'rgba(147, 51, 234, 0.95)',
          border: '1px solid var(--border)',
          color: '#fff',
          zIndex: 3
        }}>
          {lfp ? 'LFP' : '!LFP'}
        </span>
      )}

      {/* Top right: the player this one replaced */}
      {replacedNumber != null && replacedNumber !== '' && (
        <span data-disc-badge="replaced" style={{
          ...badgeBase,
          top: 0,
          right: 0,
          background: replacedByLibero ? '#ffffff' : YELLOW,
          border: replacedByLibero ? '2px solid rgba(0, 0, 0, 0.3)' : '2px solid rgba(0, 0, 0, 0.25)',
          color: '#0f172a',
          boxShadow: '0 2px 4px rgba(0, 0, 0, 0.25)'
        }}>
          {replacedNumber}
        </span>
      )}

      {/* Bottom left: libero (L, L1, L2; LC replaces it for a libero captain) */}
      {liberoLabel && !liberoCaptain && (
        <span data-disc-badge="libero" style={{
          ...badgeBase,
          bottom: 0,
          left: 0,
          background: liberoMark,
          border: '2px solid var(--border)',
          color: '#fff'
        }}>
          <span style={{ position: 'relative', display: 'inline-block' }}>
            {liberoLabel}{liberoRedesignated && 'R'}
            {liberoUnable && (
              <span style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                fontSize: '1.2em',
                color: RED,
                fontWeight: 900
              }}>✕</span>
            )}
          </span>
        </span>
      )}

      {/* Captain: C (green) / game captain (amber), LC for a libero captain */}
      {captain && (
        <span data-disc-badge="captain" style={{
          ...badgeBase,
          bottom: 0,
          // Next to the L badge when both show
          left: liberoLabel && !liberoCaptain ? 'calc(var(--disc-badge) + 2px)' : 0,
          // LC keeps the type size of every other mark and widens its badge
          // instead (a smaller share fell to 5 px on a 36 px disc)
          background: captain === 'LC' ? '#ffffff' : captain === 'LGC' ? liberoMark : 'rgba(15, 23, 42, 0.95)',
          border: `2px solid ${captain === 'C' || captain === 'LC' ? '#22c55e' : '#fbbf24'}`,
          color: captain === 'C' || captain === 'LC' ? '#22c55e' : '#fbbf24'
        }}>
          {liberoCaptain ? 'LC' : 'C'}
        </span>
      )}

      {/* Bottom right: sanction cards (official yellow / red) */}
      {hasSanction && (
        <span data-disc-badge="sanctions" style={{
          position: 'absolute',
          boxSizing: 'border-box',
          bottom: 0,
          right: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 'calc(var(--disc-badge) * 0.06)',
          height: 'var(--disc-badge)',
          padding: '0 calc(var(--disc-badge) * 0.06)',
          background: 'rgba(0, 0, 0, 0.6)',
          borderRadius: 'calc(var(--disc-badge) * 0.2)'
        }}>
          {warning && <span title="Warning" style={card(YELLOW)} />}
          {(penalty || disqualification) && <span title={disqualification ? 'Disqualification' : 'Penalty'} style={card(RED)} />}
          {expulsion && (
            <span title="Expulsion" style={{ display: 'flex', gap: 1 }}>
              <span style={card(YELLOW, 0.3)} />
              <span style={card(RED, 0.3)} />
            </span>
          )}
        </span>
      )}

      <span data-disc-number="" style={textShadow ? { textShadow } : undefined}>{number}</span>
    </div>
  )
}
