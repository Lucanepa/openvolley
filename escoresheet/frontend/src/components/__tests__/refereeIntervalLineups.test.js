// Owner, 15.11 (match 424849): both line-ups of set 2 were entered at 15:36 /
// 15:37, in the set interval, and the referee tablet still showed an empty
// court: the interval cleared every line-up. The new set's line-ups now show
// once entered (the "Line-up set" cover hides the first until both are in).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const src = readFileSync(resolve(__dirname, '../Referee.jsx'), 'utf8')

describe('referee: the new set\'s line-ups in the set interval', () => {
  it('the interval clears the line-ups only while the set is the finished one or none is entered yet', () => {
    expect(src).toContain("const intervalClearsLineups = isInSetInterval && (data?.currentSet?.finished === true || lineup.isBetweenSets === true)")
    expect(src).toContain("const leftLineup = (isMatchEnded || intervalClearsLineups) ? null :")
    expect(src).toContain("const rightLineup = (isMatchEnded || intervalClearsLineups) ? null :")
    expect(src).not.toContain("const leftLineup = (isInSetInterval || isMatchEnded) ? null")
  })
})
