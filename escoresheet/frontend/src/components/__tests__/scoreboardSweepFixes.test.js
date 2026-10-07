// @vitest-environment node
/**
 * Scoring bugs found by the atomic-actions sweep. The rules are decided by
 * tested domain helpers; Scoreboard.jsx is too large to mount, so this pins
 * that the handlers use them.
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

describe('expelled or disqualified libero on court', () => {
  const branch = () => between('// Libero on court expelled/disqualified - return replaced player to court', 'return // Exit early, don\'t do the regular substitution flow')

  it('puts back the player the libero replaced (playerReplacedByLibero), not a libero_entry playerNumber', () => {
    const body = branch()
    expect(body).toMatch(/const originalPlayerNumber = playerReplacedByLibero\(data\.events, team, data\.set\.index, playerNumber\)/)
    expect(body).not.toMatch(/lastEntry\?\.payload\?\.playerNumber/)
    // the libero_exit and its lineup sub-event are still written with it
    expect(body.indexOf("logEvent('libero_exit'")).toBeGreaterThan(body.indexOf('playerReplacedByLibero('))
    expect(body).toMatch(/currentLineup\[position\] = String\(originalPlayerNumber\)/)
  })
})
