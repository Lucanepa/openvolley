// Sport-switch confirmation on the panel.
//
// Every sport shares the same idle screens (kscw_idle / kscw_crest — see sports.js), and a sport
// switch restarts the appliance straight back into idle. So before this, switching sport changed
// NOTHING visible on the board: the operator only found out it had taken effect when the first
// point painted a different match layout. The appliance now holds the new sport's name on the
// break screen for a moment on the boot that follows a switch, then settles back to idle.
import { LedboxClient } from '../src/ledboxClient.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }

function client(opts = {}) {
  const c = new LedboxClient({ hosts: ['127.0.0.1'], layoutSettleMs: 0, ...opts })
  c.ready = true
  c.seq = []
  c._sendNow = async (cmd, value) => {
    if (cmd === 'SetLayout') c.seq.push(`layout:${value}`)
    else if (cmd === 'SetSections') {
      const l = Array.isArray(value) && value.find((v) => v.name === 'lbl')
      if (l) c.seq.push(`lbl:${l.value.value}`)
    }
    return 'ok'
  }
  return c
}

console.log('showSportConfirm:')
const c = client()
c.currentLayout = 'volleyball_matchscore_02'
await c.showSportConfirm('Beach volleyball', 20)

ok(c.seq[0] === 'layout:kscw_break', 'switches to the break screen first')
ok(c.seq.includes('lbl:BEACH VOLLEYBALL'), 'paints the sport name, upper-cased by the mapper')
ok(c.seq.includes('lbl:'), 'blanks the label on the way out (else the next countdown flashes it)')
ok(c.seq[c.seq.length - 1].startsWith('layout:kscw_'), 'settles back on an idle/crest screen')
// The blank must come after the name, not before it.
ok(c.seq.lastIndexOf('lbl:BEACH VOLLEYBALL') < c.seq.lastIndexOf('lbl:'), 'name is shown before it is cleared')

console.log('\nno breakLayout configured (older board):')
const c2 = client({ breakLayout: null })
c2.currentLayout = 'volleyball_matchscore_02'
const r2 = await c2.showSportConfirm('Volleyball', 20)
ok(r2 === false, 'declines rather than throwing')
ok(c2.seq.length === 0, 'and touches nothing on the panel')

console.log('\nbootMessage is one-shot:')
const c3 = client({ bootMessage: 'Basketball' })
ok(c3.bootMessage === 'Basketball', 'carried on the client until the first handshake')
c3.currentLayout = 'volleyball_matchscore_02'
// Mirror what connect() does after settling the default screen.
const msg = c3.bootMessage
c3.bootMessage = null
await c3.showSportConfirm(msg, 20)
ok(c3.bootMessage === null, 'cleared, so a later reconnect cannot replay a stale announcement')
ok(c3.seq.includes('lbl:BASKETBALL'), 'announced the sport it booted into')

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
