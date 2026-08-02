// Proof for the wiedisync /live publisher: the sport-specific field mapping, the
// debounce/coalesce behaviour, the 404 self-heal, and — most importantly — that a
// broken Directus can never throw into the scoring path.
//
// No network: a stub `fetch` records every request.

import { createLivePush, toRow } from '../src/livePush.js'
import { ManualSource } from '../src/manualSource.js'
import { BasketballSource } from '../src/basketballSource.js'
import { SourceManager } from '../src/sourceManager.js'

let failures = 0
const assert = (cond, label) => {
  console.log(`  ${cond ? '✓' : '✗ FAIL'}  ${label}`)
  if (!cond) failures++
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const realFetch = globalThis.fetch
let calls = []
function stubFetch(handler) {
  calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: JSON.parse(init?.body || '{}') })
    return handler ? handler(calls.length) : { ok: true, status: 200, text: async () => '' }
  }
}

const CFG = { url: 'https://directus.example/', token: 'tok', channel: 'kscw', debounceMs: 5 }

// ── 1. toRow: volleyball ─────────────────────────────────────────────────────
console.log('\ntoRow — volleyball')
{
  const vb = new ManualSource()
  vb.apply({ type: 'team', side: 'left', short: 'KSCW' })
  vb.apply({ type: 'point', side: 'left', value: 23 })
  vb.apply({ type: 'sub', side: 'left', value: 3 })
  const row = toRow(vb.getState(), null, 'volleyball')
  assert(row.sport === 'volleyball', 'sport is volleyball')
  assert(row.status === 'live', 'a played board is live')
  assert(row.points_a === 23, 'points carried')
  assert(row.subs_a === 3, 'volleyball keeps subs in subs_a')
  assert(row.fouls_a === 0, 'volleyball reports no fouls')
  assert(row.period === 1, 'period is the set being played')
  assert(row.over === false, 'not over at 0 sets')
}

// ── 2. toRow: basketball reuses subs_* for team fouls ────────────────────────
console.log('\ntoRow — basketball (subs_* carries team fouls)')
{
  const bb = new BasketballSource()
  bb.apply({ type: 'point', side: 'left', value: 64 })
  bb.apply({ type: 'sub', side: 'left', value: 5 }) // 'sub' == team foul in basketball
  bb.apply({ type: 'set', side: 'left', value: 3 }) // 'set' == period
  const state = bb.getState()
  const row = toRow(state, null, 'basketball')
  assert(state.subs_a === 5, 'source really does put fouls in subs_a')
  assert(row.fouls_a === 5, 'mapped to fouls_a on the wire')
  assert(row.subs_a === 0, 'and subs_a is zeroed so the payload does not lie')
  assert(row.period === state.period, 'period comes from the source, not the set count')
  assert(row.sport === 'basketball', 'sport is basketball')
}

// ── 3. status: idle / final ──────────────────────────────────────────────────
console.log('\ntoRow — status')
{
  assert(toRow(new ManualSource().getState(), null, 'volleyball').status === 'idle',
    'a neutral board is idle, not a 0:0 live match')

  const vb = new ManualSource()
  vb.apply({ type: 'set', side: 'left', value: 3 })
  const row = toRow(vb.getState(), null, 'volleyball')
  assert(row.status === 'final' && row.over === true,
    'volleyball is final at 3 sets — derived from state, not the transient event')

  const beach = { team_a_name: 'A', sets_won_a: 2, sets_won_b: 0, set_results: [] }
  assert(toRow(beach, null, 'beach').over === true, 'beach is over at 2 sets (BEACH.setsToWin)')
  assert(toRow(beach, null, 'volleyball').over === false, 'the same score is NOT over at volleyball')
}

// ── 4. Debounce coalesces a burst into one write with the latest state ───────
console.log('\ndebounce')
{
  stubFetch()
  const lp = createLivePush(CFG)
  const src = new ManualSource()
  src.apply({ type: 'team', side: 'left', short: 'KSCW' })
  for (let i = 1; i <= 5; i++) { src.apply({ type: 'point', side: 'left', value: i }); lp.push(src.getState()) }
  await wait(40)
  assert(calls.length === 1, `5 rapid changes → 1 write (got ${calls.length})`)
  assert(calls[0].method === 'PATCH', 'writes with PATCH')
  assert(calls[0].url.endsWith('/items/live_scores/kscw'), 'writes the channel row by primary key')
  assert(calls[0].body.points_a === 5, 'carries the LATEST state, not the first')
}

// ── 5. 404 self-heal → POST ──────────────────────────────────────────────────
console.log('\nself-heal')
{
  stubFetch((n) => (n === 1
    ? { ok: false, status: 404, text: async () => '' }
    : { ok: true, status: 200, text: async () => '' }))
  const lp = createLivePush(CFG)
  const src = new ManualSource()
  src.apply({ type: 'point', side: 'left', delta: 1 })
  lp.push(src.getState())
  await wait(40)
  assert(calls.length === 2, 'a 404 triggers a second request')
  assert(calls[1].method === 'POST' && calls[1].url.endsWith('/items/live_scores'),
    'the retry CREATES the row')
  assert(calls[1].body.channel === 'kscw', 'and includes the channel primary key')
}

// ── 6. A broken Directus must never reach the scoring path ───────────────────
console.log('\nisolation')
{
  globalThis.fetch = async () => { throw new Error('network down') }
  const lp = createLivePush(CFG)
  const src = new ManualSource()
  let threw = false
  try {
    lp.attach(src)
    for (let i = 0; i < 5; i++) src.apply({ type: 'point', side: 'left', delta: 1 })
    await wait(40)
  } catch { threw = true }
  assert(!threw, 'a thrown fetch does not propagate')
  assert(src.getState().points_a === 5, 'and scoring carried on regardless')
  lp.detach()
}

// ── 7. Disabled stub when the env is unset ───────────────────────────────────
console.log('\ndisabled by default')
{
  stubFetch()
  const lp = createLivePush({ ...CFG, token: '' })
  assert(lp.enabled === false, 'no token → disabled')
  lp.attach(new ManualSource())
  lp.push(new ManualSource().getState())
  await wait(20)
  assert(calls.length === 0, 'and it makes no requests at all')
}

// ── 8. Attaching to a SourceManager covers manual AND linked matches ─────────
console.log('\nSourceManager attach')
{
  stubFetch()
  const lp = createLivePush(CFG)
  const sm = new SourceManager()
  const src = new ManualSource()
  lp.attach(sm)
  sm.setSource(src, { mode: 'manual' })
  src.apply({ type: 'point', side: 'left', delta: 1 })
  await wait(40)
  assert(calls.length >= 1, 'state emitted through the SourceManager is published')
  lp.detach()
}

globalThis.fetch = realFetch
console.log(failures === 0 ? '\n✅ livePush selftest passed' : `\n❌ ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
