import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const sb = readFileSync(resolve(__dirname, '../Scoreboard.jsx'), 'utf8')
const scoreBlock = () => {
  const a = sb.indexOf('{/* Score display */}')
  return sb.slice(a, sb.indexOf("{renderServeSide('right')}", a))
}

describe('the big score: numbers right next to the colon (owner 22.11.2026, layout B)', () => {
  it('keeps the colon in the middle: two equal columns around it', () => {
    expect(scoreBlock()).toContain("gridTemplateColumns: '1.3em auto 1.3em'")
  })

  it('the left number ends at the colon, the right one starts at it', () => {
    const block = scoreBlock()
    expect(block).toMatch(/data-testid="score-left" style=\{\{\s*justifySelf: 'end',/)
    expect(block).toMatch(/data-testid="score-right" style=\{\{\s*justifySelf: 'start',/)
  })
})
