// @vitest-environment node
/**
 * Set 5 coin toss (Switch sides / Switch serve / Confirm) before the first
 * rally must reach the referee, bench and livescore tablets. The choice lives
 * in match fields (set5LeftTeam, set5FirstServe), not events, so the scorer
 * pushes a fresh live state for it; the tablets take sides / serve from that
 * live state (side_a, serving_team) first.
 *
 * Scoreboard.jsx and Referee.jsx are too large to mount: the wiring is pinned
 * in their source, the payload rule and the relay hop run for real.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createLanRelay } from '../../../lanRelayCore.js'
import { buildLiveStateMatchData } from '../../utils/serverDataSync'
import { liveStateNeedsFreshSnapshot } from '../../utils/livescoreModel'
import { getSideAForSet, getFirstServeForSet } from '../../domain/rules'

const scoreboard = readFileSync(resolve(__dirname, '../Scoreboard.jsx'), 'utf8')
const referee = readFileSync(resolve(__dirname, '../Referee.jsx'), 'utf8')

function slice(src, startMarker, length = 4000) {
  const start = src.indexOf(startMarker)
  expect(start).toBeGreaterThan(-1)
  return src.slice(start, start + length)
}

// What syncLiveStateToSupabase writes for side_a / serving_team (fresh snapshot)
function set5LiveSides(match) {
  const teamAKey = match.coinTossTeamA || 'home'
  const sideA = getSideAForSet(5, match)
  const firstServe = getFirstServeForSet(5, match)
  return { side_a: sideA, serving_team: firstServe === teamAKey ? sideA : (sideA === 'left' ? 'right' : 'left') }
}

// Referee.jsx homeOnLeftFor2ndRef, live state first (pinned below)
const homeOnLeftFromLiveState = (sideA, teamAKey) => (sideA === 'left' ? teamAKey === 'home' : teamAKey !== 'home')

describe('scorer: set 5 setup pushes a live state', () => {
  const inline = slice(scoreboard, "data?.set?.index === 5 && !set5SetupConfirmed && !timeoutModal?.started) ? (", 7000)

  // The three buttons' handlers are shared with the phone layout (PhoneScoreboard)
  const handlers = slice(scoreboard, 'const set5SwitchSides = async () => {', 1200)

  it('the inline setup (desktop and phone layout) uses the shared handlers', () => {
    expect(inline).toMatch(/onClick=\{set5SwitchSides\}/)
    expect(inline).toMatch(/onClick=\{set5SwitchServe\}/)
    expect(inline).toMatch(/onClick=\{set5ConfirmSetup\}/)
    expect(scoreboard).toMatch(/set5SwitchSides,\s*\n\s*set5SwitchServe,\s*\n\s*set5Confirm: set5ConfirmSetup/)
  })

  it('Switch sides and Switch serve push after writing Dexie', () => {
    expect(handlers).toMatch(/set5LeftTeam: newLeftTeam \}\)\s*\n\s*syncSet5Setup\(\{ duringInterval: !!betweenSetsCountdown \}\)/)
    expect(handlers).toMatch(/set5FirstServe: newFirstServe \}\)\s*\n\s*syncSet5Setup\(\{ duringInterval: !!betweenSetsCountdown \}\)/)
  })

  it('Confirm records the coin toss, then ends the interval on the tablets too', () => {
    expect(handlers).toMatch(/await confirmSet5SideService\([^\n]*, true\)/)
    // inside the action: the countdown goes with the setup, the tablets are
    // told after the commit (ScoreboardSet5SetupOneChange)
    const action = slice(scoreboard, 'const confirmSet5SideService = useCallback(', 1500)
    expect(action).toMatch(/setBetweenSetsCountdown\(null\)/)
    expect(action).toMatch(/deferEffect\(\{ run: \(\) => syncSet5Setup\(\{ endInterval: true \}\) \}\)/)
  })

  it('the push is a fresh snapshot to relay + cloud, plus the match bundle', () => {
    const body = slice(scoreboard, 'const syncSet5Setup = useCallback(', 2000)
    expect(body).toMatch(/sendActionToReferee\('end_interval', \{\}\)/)
    expect(body).toMatch(/syncLiveStateToSupabase\('manual_set5_setup'/)
    expect(body).toMatch(/syncToReferee\(\)/)
    expect(liveStateNeedsFreshSnapshot('manual_set5_setup')).toBe(true)
    // ending the interval elsewhere carries the chosen sides too
    expect(liveStateNeedsFreshSnapshot('end_interval')).toBe(true)
  })

  it('a push during the interval keeps the interval on the tablets', () => {
    const sync = slice(scoreboard, 'const syncLiveStateToSupabase = useCallback(', 16000)
    // the set 5 setup's pushes say so (duringInterval); any other push while
    // the screen's interval runs too (ScoreboardIntervalLiveState)
    expect(sync).toMatch(/const keepInterval = !isMatchEnd && !isSetInterval && \(eventData\?\.duringInterval === true \|\| inBreak\)/)
    expect(sync).toMatch(/else if \(isSetInterval \|\| keepInterval\) matchStatus = 'interval'/)
    expect(sync).toMatch(/set_interval_active: isSetInterval \|\| keepInterval/)
  })

  it('the set 5 defaults written after the set_end push are pushed too', () => {
    expect(scoreboard).toMatch(/The set_end push went out before the set 5 defaults were written\s*\n\s*syncSet5Setup\(\{ duringInterval: true \}\)/)
  })

  it('the snapshot takes side_a from the tested rule', () => {
    expect(scoreboard).toMatch(/const sideA = getSideAForSet\(setIndex, match\)/)
  })
})

describe('referee: sides and serve of set 5 from the pushed fields', () => {
  it('reads side_a first, the same rule as the scorer as fallback', () => {
    const body = slice(referee, 'const homeOnLeftFor2ndRef = useMemo(', 1500)
    expect(body).toMatch(/if \(data\?\.liveState\?\.side_a\)/)
    expect(body).toMatch(/getSideAForSet\(data\.currentSet\.index, data\?\.match \|\| \{\}\)/)
  })

  it('a set 5 switch reaches the referee over the LAN relay and flips sides and serve', () => {
    // Team A = home. Default after set 4: A left, A serves. The scorer switches
    // sides (B left) and serve (B first).
    const before = set5LiveSides({ coinTossTeamA: 'home', set5LeftTeam: 'A', set5FirstServe: 'A' })
    const after = set5LiveSides({ coinTossTeamA: 'home', set5LeftTeam: 'B', set5FirstServe: 'B' })
    expect(before).toEqual({ side_a: 'left', serving_team: 'left' })
    expect(after).toEqual({ side_a: 'right', serving_team: 'left' })

    const relay = createLanRelay()
    const sock = () => {
      const ws = { readyState: 1, sent: [], send(t) { this.sent.push(JSON.parse(t)) }, last(type) { return [...this.sent].reverse().find(m => m.type === type) } }
      relay.addClient(ws, { ip: '192.168.1.40' })
      return ws
    }
    const send = (ws, m) => relay.handleMessage(ws, JSON.stringify(m))
    const scorer = sock()
    const ref = sock()
    const match = { id: 7, status: 'live', gamePin: '987654', refereePin: '314159', refereeConnectionEnabled: true, coinTossTeamA: 'home', set5LeftTeam: 'B', set5FirstServe: 'B' }
    send(scorer, { type: 'sync-match-data', matchId: 7, match, homeTeam: { name: 'Home VC' }, awayTeam: { name: 'Away VC' }, homePlayers: [], awayPlayers: [], sets: [], events: [] })
    send(ref, { type: 'subscribe-match', matchId: '7', pin: '314159' })

    const base = { current_set: 5, sets_won_a: 2, sets_won_b: 2, points_a: 0, points_b: 0, team_a_name: 'Home VC', team_b_name: 'Away VC' }
    send(scorer, { type: 'live-state-update', matchId: 7, liveState: { ...base, ...before, match_status: 'interval', set_interval_active: true } })
    send(scorer, { type: 'live-state-update', matchId: 7, liveState: { ...base, ...after, match_status: 'interval', set_interval_active: true, last_event_type: 'manual_set5_setup' } })

    const got = ref.last('live-state-update').liveState
    expect(got).toMatchObject({ side_a: 'right', serving_team: 'left', set_interval_active: true })
    // Referee: Team A (home) on the right, so away is on the left and serves
    expect(homeOnLeftFromLiveState(got.side_a, 'home')).toBe(false)
    const built = buildLiveStateMatchData({ home_team: { name: 'Home VC' }, away_team: { name: 'Away VC' } }, got, '7')
    expect(built.sets[0]).toMatchObject({ index: 5, homePoints: 0, awayPoints: 0, servingTeam: 'away' })

    // A tablet that subscribes later gets the same state with the bundle
    const late = sock()
    send(late, { type: 'subscribe-match', matchId: '7', pin: '314159' })
    const full = late.last('match-full-data')
    expect(full.liveState ?? full.data?.liveState).toMatchObject({ side_a: 'right', serving_team: 'left' })
  })
})
