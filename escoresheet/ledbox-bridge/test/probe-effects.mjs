#!/usr/bin/env node
// One-pass hardware probe that settles every open question behind the operator's
// scoreboard-effect requirements. Run it at the board, watch the panel, answer the
// prompts; it prints a verdict per probe and a summary table at the end.
//
//   LEDBOX_HOST=192.168.5.1 node test/probe-effects.mjs
//
//   PROBE_AUTO=1        run without prompts (machine-readable answers only; the
//                       on-glass questions come back "(auto: not answered)")
//   PROBE_CUSTOMTEXT=1  additionally run the StartCustomText overlay probe. OFF by
//                       default: that command seizes the whole panel and is the one
//                       thing here that could plausibly leave the board needing a
//                       power cycle. Everything else only writes sections.
//
// SAFETY. The board wedges port 8889 against new connections if a client dies without
// sending Disconnect (observed: 80s closed, no self-heal, power cycle required). So
// every exit path — normal, thrown, SIGINT, watchdog — runs the same cleanup that
// restores the match layout, repaints a sane scoreboard, and disconnects politely.
//
// Reading the results. The device answers `ok` to ANY attribute name, including
// nonsense, so an accepted write proves nothing. Only two things are evidence:
//   - the attrib coming back from GetSections (the device admits it stores it), and
//   - the operator's eyes.
// Probes below are labelled with which kind of evidence they produce.

import zlib from 'node:zlib'
import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { LedboxClient } from '../src/ledboxClient.js'

const HOST = process.env.LEDBOX_HOST || '192.168.5.1'
const AUTO = process.env.PROBE_AUTO === '1'
const RUN_CUSTOMTEXT = process.env.PROBE_CUSTOMTEXT === '1'

const MATCH = 'volleyball_matchscore_02'
const COUNTDOWN = 'volleyball_matchscore_timeout_02'

// Same palette the bridge's volleyballMapper uses, so what you see here is what a
// real match will look like.
const NEUTRAL = '200,200,200'
const WARN = '255,176,0'   // amber - one short of the limit
const MAXED = '170,0,20'   // dark red - none left
const OFF = '30,30,30'
const LEFT_COLOR = '37,99,235'   // blue
const RIGHT_COLOR = '220,38,38'  // red

const client = new LedboxClient({ host: HOST, reconnectMs: 0, connectTimeoutMs: 6000 })
client.on('error', () => {}) // probes are supposed to fail sometimes; we read the failures

const rl = !AUTO && stdin.isTTY ? readline.createInterface({ input: stdin, output: stdout }) : null
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
let deviceInfo = null
let cleanedUp = false

function record(id, title, verdict, detail = '') {
  results.push({ id, title, verdict, detail })
  console.log(`    VERDICT [${id}] ${verdict}${detail ? ` - ${detail}` : ''}`)
}

const UNANSWERED = '(auto: not answered)'
async function ask(q) {
  if (!rl) return UNANSWERED
  console.log('')
  const a = await rl.question(`    >>> ${q}\n    >>> `)
  return a.trim() || '(no answer)'
}
// An on-glass question nobody answered is NOT a negative result. Keep the two apart, or a
// PROBE_AUTO=1 run silently manufactures "this requirement failed" verdicts.
const answered = (a) => a !== UNANSWERED && a !== '(no answer)'
const glassVerdict = (a, yes, no) => (!answered(a) ? 'NEEDS OPERATOR CONFIRMATION' : /^y|clean|gone|only/i.test(a) ? yes : no)

// Every probe returns {ok, value} or {ok:false, err} - never throws, so one bad probe
// cannot cost us the rest of the pass.
async function trySend(cmd, value, extra, timeoutMs = 3500) {
  try {
    return { ok: true, value: await client.send(cmd, value, extra, { timeoutMs }) }
  } catch (e) {
    return { ok: false, err: e.message }
  }
}

// SetLayout to the layout the board is ALREADY on produces no reply at all - the device
// advertises noresend and stays silent rather than acking a no-op. A request/response
// client just waits out its timeout, so silence here means "already there", not failure.
async function setLayoutSafe(name) {
  const r = await trySend('SetLayout', name, undefined, 3000)
  if (r.ok) return { ok: true, state: 'changed' }
  if (/timed out/i.test(r.err)) return { ok: true, state: 'already-current (silent, noresend)' }
  return { ok: false, state: r.err }
}

const attr = (name, attrib, value) => ({ name, value: { attrib, value: String(value) } })
const setSections = (sections, timeoutMs = 3500) => trySend('SetSections', sections, undefined, timeoutMs)

// Fire a frame with no request/response bookkeeping. Used only by the burst test, to ask
// whether the board tolerates writes arriving faster than it acks them.
function fireAndForget(obj) {
  client.socket.write(zlib.gzipSync(Buffer.from(JSON.stringify(obj), 'utf-8')))
}

function dumpSections(list) {
  const out = []
  for (const s of list || []) {
    const bits = (s.value || []).map((a) => `${a.attrib}=${JSON.stringify(a.value)}`).join('  ')
    out.push(`      ${String(s.name).padEnd(14)} ${bits}`)
  }
  return out.join('\n')
}

// A plausible mid-match scoreboard. Also the state we leave the board in on the way out.
function demoScoreboard() {
  return [
    attr('team1', 'text', 'WIEDIKON'), attr('team1', 'color', LEFT_COLOR),
    attr('team2', 'text', 'GUEST'), attr('team2', 'color', RIGHT_COLOR),
    attr('score1', 'text', '0'), attr('score1', 'color', LEFT_COLOR),
    attr('score2', 'text', '0'), attr('score2', 'color', RIGHT_COLOR),
    attr('set1', 'text', '0'), attr('set1', 'color', LEFT_COLOR),
    attr('set2', 'text', '0'), attr('set2', 'color', RIGHT_COLOR),
    attr('timeout1', 'text', '0'), attr('timeout1', 'color', NEUTRAL),
    attr('timeout2', 'text', '0'), attr('timeout2', 'color', NEUTRAL),
    attr('sub1', 'text', '0'), attr('sub1', 'color', NEUTRAL),
    attr('sub2', 'text', '0'), attr('sub2', 'color', NEUTRAL),
    attr('serve1', 'color', OFF),
    attr('serve2', 'color', OFF),
  ]
}

async function cleanup(reason) {
  if (cleanedUp) return
  cleanedUp = true
  console.log(`\n=== CLEANUP (${reason}) ===`)
  try {
    if (client.ready) {
      // Kill any overlay first, then get back to the match layout and repaint it, so the
      // board is never left showing a countdown or a half-blanked screen.
      await trySend('StopCustomText', { hashname: 'probe' }, undefined, 2000)
      const back = await setLayoutSafe(MATCH)
      console.log(`    layout -> ${MATCH}: ${back.state}`)
      await sleep(600)
      // ReloadLayout resets this layout's sections to their defaults, which is the only
      // way to undo a stray fontsize; then we paint a clean scoreboard over the top.
      await trySend('ReloadLayout', MATCH, undefined, 2500)
      await sleep(600)
      const paint = await setSections(demoScoreboard())
      console.log(`    repaint scoreboard: ${paint.ok ? 'ok' : paint.err}`)
      await trySend('Horn', { times: 1, sleep: 0.15 }, undefined, 2000) // audible "probe finished"
    } else {
      console.log('    not connected - nothing to restore')
    }
  } catch (e) {
    console.log(`    cleanup error: ${e.message}`)
  }
  try { client.disconnect() } catch { /* ignore */ }
  if (rl) rl.close()
}

function printSummary() {
  console.log('\n\n================ SUMMARY ================')
  for (const r of results) {
    console.log(`[${r.id}] ${r.title}`)
    console.log(`      ${r.verdict}${r.detail ? ` - ${r.detail}` : ''}`)
  }
  console.log('=========================================\n')
}

// ---------------------------------------------------------------------------------
// PROBES, in priority order: cheapest/most-informative first, panel-seizing last.
// ---------------------------------------------------------------------------------

// P1 - What is actually on the match layout, and what are the defaults?
// Evidence: device read-back. Settles an internal contradiction in our own notes, where
// one list claims volleyball_matchscore_02 carries `timer`/`lbl_to`/`lbl_sub`/`banner`
// and another says the match layout has no timer at all.
async function p1_matchInventory() {
  console.log('\n=== [P1] MATCH LAYOUT INVENTORY (device read-back) ===')
  await setLayoutSafe(MATCH)
  await sleep(800)
  const r = await trySend('GetSections', '')
  if (!r.ok) return record('P1', 'Match layout inventory', 'FAILED', r.err)
  const secs = r.value || []
  const names = secs.map((s) => s.name)
  console.log(`    ${secs.length} sections:`)
  console.log(dumpSections(secs))
  const attribs = [...new Set(secs.flatMap((s) => (s.value || []).map((a) => a.attrib)))]
  const expect = ['team1', 'team2', 'score1', 'score2', 'set1', 'set2', 'timeout1', 'timeout2',
    'sub1', 'sub2', 'serve1', 'serve2', 'vs', 'mode', 'timer', 'lbl_to', 'lbl_sub', 'banner',
    'bg_score1', 'bg_score2']
  const missing = expect.filter((n) => !names.includes(n))
  console.log(`    reportable attribs: ${attribs.join(', ')}`)
  console.log(`    of our assumed list, NOT present: ${missing.join(', ') || '(none)'}`)
  // An empty read means the device told us nothing - do not report that as "timer absent".
  record('P1', 'Match layout inventory', secs.length ? 'OK' : 'INCONCLUSIVE (empty read)',
    secs.length
      ? `${secs.length} sections; timer ${names.includes('timer') ? 'PRESENT' : 'ABSENT'}; attribs=${attribs.join('/')}`
      : 'GetSections returned no sections')
  return names
}

// P2 - Is there ANY device-side effect attribute, or is software the only path?
// Evidence: device read-back. The vendor app never sends blinking/animation/bordercolor as
// section attributes anywhere (blinking and the scroller_* values belong to the CustomText
// plugin model, bordercolor exists nowhere in the app at all). If none of them survive a
// read-back here, the software blink is not just the low-risk path - it is the only one.
async function p2_attributeReality() {
  console.log('\n=== [P2] ATTRIBUTE REALITY CHECK (device read-back; `ok` means nothing) ===')
  const CANDIDATES = [
    ['color', '255,0,0'],            // known-good control: must come back
    ['text', '7'],                   // known-good control: must come back
    ['blinking', 'true'],
    ['blink', 'true'],
    ['animation', 'blinking'],
    ['animation_velocity', '3'],
    ['bordercolor', '255,255,255'],  // currently sent by volleyballMapper on every push
    ['bgcolor', '0,0,0'],
    ['visible', 'false'],
    ['effect', 'blink'],
  ]
  for (const [attrib, value] of CANDIDATES) {
    const r = await setSections([attr('score1', attrib, value)])
    console.log(`    write score1.${attrib.padEnd(18)} -> ${r.ok ? 'accepted (proves nothing)' : r.err}`)
    await sleep(150)
  }
  await sleep(700)
  const read = await trySend('GetSections', '')
  let survived = []
  if (read.ok) {
    const s1 = (read.value || []).find((s) => s.name === 'score1')
    survived = (s1?.value || []).map((a) => a.attrib)
    console.log(`    score1 reads back as: ${JSON.stringify(s1?.value)}`)
  }
  const extras = survived.filter((a) => a !== 'text' && a !== 'color')
  const eyes = await ask('Is score1 blinking, animating or outlined in ANY way? (y/n)')
  // Undo: text/color get repainted at cleanup, but reload clears anything odd we stored.
  await trySend('ReloadLayout', MATCH, undefined, 2500)
  await sleep(500)
  record('P2', 'Device-side effect attributes',
    extras.length ? 'SOMETHING SURVIVED' : 'NONE SURVIVE READ-BACK',
    `read-back=[${survived.join(', ')}] extras=[${extras.join(', ') || 'none'}]; visible effect: ${eyes}`)
  return extras
}

// P3 - Requirements 6 and 7: do the counter sections honour colour on the glass?
// Evidence: the operator's eyes. The mapper already computes these thresholds; this only
// asks whether the panel actually renders them distinguishably at hall distance.
async function p3_counterColours() {
  console.log('\n=== [P3] COUNTER LIMIT COLOURS - requirements 6 and 7 ===')
  await setSections([
    ...demoScoreboard(),
    attr('timeout1', 'text', '2'), attr('timeout1', 'color', MAXED),   // both used -> dark red
    attr('timeout2', 'text', '1'), attr('timeout2', 'color', NEUTRAL), // one used  -> neutral
    attr('sub1', 'text', '5'), attr('sub1', 'color', WARN),            // 5 -> amber
    attr('sub2', 'text', '6'), attr('sub2', 'color', MAXED),           // 6 -> dark red
  ])
  await sleep(900)
  console.log(`    timeout1=2 dark red(${MAXED})  timeout2=1 neutral(${NEUTRAL})`)
  console.log(`    sub1=5 amber(${WARN})          sub2=6 dark red(${MAXED})`)
  const a = await ask('Are all four counters clearly DIFFERENT colours, readable from the far end of the hall? (y/n + notes)')
  record('P3', 'Counter limit colours (req 6, 7)', glassVerdict(a, 'CONFIRMED ON GLASS', 'NEEDS WORK'), a)
}

// P4 - Requirements 1 and 2: how fast can a bridge-driven blink actually go?
// Evidence: measured round-trip latency + the operator's eyes. The client is strictly
// request/response, so the serialized RTT is the cadence floor for an acked blink; the
// burst test then asks whether unacked writes are safe (a faster, riskier option).
async function p4_blinkCadence() {
  console.log('\n=== [P4] BLINK CADENCE - requirements 1 and 2 ===')
  const samples = []
  for (let i = 0; i < 8; i++) {
    const t0 = Date.now()
    const r = await setSections([attr('score1', 'color', i % 2 ? LEFT_COLOR : '255,255,255')])
    if (r.ok) samples.push(Date.now() - t0)
  }
  samples.sort((a, b) => a - b)
  const med = samples[Math.floor(samples.length / 2)] ?? -1
  console.log(`    acked SetSections round-trip: min=${samples[0]}ms median=${med}ms max=${samples[samples.length - 1]}ms (n=${samples.length})`)

  for (const period of [300, 200, 120]) {
    console.log(`    blinking score1 at ${period}ms for 2.4s - WATCH THE BOARD`)
    const t0 = Date.now()
    let n = 0
    while (Date.now() - t0 < 2400) {
      await setSections([attr('score1', 'color', n % 2 ? LEFT_COLOR : OFF)])
      n++
      const drift = period - (Date.now() - t0 - (n - 1) * period)
      if (drift > 0) await sleep(drift)
    }
    await setSections([attr('score1', 'color', LEFT_COLOR)])
    console.log(`      -> ${n} transitions in 2.4s (effective ${Math.round(2400 / n)}ms/step)`)
    await sleep(700)
  }
  const clean = await ask('Which blink rate looked like a deliberate blink rather than a smear or a stutter - 300 / 200 / 120 / none?')

  // Unacked burst: 10 colour flips written back-to-back with no waiting, then a liveness
  // check. If the board still answers GetLayout afterwards, faster-than-RTT blinking is on
  // the table; if it stops answering, acked-only is the rule.
  console.log('    burst test: 10 unacked frames back-to-back...')
  let burstErr = null
  try {
    for (let i = 0; i < 10; i++) fireAndForget({ cmd: 'SetSections', value: [attr('score1', 'color', i % 2 ? '255,255,255' : LEFT_COLOR)] })
  } catch (e) { burstErr = e.message }
  await sleep(1500)
  const alive = await trySend('GetLayout', '', undefined, 4000)
  console.log(`    board after burst: ${alive.ok ? `alive (layout ${alive.value})` : `NO REPLY - ${alive.err}`}`)
  record('P4', 'Blink cadence (req 1, 2)', alive.ok ? 'OK' : 'BURST WEDGED THE BOARD',
    `median RTT ${med}ms; cleanest rate: ${clean}; unacked burst: ${burstErr || (alive.ok ? 'survived' : 'no reply')}`)
  return med
}

// P5 - Is the singular SetSection accepted on a scoreboard section? It is a ~40% smaller
// frame than a one-element SetSections, which matters only for a tight blink loop. The
// vendor app has exactly one SetSection call site and it targets the image layout, so this
// combination is untested by anyone.
async function p5_setSectionSingular() {
  console.log('\n=== [P5] SetSection (singular) ON A SCOREBOARD SECTION ===')
  const r = await trySend('SetSection', { attrib: 'color', value: '0,255,0' }, { name: 'score1' })
  console.log(`    {cmd:SetSection, name:"score1", value:{attrib,value}} -> ${r.ok ? `ok ${JSON.stringify(r.value)}` : r.err}`)
  await sleep(700)
  const read = await trySend('GetSections', '')
  const s1 = read.ok ? (read.value || []).find((s) => s.name === 'score1') : null
  const colour = (s1?.value || []).find((a) => a.attrib === 'color')?.value
  const took = colour === '0,255,0'
  console.log(`    score1 colour now reads: ${colour}`)
  await setSections([attr('score1', 'color', LEFT_COLOR)])
  record('P5', 'SetSection singular', r.ok && took ? 'WORKS' : r.ok ? 'ACCEPTED BUT NO EFFECT' : 'REJECTED',
    r.ok ? `read-back=${colour}` : r.err)
}

// P6 - Requirement 8: a names-and-VS pre-match screen WITHOUT touching the waiting layout.
// The device's `waiting` layout is its own no-client screen (it refused to switch to it
// while we were connected) and ChangeWaiting turns out to be a cover-IMAGE upload, not a
// text field. So the pre-match screen has to be the match layout with everything blanked.
async function p6_preMatchScreen() {
  console.log('\n=== [P6] PRE-MATCH "TEAM A vs TEAM B" SCREEN - requirement 8 ===')
  const blanked = ['score1', 'score2', 'set1', 'set2', 'timeout1', 'timeout2', 'sub1', 'sub2']
  await setSections([
    attr('team1', 'text', 'WIEDIKON'), attr('team1', 'color', LEFT_COLOR),
    attr('team2', 'text', 'GUEST'), attr('team2', 'color', RIGHT_COLOR),
    attr('vs', 'text', 'VS'), attr('vs', 'color', '255,255,255'),
    ...blanked.flatMap((n) => [attr(n, 'text', ''), attr(n, 'color', '0,0,0')]),
    attr('serve1', 'color', '0,0,0'), attr('serve2', 'color', '0,0,0'),
  ])
  await sleep(1200)
  const read = await trySend('GetSections', '')
  const vs = read.ok ? (read.value || []).find((s) => s.name === 'vs') : null
  console.log(`    vs section reads back: ${JSON.stringify(vs?.value)}`)
  const a = await ask('Does the board now show ONLY the two team names and "VS" - are the zeros/labels genuinely gone, or still faintly lit? (describe)')
  record('P6', 'Pre-match names + VS (req 8)',
    glassVerdict(a, 'ACHIEVABLE WITH text+color', 'BLANKING IMPERFECT'), a)
}

// P7 - Requirements 3, 5 and 10, which are all the same screen with a different label and
// number. The real question is not whether it works but whether the boxes are wide enough:
// `timer` defaults to "30" (2 chars) and `lbl` to "TIMEOUT". A 10-minute warm-up needs
// "10:00" (5 chars) and a set interval wants a longer word. fontsize cannot fix an overflow
// here - it scales the glyphs inside a fixed CSS box, it does not resize the box.
async function p7_countdownLayout() {
  console.log('\n=== [P7] COUNTDOWN LAYOUT - requirements 3, 5, 10 ===')
  const sw = await setLayoutSafe(COUNTDOWN)
  console.log(`    layout -> ${COUNTDOWN}: ${sw.state}`)
  if (!sw.ok) return record('P7', 'Countdown layout', 'FAILED', sw.state)
  await sleep(1200)

  const inv = await trySend('GetSections', '')
  if (inv.ok) {
    console.log(`    ${(inv.value || []).length} sections:`)
    console.log(dumpSections(inv.value))
  }
  const names = inv.ok ? (inv.value || []).map((s) => s.name) : []

  // Width sweep on the number: the whole feasibility of 5 and 10 rests on this.
  for (const t of ['30', '2:00', '10:00', '10:00:00']) {
    await setSections([attr('timer', 'text', t), attr('timer', 'color', '255,255,255')])
    console.log(`    timer = "${t}"  (${t.length} chars) - LOOK`)
    await sleep(1600)
  }
  const timerFit = await ask('Which timer values fitted the box cleanly - 30 / 2:00 / 10:00 / 10:00:00? (list the ones that did)')

  // Width sweep on the label.
  for (const l of ['TIMEOUT', 'SET', 'INTERVAL', 'SET INTERVAL', 'WARM UP']) {
    await setSections([attr('lbl', 'text', l), attr('lbl', 'color', '255,176,0')])
    console.log(`    lbl = "${l}" - LOOK`)
    await sleep(1500)
  }
  const lblFit = await ask('Which labels fitted - TIMEOUT / SET / INTERVAL / SET INTERVAL / WARM UP? (list the ones that did)')

  // Does the interval screen keep the score visible? The inventory says score1/score2 and
  // set1/set2 live here too, which would make the set-interval screen genuinely useful.
  let scoreOnCountdown = 'n/a'
  if (names.includes('score1')) {
    await setSections([
      attr('lbl', 'text', 'SET'), attr('lbl', 'color', WARN),
      attr('timer', 'text', '2:59'), attr('timer', 'color', '255,255,255'),
      attr('score1', 'text', '25'), attr('score1', 'color', LEFT_COLOR),
      attr('score2', 'text', '21'), attr('score2', 'color', RIGHT_COLOR),
      attr('set1', 'text', '1'), attr('set2', 'text', '0'),
    ])
    await sleep(1500)
    scoreOnCountdown = await ask('On the countdown screen, are the SET SCORE (25-21) and set counts visible alongside the timer? (y/n)')
  }

  // Live 1 Hz tick - the cadence the vendor's own app uses for its practice countdown.
  console.log('    ticking 8 -> 1 at 1 Hz (this is exactly how a real timeout will run)')
  for (let s = 8; s >= 1; s--) {
    await setSections([attr('timer', 'text', String(s))])
    await sleep(1000)
  }
  const tick = await ask('Did the countdown tick smoothly once per second, with no missed or doubled numbers? (y/n)')

  const back = await setLayoutSafe(MATCH)
  console.log(`    layout -> ${MATCH}: ${back.state}`)
  await sleep(800)
  await setSections(demoScoreboard())
  record('P7', 'Countdown layout (req 3, 5, 10)', 'OK',
    `sections=[${names.join(' ')}]; timer fits: ${timerFit}; labels fit: ${lblFit}; score visible: ${scoreOnCountdown}; 1Hz tick: ${tick}`)
}

// P8 - Requirement 9. Brightness is absent from the vendor app's entire vocabulary, but
// GetConfigs takes NO argument and returns the device's whole config set, while the app
// only ever reads back 12 named keys. So this dump is the one place a brightness knob the
// app ignores could still show up. Nothing visible happens on the panel.
async function p8_brightness() {
  console.log('\n=== [P8] BRIGHTNESS / CONFIG DUMP - requirement 9 ===')
  const r = await trySend('GetConfigs', '', undefined, 5000)
  if (!r.ok) {
    // error 1 is the device saying the command does not exist - a real answer, not a fault.
    const absent = /API not avaible|not available|\(1\)/i.test(r.err)
    return record('P8', 'Brightness config (req 9)',
      absent ? 'GetConfigs NOT IMPLEMENTED ON THIS FIRMWARE' : 'FAILED', r.err)
  }
  const rows = Array.isArray(r.value) ? r.value : []
  console.log(`    ${rows.length} config entries:`)
  for (const c of rows) {
    console.log(`      ${String(c.section).padEnd(10)} ${String(c.field).padEnd(20)} = ${JSON.stringify(c.value)}   [device ${c.device}]`)
  }
  const RE = /bright|lumin|contrast|dimm|gamma|backlight|intens|nits|pwm|duty|level|percent|light/i
  const hits = rows.filter((c) => RE.test(`${c.section} ${c.field}`))
  const sections = [...new Set(rows.map((c) => c.section))]
  console.log(`    config sections present: ${sections.join(', ')}`)
  console.log(`    brightness-shaped keys: ${hits.length ? hits.map((h) => `${h.section}/${h.field}`).join(', ') : 'NONE'}`)

  // The singular GetConfig has zero call sites in the vendor app - untested by anyone.
  const single = await trySend('GetConfig',
    { section: 'LAYOUT', field: 'modifier', value: '', device: deviceInfo?.deviceName || '' }, undefined, 3000)
  console.log(`    GetConfig (singular, never used by the vendor app) -> ${single.ok ? JSON.stringify(single.value) : single.err}`)

  record('P8', 'Brightness config (req 9)', hits.length ? 'CANDIDATE KEY FOUND' : 'NOT IN THE TCP PROTOCOL',
    hits.length ? hits.map((h) => `${h.section}/${h.field}=${h.value}`).join(', ')
      : `${rows.length} entries across ${sections.join('/')}; none brightness-shaped - use the port-80 admin UI`)
}

// P9 - OPT-IN. The CustomText plugin is the only place the vendor's own code has a
// `blinking` value, and it is a full-panel overlay, not a section attribute. Worth knowing
// whether the plugin is even installed, and whether its overlay is usable for a warm-up
// banner. It seizes the panel, which is why it is off by default.
async function p9_customText() {
  console.log('\n=== [P9] CustomText OVERLAY (opt-in) ===')
  const plugins = (deviceInfo?.plugins || []).map((p) => p.name)
  console.log(`    plugins advertised at Init: ${plugins.join(', ') || '(none)'}`)
  if (!plugins.includes('customtext')) {
    return record('P9', 'CustomText overlay', 'PLUGIN NOT INSTALLED', `plugins=[${plugins.join(', ')}]`)
  }
  const payload = {
    id: 0, title: 'probe', hashname: 'probe', text: 'WARM UP',
    fontsize: 24, color: '255,176,0', animation: 'blinking', animation_velocity: 3,
  }
  const start = await trySend('StartCustomText', payload, undefined, 4000)
  console.log(`    StartCustomText -> ${start.ok ? 'ok' : start.err}`)
  await sleep(4000)
  const seen = await ask('Did a blinking "WARM UP" overlay appear on the panel? (y/n)')
  const stop = await trySend('StopCustomText', { hashname: 'probe' }, undefined, 3000)
  console.log(`    StopCustomText -> ${stop.ok ? 'ok' : stop.err}`)
  record('P9', 'CustomText overlay', start.ok && /^y/i.test(seen) ? 'WORKS' : start.ok ? 'ACCEPTED, NOTHING SEEN' : 'REJECTED',
    `visible: ${seen}; stop: ${stop.ok ? 'ok' : stop.err}`)
}

// ---------------------------------------------------------------------------------

const watchdog = setTimeout(async () => {
  console.log('\n!!! watchdog fired - probe ran too long, restoring the board')
  await cleanup('watchdog')
  printSummary()
  process.exit(1)
}, 20 * 60 * 1000)

process.on('SIGINT', async () => {
  console.log('\n^C - restoring the board before exiting (do NOT kill -9: the board wedges)')
  clearTimeout(watchdog)
  await cleanup('SIGINT')
  printSummary()
  process.exit(130)
})

client.on('ready', async (info) => {
  deviceInfo = info
  console.log(`connected to ${HOST} - ${info.deviceName} fw ${info.version}, role ${info.role}, layout ${info.current_layout}`)
  console.log(`plugins: ${(info.plugins || []).map((p) => p.name).join(', ') || '(none)'}`)
  console.log(`noresend: ${info.noresend}`)
  console.log(AUTO ? 'running non-interactive (PROBE_AUTO=1)' : 'interactive - you will be asked what you see')

  try {
    await p1_matchInventory()
    await p2_attributeReality()
    await p3_counterColours()
    await p4_blinkCadence()
    await p5_setSectionSingular()
    await p6_preMatchScreen()
    await p7_countdownLayout()
    await p8_brightness()
    if (RUN_CUSTOMTEXT) await p9_customText()
    else console.log('\n=== [P9] CustomText overlay SKIPPED (set PROBE_CUSTOMTEXT=1 to run it) ===')
  } catch (e) {
    console.log(`\n!!! probe threw: ${e.stack}`)
    record('--', 'probe run', 'ABORTED', e.message)
  } finally {
    clearTimeout(watchdog)
    await cleanup('normal end')
    printSummary()
    setTimeout(() => process.exit(0), 500)
  }
})

client.on('close', () => {
  if (!cleanedUp) console.log('socket closed before the probe finished')
})

console.log(`probe-effects: connecting to ${HOST}:8889 ...`)
client.connect()
