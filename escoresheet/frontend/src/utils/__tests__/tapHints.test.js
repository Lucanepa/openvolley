import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readShowTapHints, applyTapHints, setShowTapHints } from '../tapHints'

const css = readFileSync(resolve(__dirname, '../../styles.css'), 'utf8')
const memory = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) } }

describe('Options › Show tap hints (owner 22.11.2026)', () => {
  beforeEach(() => document.documentElement.removeAttribute('data-no-tap-hints'))

  it('is on by default and remembers off per device', () => {
    const storage = memory()
    expect(readShowTapHints(storage)).toBe(true)
    setShowTapHints(false, { storage, doc: document })
    expect(readShowTapHints(storage)).toBe(false)
    expect(document.documentElement.hasAttribute('data-no-tap-hints')).toBe(true)
    setShowTapHints(true, { storage, doc: document })
    expect(readShowTapHints(storage)).toBe(true)
    expect(document.documentElement.hasAttribute('data-no-tap-hints')).toBe(false)
  })

  it('a storage that throws still shows the hints', () => {
    expect(readShowTapHints({ getItem: () => { throw new Error('denied') } })).toBe(true)
    applyTapHints(true, document)
    expect(document.documentElement.hasAttribute('data-no-tap-hints')).toBe(false)
  })

  it('off hides every finger: the buttons\' and the time-out box\'s', () => {
    expect(css).toMatch(/html\[data-no-tap-hints\] \.tap-hint::after,\s*html\[data-no-tap-hints\] \[data-tap-hint\]::after,\s*html\[data-no-tap-hints\] \[data-tap-hint-icon\] \{\s*display: none;/)
  })
})
