import { describe, it, expect, vi } from 'vitest'
import { fitBenchColumn, createBenchFitGroup, BENCH_FIT_MIN, BENCH_FIT_BOX, BENCH_FIT_GRID } from '../benchFit.js'

// A side column whose content height follows --bench-fit: `fixed` px that
// never shrink (team header, TO/SUB, officials) plus `squares` px of bench
// and libero squares at fit 1. jsdom has no layout, so scrollHeight is faked.
function column({ height, fixed, squares }) {
  const col = document.createElement('aside')
  const fit = () => Number(col.style.getPropertyValue('--bench-fit') || 1)
  Object.defineProperty(col, 'clientHeight', { get: () => height })
  Object.defineProperty(col, 'scrollHeight', { get: () => Math.max(height, Math.ceil(fixed + squares * fit())) })
  return col
}

describe('fitBenchColumn (side column squares fit its height)', () => {
  it('leaves the squares at full size when the column fits', () => {
    const col = column({ height: 600, fixed: 300, squares: 250 })
    expect(fitBenchColumn(col)).toBe(1)
    expect(col.style.getPropertyValue('--bench-fit')).toBe('1')
  })

  it('shrinks them just enough to fit, to two decimals', () => {
    // 300 + 400 x f <= 600 -> f <= 0.75
    const col = column({ height: 600, fixed: 300, squares: 400 })
    const fit = fitBenchColumn(col)
    expect(fit).toBeLessThanOrEqual(0.75)
    expect(fit).toBeGreaterThanOrEqual(0.73)
    expect(col.scrollHeight - col.clientHeight).toBeLessThanOrEqual(1)
    expect(col.style.getPropertyValue('--bench-fit')).toBe(String(fit))
  })

  it('stops at the minimum (still tappable) and lets the column scroll', () => {
    const col = column({ height: 600, fixed: 500, squares: 400 })
    expect(fitBenchColumn(col)).toBe(BENCH_FIT_MIN)
    expect(col.style.getPropertyValue('--bench-fit')).toBe(String(BENCH_FIT_MIN))
  })

  it('keeps the scroll position', () => {
    const col = column({ height: 600, fixed: 500, squares: 400 })
    col.scrollTop = 40
    fitBenchColumn(col)
    expect(col.scrollTop).toBe(40)
  })

  it('sizes the box and the row from the same factor', () => {
    expect(BENCH_FIT_BOX).toMatchObject({ containerType: 'inline-size', width: 'calc(100% * var(--bench-fit, 1))' })
    expect(BENCH_FIT_GRID).toMatchObject({ width: 'calc(100% / var(--bench-fit, 1))', flexWrap: 'wrap' })
  })
})

// The oracle: the full search as it was written first (try 1, then the
// minimum, then halve [min, 1] to two decimals). Whatever the column showed
// before, fitBenchColumn must come to the same factor.
function fullSearch(fitsAt, min = BENCH_FIT_MIN) {
  if (fitsAt(1)) return 1
  if (!fitsAt(min)) return min
  let lo = min
  let hi = 1
  for (let i = 0; i < 7; i++) {
    const mid = Math.round(((lo + hi) / 2) * 100) / 100
    if (mid <= lo || mid >= hi) break
    if (fitsAt(mid)) lo = mid
    else hi = mid
  }
  return lo
}

// A column whose squares can change (a substitution, a sanction, a side
// swap) and that counts its scrollHeight reads: each one is a forced layout
// in the browser.
function changingColumn({ height, fixed, squares }) {
  const col = document.createElement('aside')
  col.content = { fixed, squares }
  col.reads = 0
  const fit = () => Number(col.style.getPropertyValue('--bench-fit') || 1)
  Object.defineProperty(col, 'clientHeight', { get: () => height })
  Object.defineProperty(col, 'scrollHeight', {
    get: () => { col.reads++; return Math.max(height, Math.ceil(col.content.fixed + col.content.squares * fit())) }
  })
  return col
}
const fitsWith = (height, { fixed, squares }) => (f) => Math.max(height, Math.ceil(fixed + squares * f)) - height <= 1

describe('fitBenchColumn: the same factor as the full search, from any start', () => {
  const heights = [400, 600, 800]
  const fixeds = [100, 200, 300, 400, 500]
  const squaresList = [100, 250, 400, 550, 700, 850, 1000]

  it('over a grid of columns and of what they held before', () => {
    let cases = 0
    for (const height of heights) {
      for (const fixed of fixeds) {
        for (const before of squaresList) {
          for (const squares of squaresList) {
            const col = changingColumn({ height, fixed, squares: before })
            fitBenchColumn(col)
            col.content = { fixed, squares }
            const expected = fullSearch(fitsWith(height, col.content))
            expect(fitBenchColumn(col), `h ${height} fixed ${fixed} squares ${before} -> ${squares}`).toBe(expected)
            expect(col.style.getPropertyValue('--bench-fit')).toBe(String(expected))
            cases++
          }
        }
      }
    }
    expect(cases).toBe(heights.length * fixeds.length * squaresList.length ** 2)
  })

  it('measures less: two reads for the run the observer starts after a fit, fewer over the grid', () => {
    let reads = 0
    let fullReads = 0
    for (const height of heights) {
      for (const fixed of fixeds) {
        for (const before of squaresList) {
          for (const squares of squaresList) {
            const col = changingColumn({ height, fixed, squares: before })
            fitBenchColumn(col)
            col.content = { fixed, squares }
            col.reads = 0
            fitBenchColumn(col)
            reads += col.reads
            const fits = fitsWith(height, col.content)
            fullSearch((f) => { fullReads++; return fits(f) })
            // the squares changed size, so the observer fits again: same content
            col.reads = 0
            fitBenchColumn(col)
            expect(col.reads).toBeLessThanOrEqual(2)
          }
        }
      }
    }
    expect(reads).toBeLessThan(fullReads)
  })

  it('after the other column set a smaller shared factor on this one', () => {
    for (const height of heights) {
      for (const squares of squaresList) {
        const col = changingColumn({ height, fixed: 200, squares })
        const own = fitBenchColumn(col)
        col.style.setProperty('--bench-fit', String(BENCH_FIT_MIN))
        expect(fitBenchColumn(col)).toBe(own)
      }
    }
  })
})

describe('createBenchFitGroup (both side columns)', () => {
  const fakeWindow = () => {
    const frames = []
    class FakeResizeObserver {
      constructor(cb) { this.cb = cb }
      observe() {}
      disconnect() {}
    }
    return {
      frames,
      ResizeObserver: FakeResizeObserver,
      MutationObserver: globalThis.MutationObserver,
      requestAnimationFrame: (fn) => { frames.push(fn); return frames.length },
      cancelAnimationFrame: vi.fn()
    }
  }
  const withSquares = (col) => {
    col.appendChild(Object.assign(document.createElement('div'), { className: 'bench-fit' }))
    document.body.appendChild(col)
    return col
  }

  it('does nothing without ResizeObserver', () => {
    const col = column({ height: 600, fixed: 500, squares: 400 })
    const stop = createBenchFitGroup({ requestAnimationFrame: vi.fn() }).watch(col)
    stop()
    expect(col.style.getPropertyValue('--bench-fit')).toBe('')
  })

  it('gives both columns the smaller factor, once a frame, and cleans up', () => {
    const win = fakeWindow()
    const group = createBenchFitGroup(win)
    const left = withSquares(column({ height: 600, fixed: 300, squares: 400 })) // fits at 0.75
    const right = withSquares(column({ height: 600, fixed: 200, squares: 400 })) // fits at 1
    const stopLeft = group.watch(left)
    const stopRight = group.watch(right)
    expect(win.frames).toHaveLength(1)
    win.frames[0]()
    const fit = Number(left.style.getPropertyValue('--bench-fit'))
    expect(fit).toBeLessThanOrEqual(0.75)
    expect(right.style.getPropertyValue('--bench-fit')).toBe(String(fit))
    stopLeft()
    stopRight()
    expect(left.style.getPropertyValue('--bench-fit')).toBe('')
    expect(right.style.getPropertyValue('--bench-fit')).toBe('')
    left.remove()
    right.remove()
  })

  it('leaves a column without squares alone', () => {
    const win = fakeWindow()
    const col = column({ height: 600, fixed: 500, squares: 400 })
    document.body.appendChild(col)
    const stop = createBenchFitGroup(win).watch(col)
    win.frames[0]()
    expect(col.style.getPropertyValue('--bench-fit')).toBe('')
    stop()
    col.remove()
  })
})
