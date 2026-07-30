// Integration proof: mock LAN relay -> RelaySubscriber -> mapper -> mock LedBox.
// Verifies the bridge subscribes over WebSocket, receives the flat liveState the
// Scoreboard computes, and paints the LedBox (incl. team names + substitutions).
// Requires the `ws` devDependency (run `npm install` first).

import { WebSocketServer } from 'ws'
import { startBridge } from '../src/bridge.js'

let failures = 0
const assert = (cond, label) => {
  console.log(`  ${cond ? '✓' : '✗ FAIL'}  ${label}`)
  if (!cond) failures++
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const MATCH_ID = 'demo'
const base = {
  match_id: MATCH_ID, side_a: 'left',
  team_a_short: 'USA', team_a_color: '#2563eb',
  team_b_short: 'POL', team_b_color: '#ef4444',
  points_a: 12, points_b: 9, sets_won_a: 0, sets_won_b: 0,
  timeouts_a: [{}, {}], timeouts_b: [{}], subs_a: [{}], subs_b: [{}, {}, {}, {}],
  serving_team: 'left',
}

// --- mock LAN relay (speaks the subset of the protocol the bridge uses) -------
const clients = new Set()
const wss = new WebSocketServer({ port: 0 })
await new Promise((r) => wss.on('listening', r))
const port = wss.address().port

wss.on('connection', (ws) => {
  clients.add(ws)
  ws.on('close', () => clients.delete(ws))
  ws.send(JSON.stringify({ type: 'connected' }))
  ws.on('message', (buf) => {
    const msg = JSON.parse(buf.toString())
    if (msg.type === 'subscribe-match' && String(msg.matchId) === MATCH_ID) {
      ws.send(JSON.stringify({ type: 'match-full-data', matchId: MATCH_ID, data: { liveState: base } }))
    }
  })
})
const broadcast = (liveState) => {
  for (const ws of clients) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'match-data-update', matchId: MATCH_ID, data: { liveState } }))
    }
  }
}

// --- bridge, pointed at the mock relay, painting an in-process mock LedBox -----
const { relay, ledbox, mock } = await startBridge({
  relayUrl: `ws://127.0.0.1:${port}`,
  matchId: MATCH_ID,
  ledboxHost: '127.0.0.1', ledboxPort: 0, ledboxLayout: 'volleyball_matchscore_02',
  ledboxAlias: 'test', ledboxApiVersion: 2, reconnectMs: 0, mock: true, debug: false,
})

await wait(400) // connect + subscribe + initial match-full-data + paint

console.log('\n[1] Initial state (delivered via match-full-data)')
assert(mock.text('team1') === 'USA' && mock.text('team2') === 'POL', 'team names painted (USA / POL)')
assert(mock.text('score1') === '12' && mock.text('score2') === '9', 'points 12-9')
assert(mock.text('timeout1') === '2' && mock.text('timeout2') === '1', 'timeouts 2-1')
assert(mock.text('sub1') === '1' && mock.text('sub2') === '4', 'substitutions 1-4')
assert(mock.screen.serve1.color === '37,99,235', 'serve indicator on USA (left, blue)')

console.log('\n[2] Live update via match-data-update: USA scores -> 13')
broadcast({ ...base, points_a: 13 })
await wait(200)
assert(mock.text('score1') === '13', 'points updated to 13 over the relay')

console.log('\n[3] Live update via the dedicated live-state-update message: POL -> 10')
for (const ws of clients) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'live-state-update', matchId: MATCH_ID, liveState: { ...base, points_a: 13, points_b: 10 } }))
  }
}
await wait(200)
assert(mock.text('score2') === '10', 'points updated via live-state-update message')

relay.stop(); ledbox.disconnect(); await mock.close(); wss.close()
console.log(`\n${failures === 0 ? '✅ ALL PASSED' : `❌ ${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
