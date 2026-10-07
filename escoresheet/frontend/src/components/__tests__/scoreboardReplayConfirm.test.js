// "Replay rally" during a rally asks first, like Undo. Scoreboard is too large
// to render in a unit test, so the source is checked for the wiring.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const sb = readFileSync(resolve(__dirname, '../Scoreboard.jsx'), 'utf8')
const between = (from, to) => sb.slice(sb.indexOf(from), sb.indexOf(to, sb.indexOf(from)))

describe('Scoreboard "Replay rally" confirmation', () => {
  it('the in-play button opens the confirmation instead of logging the replay', () => {
    const handler = between('const handleReplay = useCallback', '// Confirmed "Replay rally"')
    const inPlay = handler.slice(handler.indexOf("if (rallyStatus === 'in_play')"), handler.indexOf("if (rallyStatus === 'idle'"))
    expect(inPlay).toContain('setReplayConfirm(true)')
    expect(inPlay).not.toContain("logEvent('replay')")
    // the decision-change path keeps its own modal, no second confirmation
    expect(handler).toContain('setReplayRallyConfirm({')
  })

  it('only the confirmation logs the replay, and only while the rally is in play', () => {
    const confirm = between('const confirmReplay = useCallback', 'const cancelReplay')
    expect(confirm).toContain("if (rallyStatus !== 'in_play') return")
    expect(confirm).toContain("await logEvent('replay')")
    expect(sb.match(/logEvent\('replay'\)/g)).toHaveLength(1)
  })

  it('the modal is a decision modal: Enter confirms, it blocks the point keys', () => {
    const keys = between('const handleKeyDown = (e) =>', "window.addEventListener('keydown', handleKeyDown)")
    expect(keys).toMatch(/const hasDecisionModal = [^;]*replayConfirm \|\|/)
    expect(keys).toMatch(/if \(replayConfirm\) \{\s*e\.preventDefault\(\)\s*confirmReplay\(\)/)
  })

  it('the modal uses translated texts', () => {
    const modal = between('{replayConfirm && (', '</Modal>')
    expect(modal).toContain("t('scoreboard.modals.confirmReplay')")
    expect(modal).toContain("t('scoreboard.modals.confirmReplayBody')")
    expect(modal).toContain('onClick={confirmReplay}')
    expect(modal).toContain('onClick={cancelReplay}')
  })
})
