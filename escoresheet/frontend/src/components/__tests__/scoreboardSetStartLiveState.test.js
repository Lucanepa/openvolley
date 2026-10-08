import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { hasMatchStarted } from '../../utils/livescoreModel'

// Scoreboard.jsx is too large to mount in a unit test; this pins the wiring of
// Start Set to the live state (the livescore lists a match once a row says
// 'set_start', see livescoreModel), so a refactor cannot drop it silently.
const src = readFileSync(resolve(__dirname, '../Scoreboard.jsx'), 'utf8')

function confirmSetStartTimeBody() {
  const start = src.indexOf('const confirmSetStartTime = useCallback(')
  expect(start).toBeGreaterThan(-1)
  const end = src.indexOf('const confirmSetEndTime = useCallback(', start)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('Start Set pushes the live state', () => {
  it("confirmSetStartTime syncs 'set_start' right after writing the set_start event", () => {
    const body = confirmSetStartTimeBody()
    const write = body.indexOf("type: 'set_start'")
    const sync = body.indexOf("syncLiveStateToSupabase('set_start'")
    const rally = body.indexOf("type: 'rally_start'")
    expect(write).toBeGreaterThan(-1)
    expect(sync).toBeGreaterThan(write)
    expect(rally).toBeGreaterThan(sync)
  })

  it('confirmSetStartTime lists syncLiveStateToSupabase in its deps', () => {
    const body = confirmSetStartTimeBody()
    const deps = body.slice(body.search(/\n  \}\)+, \[/))
    expect(deps).toMatch(/syncLiveStateToSupabase/)
  })

  it("a 0:0 set-1 row whose last event is 'set_start' is listed as started", () => {
    expect(hasMatchStarted({
      match_status: 'in_progress',
      current_set: 1,
      points_a: 0,
      points_b: 0,
      sets_won_a: 0,
      sets_won_b: 0,
      last_event_type: 'set_start'
    })).toBe(true)
  })
})

describe('Set 1 start from the schedule (owner 2026-10-08)', () => {
  it('both dialog openers pass the scheduled time', () => {
    const calls = src.match(/defaultSetStartTime\(\{[^}]*\}\)/g) || []
    expect(calls).toHaveLength(2)
    for (const c of calls) expect(c).toMatch(/scheduledAt/)
    expect((src.match(/startsFromSchedule\(\{ setIndex: data\?\.set\?\.index, scheduledAt \}\)/g) || [])).toHaveLength(2)
  })

  it('confirmSetStartTime writes the "Actual start time" remark and records it for undo', () => {
    const body = confirmSetStartTimeBody()
    expect(body).toMatch(/actualStartRemark\(\{ setIndex: setStartTimeModal\.setIndex, scheduledAt: data\.match\?\.scheduledAt/)
    expect(body).toMatch(/setActualStartRemark\(freshMatch\?\.remarks \|\| '', autoRemark\)/)
    expect(body).toMatch(/\.\.\.\(autoRemark \? \{ autoRemark \} : \{\}\)/)
    // the remarks dialog does not pop up over the remark it wrote itself
    expect(body).toMatch(/timeDifferent && !fromSchedule/)
  })
})
