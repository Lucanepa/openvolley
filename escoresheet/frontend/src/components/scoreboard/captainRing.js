// The captain as on the paper scoresheet: the number circled. A thin ring laid
// over the number's own box (absolute, centred on it: the number's box must be
// positioned), so the number keeps its place. borderColor is set where it is
// drawn. As wide as the number plus `pad` each side and never narrower than
// `minWidth` (the ring's height, `size`, unless given): one digit gets a
// circle, two a short oval. `round` draws a true circle, `size` wide and high,
// whatever the number's width (one digit on the bench chips: the number plus
// `pad` was narrower than high, an upright egg, device check 16.11.2026).
// A length is a CSS length or a number of px.
// Drawn on the phone layout's court and on the scoring screen's bench chips.
export function captainRingStyle({ size, pad, minWidth = size, round = false }) {
  const width = round ? size : `calc(100% + ${typeof pad === 'number' ? `${2 * pad}px` : `2 * ${pad}`})`
  return {
    position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
    width, minWidth: round ? size : minWidth, height: size,
    boxSizing: 'border-box', borderWidth: 2, borderStyle: 'solid', borderRadius: 999, pointerEvents: 'none'
  }
}
