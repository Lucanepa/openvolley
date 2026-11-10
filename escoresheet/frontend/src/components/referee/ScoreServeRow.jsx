/**
 * The referee view's score row: left score : right score, with the SERVE
 * block (serving team, server's number) beside the serving team's score.
 *
 * Before, SERVE was a small label and a bordered box squeezed into the screen
 * corner, while the space between it and the score stayed empty. Now each
 * side of the score is a slot of the same width (1fr | score | 1fr), both
 * always rendered, so the score never moves when the serve changes side;
 * the block sits next to the score, as wide as its content (the label, the
 * server's number with its padding: owner, 3.0.16 "auto width is fine"; it
 * filled the slot up to 26 vmin before) and exactly as tall as the score
 * digits, so the row (and the court under it) keeps its height. The number
 * box is two digits wide whatever the number, so #1 -> #12 moves nothing.
 * It is green like the scorer's SERVE indicator (Scoreboard.jsx
 * renderServeSide, owner 2026-11-09): the green SERVE label over a
 * light-green box with a green border and the server's number in green. It
 * wore the serving team's colour before; the team colours stay on the team
 * names, the A / B boxes and the discs.
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
  /**
   * SERVE label, vmin, and at most the slot width over its length: an
   * upper-case letter in bold with the letter spacing is up to ~0.76 em, so
   * 0.85 em a letter leaves a margin. A fixed share for the longest label
   * (AUFSCHLAG) made SERVE as small as AUFSCHLAG in a narrow slot.
   */
  labelVmin: 3.4,
  labelEmPerChar: 0.85,
  /**
   * server's number, vmin, and at most this share of the slot width: the box
   * is two digits (~1.11 em) plus its padding (2 x `numberPadEm`) and its
   * 3 px border, which 64cqi keeps inside a narrow portrait slot (150 %
   * display scale: 128 px) at about the old corner box's 7 vmin.
   */
  numberVmin: 8.6,
  numberCqi: 64,
  numberPadEm: 0.18
}

/** The label's largest font size as a share (cqi) of the slot width. */
export function serveLabelCqi(label) {
  const chars = Math.max(1, String(label ?? '').length)
  return Number((100 / (chars * SERVE_BLOCK.labelEmPerChar)).toFixed(2))
}

/** The scorer's serve green: the theme's accent (#22c55e in the light theme), as Scoreboard.jsx uses it. */
export const SERVE_GREEN = 'var(--accent, #22c55e)'
export const SERVE_GREEN_FILL = 'rgba(34, 197, 94, 0.1)'

/**
 * @param {object} props
 * @param {string|number} props.leftScore
 * @param {string|number} props.rightScore
 * @param {'left'|'right'|null} props.servingSide
 * @param {string|number|null} props.serverNumber the player in position I of the serving team
 * @param {string} props.serveLabel "SERVE", translated
 * @param {(v: number) => number} props.vmin scaled vmin to px (useScaledLayout)
 * @param {string} [props.scoreFont]
 */
export default function ScoreServeRow({ leftScore, rightScore, servingSide, serverNumber, serveLabel, vmin, scoreFont = 'inherit' }) {
  const slot = (side) => (
    <div
      data-serve-slot={side}
      style={{
        display: 'flex',
        alignItems: 'center',
        // next to the score: the block sits on the serving team's side of it
        justifyContent: side === 'left' ? 'flex-end' : 'flex-start',
        minWidth: 0,
        height: vmin(SERVE_BLOCK.heightVmin),
        // the label and number size from the slot's width (cqi), so a narrow
        // portrait slot or a long label never spills (the block itself is
        // as wide as its content: no container of its own)
        containerType: 'inline-size'
      }}
    >
      {servingSide === side && (
        <ServeBlock side={side} label={serveLabel} number={serverNumber} vmin={vmin} />
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

function ServeBlock({ side, label, number, vmin }) {
  const B = SERVE_BLOCK
  return (
    <div
      data-serve-block={side}
      style={{
        // as wide as the label or the number box, whichever is wider
        boxSizing: 'border-box',
        width: 'auto',
        maxWidth: '100%',
        height: vmin(B.heightVmin),
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: vmin(0.6),
        overflow: 'hidden'
      }}
    >
      {/* the scorer's green SERVE label, over the box */}
      <span
        data-serve-label=""
        style={{
          fontSize: `min(${vmin(B.labelVmin)}px, ${serveLabelCqi(label)}cqi)`,
          fontWeight: 800,
          letterSpacing: '0.06em',
          lineHeight: 1.1,
          color: SERVE_GREEN,
          textAlign: 'center',
          whiteSpace: 'nowrap',
          maxWidth: '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }}
      >
        {label}
      </span>
      <span
        data-serve-box=""
        style={{
          flex: '1 1 0',
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          // the number's size: the padding is in its em
          fontSize: `min(${vmin(B.numberVmin)}px, ${B.numberCqi}cqi)`,
          padding: `0 ${B.numberPadEm}em`,
          background: SERVE_GREEN_FILL,
          border: `3px solid ${SERVE_GREEN}`,
          borderRadius: 'clamp(8px, 1.4vw, 14px)',
          boxSizing: 'border-box'
        }}
      >
        <span
          data-serve-number=""
          style={{
            fontWeight: 800,
            lineHeight: 1,
            color: SERVE_GREEN,
            fontVariantNumeric: 'tabular-nums',
            // two digits wide for any number: #1 and #12 the same box
            minWidth: '2ch',
            textAlign: 'center'
          }}
        >
          {number ?? ''}
        </span>
      </span>
    </div>
  )
}
