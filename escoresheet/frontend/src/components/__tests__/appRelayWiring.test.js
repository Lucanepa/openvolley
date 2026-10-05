import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// App.jsx cannot be mounted in a unit test (Dexie, sync queue, relay, i18n);
// the helpers it uses are tested in relayPublisher.test.js and
// serverDataSync.relay.test.js. This pins how App.jsx wires them.
const src = readFileSync(resolve(__dirname, '../../App.jsx'), 'utf8')

function slice(from, to) {
  const start = src.indexOf(from)
  expect(start).toBeGreaterThan(-1)
  const end = src.indexOf(to, start + from.length)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('App.jsx relay wiring', () => {
  it('opens exactly one WebSocket: its relay socket (no probe sockets)', () => {
    expect(src.match(/new WebSocket\(/g)).toHaveLength(1)
    expect(src).toMatch(/wsRef\.current = new WebSocket\(wsUrl\)/)
  })

  it('the connection status check asks the relay over HTTP, via relayConnectionStatus', () => {
    const body = slice('const checkConnectionStatuses = useCallback(', '\n  }, [')
    expect(body).toMatch(/relayConnectionStatus\(\{ wsUrl, ws: wsRef\.current \}\)/)
    expect(body).not.toMatch(/new WebSocket\(/)
  })

  it('the network checks do not re-run on match writes or sync status flips', () => {
    const start = src.indexOf('const checkConnectionStatuses = useCallback(')
    const deps = src.slice(src.indexOf('\n  }, [', start), src.indexOf(']', src.indexOf('\n  }, [', start)) + 1)
    expect(deps).not.toMatch(/syncStatus|currentMatch\b|serverStatus\b/)
  })

  it('sync-match-data goes under the relay key with PINs only when they change', () => {
    const body = slice('const syncMatchData = async () => {', 'const handlePinValidationRequest')
    expect(body).toMatch(/relayPinsRef\.current\.payloadFor\(ws, currentMatchData\)/)
    expect(body).toMatch(/matchId: relayMatchKey\(currentMatchData, currentActiveMatchId\)/)
    expect(body).toMatch(/commitPins\(\)/)
    // the raw match (with game_pin / connection_pins) is never sent
    expect(body).not.toMatch(/match: currentMatchData/)
  })
})
