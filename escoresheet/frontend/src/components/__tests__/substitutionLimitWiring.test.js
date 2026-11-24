// @vitest-environment node
/**
 * The 6-substitution limit (FIVB 15.6) and the request rules are decided by
 * the tested domain rules (substitutionRequestIssues, classifyLiveSubstitution)
 * at the one place every live substitution goes through, with the team's
 * roster for the pair (substitutionIllegalReason). This pins the wiring; the
 * behaviour is ScoreboardSubstitutionLegality.test.jsx's (mounted).
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
    const guard = slice('const setSubstitutionConfirm = useCallback(', 900)
    // the request rules first (domain/interruptionRequests.js): replay pending,
    // second request, 7th substitution, request after a delay warning, the
    // pair (with the team's roster: its liberos)
    expect(guard).toMatch(/const roster = \{ players: guard\.players\?\.\[next\.team\] \|\| \[\] \}/)
    expect(guard).toMatch(/substitutionRequestIssues\(guard\.events, guard\.setIndex, next\.team, next, roster\)/)
    expect(guard).toMatch(/guard\.onIssues\(next, issues, acknowledged\)/)
    expect(guard).toMatch(/classifyLiveSubstitution\(guard\.events, guard\.setIndex, next\.team, next, roster\)/)
    expect(guard).toMatch(/verdict === 'exceptional' && !next\.isExceptional/)
    // the raw state setter is used only by the guard and confirmSubstitution
    expect(scoreboard.match(/setSubstitutionConfirmState\(/g)).toHaveLength(3)
  })

  it('a request beyond the limit opens the request warning (improper request / delay)', () => {
    // openRequestWarning resolves both ladders once (improper request, or the
    // delay sanction it escalates to) and keeps them in the dialog state
    expect(scoreboard).toMatch(/onIssues: \(request, issues, acknowledged\) => \{\s*if \(rallyStatus === 'idle'\) openRequestWarning\('substitution', request, issues, acknowledged\)/)
    expect(scoreboard).toMatch(/improper: resolveSanction\('improper_request', counts\)/)
    expect(scoreboard).toMatch(/delay: resolveSanction\('delay_warning', counts\)/)
  })

  it('confirmSubstitution re-checks before writing the event', () => {
    const body = slice('const confirmSubstitution = useCallback(', 6000)
    const check = body.indexOf('classifyLiveSubstitution(data.events, data.set.index, team, substitutionConfirm,')
    const write = body.indexOf("logEvent('substitution'")
    expect(check).toBeGreaterThan(-1)
    expect(write).toBeGreaterThan(check)
    expect(body).toMatch(/const isExceptional = verdict === 'exceptional'/)
  })

  it('the limit (the SUB box colour) and the legal-substitute list count regular substitutions only', () => {
    expect(slice('const substitutionsUsed = useMemo(', 400)).toMatch(/countRegularSubstitutions\(data\.events, 'home', data\.set\.index\)/)
    expect(slice('const getAvailableSubstitutes = useCallback(', 500))
      .toMatch(/if \(!allowExceptional && data\.set && countRegularSubstitutions\(data\.events, teamKey, data\.set\.index\) >= MAX_SUBSTITUTIONS_PER_SET\) return \[\]/)
    expect(slice('const isSubstitutionLegal = useCallback(', 400)).toMatch(/countRegularSubstitutions\(/)
  })

  // owner 22.11.2026: "SUB shall count exceptional substitutions"; the colour
  // stays with the regular ones (the limit)
  it('the SUB box shows every substitution, exceptional ones included; its colour the regular ones', () => {
    expect(slice('const substitutionsShown = useMemo(', 400)).toMatch(/countAllSubstitutions\(data\.events, 'home', data\.set\.index\)/)
    for (const side of ['left', 'right']) {
      expect(scoreboard).toContain(`}}>{getSubstitutionsShown('${side}')}</div>`)
      expect(scoreboard).toContain(`color: getSubstitutionsUsed('${side}') >= 6 ? '#ef4444'`)
    }
    // the phone tile: the number shown and the regular count for its colour
    expect(scoreboard).toMatch(/subs: getSubstitutionsShown\(side\),\s*subsRegular: getSubstitutionsUsed\(side\)/)
  })

  it('the referee counter counts every substitution too, its colour from the regular ones', () => {
    expect(referee).toMatch(/return eventCounters\(currentSetEvents\)/)
    expect(referee).toMatch(/counter\('SUB', stats\.substitutions, subCounterTone\(stats\)\)/)
  })
})
