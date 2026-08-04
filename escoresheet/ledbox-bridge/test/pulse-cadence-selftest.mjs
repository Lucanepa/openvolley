// Blink cadence. `send` allows exactly ONE command in flight and waits for the board's ack, so a
// blink driven by a fixed-rate setInterval enqueues toggles faster than they drain as soon as an
// ack is slower than pulseIntervalMs. They pile up behind each other and behind the point's own
// score repaint; the panel shows one long smear instead of a blink, and how bad it looks depends
// on what was already queued — which is why the same blinkMs gave two blinks on one side and a
// single slow one on the other.
//
// The blink is now self-clocked: each toggle waits for its own ack, then schedules the next.
// This test pins that down by making acks SLOWER than the interval — the pathological case.
import { LedboxClient } from '../src/ledboxClient.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const INTERVAL = 20   // requested blink half-period
const ACK = 60        // board takes 3x that to answer — the queue would build under setInterval
const TEAM = '37,99,235'

function client() {
  const c = new LedboxClient({ hosts: ['127.0.0.1'], pulseIntervalMs: INTERVAL })
  c.ready = true
  c.calls = []
  c.inFlight = 0
  c.maxInFlight = 0
  // Stub the WIRE (_sendNow), not send() — send() is what applies the _sendChain serialization
  // that guarantees one command in flight, and that is precisely the behaviour under test.
  c._sendNow = async (cmd, value) => {
    c.inFlight++
    c.maxInFlight = Math.max(c.maxInFlight, c.inFlight)
    c.calls.push(value[0].value.value)
    await sleep(ACK)
    c.inFlight--
    return 'ok'
  }
  return c
}

console.log(`blink with acks (${ACK}ms) slower than the interval (${INTERVAL}ms):`)
const c = client()
c.pulse('score2', 300, TEAM)
await sleep(900)

ok(c.maxInFlight === 1, `never more than one paint in flight (saw ${c.maxInFlight})`)
// 300ms of blinking at an effective ~60ms cadence is ~5 toggles. A backlogged setInterval would
// have queued ~15. Allow slack for timer jitter but reject a pile-up.
ok(c.calls.length <= 8, `no backlog — ${c.calls.length} paints, not one per interval tick`)
ok(c.calls.length >= 3, `still actually blinks (${c.calls.length} paints)`)
ok(c.calls[0] === '0,0,0', 'starts dark, so the blink is visible immediately')
ok(c.calls[c.calls.length - 1] === TEAM, 'settles on the team colour, never dark')
ok(!c._pulses.has('score2'), 'pulse deregisters itself when finished')

// Left and right must behave identically — the reported fault was one side blinking once and
// slowly while the other managed two.
console.log('\nboth sides, same conditions:')
const l = client(); const r = client()
l.pulse('score1', 300, TEAM)
r.pulse('score2', 300, TEAM)
await sleep(900)
ok(Math.abs(l.calls.length - r.calls.length) <= 1,
  `left and right get the same cadence (${l.calls.length} vs ${r.calls.length} paints)`)

// Re-scoring restarts the blink rather than stacking a second timer on the same section.
console.log('\nre-scoring the same section:')
const c2 = client()
c2.pulse('score1', 300, TEAM)
await sleep(30)
c2.pulse('score1', 300, TEAM)
await sleep(900)
ok(c2.maxInFlight === 1, `restart does not stack a second blinker (max in flight ${c2.maxInFlight})`)
ok(c2.calls[c2.calls.length - 1] === TEAM, 'restarted blink still settles on the team colour')

// clearPulses (runs just before every layout switch) must stop it and restore the team colour.
console.log('\nclearPulses during a blink:')
const c3 = client()
c3.pulse('score1', 2000, TEAM)
await sleep(90)
c3.clearPulses()
const afterClear = c3.calls.length
await sleep(300)
ok(c3.calls.length <= afterClear + 1, 'no further toggles after clearPulses')
ok(c3._pulses.size === 0, 'pulse registry emptied')

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
