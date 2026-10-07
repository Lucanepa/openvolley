// Every scorer confirmation dialog follows one pattern (hooks/useConfirmAction):
// snapshot at open, close before the first await, one run at a time.
// Scoreboard is too large to render in a unit test, so the source is checked
// for the wiring; the pattern itself is tested in useConfirmAction.test.jsx.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import en from '../../i18n/locales/en.json'
import de from '../../i18n/locales/de.json'
import deCH from '../../i18n/locales/de-CH.json'
import fr from '../../i18n/locales/fr.json'
import it_ from '../../i18n/locales/it.json'

const sb = readFileSync(resolve(__dirname, '../Scoreboard.jsx'), 'utf8')
const between = (from, to) => {
  const a = sb.indexOf(from)
  if (a < 0) throw new Error(`not found: ${from}`)
  return sb.slice(a, sb.indexOf(to, a + from.length))
}
// a useCallback body, from its header to its dependency list
const handler = header => between(header, '\n  }), [')

// [handler header, the call that closes its dialog]
const DIALOGS = [
  ['const confirmTimeout = useCallback(', 'setTimeoutModal({ ...request, started: true'],
  ['const confirmSanction = useCallback(', 'setSanctionConfirm(null)'],
  ['const confirmPlayerSanction = useCallback(', 'setSanctionConfirmModal(null)'],
  ['const handleSanctionSubstitution = useCallback(', 'setSanctionSubstitutionModal(null)'],
  ['const confirmSubstitution = useCallback(', 'setSubstitutionConfirm(null)'],
  ['const confirmLibero = useCallback(', 'setLiberoConfirm(null)'],
  ['const confirmLiberoReentry = useCallback(', 'setLiberoReentryModal(null)'],
  ['const confirmLiberoRedesignation = useCallback(', 'setLiberoRedesignationModal(null)'],
  ['const handleSelectCaptainOnCourt = useCallback(', 'setCaptainOnCourtModal(null)'],
  ['const confirmCourtSwitch = useCallback(', 'setCourtSwitchModal(null)'],
  ['const cancelCourtSwitch = useCallback(', 'setCourtSwitchModal(null)'],
  ['const confirmSet5SideService = useCallback(', 'setSet5SideServiceModal(null)'],
  ['const handleUndo = useCallback(', 'setUndoConfirm(null)'],
  ['const handleDecisionChange = useCallback(', 'setReplayRallyConfirm(null)'],
]

describe('Scoreboard confirmation dialogs: snapshot, close first, one run', () => {
  it.each(DIALOGS)('%s is guarded and closes before its first await', (header, close) => {
    const body = handler(header)
    expect(body).toMatch(/=> run\w+\(async \(\) => \{/)
    const closeAt = body.indexOf(close)
    const firstAwait = body.indexOf('await ')
    expect(closeAt).toBeGreaterThan(-1)
    expect(firstAwait).toBeGreaterThan(-1)
    expect(closeAt).toBeLessThan(firstAwait)
    // the guard hook is declared right before the handler
    const runner = body.match(/=> (run\w+)\(async/)[1]
    expect(sb).toContain(`const ${runner} = useConfirmAction(onConfirmFailed)`)
  })

  it('the replay branch of the decision change closes before its first await too', () => {
    const body = between('const handleReplayRally = useCallback(', '\n  }, [')
    expect(body.indexOf('setReplayRallyConfirm(null)')).toBeLessThan(body.indexOf('await '))
  })

  it('the decision change records what its dialog shows when nothing was chosen (swap)', () => {
    expect(handler('const handleDecisionChange = useCallback(')).toContain("replayRallyConfirm.selectedOption || 'swap'")
    expect(sb).toContain("const selectedOption = replayRallyConfirm.selectedOption || 'swap'")
  })

  it('reopening a set is guarded and closes first', () => {
    const click = between('onClick={() => runReopenSet(async () => {', 'Yes, reopen')
    expect(click.indexOf('setReopenSetConfirm(null)')).toBeLessThan(click.indexOf('await '))
  })
})

describe('time-out request (owner report: "this set?" and the 1st/2nd flash)', () => {
  it('the dialog is classified once, when it opens', () => {
    const open = between('const handleTimeout = useCallback(', 'const runTimeoutConfirm')
    expect(open).toContain('classifyTimeoutRequest(data.events, data.set.index, teamKey)')
    expect(open).toContain('ordinal: request.ordinal')
    expect(open).toContain('consecutive: request.consecutive')
  })

  it('the dialog wording never reads the live time-out count', () => {
    const dialog = between('{timeoutModal && !timeoutModal.started && (', '</Modal>')
    expect(dialog).not.toContain('timeoutsUsed')
    expect(dialog).toContain('timeoutModal.ordinal === 2')
    expect(dialog).toContain('timeoutModal.consecutive')
    expect(dialog).toContain("t('scoreboard.timeoutRequest.consecutive'")
    expect(dialog).toContain("t('scoreboard.timeoutRequest.second'")
  })

  it('there is one time-out dialog: the separate "already used a timeout this set" one is gone', () => {
    expect(sb).not.toContain('duplicateTimeoutConfirm')
    expect(sb).not.toContain('timeoutAlreadyTaken')
  })

  it('a third request opens the improper-request dialog, also from the TO counter', () => {
    const open = between('const handleTimeout = useCallback(', 'const runTimeoutConfirm')
    expect(open).toContain("openTeamSanctionConfirm(side, 'improper_request', 'third_timeout')")
    expect(sb).not.toMatch(/canCallTimeout = getTimeoutsUsed\(/)
  })

  it('the sanction dialog shows and records the resolved sanction', () => {
    const open = between('const openTeamSanctionConfirm = useCallback(', '\n  }, [')
    expect(open).toContain('resolveSanction(requestedType')
    const confirm = handler('const confirmSanction = useCallback(')
    expect(confirm).toContain('resolved: type } = sanctionConfirm')
    expect(confirm).not.toContain('resolveSanction(')
    const dialog = between('{sanctionConfirm && (', '</Modal>')
    expect(dialog).toContain("reason === 'third_timeout'")
    expect(dialog).toContain("t('scoreboard.teamSanctionConfirm.thirdTimeout'")
  })
})

describe('time-out and team-sanction texts', () => {
  const LOCALES = { en, de, 'de-CH': deCH, fr, it: it_ }
  const KEYS = [
    'timeoutRequest.title', 'timeoutRequest.first', 'timeoutRequest.second', 'timeoutRequest.consecutive',
    'timeoutRequest.confirmConsecutive', 'timeoutRequest.notRecorded', 'confirmFailed',
    'teamSanctionConfirm.thirdTimeout', 'teamSanctionConfirm.applyImproperRequest',
    'teamSanctionConfirm.applyDelayWarning', 'teamSanctionConfirm.applyDelayPenalty',
    'teamSanctionConfirm.repeatedImproperRequest', 'teamSanctionConfirm.repeatedDelay',
    'teamSanctionConfirm.pointToOpponent', 'buttons.confirmTimeout'
  ]
  const get = (o, p) => p.split('.').reduce((x, k) => x?.[k], o)

  it.each(Object.keys(LOCALES))('%s has every key, with its placeholders', (lng) => {
    const s = LOCALES[lng].scoreboard
    for (const key of KEYS) {
      const value = get(s, key)
      expect(typeof value, `${lng} scoreboard.${key}`).toBe('string')
      const placeholders = (get(en.scoreboard, key).match(/\{\{\w+\}\}/g) || []).sort()
      expect((value.match(/\{\{\w+\}\}/g) || []).sort(), `${lng} scoreboard.${key}`).toEqual(placeholders)
    }
  })

  it('the consecutive wording is about the interruption, not the set', () => {
    expect(en.scoreboard.timeoutRequest.consecutive).toMatch(/interruption/)
    expect(en.scoreboard.timeoutRequest.consecutive).not.toMatch(/this set/)
    expect(en.scoreboard.timeoutRequest.second).toMatch(/1 of 2 already used/)
  })

  it('no machine-translated "network timeout" words in the time-out texts', () => {
    for (const lng of ['de', 'de-CH', 'fr']) {
      const text = JSON.stringify(LOCALES[lng].scoreboard.timeoutRequest)
      expect(text).not.toMatch(/Zeitüberschreitung|délai/i)
    }
  })
})
