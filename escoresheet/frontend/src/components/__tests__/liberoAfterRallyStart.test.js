// Owner, 15.11: a libero replacement can be written after "Start rally". It
// belongs before the service: runAction('libero') takes the rally start back,
// runs the libero action and starts the rally again, in one action. Checked
// end to end in Chromium (libero entry from the court menu during play: the
// record reads point, libero_entry + its line-up row, rally_start).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const sb = readFileSync(resolve(__dirname, '../Scoreboard.jsx'), 'utf8')
const between = (a, b) => { const i = sb.indexOf(a); return sb.slice(i, sb.indexOf(b, i)) }

describe('libero replacement after Start rally', () => {
  it('runAction wraps the libero key: rally start out, the action, rally start back (its start time kept)', () => {
    const wrap = between('const runAction = useCallback((key, body, opts) => {', '}, [runScorerAction, matchId, deferEffect])')
    expect(wrap).toContain("if (key !== 'libero') return runScorerAction(key, body, opts)")
    expect(wrap).toContain("rallyStatusOf(events, setIndex) === 'in_play'")
    expect(wrap).toContain('await h.discardEvents([taken])')
    expect(wrap).toMatch(/finally \{[\s\S]*db\.events\.add\(\{ \.\.\.row, seq: await h\.getNextSeq\(\) \}\)/)
    expect(sb).toContain('liberoRallyHelpersRef.current = { discardEvents, getNextSeq, syncToReferee }')
  })

  it('the libero entry points open while the rally is in play; the court menu shows the libero only', () => {
    for (const name of ['handleLiberoOut', 'handleExchangeLibero', 'handleLiberoIn']) {
      const body = between(`const ${name} = useCallback(`, '\n  }')
      expect(body, name).toContain("if (rallyStatus !== 'idle' && rallyStatus !== 'in_play') return")
    }
    const click = between('const handlePlayerClick = useCallback(', '}, [rallyStatus,')
    expect(click).toContain("const rallyInPlay = rallyStatus === 'in_play'")
    expect(click).toContain('const canSubstitute = !rallyInPlay &&')
    expect(click).toContain('liberoOnly: rallyInPlay')
    expect(sb).toContain('{!playerActionMenu.liberoOnly && (')
    expect(sb).toContain('{!playerActionMenu.isLiberoOnCourt && !playerActionMenu.liberoOnly && (')
  })
})
