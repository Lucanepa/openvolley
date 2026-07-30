// End-to-end proof: OpenVolley match_live_state -> mapper -> gzip TCP -> mock LedBox.
// Drives a realistic sequence and asserts the panel reflects each change.
// No dependencies, no hardware — this is the on-Pi smoke test.

import { MockLedbox } from '../src/mockLedbox.js'
import { LedboxClient } from '../src/ledboxClient.js'

const PORT = 18889
let failures = 0
const assert = (cond, label) => {
  console.log(`  ${cond ? '✓' : '✗ FAIL'}  ${label}`)
  if (!cond) failures++
}
const once = (em, ev) => new Promise((res) => em.once(ev, res))
const settle = () => new Promise((r) => setTimeout(r, 40))

// A realistic match_live_state row (Team A = coin-toss winner, on the left).
const base = {
  match_id: 'demo', current_set: 1, side_a: 'left',
  team_a_name: 'Volero Zürich', team_a_short: 'VZH', team_a_color: '#ef4444',
  team_b_name: 'Genève Volley', team_b_short: 'GEN', team_b_color: '#2563eb',
  points_a: 0, points_b: 0, sets_won_a: 0, sets_won_b: 0,
  timeouts_a: 0, timeouts_b: 0, subs_a: null, subs_b: null, serving_team: 'left',
  match_status: 'in_progress',
}

function panel(mock) {
  const g = (n) => mock.screen[n] || {}
  const serve = (n) => (g(n).color && g(n).color !== '30,30,30' ? '🏐' : '  ')
  console.log(
    `      ┌─────────────────────────────────────────┐\n` +
    `      │  ${(mock.text('team1') || '').padEnd(6)} ${serve('serve1')}  set ${mock.text('set1') || 0}-${mock.text('set2') || 0}  ${serve('serve2')} ${(mock.text('team2') || '').padStart(6)}  │\n` +
    `      │            ${String(mock.text('score1') || 0).padStart(3)}  :  ${String(mock.text('score2') || 0).padEnd(3)}            │\n` +
    `      │      T ${mock.text('timeout1') || 0} · ${mock.text('timeout2') || 0}      S ${mock.text('sub1') || 0} · ${mock.text('sub2') || 0}       │\n` +
    `      └─────────────────────────────────────────┘`
  )
}

const mock = new MockLedbox()
await mock.listen(PORT)

const client = new LedboxClient({ host: '127.0.0.1', port: PORT, reconnectMs: 0 })
const commands = []
mock.on('command', (m) => commands.push(m.cmd))

client.connect()
await once(client, 'ready')
await settle() // let the SetLayout that fires just after 'ready' round-trip

console.log('\n[1] Handshake')
assert(commands.includes('Init'), 'client sent Init on connect')
assert(mock.currentLayout === 'volleyball_matchscore_02', 'layout set to volleyball_matchscore_02')

console.log('\n[2] Kickoff (0-0, Volero serving on the left)')
await client.pushState(base); await settle()
panel(mock)
assert(mock.text('team1') === 'VZH' && mock.text('team2') === 'GEN', 'team short names on correct sides')
assert(mock.text('score1') === '0' && mock.text('score2') === '0', 'scores 0-0')
assert(mock.screen.serve1.color === '239,68,68', 'serve1 lit red (Volero serving)')
assert(mock.screen.serve2.color === '30,30,30', 'serve2 off')
assert(mock.text('sub1') === '0' && mock.text('sub2') === '0', 'substitutions 0-0')

console.log('\n[3] Volero -> 3-1, Genève wins the serve')
await client.pushState({ ...base, points_a: 3, points_b: 1, serving_team: 'right' }); await settle()
panel(mock)
assert(mock.text('score1') === '3' && mock.text('score2') === '1', 'scores 3-1')
assert(mock.screen.serve2.color === '37,99,235', 'serve2 lit blue (Genève serving)')

console.log('\n[4] Genève takes 1 timeout and makes 2 substitutions (arrays)')
await client.pushState({
  ...base, points_a: 3, points_b: 1, serving_team: 'right',
  timeouts_b: [{ at: 4 }], subs_b: [{ in: 7, out: 3 }, { in: 9, out: 5 }],
}); await settle()
panel(mock)
assert(mock.text('timeout2') === '1', 'Genève timeout count = 1 (counted from array)')
assert(mock.text('sub2') === '2', 'Genève substitution count = 2 (counted from array)')
assert(mock.text('sub1') === '0', 'Volero substitution count = 0')

console.log('\n[5] Set 1 to Volero; sides swap for set 2 (side_a -> right)')
await client.pushState({
  ...base, current_set: 2, side_a: 'right',
  sets_won_a: 1, sets_won_b: 0, serving_team: 'left',
}); await settle()
panel(mock)
assert(mock.text('team2') === 'VZH' && mock.text('team1') === 'GEN', 'teams swapped sides for set 2')
assert(mock.text('set2') === '1' && mock.text('set1') === '0', 'set score follows the swap')
assert(mock.screen.score1.color === '37,99,235', 'left score now blue (Genève on left)')

console.log('\n[6] Device errors carry their text (the board says WHY, not just a code)')
const rejection = await client.send('SetSections', [{ name: 'not_a_section', value: { attrib: 'text', value: 'x' } }])
  .then(() => null, (e) => e.message)
assert(rejection !== null, 'unknown section is rejected')
assert(/section not found/.test(rejection || ''), `error text preserved (got: ${rejection})`)

console.log(`\n[7] Commands to LedBox: ${commands.length} (Init, SetLayout, ${commands.filter((c) => c === 'SetSections').length}x SetSections)`)

client.disconnect()
await mock.close()
console.log(`\n${failures === 0 ? '✅ ALL PASSED' : `❌ ${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
