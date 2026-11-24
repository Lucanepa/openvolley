// @vitest-environment node
/**
 * The live state the referee tablets run on reads the fields the scorer's
 * events really carry: a substitution's isExceptional (the referee counts the
 * regular ones), and a libero entry's liberoIn / playerOut, a libero exit's
 * liberoOut / playerIn (the referee flashes liberoNumber || playerIn).
 * Scoreboard.jsx is too large to mount for this; this pins the wiring.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const sb = readFileSync(resolve(__dirname, '../Scoreboard.jsx'), 'utf8')
const between = (from, to) => {
  const start = sb.indexOf(from)
  expect(start).toBeGreaterThan(-1)
  const end = sb.indexOf(to, start + from.length)
  expect(end).toBeGreaterThan(start)
  return sb.slice(start, end)
}

describe('live state payload fields', () => {
  it('a substitution in subs_a / subs_b is exceptional by its isExceptional flag', () => {
    const subs = between('// Substitutions with details', 'const subsA = ')
    expect(subs).toMatch(/exceptional: e\.payload\?\.isExceptional === true/)
  })

  it('libero events send the payload\'s own fields', () => {
    const data = between("if (type === 'substitution') {\n        eventData = { playerIn", "} else if (type === 'court_captain_designation')")
    expect(data).toMatch(/type === 'libero_entry'\) \{\s*(\/\/[^\n]*\n\s*)*eventData = \{ liberoNumber: payload\?\.liberoIn, liberoIn: payload\?\.liberoIn, playerOut: payload\?\.playerOut \}/)
    expect(data).toMatch(/type === 'libero_exit'\) \{\s*eventData = \{ liberoOut: payload\?\.liberoOut, playerIn: payload\?\.playerIn \}/)
    expect(data).not.toMatch(/payload\?\.liberoNumber/)
  })
})
