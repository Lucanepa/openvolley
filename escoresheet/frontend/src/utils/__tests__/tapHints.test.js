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

  it('continuous play\'s held point buttons: a stopwatch hint (.hold-hint), hidden with the tap hints too', () => {
    expect(css).toMatch(/\.hold-hint:not\(:disabled\)::after \{[^}]*content: '';[^}]*mask: url\("data:image\/svg\+xml,[^"]*circle cx='12' cy='14' r='8'/)
    expect(css).toMatch(/html\[data-no-tap-hints\] \.hold-hint::after \{\s*display: none;/)
  })
})

describe('the held point button (continuous play, HoldToConfirmButton)', () => {
  const rule = (selector) => {
    const at = css.indexOf(`${selector} {`)
    expect(at, selector).toBeGreaterThan(-1)
    return css.slice(at, css.indexOf('}', at))
  }

  it('the touch is the hold\'s: no scrolling, callout, selection (the Android WebView cancelled a touch held ~500 ms)', () => {
    const body = rule('.hold-button')
    expect(body).toMatch(/touch-action: none;/)
    expect(body).toMatch(/-webkit-touch-callout: none;/)
    expect(body).toMatch(/user-select: none;/)
  })

  it('held, it looks pressed and its fill grows by a transform over --hold-ms (no layout, nothing in React)', () => {
    // a layer of its own (the phone's kit reset and a team colour's inline ring own box-shadow)
    const wash = rule('.hold-button[data-holding]::before')
    expect(wash).toMatch(/content: '';/)
    expect(wash).toMatch(/background: rgba\(0, 0, 0, 0\.12\);/)
    expect(wash).toMatch(/z-index: -1;/)
    expect(rule('.hold-fill')).toMatch(/transform: scaleX\(0\);/)
    const held = rule('.hold-button[data-holding] > .hold-fill')
    expect(held).toMatch(/transform: scaleX\(1\);/)
    expect(held).toMatch(/transition: transform var\(--hold-ms, 2000ms\) linear;/)
    expect(held).not.toMatch(/width|left/)
  })
})

