/**
 * The side columns' squares (bench players, liberos, the tablet's official
 * chips) shrink together, in proportion, when the column would otherwise
 * scroll (owner, 20.11.2026: with 10 on the bench the last bench official was
 * out of sight on a tablet). Below BENCH_FIT_MIN a square is too small to tap,
 * so there the column scrolls as before.
 *
 * How: every row of squares sits in a box that is a container of its own
 * (BENCH_FIT_BOX), `--bench-fit` times as wide as the column. The squares are
 * sized in cqw of the nearest container, so they all come out --bench-fit
 * times their size: padding, numbers, badges, sanction cards. The row inside
 * (BENCH_FIT_GRID) is widened back to the column's full width, so smaller
 * squares wrap to more per line and often save a whole row. The few px sizes
 * in a square (the 44px minimum, the font floors) are written
 * `calc(<n>px * var(--bench-fit, 1))` in Scoreboard.jsx. CSS zoom would be
 * shorter, but Firefox does not shrink container units under zoom (Chromium
 * and WebKit do; checked 20.11.2026).
 *
 * fitBenchColumn() finds the factor by measuring: the largest one, to two
 * decimals, at which the column has no overflow. Both columns then take the
 * smaller of their two factors, so the teams' squares stay the same size
 * (they change sides every set). watchBenchFit() does it again whenever a
 * column or a block in one changes size.
 */

export const BENCH_FIT_MIN = 0.6
const SEARCH_STEPS = 7
const FIT_VAR = '--bench-fit'
const FIT = `var(${FIT_VAR}, 1)`

/** The box around a row of squares: a container --bench-fit times as wide as the column. */
export const BENCH_FIT_BOX = { containerType: 'inline-size', width: `calc(100% * ${FIT})` }
/** The row of squares inside BENCH_FIT_BOX, back at the column's full width. */
export const BENCH_FIT_GRID = { width: `calc(100% / ${FIT})`, display: 'flex', flexWrap: 'wrap', gap: '1.9cqw' }

const overflows = (col) => col.scrollHeight - col.clientHeight > 1

// Each column's own factor from its last fit. Every measurement is a forced
// layout of the column, and on the tablet with its large system font each
// one restyles every square. Most fits come to the factor of the last one
// (the observer runs again after every fit: the squares changed size), so
// the search starts there: two measurements instead of about ten. Not the
// factor on the column: after the shared step that is the other column's.
const lastFit = new WeakMap()

// The largest two-decimal factor in [lo, hi) that fits, between lo (fits)
// and hi (overflows): halving, as many steps as [min, 1] needs.
function largestFit(lo, hi, fitsAt) {
  for (let i = 0; i < SEARCH_STEPS; i++) {
    const mid = Math.round(((lo + hi) / 2) * 100) / 100
    if (mid <= lo || mid >= hi) break
    if (fitsAt(mid)) lo = mid
    else hi = mid
  }
  return lo
}

/**
 * Sets --bench-fit on the column to the largest factor in [min, 1] (two
 * decimals) at which it does not overflow, and returns it: 1 when it fits as
 * it is, `min` when even that overflows. The column keeps its scroll position.
 *
 * The search starts from the column's last factor (1 the first time) and only
 * looks on the side of it where the answer is. The height grows with the
 * factor, so the answer is the same as a search over all of [min, 1]
 * (benchFit.test.js checks it against that search).
 */
export function fitBenchColumn(col, min = BENCH_FIT_MIN) {
  const set = (f) => col.style.setProperty(FIT_VAR, String(f))
  const fitsAt = (f) => { set(f); return !overflows(col) }
  const top = col.scrollTop
  const start = Math.min(1, Math.max(min, lastFit.get(col) ?? 1))
  let fit
  if (fitsAt(start)) {
    if (start >= 1) fit = 1
    else {
      const up = Math.round(start * 100 + 1) / 100
      if (!fitsAt(up)) fit = start
      else if (up >= 1 || fitsAt(1)) fit = 1
      else fit = largestFit(up, 1, fitsAt)
    }
  } else if (start <= min || !fitsAt(min)) {
    fit = min
  } else {
    fit = largestFit(min, start, fitsAt)
  }
  set(fit)
  lastFit.set(col, fit)
  if (col.scrollTop !== top) col.scrollTop = top
  return fit
}

/**
 * The columns fitted together (the scoring screen's two): each is measured on
 * its own, then all take the smallest factor. Re-fits when a column changes
 * size (window, toolbar folded away) or any block in one does (a banner, a
 * sanction, a player more on the bench), at most once a frame and outside the
 * observer's own callback. Does nothing where ResizeObserver is missing
 * (tests).
 */
export function createBenchFitGroup(win = globalThis.window) {
  const columns = new Set()
  let frame = 0
  const run = () => {
    frame = 0
    const live = [...columns].filter((col) => col.isConnected && col.querySelector('.bench-fit'))
    if (!live.length) return
    const fits = live.map((col) => fitBenchColumn(col))
    const shared = Math.min(...fits)
    live.forEach((col, i) => { if (fits[i] !== shared) col.style.setProperty(FIT_VAR, String(shared)) })
  }
  const schedule = () => { if (!frame) frame = win.requestAnimationFrame(run) }

  /** Fits `col` with the others while it lives; returns the clean-up. */
  const watch = (col) => {
    if (!col || !win?.ResizeObserver || !win.requestAnimationFrame) return () => {}
    const resize = new win.ResizeObserver(schedule)
    const observeAll = () => {
      resize.disconnect()
      resize.observe(col)
      for (const block of col.children) resize.observe(block)
    }
    observeAll()
    const blocks = win.MutationObserver ? new win.MutationObserver(() => { observeAll(); schedule() }) : null
    blocks?.observe(col, { childList: true })
    columns.add(col)
    schedule()
    return () => {
      resize.disconnect()
      blocks?.disconnect()
      columns.delete(col)
      col.style.removeProperty(FIT_VAR)
      if (columns.size) schedule()
      else if (frame) { win.cancelAnimationFrame(frame); frame = 0 }
    }
  }
  return { watch }
}

let shared = null
/** Fits a scoring-screen side column together with the other one (see createBenchFitGroup). */
export function watchBenchFit(col) {
  if (!shared) shared = createBenchFitGroup()
  return shared.watch(col)
}
