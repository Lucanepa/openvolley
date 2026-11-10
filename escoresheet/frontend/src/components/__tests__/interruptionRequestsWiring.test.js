// @vitest-environment node
/**
 * Rows 10, 11 and 19 of the interruption-request spec (2026-11-09): the
 * late request that stopped a rally (the in-play Replay dialog), the
 * improper request with no reason asked or kept (the owner, 2026-11-09:
 * "no reason, no need, same for delays"), and the decision change after a
 * substitution or time-out (taken back with it). The rules
 * are tested in domain/__tests__/interruptionRequests.test.js and the flows
 * on the mounted screen in ScoreboardInterruptionFlows.test.jsx;
 * Scoreboard.jsx is too large to mount for every detail, so this pins the
 * wiring.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import en from '../../i18n/locales/en.json'
import de from '../../i18n/locales/de.json'
import deCH from '../../i18n/locales/de-CH.json'
import fr from '../../i18n/locales/fr.json'
import it_ from '../../i18n/locales/it.json'

const sb = readFileSync(resolve(__dirname, '../Scoreboard.jsx'), 'utf8')
const phone = readFileSync(resolve(__dirname, '../scoreboard/PhoneScoreboard.jsx'), 'utf8')
const between = (from, to) => {
  const a = sb.indexOf(from)
  if (a < 0) throw new Error(`not found: ${from}`)
  return sb.slice(a, sb.indexOf(to, a + from.length))
}
// a useCallback body, from its header to its dependency list
const handler = (name) => {
  const header = `  const ${name} = useCallback(`
  const a = sb.indexOf(header)
  if (a < 0) throw new Error(`not found: ${header}`)
  const end = sb.slice(a).search(/\n {2}\}(, \{ [^\n]*\})?\)*, \[/)
  if (end < 0) throw new Error(`no end: ${name}`)
  return sb.slice(a, a + end)
}

describe('row 10: a late request stopped the rally (the in-play Replay dialog)', () => {
  it('confirmReplay records the replay and the team\'s next delay sanction in one action', () => {
    const body = handler('confirmReplay')
    expect(body).toMatch(/useCallback\(\(lateRequestTeam\) => runAction\('replay', async \(\) => \{/)
    // still only while the rally is in play, and the plain replay is unchanged
    expect(body).toContain("if (rallyStatus !== 'in_play') return")
    expect(body).toContain("lateRequestOutcome(data?.events, lateRequestTeam)")
    // a delay penalty decides the rally: no replay then
    expect(body).toContain("if (!late || late.replay) await logEvent('replay')")
    expect(body).toContain('await recordTeamSanction({ side: mapTeamKeyToSide(lateRequestTeam), team: lateRequestTeam, type: late.sanction })')
    // the replay before the sanction: the replay keeps requests closed (row 7)
    expect(body.indexOf("await logEvent('replay')")).toBeLessThan(body.indexOf('await recordTeamSanction('))
  })

  it('the Replay dialog offers one late-request option per team, A first, saying what it records', () => {
    const modal = between('{replayConfirm && (', '{replayRallyConfirm && (() => {')
    expect(modal).toContain('onClick={confirmReplay}')
    expect(modal).toContain('[teamAKey, teamBKey].map(key => {')
    expect(modal).toContain('const late = lateRequestOutcome(data?.events, key)')
    expect(modal).toContain('onClick={() => confirmReplay(key)}')
    expect(modal).toContain("t(late.replay ? 'scoreboard.lateRequest.replay' : 'scoreboard.lateRequest.penalty', { team: labelOf(key) })")
    expect(modal).toContain('card={late.sanction}')
  })

  it('the phone\'s Replay opens the same dialog', () => {
    expect(phone).toContain("gridButton('replay', t('scoreboard.phone.replay'), () => actions.replay(), { disabled: !inPlay })")
    expect(sb).toMatch(/\n\s+replay: handleReplay,/)
  })
})

describe('the team sanction is written in one place', () => {
  it('recordTeamSanction writes no reason on the sanction, and a penalty point is never asked as an accidental tap', () => {
    const body = handler('recordTeamSanction')
    expect(body).toContain('useCallback(async ({ side, team: teamKey, type }) => {')
    expect(body).toContain("const sanctionSeq = await logEvent('sanction', {\n      team: teamKey,\n      type: type\n    })")
    expect(body).not.toMatch(/reason/)
    expect(body).toContain('await handlePoint(otherSide, true, { penaltySeq: sanctionSeq })')
    expect(sb.match(/logEvent\('sanction', \{\n\s+team: teamKey,\n\s+type: type/g)).toHaveLength(1)
  })

  it('confirmSanction records through it, the dialog\'s and the warning\'s sanction alike', () => {
    const body = handler('confirmSanction')
    expect(body).toContain('await recordTeamSanction({ side, team: teamKey, type })')
    expect(handler('chooseRequestWarning')).toContain('confirmSanction({ side: mapTeamKeyToSide(team), team, resolved })')
  })
})

describe('row 11: the improper request asks no reason', () => {
  it('the Improper request dialog has no reason picker', () => {
    const open = between('const openTeamSanctionConfirm = useCallback(', '\n  }, [')
    expect(open).toContain('setSanctionConfirm({ side, team: teamKey, type: requestedType, resolved, reason })')
    expect(open).not.toContain('improperReason')
    const dialog = between('{sanctionConfirm && (', '</Modal>')
    expect(dialog).not.toContain('ImproperReasonPicker')
    expect(dialog).not.toContain('improperReason')
    expect(sb).not.toContain('ImproperReasonPicker')
  })

  it('the phone\'s Improper request opens the same dialog', () => {
    expect(phone).toContain('actions.improperRequest(team.side)')
    expect(sb).toMatch(/\n\s+improperRequest: handleImproperRequest,/)
  })
})

describe('row 19: decision change after a substitution or time-out', () => {
  it('is offered when the last point is followed only by time-outs / substitutions (tablet and phone)', () => {
    const memo = between('const decisionTakeBack = useMemo(', 'const isFirstRally')
    expect(memo).toContain('!canReplayRally && data?.set ? decisionChangeTakeBack(data.events, data.set.index) : null')
    expect(memo).toContain('const canChangeDecision = canReplayRally || !!decisionTakeBack')
    expect(sb).toContain("{rallyStatus === 'idle' && canChangeDecision && (")
    expect(sb).toContain("{rallyStatus === 'idle' && !canChangeDecision && <span aria-hidden=\"true\" />}")
    expect(sb).toMatch(/canReplayRally,\n(\s+\/\/[^\n]*\n)+\s+canChangeDecision,/)
    expect(phone).toContain('(rally.canChangeDecision ?? rally.canReplayRally)')
  })

  it('the dialog is the decision change\'s, with what it takes back', () => {
    const open = handler('handleReplay')
    expect(open).toContain("setReplayRallyConfirm({ event: pointEvent, description: `Point for ${teamName}`, selectedOption: 'swap', takeBack: decisionTakeBack.requests })")
    const dialog = between('{replayRallyConfirm && (() => {', '</Modal>')
    expect(dialog).toContain('data-testid="decision-take-back"')
    expect(dialog).toContain("t('scoreboard.decisionTakeBack.substitution'")
    expect(dialog).toContain("t('scoreboard.decisionTakeBack.timeout'")
    // only the sentence that applies (it always named both, 3.0.16 test match)
    expect(dialog).toContain('t(`scoreboard.decisionTakeBack.${decisionTakeBackTextKey(replayRallyConfirm.takeBack)}`)')
  })

  it('takes them back through Undo\'s own writes, then changes the decision on the events as they are then', () => {
    const body = handler('handleDecisionChange')
    const loop = body.indexOf('for (const request of takeBack) await undoEventTx(request)')
    const fresh = body.indexOf("const events = takeBack.length > 0 ? await db.events.where('matchId').equals(matchId).toArray() : data.events")
    const swap = body.indexOf("if (selectedOption === 'swap') {")
    expect(loop).toBeGreaterThan(-1)
    expect(fresh).toBeGreaterThan(loop)
    expect(swap).toBeGreaterThan(fresh)
    // the swap reads those events, not the screen's
    const swapBranch = body.slice(swap)
    expect(swapBranch).toContain('pointSubEventsForTeam(events, lastEvent, oldTeam)')
    expect(swapBranch).not.toContain('data.events')
    // Undo goes through the same writes; nothing duplicates them
    expect(handler('handleUndo')).toContain('await undoEventTx(lastEvent)')
    expect(sb.match(/const lastEventSeq = lastEvent\.seq \|\| 0\n\s+const baseSeq = Math\.floor\(lastEventSeq\)/g)).toHaveLength(1)
  })
})

describe('the texts, in all five languages', () => {
  const LOCALES = { en, de, 'de-CH': deCH, fr, it: it_ }
  const KEYS = [
    'scoreboard.lateRequest.heading', 'scoreboard.lateRequest.replay', 'scoreboard.lateRequest.penalty',
    'scoreboard.lateRequest.recordsWarning', 'scoreboard.lateRequest.recordsPenalty', 'scoreboard.lateRequest.rule',
    'scoreboard.decisionTakeBack.title', 'scoreboard.decisionTakeBack.timeout', 'scoreboard.decisionTakeBack.substitution',
    'scoreboard.decisionTakeBack.textSubstitution', 'scoreboard.decisionTakeBack.textTimeout',
    'scoreboard.decisionTakeBack.textBoth', 'scoreboard.decisionTakeBack.rule'
  ]
  const get = (o, p) => p.split('.').reduce((x, k) => x?.[k], o)
  it.each(Object.entries(LOCALES))('%s has every key', (_, locale) => {
    for (const key of KEYS) expect(typeof get(locale, key), key).toBe('string')
    expect(get(locale, 'scoreboard.lateRequest.replay')).toContain('{{team}}')
    expect(get(locale, 'scoreboard.lateRequest.recordsPenalty')).toContain('{{opponent}}')
    expect(get(locale, 'scoreboard.decisionTakeBack.substitution')).toMatch(/\{\{in\}\}[\s\S]*\{\{out\}\}/)
    // the substitution's sentence names no time-out, the time-out's no substitution
    expect(get(locale, 'scoreboard.decisionTakeBack.textSubstitution')).not.toBe(get(locale, 'scoreboard.decisionTakeBack.textBoth'))
    expect(get(locale, 'scoreboard.decisionTakeBack.textTimeout')).not.toBe(get(locale, 'scoreboard.decisionTakeBack.textBoth'))
    expect(get(locale, 'scoreboard.decisionTakeBack.textSubstitution').toLowerCase()).not.toMatch(/time-?out|temps mort/)
    expect(get(locale, 'scoreboard.decisionTakeBack.text')).toBeUndefined()
    // no reason texts any more (the owner, 2026-11-09)
    expect(get(locale, 'scoreboard.improperReason')).toBeUndefined()
    expect(get(locale, 'corrections.sanctionReason')).toBeUndefined()
  })
})
