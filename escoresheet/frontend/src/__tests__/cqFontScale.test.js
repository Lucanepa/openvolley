// The board's double page zoom on container-unit font sizes (utils/cqFontScale.js): the measurement,
// the factor, and a guard that every font-size in container units carries var(--cqf).
import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { measureCqFontScale, cqFontFactor, applyCqFontScale } from '../utils/cqFontScale.js'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('cqFontScale', () => {
  afterEach(() => { vi.restoreAllMocks(); document.documentElement.style.removeProperty('--cqf') })

  it('the factor undoes the measured scale, and is exactly 1 when there is nothing to undo', () => {
    expect(cqFontFactor(1.5)).toBe(0.6667)
    expect(cqFontFactor(2)).toBe(0.5)
    expect(cqFontFactor(1)).toBe(1)
    expect(cqFontFactor(1.004)).toBe(1)
    expect(cqFontFactor(NaN)).toBe(1)
    expect(cqFontFactor(0)).toBe(1)
  })

  it('measures 50cqh in a 100px container: 75px under the board\'s zoom is 1.5, and the probe is removed', () => {
    const real = window.getComputedStyle
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => (el.style.fontSize === '50cqh' ? { fontSize: '75px' } : real(el)))
    const before = document.body.childElementCount
    expect(measureCqFontScale(document)).toBe(1.5)
    expect(document.body.childElementCount).toBe(before)
    expect(applyCqFontScale(document)).toBe(0.6667)
    expect(document.documentElement.style.getPropertyValue('--cqf')).toBe('0.6667')
  })

  it('an engine that cannot say (jsdom: no font size) leaves the factor at 1', () => {
    expect(measureCqFontScale(document)).toBe(1)
    expect(applyCqFontScale(document)).toBe(1)
  })
})

// Every font-size given in container units must be scaled by var(--cqf), or it is 1.5x too big on the
// board. JS: the value after `fontSize:` up to its top-level comma, brace or line end. CSS: font-size.
const TOKEN = /(?<![\w.$])((?:\d*\.)?\d+|\$\{[^{}]*\})cq(?:h|w|i|b|min|max)\b(?!\s*\*\s*var\(--cqf)/g
function jsFontSizeValues (text) {
  const out = []
  for (const m of text.matchAll(/\bfontSize\s*:/g)) {
    let i = m.index + m[0].length, depth = 0, quote = null
    for (; i < text.length; i++) {
      const c = text[i]
      if (quote) {
        if (c === '\\') { i++; continue }
        if (quote === '`' && text.startsWith('${', i)) { i = text.indexOf('}', i); continue }
        if (c === quote) quote = null
      } else if (c === "'" || c === '"' || c === '`') quote = c
      else if ('([{'.includes(c)) depth++
      else if (')]}'.includes(c)) { if (depth === 0) break; depth-- }
      else if ((c === ',' || c === '\n') && depth === 0) break
    }
    out.push(text.slice(m.index, i))
  }
  return out
}
function* sourceFiles (dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '__tests__' || e.name === 'node_modules') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* sourceFiles(p)
    else if (/\.(jsx?|css)$/.test(e.name) && !/\.test\./.test(e.name)) yield p
  }
}

describe('font sizes in container units', () => {
  it('all carry var(--cqf)', () => {
    const bad = []
    let checked = 0
    for (const file of sourceFiles(SRC)) {
      const text = fs.readFileSync(file, 'utf8')
      const values = file.endsWith('.css') ? [...text.matchAll(/font-size\s*:[^;{}]+;/g)].map((m) => m[0]) : jsFontSizeValues(text)
      for (const v of values) {
        if (/cq(?:h|w|i|b|min|max)\b/.test(v)) checked++
        if (v.match(TOKEN)) bad.push(`${path.relative(SRC, file)}: ${v.trim().slice(0, 120)}`)
      }
    }
    expect(checked).toBeGreaterThan(100)
    expect(bad).toEqual([])
  })
})
