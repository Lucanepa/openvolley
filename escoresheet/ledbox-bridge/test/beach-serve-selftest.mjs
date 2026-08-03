// Integration self-test for the BEACH serve-player indicator (zero deps).
// Wires MockLedbox <- LedboxClient(beach mapper) <- BeachSource exactly like the appliance
// (src/appliance.js) — minus the HTTP layer — and asserts the mock LedBox panel shows the
// right centre digit as serve alternates and is overridden. This proves the whole paint path
// source -> beachMapper.toBeachSections -> ledboxClient -> LedBox for the new `serveplr` section.

import { setTimeout as sleep } from 'node:timers/promises'
import { MockLedbox } from '../src/mockLedbox.js'
import { LedboxClient } from '../src/ledboxClient.js'
import { BeachSource } from '../src/beachSource.js'
import { toBeachSections } from '../src/beachMapper.js'
import * as volley from '../src/volleyballMapper.js'

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}`) } }
const eq = (got, want, label) => ok(got === want, `${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)

const mock = new MockLedbox()
const addr = await mock.listen(0, '127.0.0.1')
console.log(`▶ standalone mock LedBox on 127.0.0.1:${addr.port}`)

// The beach sport as sports.js assembles it: beach match mapper, volleyball everything-else.
const mapper = {
  toSections: toBeachSections,
  toCountdownSections: volley.toCountdownSections,
  toIdleSections: volley.toIdleSections,
  toClubIdleSections: volley.toClubIdleSections,
  toBreakSections: volley.toBreakSections,
  toLeftRight: volley.toLeftRight,
}
const ledbox = new LedboxClient({
  host: '127.0.0.1', port: addr.port, sport: 'beach',
  layout: 'beach_matchscore', mapper, apiVersion: 2, reconnectMs: 0, defaultIdle: false,
})
const src = new BeachSource()
// The mock has no layouts on disk, so SetLayout replies "not present" (code 5) — non-fatal, the
// appliance logs+ignores it and paints via the match layout. Swallow it here for the same reason.
ledbox.on('error', () => {})
ledbox.connect()
await sleep(250) // connect + layout settle

// Apply an action to the source, push the resulting state to the (mock) board, let it land.
const paint = async (a) => { src.apply(a); await ledbox.pushState(src.getState()); await sleep(70) }
// The serving side's digit is lit; the other is blank. Read whichever side is showing.
const digit = () => mock.text('serveplr1') || mock.text('serveplr2') || ''

try {
  await paint({ type: 'team', side: 'left', short: 'MOL/SOR', color: '#2563eb' })
  await paint({ type: 'team', side: 'right', short: 'ART/DAL', color: '#ff4500' })

  // Declared order: left serves first with player 1, right's first server is 2.
  await paint({ type: 'serve-order', first: 'left', leftServer: 1, rightServer: 2 })
  eq(digit(), '1', 'board shows L1 at the opening serve')
  const c1 = mock.color('serveplr1') // left serving -> the left-side digit is lit
  ok(c1 && c1 !== '30,30,30', `serve digit lit in the serving pair colour (${JSON.stringify(c1)})`)

  // Side-out to the right pair: its first turn -> declared player 2, no flip.
  await paint({ type: 'point', side: 'right', delta: 1 })
  eq(digit(), '2', 'board shows R2 after the side-out (first right turn)')

  // Side-out back to the left pair: its 2nd turn -> flips to player 2.
  await paint({ type: 'point', side: 'left', delta: 1 })
  eq(digit(), '2', 'board shows L2 when the left pair regains serve (flip)')

  // Manual override of the serving pair: flip L2 -> L1.
  await paint({ type: 'serve-player' })
  eq(digit(), '1', 'manual flip repaints the board digit (L2 -> L1)')

  // The digit follows its pair across a change of ends (swap).
  await paint({ type: 'swap' })
  eq(digit(), '1', 'digit still shows the serving pair number after a court switch')
} finally {
  ledbox.disconnect()
  await mock.close()
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
