// Idle wall clock — the crest screen swaps its QR codes for a clock once someone is connected.
//
// The QR pair ("Join WiFi" / "Open UI") exists purely to GET an operator onto the control UI.
// Once they are on it those two thirds of the panel are dead space, so the board shows the wall
// clock there instead, and puts the QRs back when the last device goes away.
//
// The clock is deliberately confined to the "no teams known yet" screen: once teams are set,
// kscw_idle already spends that side of the panel on their names.
import { LedboxClient } from '../src/ledboxClient.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }

function client(opts = {}) {
  const c = new LedboxClient({ hosts: ['127.0.0.1'], layoutSettleMs: 0, idleTickMs: 0, ...opts })
  c.ready = true
  c.seq = []
  c.sections = {}
  c._sendNow = async (cmd, value) => {
    if (cmd === 'SetLayout') c.seq.push(`layout:${value}`)
    else if (cmd === 'SetSections') {
      for (const s of value || []) {
        c.sections[s.name] = s.value.value
        c.seq.push(`${s.name}:${s.value.value}`)
      }
    }
    return 'ok'
  }
  return c
}

console.log('nobody connected:')
const a = client()
await a.showIdle(true)
ok(a.currentLayout === 'kscw_crest', 'boots to the QR crest — the screen that tells you how to connect')
ok(!a.seq.some((s) => s.startsWith('time:')), 'no clock pushed')

console.log('\noperator opens the control UI:')
const b = client()
await b.showIdle(true)
ok(b.currentLayout === 'kscw_crest', 'starts on the QR crest')
b.noteViewer()                       // what controlServer does on every API request
await b._idleTick()
ok(b.currentLayout === 'kscw_clock', 'swaps to the clock screen')
ok(/^\d\d:\d\d:\d\d$/.test(b.sections.time), `time section is HH:MM:SS (${b.sections.time})`)
ok(/^[A-Z][a-z]{2} \d\d\.\d\d\.\d{4}$/.test(b.sections.date), `date section is Ddd DD.MM.YYYY (${b.sections.date})`)

console.log('\nviewer goes away:')
// noteViewer() reacts to an ARRIVAL immediately; a departure is noticed by the ticker.
b._viewerAt = Date.now() - (b.viewerTimeoutMs + 1)
await b._idleTick()
ok(b.currentLayout === 'kscw_crest', 'QR codes come back for the next person')

console.log('\nclock only writes when the displayed text actually changes:')
const c = client()
c.noteViewer()
// Freeze the clock so the assertion can't straddle a real second boundary and flake.
let fake = { time: '12:00:00', date: 'Tue 04.08.2026' }
c.formatClock = () => fake
await c.showIdle(true)
const writes = () => c.seq.filter((s) => s.startsWith('time:')).length
const first = writes()
await c._idleTick()
await c._idleTick()
ok(writes() === first, 'repeated ticks within the same second push nothing')
fake = { time: '12:00:01', date: 'Tue 04.08.2026' }
await c._idleTick()
ok(writes() === first + 1, 'a ticked second pushes exactly once')

console.log('\nteams known — named idle screen keeps its names:')
const d = client()
d.noteViewer()
d._lastState = { leftName: 'KSCW', rightName: 'GAST' }
await d.showIdle(true)
ok(d.currentLayout === 'kscw_idle', 'uses the team-name idle screen, not the clock')
await d._idleTick()
ok(d.currentLayout === 'kscw_idle', 'and the ticker leaves it alone')

console.log('\nboard without the clock layout falls back:')
const e = client()
e.noteViewer()
e._sendNow = async (cmd, value) => {
  // The board answers code 5 for a layout it does not have.
  if (cmd === 'SetLayout' && value === 'kscw_clock') {
    const err = new Error('SetLayout: layout not present in device (5)'); err.code = 5; throw err
  }
  if (cmd === 'SetLayout') e.seq.push(`layout:${value}`)
  return 'ok'
}
e.on('error', () => {})
await e.showIdle(true)
ok(e.currentLayout === 'kscw_crest', 'falls back to the QR crest rather than a blank panel')

// A board that never had the KSCW layouts (a stock C0270, or one just reflashed) refuses ALL of
// them. The idle ticker runs every second, so without remembering a code-5 refusal it re-asks
// and re-logs forever — 77 errors in 25s when this was first wired up.
console.log('\nboard with no KSCW layouts at all stops asking:')
const g2 = client()
g2.noteViewer()
let setLayoutCalls = 0
g2._sendNow = async (cmd, value) => {
  if (cmd === 'SetLayout') {
    setLayoutCalls++
    if (String(value).startsWith('kscw_')) {
      const err = new Error('SetLayout: layout not present in device (5)'); err.code = 5; throw err
    }
  }
  return 'ok'
}
g2.on('error', () => {})
await g2.showIdle(true)
ok(g2.currentLayout === 'volleyball_matchscore_02', 'settles on the match-layout idle instead')
const afterFirst = setLayoutCalls
for (let i = 0; i < 5; i++) await g2._idleTick()
ok(setLayoutCalls === afterFirst, `five further ticks ask the board nothing (${setLayoutCalls} calls, was ${afterFirst})`)
ok(g2._missingLayouts.has('kscw_clock') && g2._missingLayouts.has('kscw_crest'), 'the refusals are remembered')

console.log('\na transient failure stays retryable:')
const h = client()
ok(h._layoutAvailable('kscw_clock') === true, 'available before any failure')
h._noteLayoutMissing('kscw_clock', new Error('timeout'))            // no .code
ok(h._layoutAvailable('kscw_clock') === true, 'a timeout does not disqualify the layout')
const perm = new Error('nope'); perm.code = 5
h._noteLayoutMissing('kscw_clock', perm)
ok(h._layoutAvailable('kscw_clock') === false, 'only code 5 does')

console.log('\nformatClock:')
const f = client()
const fixed = f.formatClock(new Date(2026, 7, 4, 9, 5, 7))
ok(fixed.time === '09:05:07', `zero-pads the time (${fixed.time})`)
ok(fixed.date === 'Tue 04.08.2026', `zero-pads the date (${fixed.date})`)
const mid = f.formatClock(new Date(2026, 0, 1, 0, 0, 0))
ok(mid.time === '00:00:00', 'midnight is 00:00:00, not 24:00:00')
// Widest strings the layout must hold, measured against the board's own ARIAL: "23:59:59" is
// 109px at 28pt and the date 95px at 14pt, both inside the 128px column. Fixed widths mean no
// time or date can ever outgrow it.
ok(mid.time.length === 8, 'time string is a fixed 8 characters')
ok(mid.date.length === 14, 'date string is a fixed 14 characters, so it cannot outgrow the column')

console.log('\nviewerPresent:')
const g = client()
ok(g.viewerPresent() === false, 'false before anyone has ever connected')
g.noteViewer()
ok(g.viewerPresent() === true, 'true right after a request')
g._viewerAt = Date.now() - (g.viewerTimeoutMs + 1)
ok(g.viewerPresent() === false, 'false once the window lapses')

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
