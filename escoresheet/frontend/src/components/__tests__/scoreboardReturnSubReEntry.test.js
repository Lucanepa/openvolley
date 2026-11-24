// @vitest-environment node
/**
 * A player who left expelled, disqualified or by an exceptional substitution
 * is not offered back as the return substitute (FIVB 15.7, 21.3.2, 21.3.3):
 * the "only the player who went out" branch of getAvailableSubstitutes asks
 * canPlayerReEnter like the bench filter does. Scoreboard.jsx is too large to
 * mount for a forced substitution, so this pins the check.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const sb = readFileSync(resolve(__dirname, '../Scoreboard.jsx'), 'utf8')

describe('return substitute after an expulsion or disqualification', () => {
  it('the original player comes back only if canPlayerReEnter allows it', () => {
    const start = sb.indexOf('const getAvailableSubstitutes = useCallback(')
    expect(start).toBeGreaterThan(-1)
    const body = sb.slice(start, sb.indexOf('// Player was not substituted in, so any bench player can substitute', start))
    const ret = body.indexOf('return [originalPlayer]')
    expect(ret).toBeGreaterThan(-1)
    const guard = body.slice(body.lastIndexOf('if (', ret), ret)
    expect(guard).toMatch(/canPlayerReEnter\(teamKey, originalPlayer\.number, data\.set\.index\)/)
  })
})
