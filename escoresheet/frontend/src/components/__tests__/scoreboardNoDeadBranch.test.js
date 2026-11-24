// The scoring screen has no branch behind a constant condition. A whole
// smartphone layout sat behind `{false ? (...) : (...)}` (about 1000 lines,
// removed 2026-10-09): never drawn, it still called handlePoint, the
// sanction and time-out paths with stale arguments, and kept state alive
// that only it read. The phone layout is PhoneScoreboard.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Lines with a conditional on a literal: `{false ? …`, `(true && …`,
// `= false ? …` (comments left out)
function constantBranches(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '')
  const found = []
  code.split('\n').forEach((line, i) => {
    // not a comparison (`=== true ||`)
    if (/(^|[{(:?,]|(?<![=!<>])=|\breturn)\s*(false|true)\s*(\?|&&|\|\|)/.test(line)) found.push(i + 1)
  })
  return found
}

describe('Scoreboard: no dead branches', () => {
  it('no `false ? … : …` (or `true &&`) in the scoring screen', () => {
    const source = readFileSync(resolve(__dirname, '../Scoreboard.jsx'), 'utf8')
    expect(constantBranches(source)).toEqual([])
  })

  it('the check finds one, not a comparison', () => {
    expect(constantBranches('const a = <div>{false ? (<b />) : (<i />)}</div>\nconst b = x === true || y\nconst c = true && z')).toEqual([1, 3])
  })
})
