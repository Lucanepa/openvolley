import { teamBoxStyle } from '../../utils/teamColours.js'

/**
 * The referee view's score row: left score : right score, with the SERVE
 * block (serving team, server's number) beside the serving team's score.
 *
 * Before, SERVE was a small label and a bordered box squeezed into the screen
 * corner, while the space between it and the score stayed empty. Now each
 * side of the score is a slot of the same width (1fr | score | 1fr), both
 * always rendered, so the score never moves when the serve changes side;
 * the block fills the serving side's slot up to `SERVE_BLOCK.widthVmin`,
 * next to the score, in the serving team's colour, and exactly as tall as
 * the score digits, so the row (and the court under it) keeps its height.
 * Left and right are the referee's: they follow the 1st / 2nd referee view
 * and the court switches, like the scores.
 */
export const SCORE_ROW = {
  /** score digits, vmin (line height 1: the row's height) */
  scoreVmin: 15,
  colonVmin: 11
}

export const SERVE_BLOCK = {
  /** as tall as the score digits */
  heightVmin: SCORE_ROW.scoreVmin,
  /** at most this wide; never wider than its slot */
  widthVmin: 26,
  /** SERVE label, vmin, and at most this share of the block width (AUFSCHLAG, SERVIZIO fit) */
  labelVmin: 3.4,
  labelCqi: 13,
  /** server's number, vmin, and at most this share of the block width (two digits) */
  numberVmin: 9.5,
  numberCqi: 55
}

/**
 * @param {object} props
 * @param {string|number} props.leftScore
 * @param {string|number} props.rightScore
 * @param {'left'|'right'|null} props.servingSide
 * @param {string|number|null} props.serverNumber the player in position I of the serving team
 * @param {string} [props.servingColour] the serving team's colour (team box style)
 * @param {string} props.serveLabel "SERVE", translated
 * @param {(v: number) => number} props.vmin scaled vmin to px (useScaledLayout)
 * @param {string} [props.scoreFont]
 */
export default function ScoreServeRow({ leftScore, rightScore, servingSide, serverNumber, servingColour, serveLabel, vmin, scoreFont = 'inherit' }) {
  const slot = (side) => (
    <div
      data-serve-slot={side}
      style={{
        display: 'flex',
        alignItems: 'center',
        // next to the score: the block sits on the serving team's side of it
        justifyContent: side === 'left' ? 'flex-end' : 'flex-start',
        minWidth: 0,
        height: vmin(SERVE_BLOCK.heightVmin)
      }}
    >
      {servingSide === side && (
        <ServeBlock side={side} label={serveLabel} number={serverNumber} colour={servingColour} vmin={vmin} />
      )}
    </div>
  )

  const digits = { fontFamily: scoreFont, fontSize: vmin(SCORE_ROW.scoreVmin), fontWeight: 600, lineHeight: 1 }
  return (
    <div
      data-score-row=""
      style={{
        // Two equal slots around the score: the score stays centred and the
        // empty slot keeps the serve block's room on the other side.
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
        alignItems: 'center',
        columnGap: 'clamp(8px, 2vw, 24px)',
        width: '100%',
        maxWidth: '100%',
        padding: '0 clamp(10px, 2.5vw, 24px)',
        boxSizing: 'border-box'
      }}
    >
      {slot('left')}
      <div data-score="" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'clamp(4px, 1vw, 12px)' }}>
        <span style={{ ...digits, textAlign: 'right' }}>{leftScore}</span>
        <span style={{ fontFamily: scoreFont, fontSize: vmin(SCORE_ROW.colonVmin), fontWeight: 800, color: 'var(--accent)', lineHeight: 1, marginTop: vmin(-0.5) }}>:</span>
        <span style={{ ...digits, textAlign: 'left' }}>{rightScore}</span>
      </div>
      {slot('right')}
    </div>
  )
}

function ServeBlock({ side, label, number, colour, vmin }) {
  const B = SERVE_BLOCK
  return (
    <div
      data-serve-block={side}
      style={{
        ...teamBoxStyle(colour, { fallback: '#22c55e', ringWidth: 3 }),
        // the label and number size from the block's own width (cqi), so a
        // narrow portrait slot or a long label never spills
        containerType: 'inline-size',
        boxSizing: 'border-box',
        width: `min(100%, ${vmin(B.widthVmin)}px)`,
        height: vmin(B.heightVmin),
        borderRadius: 'clamp(8px, 1.4vw, 16px)',
        padding: `${vmin(0.8)}px ${vmin(1)}px`,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden'
      }}
    >
      <span
        data-serve-label=""
        style={{
          fontSize: `min(${vmin(B.labelVmin)}px, ${B.labelCqi}cqi)`,
          fontWeight: 800,
          letterSpacing: '0.06em',
          lineHeight: 1.1,
          whiteSpace: 'nowrap',
          maxWidth: '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }}
      >
        {label}
      </span>
      <span
        data-serve-number=""
        style={{
          fontSize: `min(${vmin(B.numberVmin)}px, ${B.numberCqi}cqi)`,
          fontWeight: 800,
          lineHeight: 1,
          fontVariantNumeric: 'tabular-nums'
        }}
      >
        {number ?? ''}
      </span>
    </div>
  )
}
