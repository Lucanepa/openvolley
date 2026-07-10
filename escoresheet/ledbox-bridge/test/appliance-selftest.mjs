// Integration self-test for the LedBox appliance (zero deps).
// Boots a STANDALONE MockLedbox on an ephemeral port, starts the appliance
// against it, then drives the control API with global fetch and asserts BOTH
// (a) GET /api/status .state (the source's liveState) AND
// (b) the mock LedBox panel (proving API -> source -> mapper -> ledboxClient -> LedBox).

import { setTimeout as sleep } from 'node:timers/promises'
import { startAppliance } from '../src/appliance.js'
import { MockLedbox } from '../src/mockLedbox.js'

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}`) } }
const eq = (got, want, label) => ok(got === want, `${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)

// Standalone mock LedBox on an ephemeral port.
const mock = new MockLedbox()
const addr = await mock.listen(0, '127.0.0.1')
console.log(`▶ standalone mock LedBox on 127.0.0.1:${addr.port}`)

const app = await startAppliance({
  relayUrl: 'ws://127.0.0.1:1',
  relayHttpUrl: 'http://127.0.0.1:1',
  matchId: '',
  ledboxHost: '127.0.0.1',
  ledboxPort: addr.port,
  ledboxLayout: 'volleyball_matchscore',
  ledboxAlias: 'test',
  ledboxApiVersion: 1.30,
  reconnectMs: 0,
  mock: false,
  controlPort: 0,
  debug: false,
})

const port = app.server.address().port
const base = `http://127.0.0.1:${port}`
console.log(`▶ control server on ${base}`)

// Let the ledbox connect + the auto-start MANUAL push settle.
await sleep(200)

const post = async (path, body) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}
const action = async (a) => { const r = await post('/api/action', { action: a }); await sleep(150); return r }
const status = async () => (await fetch(base + '/api/status')).json()

try {
  // Switch to manual explicitly.
  const m = await post('/api/manual')
  eq(m.status, 200, 'POST /api/manual -> 200')

  // Drive a short sequence.
  await action({ type: 'team', side: 'left', short: 'USA', color: '#2563eb' })
  await action({ type: 'team', side: 'right', short: 'POL', color: '#ef4444' })
  await action({ type: 'point', side: 'left', delta: 12 })
  await action({ type: 'point', side: 'right', delta: 9 })
  await action({ type: 'serve', side: 'left' })
  await action({ type: 'timeout', side: 'left', delta: 1 })
  await action({ type: 'sub', side: 'right', delta: 2 })

  // ── (a) assert /api/status .state reflects the actions ──
  const s1 = await status()
  console.log('\n── before swap: /api/status.state ──')
  eq(s1.mode, 'manual', 'status.mode == manual')
  eq(s1.ledbox.connected, true, 'status.ledbox.connected == true')
  const st = s1.state
  eq(st.side_a, 'left', 'state.side_a == left')
  eq(st.team_a_short, 'USA', 'state.team_a_short == USA')
  eq(st.team_b_short, 'POL', 'state.team_b_short == POL')
  eq(st.points_a, 12, 'state.points_a == 12')
  eq(st.points_b, 9, 'state.points_b == 9')
  eq(st.serving_team, 'left', 'state.serving_team == left')
  // timeouts/subs may be number or array — count either.
  const cnt = (t) => (Array.isArray(t) ? t.length : (t || 0))
  eq(cnt(st.timeouts_a), 1, 'state.timeouts_a == 1')
  eq(cnt(st.subs_b), 2, 'state.subs_b == 2')

  // ── (b) assert the STANDALONE mock panel reflects them ──
  console.log('\n── before swap: mock LedBox panel ──')
  eq(mock.text('team1'), 'USA', 'mock team1 == USA')
  eq(mock.text('team2'), 'POL', 'mock team2 == POL')
  eq(mock.text('score1'), '12', 'mock score1 == 12')
  eq(mock.text('score2'), '9', 'mock score2 == 9')
  eq(mock.text('timeout1'), '1', 'mock timeout1 == 1')
  eq(mock.text('sub2'), '2', 'mock sub2 == 2')
  const serve1 = mock.screen.serve1?.color
  ok(serve1 && serve1 !== '30,30,30', `mock serve1 lit (color ${JSON.stringify(serve1)})`)
  ok(mock.screen.serve2?.color === '30,30,30', 'mock serve2 off')

  // ── swap sides ──
  await action({ type: 'swap' })

  const s2 = await status()
  console.log('\n── after swap: /api/status.state ──')
  // side_a stays 'left'; the left/right fields are physically swapped.
  eq(s2.state.team_a_short, 'POL', 'after swap state.team_a_short == POL')
  eq(s2.state.team_b_short, 'USA', 'after swap state.team_b_short == USA')
  eq(s2.state.points_a, 9, 'after swap state.points_a == 9')
  eq(s2.state.points_b, 12, 'after swap state.points_b == 12')
  eq(s2.state.serving_team, 'right', 'after swap serving flips to right')

  console.log('\n── after swap: mock LedBox panel ──')
  eq(mock.text('team1'), 'POL', 'after swap mock team1 == POL')
  eq(mock.text('team2'), 'USA', 'after swap mock team2 == USA')
  eq(mock.text('score1'), '9', 'after swap mock score1 == 9')
  eq(mock.text('score2'), '12', 'after swap mock score2 == 12')
  eq(mock.text('sub2'), '0', 'after swap mock sub2 == 0')
  ok(mock.screen.serve1?.color === '30,30,30', 'after swap mock serve1 off')
  const serve2b = mock.screen.serve2?.color
  ok(serve2b && serve2b !== '30,30,30', `after swap mock serve2 lit (color ${JSON.stringify(serve2b)})`)
} catch (err) {
  fail++
  console.log(`  ❌ threw: ${err?.stack || err}`)
} finally {
  await app.close()
  await mock.close()
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
