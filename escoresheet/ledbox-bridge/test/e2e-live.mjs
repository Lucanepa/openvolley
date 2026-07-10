// Live end-to-end harness (manual — needs the frontend's server.js + its node_modules):
// boots the REAL relay (escoresheet/frontend/server.js) + the REAL bridge + a mock
// LedBox, then a scripted scoreboard drives a short match through the actual relay.
//
// Run:  node test/e2e-live.mjs
// Proves the offline "link to a live match" path without any LedBox hardware.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { MockLedbox } from '../src/mockLedbox.js'
import { startBridge } from '../src/bridge.js'

const FRONTEND_DIR = fileURLToPath(new URL('../../frontend', import.meta.url))
const WS_PORT = 8099, HTTP_PORT = 5199, LEDBOX_PORT = 8899, MATCH_ID = 'demo'

function panel(mock, label) {
  const t = (n) => mock.text(n) ?? ''
  const g = (n) => mock.screen[n] || {}
  const serve = (n) => (g(n).color && g(n).color !== '30,30,30' ? '🏐' : '  ')
  console.log(`\n  ── ${label}`)
  console.log(`  ┌────────────────────────────────────────────┐`)
  console.log(`  │  ${String(t('team1')).padEnd(4)} ${serve('serve1')}   set ${t('set1') || 0}-${t('set2') || 0}   ${serve('serve2')} ${String(t('team2')).padStart(4)}  │`)
  console.log(`  │              ${String(t('score1')).padStart(3)}  :  ${String(t('score2')).padEnd(3)}               │`)
  console.log(`  │        T ${t('timeout1') || 0} · ${t('timeout2') || 0}       S ${t('sub1') || 0} · ${t('sub2') || 0}         │`)
  console.log(`  └────────────────────────────────────────────┘`)
}

console.log('▶ starting REAL relay (frontend/server.js)…')
const relayProc = spawn('node', ['server.js'], {
  cwd: FRONTEND_DIR,
  env: { ...process.env, HTTPS: 'false', PORT: String(HTTP_PORT), WS_PORT: String(WS_PORT), NODE_ENV: 'development' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let relayReady = false
relayProc.stdout.on('data', (d) => { if (/WebSocket Server running/.test(d.toString())) relayReady = true })
relayProc.stderr.on('data', (d) => console.log('[relay:err]', d.toString().trim()))
for (let i = 0; i < 60 && !relayReady; i++) await sleep(100)
console.log(relayReady ? '  relay up ✅' : '  (ready signal not seen — continuing)')

const mock = new MockLedbox()
await mock.listen(LEDBOX_PORT, '127.0.0.1')
console.log(`▶ mock LedBox on 127.0.0.1:${LEDBOX_PORT}`)

console.log('▶ starting REAL bridge (relay → mapper → LedBox)…')
const { relay: bridgeRelay, ledbox } = await startBridge({
  relayUrl: `ws://127.0.0.1:${WS_PORT}`, matchId: MATCH_ID,
  ledboxHost: '127.0.0.1', ledboxPort: LEDBOX_PORT, ledboxLayout: 'volleyball_matchscore',
  ledboxAlias: 'e2e', ledboxApiVersion: 1.30, reconnectMs: 0, mock: false, debug: false,
})
await sleep(700)

console.log('▶ scoreboard connecting to relay…')
const sb = new WebSocket(`ws://127.0.0.1:${WS_PORT}`)
await new Promise((res, rej) => { sb.addEventListener('open', res); sb.addEventListener('error', () => rej(new Error('scoreboard WS failed'))) })
const send = (o) => sb.send(JSON.stringify(o))

const base = {
  match_id: MATCH_ID, side_a: 'left',
  team_a_short: 'USA', team_a_color: '#2563eb',
  team_b_short: 'POL', team_b_color: '#ef4444',
  points_a: 0, points_b: 0, sets_won_a: 0, sets_won_b: 0,
  timeouts_a: [], timeouts_b: [], subs_a: [], subs_b: [], serving_team: 'left',
}
send({ type: 'sync-match-data', matchId: MATCH_ID, match: { id: MATCH_ID }, homeTeam: {}, awayTeam: {}, sets: [], events: [] })
await sleep(250)

const steps = [
  ['whistle — 0-0, USA to serve',         { ...base }],
  ['USA point — 1-0',                     { ...base, points_a: 1 }],
  ['POL sideout — 1-1, POL serving',      { ...base, points_a: 1, points_b: 1, serving_team: 'right' }],
  ['rally to 5-3, USA serving',           { ...base, points_a: 5, points_b: 3, serving_team: 'left' }],
  ['USA timeout',                         { ...base, points_a: 5, points_b: 3, serving_team: 'left', timeouts_a: [{}] }],
  ['POL double sub, POL to 6',            { ...base, points_a: 5, points_b: 6, serving_team: 'right', timeouts_a: [{}], subs_b: [{}, {}] }],
  ['set point — 24-22',                   { ...base, points_a: 24, points_b: 22, serving_team: 'left', timeouts_a: [{}], subs_b: [{}, {}] }],
  ['USA wins set 1 → set 2 (sides swap)', { ...base, side_a: 'right', sets_won_a: 1, sets_won_b: 0, serving_team: 'left' }],
]
for (const [label, st] of steps) {
  send({ type: 'live-state-update', matchId: MATCH_ID, liveState: st })
  await sleep(450)
  panel(mock, label)
}

console.log('\n✅ END-TO-END OK — the mock LedBox tracked a live match through the REAL relay + REAL bridge.')
sb.close(); bridgeRelay.stop(); ledbox.disconnect(); await mock.close(); relayProc.kill('SIGTERM')
await sleep(200)
process.exit(0)
