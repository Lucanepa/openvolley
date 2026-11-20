// @vitest-environment node
// No raw dvh / svh / lvh (or their w, i, b, min, max forms) in the app's
// sources. The build is made for Chrome / Android WebView 107 and the boot
// check (browser-check.js) lets 105 in, but these units arrived in Chrome 108:
// before that a declaration that uses one is dropped, an inline style value
// too, and the screen loses its height (on WebView 105-107 the phone scoring
// screen was blank, 2026-11-20). Heights use var(--ov-vh100), defined once in
// src/tailwind.css: 100dvh where @supports says the browser has it, else
// 100vh. The classic `height: 100vh; height: 100dvh` pair is no way out
// either: the build's CSS minifier keeps only the last declaration.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const frontend = resolve(__dirname, '../..')
const DEFINITION = 'src/tailwind.css'
const SKIP_DIRS = new Set(['node_modules', 'android', 'ios', 'src-tauri', 'coverage', '__tests__', 'e2e-ui', 'e2e-desktop'])

/** Text sources under dir (stylesheets, pages, scripts), without build output, native projects and tests. */
function sourceFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('dist')) out.push(...sourceFiles(full))
    } else if (/\.(jsx?|mjs|cjs|tsx?|css|html)$/.test(entry.name) && !/\.test\.[jt]sx?$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

// Comments may name the units. Block comments keep their line breaks, so line
// numbers stay right; a `//` comment needs whitespace (or the line start)
// before it, so 'https://…' is not cut.
function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n')
}

// A length in one of the units (100dvh, 92svh, .5lvw, 10dvmin; also inside a
// Tailwind value without spaces, calc(100dvh-2rem)), or a Tailwind utility
// named after one (h-, min-h-, max-h-, w- followed by dvh, svh, lvh, dvw).
const RAW_UNIT = /\d(?:dv|sv|lv)(?:h|w|i|b|min|max)(?![a-z])|[\w-]-(?:dv|sv|lv)[hw](?![\w-])/i

const offendingLines = (text) => withoutComments(text).split('\n')
  .map((line, i) => ({ line: line.trim(), at: i + 1 }))
  .filter(({ line }) => RAW_UNIT.test(line))

// The samples below spell the units <dv>h, <sv>h, <lv>h: Tailwind's class
// scanner reads this file too (comments included), and would otherwise build
// those utilities into the app's stylesheet.
const unit = (s) => s.replace(/<(dv|sv|lv)>/gi, '$1')

describe('viewport heights go through var(--ov-vh100)', () => {
  it('the pattern catches the units and the utilities, and spares the variable', () => {
    for (const bad of ["height: '100<dv>h',", 'max-height: calc(85<dv>h / 1.5);', 'className="h-[92<dv>h]"', 'max-h-[min(24rem,70<dv>h)]', 'className="h-<dv>h overflow-y-auto"', 'min-h-<sv>h', 'height: 100<LV>H;', 'width: 50<dv>w;', 'max-h-[calc(100<dv>h-2rem)]', 'height: 10<dv>min'].map(unit)) {
      expect(RAW_UNIT.test(bad), bad).toBe(true)
    }
    for (const ok of ["height: 'var(--ov-vh100, 100vh)',", 'max-height: calc(var(--ov-vh100) * 0.85 / 1.5);', 'h-[calc(var(--ov-vh100)*0.92)]', 'height: 100vh;', 'width: 100vw;', '// <dv>h where the browser has it', 'data-<dv>h-x'].map(unit)) {
      expect(RAW_UNIT.test(ok), ok).toBe(false)
    }
  })

  it('comments do not count, code after them does', () => {
    expect(offendingLines(unit('/* 100<dv>h\n 92<dv>h */\nheight: 1px; // 100<dv>h\n<!-- h-<dv>h -->\nheight: 100<dv>h;')).map((l) => l.at)).toEqual([5])
  })

  it('no source file uses a raw dvh / svh / lvh', () => {
    const offenders = []
    for (const file of sourceFiles(frontend)) {
      const rel = relative(frontend, file).split('\\').join('/')
      if (rel === DEFINITION) continue
      for (const { line, at } of offendingLines(readFileSync(file, 'utf8'))) offenders.push(`${rel}:${at}: ${line}`)
    }
    expect(offenders, "use var(--ov-vh100) (inline styles: 'var(--ov-vh100, 100vh)'; fractions: calc(var(--ov-vh100) * 0.9))").toEqual([])
  })

  it('src/tailwind.css defines the variable: 100vh, and 100dvh only where the browser has it', () => {
    const css = withoutComments(readFileSync(join(frontend, DEFINITION), 'utf8'))
    expect(css).toMatch(/:root\s*\{\s*--ov-vh100:\s*100vh;\s*\}\s*@supports \(height: 100dvh\)\s*\{\s*:root\s*\{\s*--ov-vh100:\s*100dvh;\s*\}\s*\}/)
    // and the unit appears nowhere else in it
    expect(offendingLines(css).map((l) => l.line)).toEqual(['@supports (height: 100dvh) {', '--ov-vh100: 100dvh;'])
  })
})
