// Verifies the appliance log store: level gating, the memory ring, redaction, JSONL
// persistence + rotation, querying, live subscription — and, most importantly, that it can
// never throw into a caller (a logger that breaks scoring is worse than no logger).
import { LogStore, LEVELS } from '../src/logStore.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-logs-'))
const file = path.join(dir, 'appliance.jsonl')
const lines = (p) => fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

console.log('log store — levels, ring and redaction:')
{
  // console:false throughout — the assertions below are the output we want to read.
  const log = new LogStore({ console: false, maxEntries: 5 })

  log.debug('ledbox', 'a debug line')
  log.info('ledbox', 'an info line')
  ok(log.query().length === 1, 'debug is dropped at the default info level')
  ok(log.query()[0].msg === 'an info line', 'info is kept')
  ok(log.dropped === 1, 'the dropped count is reported')

  log.setLevel('debug')
  log.debug('ledbox', 'now recorded')
  ok(log.query().length === 2, 'lowering the level starts recording debug')

  for (let i = 0; i < 10; i++) log.info('spam', `line ${i}`)
  ok(log.entries.length === 5, 'the ring buffer is capped at maxEntries')
  ok(log.entries[4].msg === 'line 9', 'the newest entry survives the cap')

  const ids = log.entries.map((e) => e.id)
  ok(ids.every((v, i) => i === 0 || v > ids[i - 1]), 'ids increase monotonically (SSE cursor)')
}

console.log('\nredaction — a PIN or token must never reach the log:')
{
  const log = new LogStore({ console: false })
  // Not a year-like PIN: the entry's own ISO timestamp would contain it and make the
  // "nothing leaked" assertion below lie in either direction.
  log.info('settings', 'saved', { scorerPin: '778899', clubName: 'KSC WIEDIKON', nested: { token: 'secret-abc' } })
  const e = log.query()[0]
  ok(e.data.scorerPin === '[redacted]', 'scorerPin is redacted')
  ok(e.data.nested.token === '[redacted]', 'a nested token is redacted')
  ok(e.data.clubName === 'KSC WIEDIKON', 'ordinary fields survive')
  ok(!JSON.stringify(e).includes('778899') && !JSON.stringify(e).includes('secret-abc'), 'no secret value appears anywhere in the entry')

  log.info('settings', 'empty pin', { scorerPin: '' })
  ok(log.query({ q: 'empty pin' })[0].data.scorerPin === '', 'an unset PIN reads as empty, not as [redacted]')
}

console.log('\nunloggable input — the store must survive anything a caller hands it:')
{
  const log = new LogStore({ console: false })
  const cycle = { name: 'loop' }; cycle.self = cycle
  ok(log.info('x', 'cyclic', cycle) !== null, 'a circular object does not throw')
  ok(log.query()[0].data.self === '[circular]', 'the cycle is marked rather than followed')

  const deep = { a: { b: { c: { d: { e: { f: 'too deep' } } } } } }
  log.info('x', 'deep', deep)
  ok(typeof log.query({ q: 'deep' })[0].data.a.b.c.d === 'string', 'depth is bounded')

  log.info('x', 'long', { s: 'y'.repeat(5000) })
  ok(log.query({ q: 'long' })[0].data.s.length < 700, 'a huge string is truncated')

  const err = new Error('board refused')
  err.code = 'E_BOARD'
  log.error('x', 'failed', err)
  const le = log.query({ level: 'error' })[0]
  ok(le.data.message === 'board refused' && le.data.code === 'E_BOARD', 'an Error is unwrapped into readable fields')

  const wide = {}
  for (let i = 0; i < 200; i++) wide[`k${i}`] = i
  log.info('x', 'wide', wide)
  ok(Object.keys(log.query({ q: 'wide' })[0].data).length <= 41, 'object width is bounded')

  ok(log.info('x', 'undefined data', undefined) !== null, 'undefined data is fine')
  ok(log.log('nonsense-level', 'x', 'unknown level') !== null, 'an unknown level falls back to info')
}

console.log('\nquery — what the /logs page and its filters rely on:')
{
  const log = new LogStore({ console: false, level: 'debug' })
  log.debug('ledbox', 'paint', { score: '5-3' })
  log.info('control', 'POST /api/action')
  log.warn('relay', 'disconnected')
  log.error('ledbox', 'push failed')

  ok(log.query({ level: 'warn' }).length === 2, 'level filters to that level AND above')
  ok(log.query({ scope: 'ledbox' }).length === 2, 'scope filter')
  ok(log.query({ scope: 'ledbox,relay' }).length === 3, 'multiple scopes')
  ok(log.query({ q: '5-3' }).length === 1, 'search reaches into the data payload')
  ok(log.query({ q: 'API/ACTION' }).length === 1, 'search is case-insensitive')
  ok(log.query({ limit: 2 }).length === 2, 'limit returns the NEWEST n')
  ok(log.query({ limit: 2 })[1].msg === 'push failed', 'the newest entry is last')
  const after = log.query({ sinceId: log.entries[1].id })
  ok(after.length === 2 && after[0].msg === 'disconnected', 'sinceId returns only what came after (SSE catch-up)')
  ok(log.scopes().join(',') === 'control,ledbox,relay', 'scopes() lists what has actually been logged')
  ok(log.stats().counts.error === 1 && log.stats().counts.warn === 1, 'stats count by level')
}

console.log('\nsubscription — the live tail:')
{
  const log = new LogStore({ console: false })
  const seen = []
  const off = log.subscribe((e) => seen.push(e.msg))
  log.info('x', 'first')
  log.info('x', 'second')
  off()
  log.info('x', 'after unsubscribe')
  ok(seen.length === 2 && seen[0] === 'first', 'subscribers receive entries as they happen')
  ok(!seen.includes('after unsubscribe'), 'unsubscribing stops the feed')
  ok(log.query({ q: 'debug-level entry that is dropped' }).length === 0, 'no phantom entries')
}

console.log('\npersistence — the JSONL trail on the card:')
{
  const log = new LogStore({ console: false, file, flushAt: 3, flushMs: 50 })
  log.info('boot', 'one')
  log.info('boot', 'two')
  ok(!fs.existsSync(file) || lines(file).length === 0, 'writes are buffered, not one fsync per entry')
  log.info('boot', 'three') // hits flushAt
  ok(lines(file).length === 3, 'the buffer flushes once it fills')
  ok(lines(file)[0].msg === 'one', 'entries are written in order')

  log.info('boot', 'four')
  log.error('boot', 'a fault') // errors flush immediately — they must survive a crash
  ok(lines(file).length === 5, 'an error forces an immediate flush')

  log.flush()
  ok(log.files().length === 1 && log.files()[0].bytes > 0, 'files() reports the active file')
}

console.log('\nrotation — the disk ceiling holds:')
{
  const rdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-rot-'))
  const rfile = path.join(rdir, 'appliance.jsonl')
  const log = new LogStore({ console: false, file: rfile, maxBytes: 2000, maxFiles: 3, flushAt: 1 })
  for (let i = 0; i < 60; i++) log.info('spam', `entry number ${i} with enough text to move the byte counter along`)
  log.flush()
  const rotated = fs.readdirSync(rdir).sort()
  ok(rotated.includes('appliance.jsonl'), 'the active file exists')
  ok(rotated.includes('appliance.1.jsonl'), 'a rotation was created')
  ok(rotated.length <= 3, `never more than maxFiles on disk (got ${rotated.length})`)
  const total = rotated.reduce((n, f) => n + fs.statSync(path.join(rdir, f)).size, 0)
  ok(total <= 2000 * 3, 'total bytes stay under maxBytes × maxFiles')
  ok(log.files().length === rotated.length, 'files() sees every rotation')

  log.clear()
  ok(fs.readdirSync(rdir).length === 0, 'clear() removes the files as well as the ring')
  ok(log.query().length === 0, 'clear() empties the ring')
  fs.rmSync(rdir, { recursive: true, force: true })
}

console.log('\nunwritable location — the board must still boot:')
{
  // A regular file standing where a directory should be: mkdir fails with ENOTDIR, which is
  // the same class of failure as a full or read-only card.
  const blocker = path.join(dir, 'not-a-directory')
  fs.writeFileSync(blocker, 'x')
  const log = new LogStore({ console: false, file: path.join(blocker, 'appliance.jsonl') })
  ok(log.opts.file === null, 'an unwritable path falls back to memory-only instead of throwing')
  ok(log.info('x', 'still logging') !== null, 'logging continues without a file')
}

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
