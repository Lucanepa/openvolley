import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// App.jsx cannot be mounted in a unit test (Dexie, sync queue, relay, i18n);
// the helpers it uses are tested in relayPublisher.test.js and
// serverDataSync.relay.test.js. This pins how App.jsx wires them.
const src = readFileSync(resolve(__dirname, '../../App.jsx'), 'utf8')
const scoreboardSrc = readFileSync(resolve(__dirname, '../Scoreboard.jsx'), 'utf8')

function slice(from, to) {
  const start = src.indexOf(from)
  expect(start).toBeGreaterThan(-1)
  const end = src.indexOf(to, start + from.length)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('App.jsx relay wiring', () => {
  it('opens no WebSocket of its own: it attaches to the one scorer connection (no probe sockets)', () => {
    expect(src).not.toMatch(/new WebSocket\(/)
    expect(scoreboardSrc).not.toMatch(/new WebSocket\(/)
    expect(src).toMatch(/scorerRelay\.attach\(wsUrl, \{/)
    expect(src).toMatch(/const wsUrl = scorerRelayUrl\(\{ wsPort: serverStatus\?\.wsPort \}\)/)
  })

  it('the connection status check asks the relay over HTTP, via relayConnectionStatus', () => {
    const body = slice('const checkConnectionStatuses = useCallback(', '\n  }, [')
    expect(body).toMatch(/relayConnectionStatus\(\{ wsUrl, ws: scorerRelay\.socket \}\)/)
    // the same url the shared connection is attached to
    expect(body).toMatch(/const wsUrl = scorerRelayUrl\(\{ wsPort: relayWsPort \}\)/)
    expect(body).not.toMatch(/new WebSocket\(/)
  })

  it('the network checks do not re-run on match writes or sync status flips', () => {
    const start = src.indexOf('const checkConnectionStatuses = useCallback(')
    const deps = src.slice(src.indexOf('\n  }, [', start), src.indexOf(']', src.indexOf('\n  }, [', start)) + 1)
    expect(deps).not.toMatch(/syncStatus|currentMatch\b|serverStatus\b/)
  })

  it('sync-match-data goes under the seed key with PINs only when they change', () => {
    const body = slice('const syncMatchData = async () => {', 'const handlePinValidationRequest')
    // nothing under a Dexie id: no seed key, no sync
    expect(body).toMatch(/const relayKey = relayMatchKey\(currentMatchData\)\n\s*if \(!relayKey\) return/)
    // the connection's one PIN tracker, shared with the Scoreboard
    expect(body).toMatch(/scorerRelay\.pins\.payloadFor\(ws, currentMatchData, relayKey, syncMark\)/)
    expect(body).toMatch(/matchId: relayKey,/)
    expect(body).toMatch(/ws\.send\(JSON\.stringify\(syncPayload\)\)\n\s*commitPins\(\)/)
    // the raw match (with game_pin / connection_pins) is never sent
    expect(body).not.toMatch(/match: currentMatchData/)
  })
})

describe('Scoreboard live state: a test match stays out of the cloud', () => {
  // Scoreboard cannot be mounted here either; publishLiveState and
  // liveStateTargets are tested in relayPublisher.test.js. This pins that every
  // cloud step of syncLiveStateToSupabase sits inside publishLiveState's toCloud.
  const start = scoreboardSrc.indexOf('const syncLiveStateToSupabase = useCallback(')
  const end = scoreboardSrc.indexOf('\n  }, [', start)
  const body = scoreboardSrc.slice(start, end)
  const cloudAt = body.indexOf('toCloud: async () => {')
  const catchAt = body.lastIndexOf('} catch (err) {')

  it('routes through publishLiveState with the targets of liveStateTargets', () => {
    expect(start).toBeGreaterThan(-1)
    expect(body).toMatch(/await publishLiveState\(\{\s*targets: routeOf\(\),/)
    expect(body).toMatch(/const routeOf = \(\) => liveStateTargets\(\{ isTest, relayKey: relayKeyRef\.current, relayUrl: scorerRelay\.url \}\)/)
    expect(cloudAt).toBeGreaterThan(-1)
  })

  it('looks up, upserts and marks for retry only inside toCloud', () => {
    const before = body.slice(0, cloudAt)
    const cloud = body.slice(cloudAt, catchAt)
    for (const step of ['apiFrom(', 'setLiveStateDirty(', 'isAuthBlocked(', 'liveOrder.write(']) {
      expect(before, step).not.toContain(step)
      expect(cloud, step).toContain(step)
    }
    // The relay push is not in toCloud
    expect(cloud).not.toContain("type: 'live-state-update'")
  })
})
