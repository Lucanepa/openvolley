/**
 * Sizes of the per-team set tables beside the rally buttons on the scoring
 * screen (Set · P · W · S · T, Scoreboard.jsx `.set-summary-card`).
 *
 * The box stays the same all match long (owner, 17.11.2026): it is the
 * column beside the rally buttons, as tall as they are, and it no longer
 * grows with each set. On a small tablet (1005x600) the rows nearly filled
 * the card by set 3, and sets 4 and 5 would have run out of it (or pushed the
 * court smaller). Now, as rows are added, everything inside the box gets
 * smaller to fit: the text, the row height and the padding. With room to
 * spare each keeps its usual size (min() of the usual size and the share).
 *
 * How: the column is a size container (styles.css `.set-summary-col`,
 * `container-type: size`), so it takes the height the rally buttons give the
 * row and its content adds none. The card fills it; the team badge and the
 * card padding are a share of the column height (cqh); the table sits in a
 * second size container (`tableBox`) whose height is shared by the header
 * and the set rows.
 *
 * Shares, per row of the table: text 0.56, padding 0.08 above and below,
 * line height 1.2, so a row takes 0.56 x 1.2 + 2 x 0.08 = 0.83 of its share
 * plus its 1px rule (2px under the header): the rows fit down to a 40px box.
 *
 * @param {number} setRows the set rows shown (1 to 5)
 * @returns {Record<string, object>} inline styles
 */
export function setSummaryFit(setRows) {
  const rows = Math.max(1, Math.round(Number(setRows) || 1)) + 1 // + the header row
  const share = `(100cqh / ${rows})`
  const cellPad = `min(calc(4px * var(--scale-factor)), calc(${share} * 0.08))`
  const badgeFont = `min(calc(16px * var(--scale-factor)), 11cqh)`
  const cardPadY = `min(calc(12px * var(--scale-factor)), 5cqh)`
  return {
    rows,
    card: {
      height: '100%',
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      paddingTop: cardPadY,
      paddingBottom: cardPadY
    },
    heading: {
      margin: `0 0 min(calc(8px * var(--scale-factor)), 3cqh)`,
      fontSize: badgeFont,
      lineHeight: 1.2,
      flexShrink: 0
    },
    badge: {
      padding: `min(calc(2px * var(--scale-factor)), 1cqh) calc(8px * var(--scale-factor))`,
      fontSize: badgeFont
    },
    tableBox: {
      flex: '1 1 0',
      minHeight: 0,
      containerType: 'size',
      overflow: 'hidden'
    },
    table: {
      lineHeight: 1.2,
      fontSize: `min(calc(15px * var(--scale-factor)), calc(${share} * 0.56))`
    },
    th: {
      padding: `${cellPad} var(--set-cell-pad-x, calc(2px * var(--scale-factor)))`,
      fontSize: `min(calc(13px * var(--scale-factor)), calc(${share} * 0.5))`
    },
    td: {
      padding: `${cellPad} var(--set-cell-pad-x, calc(2px * var(--scale-factor)))`,
      fontSize: `min(calc(15px * var(--scale-factor)), calc(${share} * 0.56))`
    }
  }
}
