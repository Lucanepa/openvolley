import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Scoreboard.jsx and Referee.jsx are too large to mount in a unit test; this
// pins how they use the tested helpers (utils/matchFormat, utils/livescoreModel).
const scoreboard = readFileSync(resolve(__dirname, '../Scoreboard.jsx'), 'utf8')
const referee = readFileSync(resolve(__dirname, '../Referee.jsx'), 'utf8')

function syncLiveStateBody() {
  const start = scoreboard.indexOf('const syncLiveStateToSupabase = useCallback(')
  expect(start).toBeGreaterThan(-1)
  const end = scoreboard.indexOf('const liveStateData = {', start)
  expect(end).toBeGreaterThan(start)
  return scoreboard.slice(start, end)
}

describe('Scoreboard live-state push', () => {
  it('counts the finished set through setsWonWithFinishedSet (Team B derived, not snapshot.teamBKey)', () => {
    const body = syncLiveStateBody()
    expect(body).toMatch(/setsWonWithFinishedSet\(snapshot, setWinner, countFinishedSet\)/)
    // ...only when the snapshot does not count the finished set yet
    expect(body).toMatch(/countFinishedSet = finishedSetMissingFromSnapshot\(snapshot, finishedSetCount, eventType\)/)
    expect(body).toMatch(/if \(isSetInterval \|\| isMatchEnd\) \{/)
    // captureFullStateSnapshot never stores teamBKey: any use of it is the old bug
    expect(scoreboard).not.toMatch(/snapshot\.teamBKey/)
  })

  it('takes a fresh snapshot for the court switch (sides changed without an event)', () => {
    const body = syncLiveStateBody()
    expect(body).toMatch(/if \(liveStateNeedsFreshSnapshot\(eventType\)\)/)
    expect(scoreboard).toMatch(/syncLiveStateToSupabase\('court_switch'/)
  })
})

describe('set number display', () => {
  it('the scorer header shows displaySetNumber of the current set', () => {
    expect(scoreboard).toMatch(/\{displaySetNumber\(data\?\.set\?\.index \|\| 1, data\?\.match\?\.bestOf\)\}/)
  })

  it('the referee header maps its set index through displaySetNumber', () => {
    expect(referee).toMatch(/const displaySetIndex = displaySetNumber\(/)
  })

  it('the referee\'s last-event text shows the set end as the displayed set number', () => {
    expect(referee).toMatch(/refereeDashboard\.events\.setEnd', \{ set: lastEvent\.data\?\.setIndex \? displaySetNumber\(lastEvent\.data\.setIndex, refBestOf\)/)
  })
})
