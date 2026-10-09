/**
 * "Which team is forfeiting?": with no colour on the team record, the home
 * button was blue and the away one red, the court's colours swapped. Both
 * now take the colour the court shows (effectiveTeamColour). Scoreboard.jsx
 * is too large to mount, so the source is checked for the wiring.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const sb = readFileSync(resolve(__dirname, '../Scoreboard.jsx'), 'utf8')

describe('the forfeit team buttons', () => {
  const start = sb.indexOf("'Which team is forfeiting?'")
  const block = sb.slice(start, sb.indexOf('</Modal>', start))

  it('take the team colour the court shows', () => {
    expect(start).toBeGreaterThan(-1)
    expect(block).toContain("...teamBoxStyle(effectiveTeamColour('home', data?.homeTeam, data?.match))")
    expect(block).toContain("...teamBoxStyle(effectiveTeamColour('away', data?.awayTeam, data?.match))")
    expect(block).not.toMatch(/homeTeam\?\.color \|\| '#3b82f6'/)
  })
})
