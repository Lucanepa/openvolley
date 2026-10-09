import { useId } from 'react'
import { contrastRatio, normaliseColour, parseColour, readableTextOn } from '../utils/teamColours'

// A short-sleeved jersey in one path, drawn on the shirt's 38 x 36 box (body
// x 1-37, y 0-36); the sleeves reach out to x -11 / 49 and the back of the
// neck up to y -2.3, inside the viewBox below.
export const SHIRT_PATH =
  'M12 -1 Q19 -2.8 26 -1 L36 1 L49 9 L44.2 17.4 L37 13 L37 33 Q37 36 34 36 ' +
  'L4 36 Q1 36 1 33 L1 13 L-6.2 17.4 L-11 9 L2 1 Z'
// The inside of the shirt seen through the neck, and the ribbed front collar
const NECK_PATH = 'M12 -1 Q19 -2.8 26 -1 Q19 7 12 -1 Z'
const COLLAR_PATH = 'M12 -1 Q19 7 26 -1 L28 -0.6 Q19 10 10 -0.6 Z'
const SEAMS_PATH = 'M2.6 1.4 L1.4 12.6 M35.4 1.4 L36.6 12.6'
const VIEW_BOX = '-13 -5 64 43'

const CARD = '#ffffff'
const MIN_EDGE = 3
const FALLBACK_FILL = '#2563eb'

function mix(a, b, t) {
  const x = parseColour(a), y = parseColour(b)
  const ch = (k) => Math.round(x[k] + (y[k] - x[k]) * t).toString(16).padStart(2, '0')
  return `#${ch('r')}${ch('g')}${ch('b')}`
}

/**
 * The shirt's outline: the fill darkened (a third at least, so a mid-tone
 * shirt keeps a seam) until it stands 3:1 off a white card. A white shirt
 * gets a grey edge, a yellow one an ochre edge, black and navy a darker
 * shade of themselves.
 * @param {string} fill the team colour
 * @returns {string} '#rrggbb'
 */
export function shirtEdge(fill) {
  const f = normaliseColour(fill)
  if (!f) return '#57534e'
  for (let t = 0.35; t < 1; t += 0.05) {
    const edge = mix(f, '#000000', t)
    if ((contrastRatio(edge, CARD) ?? 21) >= MIN_EDGE) return edge
  }
  return '#000000'
}

/**
 * A team shirt in the team colour with a number on it: a jersey silhouette
 * with an outline that stays visible on a white card for every colour, and
 * light shading. It keeps the old CSS shirt's box (`.shirt`, 38 x 36 times the
 * scale factor, the sleeves drawn outside it), so callers scale and place it
 * the same way (style transform / margin).
 * @param {object} props
 * @param {string} props.color the team colour
 * @param {number|string} [props.number] shirt number (1)
 * @param {string} [props.numberColor] number colour, readableTextOn(color) by default
 * @param {string} [props.className]
 * @param {object} [props.style]
 */
export default function TeamShirt({ color, number = 1, numberColor, className, style, ...rest }) {
  const fill = normaliseColour(color) ?? FALLBACK_FILL
  const edge = shirtEdge(fill)
  const ink = numberColor ?? readableTextOn(fill)
  const lightInk = (contrastRatio(ink, '#000000') ?? 0) > (contrastRatio(ink, '#ffffff') ?? 0)
  const shade = `shirt-shade-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  return (
    <div className={className ? `shirt ${className}` : 'shirt'} style={style} data-color={fill} {...rest}>
      <svg viewBox={VIEW_BOX} aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={shade} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.22" />
            <stop offset="0.45" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="1" stopColor="#000000" stopOpacity="0.16" />
          </linearGradient>
        </defs>
        <path d={SHIRT_PATH} fill={fill} data-part="body" />
        <path d={SHIRT_PATH} fill={`url(#${shade})`} />
        <path d={NECK_PATH} fill={edge} fillOpacity="0.45" />
        <path d={COLLAR_PATH} fill={edge} fillOpacity="0.75" />
        <path d={SEAMS_PATH} fill="none" stroke={edge} strokeOpacity="0.6" strokeWidth="1" strokeLinecap="round" />
        <path
          d={SHIRT_PATH}
          fill="none"
          stroke={edge}
          strokeWidth="2"
          strokeLinejoin="round"
          data-part="outline"
        />
      </svg>
      <div className="number" style={{ color: ink, textShadow: lightInk ? undefined : 'none' }}>{number}</div>
    </div>
  )
}
