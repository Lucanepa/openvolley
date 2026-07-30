// Hardware discovery probe — machine-readable half. Nothing here needs a human watching
// the board; every answer comes back as an accept, a refusal, or the device's own error text.
//
// Relies on the board naming the missing key in `error_message` (the fix that made the
// config shape crackable). Run with the appliance still up; it only repaints on change.
//
//   LEDBOX_HOST=192.168.5.1 node test/probe-board.mjs
import { LedboxClient } from '../src/ledboxClient.js'

const HOST = process.env.LEDBOX_HOST || '192.168.5.1'
const CURRENT = 'volleyball_matchscore_02'
const client = new LedboxClient({ host: HOST, reconnectMs: 0, connectTimeoutMs: 6000 })
client.on('error', () => {}) // probes are expected to fail; we read the failures

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// SetLayout to the CURRENT layout never replies (noresend), so silence means "already there".
const trySend = async (cmd, value, extra) => {
  try { return { ok: true, value: await client.send(cmd, value, extra, { timeoutMs: 3500 }) } }
  catch (e) { return { ok: false, err: e.message } }
}

client.on('ready', async (info) => {
  console.log(`connected to ${HOST} — ${info.deviceName} fw ${info.version}, layout ${info.current_layout}\n`)

  // ---- 1. Which layouts does this device actually have? -----------------------------
  // error 5 = "layout not present in device". Anything else means it exists.
  console.log('[1] LAYOUT INVENTORY  (error 5 = absent)')
  const CANDIDATES = [
    'waiting',
    'volleyball_matchscore_02',
    'volleyball_matchscore_timeout_02',
    'volleyball_matchscore_set_02',
    'volleyball_matchscore_01',
    'volleyball_matchscore',
    'volleyball_timeout_02',
    'volleyball_set_02',
    'volleyball_warmup_02',
    'volleyball_matchscore_end_02',
    'timeout', 'set', 'warmup', 'default_layout',
  ]
  const present = []
  for (const name of CANDIDATES) {
    const r = await trySend('SetLayout', name)
    const absent = !r.ok && /not present|code 5/i.test(r.err || '')
    const silent = !r.ok && /timed out/.test(r.err || '')
    const verdict = absent ? 'absent' : silent ? 'PRESENT (silent = already current)' : 'PRESENT'
    if (!absent) present.push(name)
    console.log(`    ${name.padEnd(34)} ${verdict}${absent ? '' : '   <-- board changed'}`)
    if (!absent) { await sleep(900); await trySend('SetLayout', CURRENT); await sleep(400) }
  }
  console.log(`  => present: ${present.join(', ')}\n`)

  // ---- 2. ChangeWaiting: what does it want? ------------------------------------------
  // Send deliberately wrong shapes and let the device name the key it is missing.
  console.log('[2] ChangeWaiting PAYLOAD  (read the error text, it names the missing key)')
  const SHAPES = [
    ['empty string', '', undefined],
    ['plain text', 'KSC WIEDIKON', undefined],
    ['empty object', {}, undefined],
    ['{text}', { text: 'KSC WIEDIKON' }, undefined],
    ['{name,value}', { name: 'waiting', value: 'KSC WIEDIKON' }, undefined],
    ['sections array', [{ name: 'team1', value: { attrib: 'text', value: 'WIE' } }], undefined],
    ['name= extra', 'KSC WIEDIKON', { name: 'waiting' }],
  ]
  for (const [label, value, extra] of SHAPES) {
    const r = await trySend('ChangeWaiting', value, extra)
    console.log(`    ${label.padEnd(16)} -> ${r.ok ? 'OK ' + JSON.stringify(r.value) : r.err}`)
    await sleep(300)
  }
  console.log()

  // ---- 3. Does GetSections ever report anything beyond text/color? -------------------
  console.log('[3] ATTRIBUTE VISIBILITY  (does the device echo back more than text/color?)')
  await trySend('SetSections', [
    { name: 'score1', value: { attrib: 'blinking', value: 'true' } },
    { name: 'score1', value: { attrib: 'fontsize', value: '18' } },
  ])
  await sleep(600)
  const read = await trySend('GetSections', '')
  if (read.ok) {
    const s1 = (read.value || []).find((s) => s.name === 'score1')
    console.log(`    score1 reports: ${JSON.stringify(s1?.value)}`)
    const attribs = new Set((read.value || []).flatMap((s) => (s.value || []).map((a) => a.attrib)))
    console.log(`    every attrib the device will report: ${[...attribs].join(', ')}`)
  } else {
    console.log(`    GetSections failed: ${read.err}`)
  }
  console.log()

  // ---- 4. Horn — payload is known from the vendor's own JS, so this should just work --
  console.log('[4] HORN  (vendor JS: {times, sleep}) — listen for the buzzer')
  const horn = await trySend('Horn', { times: 2, sleep: 0.2 })
  console.log(`    ${horn.ok ? 'accepted: ' + JSON.stringify(horn.value) : horn.err}\n`)

  // Leave the board sane no matter what happened above.
  await trySend('SetLayout', CURRENT)
  client.disconnect()
  setTimeout(() => process.exit(0), 500)
})

client.connect()
setTimeout(() => { console.log('probe timed out'); process.exit(1) }, 120000)
