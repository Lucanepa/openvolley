// @vitest-environment node
/**
 * The 6-substitution limit (FIVB 15.6) is decided by the tested domain rule
 * (classifySubstitutionRequest) at the one place every live substitution goes
 * through. Scoreboard.jsx is too large to mount: this pins the wiring.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const scoreboard = readFileSync(resolve(__dirname, '../Scoreboard.jsx'), 'utf8')
const referee = readFileSync(resolve(__dirname, '../Referee.jsx'), 'utf8')

function slice(startMarker, length) {
  const start = scoreboard.indexOf(startMarker)
  expect(start).toBeGreaterThan(-1)
  return scoreboard.slice(start, start + length)
}

describe('Scoreboard substitution limit', () => {
  it('every substitution request opens its confirm through the guarded setter', () => {
    expect(scoreboard).toMatch(/const \[substitutionConfirm, setSubstitutionConfirmState\] = useState\(null\)/)
    const guard = slice('const setSubstitutionConfirm = useCallback(', 700)
    expect(guard).toMatch(/classifySubstitutionRequest\(guard\.events, next\.team, guard\.setIndex, next\)/)
    expect(guard).toMatch(/verdict === 'improper_request'/)
    expect(guard).toMatch(/guard\.onImproperRequest\(next\.team\)/)
    expect(guard).toMatch(/verdict === 'exceptional' && !next\.isExceptional/)
    // the raw state setter is used only by the guard and confirmSubstitution
    expect(scoreboard.match(/setSubstitutionConfirmState\(/g)).toHaveLength(3)
  })

  it('a request beyond the limit becomes the improper-request flow', () => {
    expect(scoreboard).toMatch(/setSanctionConfirm\(\{ side: mapTeamKeyToSide\(teamKey\), type: 'improper_request', reason: 'substitution_limit' \}\)/)
  })

  it('confirmSubstitution re-checks before writing the event', () => {
    const body = slice('const confirmSubstitution = useCallback(', 6000)
    const check = body.indexOf('classifySubstitutionRequest(data.events, team, data.set.index, substitutionConfirm)')
    const write = body.indexOf("logEvent('substitution'")
    expect(check).toBeGreaterThan(-1)
    expect(write).toBeGreaterThan(check)
    expect(body).toMatch(/const isExceptional = verdict === 'exceptional'/)
  })

  it('the counter and the legal-substitute list count regular substitutions only', () => {
    expect(slice('const substitutionsUsed = useMemo(', 400)).toMatch(/countRegularSubstitutions\(data\.events, 'home', data\.set\.index\)/)
    expect(slice('const getAvailableSubstitutes = useCallback(', 500))
      .toMatch(/if \(!allowExceptional && data\.set && countRegularSubstitutions\(data\.events, teamKey, data\.set\.index\) >= MAX_SUBSTITUTIONS_PER_SET\) return \[\]/)
    expect(slice('const isSubstitutionLegal = useCallback(', 400)).toMatch(/countRegularSubstitutions\(/)
  })

  it('the referee counter leaves exceptional substitutions out too', () => {
    expect(referee).toMatch(/e\.type === 'substitution' && e\.payload\?\.team === 'home' && !e\.payload\?\.isExceptional/)
    expect(referee).toMatch(/e\.type === 'substitution' && e\.payload\?\.team === 'away' && !e\.payload\?\.isExceptional/)
  })
})
