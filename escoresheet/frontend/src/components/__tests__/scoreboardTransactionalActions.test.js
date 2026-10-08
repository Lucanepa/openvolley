import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// "First the ball moves, then the team rotates": every write of a scorer
// action was its own Dexie transaction, so the live query painted the score,
// then the serve on the old server, then the rotation. Each action now writes
// in ONE transaction (runAction, tested in hooks/__tests__/useScorerActions)
// and the dialogs it opens or closes are applied with its data (deferUi).
// Scoreboard.jsx is too large to mount in a unit test; this pins the wiring.
const src = readFileSync(resolve(__dirname, '../Scoreboard.jsx'), 'utf8')

// [handler, its runAction key]
const ACTIONS = [
  ['handlePoint', 'point'],
  ['handleStartRally', 'rally'],
  ['confirmReplay', 'replay'],
  ['confirmSanction', 'sanction'],
  ['confirmSetStartTime', 'setStart'],
  ['confirmSet5SideService', 'set5Setup'],
  ['handleUndo', 'undo'],
  ['handleReplayRally', 'decision'],
  ['handleDecisionChange', 'decision'],
  ['confirmTimeout', 'timeout'],
  ['confirmSubstitution', 'substitution'],
  ['confirmPlayerSanction', 'playerSanction'],
  ['handleSanctionSubstitution', 'sanctionSubstitution'],
  ['showLiberoConfirm', 'libero'],
  ['handleLiberoInPlayerSelect', 'libero'],
  ['confirmLibero', 'libero'],
  ['confirmLiberoReentry', 'libero'],
  ['handleLiberoOut', 'libero'],
  ['confirmLiberoRedesignation', 'liberoRedesignation'],
  ['confirmLiberoUnable', 'liberoUnable'],
  ['handleExchangeLibero', 'libero'],
  ['handleSelectCaptainOnCourt', 'captain'],
  ['confirmCourtSwitch', 'courtSwitch'],
  ['cancelCourtSwitch', 'courtSwitch']
]

// a useCallback, from its header to its dependency list
function handler(name) {
  const start = src.indexOf(`  const ${name} = useCallback(`)
  expect(start, name).toBeGreaterThan(-1)
  // `  }, [deps])`, `  }), [deps])`, `  })), [deps])`, with runAction options
  // (`  }, { reason: 'undo' })), [deps])`), or a multi-line `  )`
  const end = src.slice(start).search(/\n {2}(\}(, \{ [^\n]*\})?\)*, \[|\)\n)/)
  expect(end, `${name} end`).toBeGreaterThan(0)
  return src.slice(start, start + end)
}

describe('Scoreboard: one transaction and one screen change per scorer action', () => {
  it('reads the match in one read transaction through useActionLiveQuery', () => {
    expect(src).toMatch(/function readScoreboard\(matchId\) \{\n  return db\.transaction\('r', \[db\.matches, db\.teams, db\.sets, db\.players, db\.events\], async \(\) => \{/)
    expect(src).toMatch(/const \[data, liveCommits\] = useActionLiveQuery\(\(\) => readScoreboard\(matchId\), \[matchId\], preloaded\)/)
    expect(src).not.toMatch(/const data = useLiveQuery\(/)
    expect(src).toMatch(/useScorerActions\(\{\s*db,\s*commits: liveCommits,\s*mutexRef: eventInProgressRef,/)
  })

  it.each(ACTIONS)('%s runs as one action (%s)', (name, key) => {
    const body = handler(name)
    expect(body).toContain(`runAction('${key}', async () => {`)
  })

  it.each(ACTIONS)('%s awaits no timer inside its transaction and opens no dialog on a timer', (name) => {
    const body = handler(name)
    expect(body).not.toMatch(/await new Promise\(resolve => setTimeout/)
    expect(body).not.toMatch(/eventInProgressRef\.current = (true|false)/)
    // the captain check counts from when the action's data is shown
    expect(body).not.toMatch(/\n\s+setTimeout\(\(\) => \{\s*checkAndRequestCaptainOnCourtRef/)
    expect(body).not.toMatch(/setTimeout\(\(\) => \{\s*setLiberoUnableModal/)
  })

  it('the side-out point writes its rotation and libero exit in the same action, and awaits the set-end check', () => {
    const body = handler('handlePoint')
    expect(body).toContain("await logEvent('libero_exit'")
    expect(body).toContain("type: 'lineup',")
    // the set-5 change of courts and the set end: one step that every point
    // path awaits (afterPointScored)
    expect(body).toContain('await afterPointScored({ set: freshCurrentSet, homePoints, awayPoints, teamKey })')
    expect(body).toContain('deferUi(() => setLiberoRotationModal({')
    expect(body).toContain('deferUi(() => setLiberoReentryModal({')
    const after = handler('afterPointScored')
    expect(after).toContain('deferUi(() => setCourtSwitchModal({')
    expect(after).toContain('await checkSetEnd(set, homePoints, awayPoints)')
  })

  it('the serve ball is no longer hidden while a rotation is pending (no render shows one)', () => {
    expect(src).not.toContain('isRotationPending')
    expect(src).not.toContain('pendingRotationRef')
  })

  it('the set-end dialog opens with the winning point', () => {
    const body = handler('checkSetEnd')
    expect(body).toContain('deferUi(() => setSetEndTimeModal({')
  })

  it('logEvent is one action of its own, or joins the running one', () => {
    const body = handler('logEvent')
    expect(body).toContain('return runAction(null, () => logEventTx(type, payload, options), { skipMutex: !!options.skipMutex })')
    const tx = src.slice(src.indexOf('async function logEventTx('), src.indexOf('// Keep logEventRef updated'))
    // part of the transaction, not fire-and-forget (a write after the commit fails)
    expect(tx).toContain("if (type === 'point') await queueSetScoreSync(db, { matchId, setIndex })")
    expect(tx).toContain("deferEffect({ once: 'backup', run: () => triggerContinuousBackup(")
    expect(tx).not.toMatch(/eventInProgressRef/)
  })

  it('the tablets, the livescore, the referee actions and the scoresheet get the action once it committed', () => {
    for (const name of ['syncToReferee', 'sendActionToReferee', 'syncLiveStateToSupabase', 'notifyScoresheetUpdate']) {
      const head = handler(name).slice(0, 600)
      expect(head, name).toMatch(/if \(deferEffect\(\{/)
    }
    // the live state of a deferred push is the action's final snapshot
    expect(handler('syncLiveStateToSupabase')).toContain('pickLiveStateSnapshot(cachedSnapshot, finalSnapshot)')
    // ... and the action's pushes of that state go out as one (mergeLiveStatePushes)
    expect(handler('syncLiveStateToSupabase')).toContain('liveState: { eventType, cachedSnapshot }')
  })

  it('the libero from the court player menu enters with its lineup in one action', () => {
    const start = src.indexOf('const handleLiberoSelect = ')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('\n                  return (', start))
    expect(body).toMatch(/^const handleLiberoSelect = \(libero\) => runAction\('libero', async \(\) => \{/)
    expect(body).toMatch(/deferUi\(\(\) => \{\s*setPlayerActionMenu\(null\)/)
    expect(body.indexOf("await logEvent('libero_entry'")).toBeLessThan(body.indexOf("type: 'lineup'"))
  })

  it('"Libero out" and "Exchange libero" close the player menu with the result, not over the old court', () => {
    for (const name of ['handleLiberoOut', 'handleExchangeLibero']) {
      expect(handler(name), name).toMatch(/\(side, closeMenu = null\) => runAction\('libero', async \(\) => \{\s*if \(closeMenu\) deferUi\(closeMenu\)/)
      expect(src, name).toContain(`onClick={() => ${name}(side, () => {`)
    }
  })

  it('a decision change sends the swapped point to the tablets (they kept the old team\'s point)', () => {
    const swap = handler('handleDecisionChange').split("} else {\n      // Replay rally")[0]
    expect(swap).toContain("syncLiveStateToSupabase('decision_change'")
    expect(swap).toContain('syncToReferee()')
  })

  it('a manual change written during an action is part of its transaction, its cloud update too (sync queue)', () => {
    const body = handler('logManualChange')
    expect(body).toContain('trackWrite(db.matches.update(matchId, { manualChanges: updatedChanges })')
    // the cloud copy goes through the sync queue (a Dexie write): in the transaction, no network
    expect(body).toContain('trackWrite(queueMatchUpdate(db, data.match?.seed_key, { manual_changes: updatedChanges }')
    expect(body).not.toMatch(/apiFrom\(/)
  })

  // The event history (db/eventHistory): the db.events hooks write a void /
  // edit row and its sync job for every delete and edit, labelled with the
  // reason of the surrounding action, inside the action's transaction
  it.each([
    ['handleUndo', 'undo'],
    ['handleDecisionChange', 'decision_change'],
    ['handleReplayRally', 'decision_change'],
    ['cancelCourtSwitch', 'undo']
  ])('%s labels the events it takes back (reason %s) inside its action', (name, reason) => {
    const body = handler(name)
    // the closing line of the action, right after its body
    const closing = src.slice(src.indexOf(body) + body.length).split('\n')[1]
    expect(closing).toMatch(new RegExp(`^ {2}\\}, \\{ reason: '${reason}' \\}\\)+, \\[`))
    // no second context around the action: the reason is set inside its transaction
    expect(handler(name)).not.toMatch(/withActivityContext\(/)
  })

  it('points taken back become voids, their unsent insert jobs go (discardEvents)', () => {
    for (const name of ['handleReplayRally', 'cancelCourtSwitch']) {
      expect(handler(name), name).toContain('planPointRemoval(')
      expect(handler(name), name).toContain('await discardEvents(')
    }
    const discard = handler('discardEvents')
    expect(discard).toContain('db.events.bulkDelete(')
    expect(discard).toContain('syncJobsForEvents(queued,')
  })

  it('the history knows the match key, so its jobs are queued in the action\'s transaction', () => {
    expect(src).toContain('rememberSeedKey(matchId, data.match.seed_key ?? null, data.match.test === true)')
  })

  it('the line-up dialog never gives out a voided seq again (as getNextSeq)', () => {
    expect(src).toMatch(/const maxSeq = Math\.max\(\s*allEvents\.reduce\(\(max, e\) => Math\.max\(max, e\.seq \|\| 0\), 0\),\s*Math\.floor\(await maxVoidedSeq\(db, matchId\)\)\s*\)\s*const manualLineupSeq = maxSeq \+ 1/)
  })

  it('the game captain chosen in the line-up dialog is one action', () => {
    expect(src).toMatch(/await runAction\('gameCaptain', async \(\) => \{\s*if \(Object\.keys\(gameCaptain\.matchUpdate\)\.length\) await db\.matches\.update\(matchId, gameCaptain\.matchUpdate\)\s*if \(gameCaptain\.event\) await logEvent\('court_captain_designation', gameCaptain\.event\)/)
  })

  it('Dexie-only helpers that were not awaited are awaited inside the actions', () => {
    expect(handler('confirmSetStartTime')).toContain('await queueEventSync(db, setStartEventId)')
    expect(handler('handleUndo')).toContain('await queueSetScoreSync(db, { matchId, setIndex: undoneSetIndex })')
  })

  // A body that catches a failed write and carries on commits the writes made
  // before it: an undo that deleted the point but kept the score, a decision
  // change without its rotation, a time-out recorded while the scorer is told
  // it was not. Every catch in an action body rethrows.
  it('no action body swallows a failure: every catch rethrows, so the action rolls back as a whole', () => {
    const bodies = [...ACTIONS.map(([name]) => name), 'restoreStateFromSnapshot']
    for (const name of bodies) {
      const body = handler(name)
      const catches = [...body.matchAll(/\} catch \((\w+)\) \{/g)]
      for (const m of catches) {
        // the catch block: up to the next line closing it at the same indent
        const indent = body.slice(body.lastIndexOf('\n', m.index) + 1, m.index)
        const blockEnd = body.indexOf(`\n${indent}}`, m.index)
        const block = body.slice(m.index, blockEnd)
        expect(block, `${name}: catch (${m[1]})`).toMatch(new RegExp(`throw (markActionErrorReported\\()?${m[1]}\\b`))
      }
    }
  })

  it('a failed scorer action is shown to the scorer once', () => {
    expect(src).toMatch(/onError: onActionFailed\n\s*\}\)/)
    const failed = src.slice(src.indexOf('const onActionFailed = useCallback('), src.indexOf('const onActionFailed = useCallback(') + 300)
    expect(failed).toContain("showAlert(t('scoreboard.confirmFailed'), 'error')")
    const confirmFailed = src.slice(src.indexOf('const onConfirmFailed = useCallback('), src.indexOf('const onActionFailed = useCallback('))
    expect(confirmFailed).toContain('if (isReportedActionError(err)) return')
    // the time-out keeps its own message, not a second one
    expect(handler('confirmTimeout')).toContain("showAlert(t('scoreboard.timeoutRequest.notRecorded'), 'error')\n      throw markActionErrorReported(err)")
  })
})
