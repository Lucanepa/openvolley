// Go back in the scoring screen (Scoreboard is too large to render
// in a unit test, so the source is checked for the wiring; the planners are
// tested in domain/__tests__/rectify.test.js and the panel in
// components/rectify/__tests__/RectifyPanel.test.jsx).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { matchMenuSections } from '../matchMenu'

const sb = readFileSync(resolve(__dirname, '../Scoreboard.jsx'), 'utf8')
const handler = header => {
  const a = sb.indexOf(header)
  if (a < 0) throw new Error(`not found: ${header}`)
  const end = sb.slice(a).search(/\n  \}(, \{ [^\n]*\})?\)*, \[/)
  if (end < 0) throw new Error(`no end: ${header}`)
  return sb.slice(a, a + end)
}

describe('Scoreboard: go back', () => {
  it('is a row of the Match menu (tablet toolbar and phone action sheet), in Corrections', () => {
    const opened = []
    const sections = matchMenuSections(k => k, { goBack: () => opened.push('go-back'), manualChanges: () => {} })
    const corrections = sections.find(s => s.key === 'corrections')
    expect(corrections.items.map(i => i.key)).toEqual(['go-back', 'manual'])
    corrections.items[0].onClick()
    expect(opened).toEqual(['go-back'])
    expect(sb).toContain('goBack: () => setShowRectify(true),')
  })

  it('mounts the panel on the live set with the rally state and its hooks', () => {
    const mount = sb.slice(sb.indexOf('{showRectify && ('), sb.indexOf('{/* Remarks Modal */}'))
    expect(mount).toContain('<RectifyPanel')
    expect(mount).toContain('liveSetIndex={data?.set?.index ?? null}')
    expect(mount).toContain("rallyInPlay={rallyStatus === 'in_play'}")
    expect(mount).toContain('apply: applyRectification')
    // a team that cannot go on: only a link to the scorer's own forfeit
    expect(mount).toContain("openStopMatch: () => { setShowRectify(false); setStopMatchModal('select') }")
  })

  it('writes the plan as one correction in one action, closing with its data; the score it leaves is followed like a point\'s', () => {
    const body = handler('const applyRectification = useCallback(')
    expect(body).toMatch(/runAction\('rectify', async \(\) => \{/)
    const close = body.indexOf('deferUi(() => setShowRectify(false))')
    expect(close).toBeGreaterThan(-1)
    expect(close).toBeLessThan(body.indexOf('await applyCorrectionPlan(plan'))
    expect(body).toContain("await applyCorrectionPlan(plan, { matchId, db, mode: 'live' })")
    expect(body).toContain('await afterPointScored({ set, homePoints: set.homePoints || 0, awayPoints: set.awayPoints || 0, teamKey: r.penaltyTo || null })')
  })

  it('one serve rule (domain/rules servingTeamFromLog): the screen, the Point path (who rotates), the state sync and the referee', () => {
    expect(handler('const getCurrentServe = useCallback(')).toContain('servingTeamFromLog(data.events, setIndex, data.match)')
    expect(handler('const handlePoint = useCallback(')).toContain('servingTeamFromLog(allEventsBeforePoint, setIndex, data?.match)')
    expect(sb).toContain('const servingTeam = servingTeamFromLog(allEventsForSync, setIndex, match) || currentSetFirstServe')
    const referee = readFileSync(resolve(__dirname, '../Referee.jsx'), 'utf8')
    expect(referee).toContain('servingTeamFromLog(data.events, data.currentSet.index, data.match)')
  })

  it('Undo takes a going back back from its own record, as one correction', () => {
    const body = handler('const undoEventTx = useCallback(')
    const branch = body.slice(body.indexOf("if (lastEvent.type === 'rectification') {"), body.indexOf("if (lastEvent.type === 'forfait') {"))
    expect(branch).toContain('planRectificationReversal(allEventsForRectify, lastEvent.id,')
    expect(branch).toContain("await applyCorrectionPlan(plan, { matchId, db, mode: 'live' })")
    expect(branch).toContain('await settleCourtSwitchAfterUndo(')
    expect(branch).toContain('return')
  })
})
