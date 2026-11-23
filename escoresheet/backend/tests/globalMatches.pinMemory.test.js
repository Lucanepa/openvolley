// The Global cloud copy's memory of who guessed a PIN (GCS-R3, the review of
// the SEC-30 fix): wrong PINs on thousands of self-made copies pushed a
// locked copy's guessers out of memory (at most 10000 copies were held), so
// they were fresh networks again and got their compares back; and 10000
// copies of 64 networks each could take tens of MB. Now the networks of a
// locked copy are kept and every copy's are bounded in all
// (PIN_MEMORY_ENTRIES), the unlocked copies' given up first. A stub pool
// (no Postgres): thousands of copies in a few seconds.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createGlobalMatches, keyHash, pinHash, PIN_MEMORY_ENTRIES } from '../lib/globalMatches.js'

const silent = { error() {}, warn() {}, log() {} }
const newKey = () => crypto.randomBytes(16).toString('base64url')

/** A pool that holds global_matches rows in memory, for load()'s PIN check. */
function stubPool(nowMs) {
  const rows = new Map() // key_hash -> row
  let id = 0
  const add = (key, pin) => rows.set(keyHash(key), { id: ++id, key_hash: keyHash(key), pin_hash: pinHash(key, pin), pin_failures: null, pin_failed_at: null, locked_until: null })
  const byId = (n) => [...rows.values()].find((r) => r.id === n)
  const pool = {
    async query(text, params) {
      if (/^SELECT .* FROM public\.global_matches WHERE key_hash = \$1 AND expires_at > now\(\)$/s.test(text)) {
        const r = rows.get(params[0])
        return { rows: r ? [{ id: r.id, bundle: {}, summary: {}, updated_at: new Date(nowMs()), share_token: null, organizer_hash: null, own_pin_hash: r.pin_hash, own_locked_until: r.locked_until }] : [] }
      }
      if (/SET\s+pin_failures/.test(text)) {
        const r = byId(params[0])
        const forget = params[1] * 1000
        r.pin_failures = !r.pin_failed_at || r.pin_failed_at < nowMs() - forget ? 1 : (r.pin_failures || 0) + 1
        r.pin_failed_at = nowMs()
        return { rows: [{ pin_failures: r.pin_failures }] }
      }
      if (/SET locked_until/.test(text)) {
        const r = byId(params[0])
        r.locked_until = new Date(Math.max(r.locked_until ? r.locked_until.getTime() : nowMs(), nowMs() + params[1] * 1000))
        return { rows: [] }
      }
      throw new Error(`stub pool: unexpected SQL ${text.slice(0, 80)}`)
    }
  }
  return { pool, add, rows }
}

describe('Global cloud: the memory of who guessed (GCS-R3)', () => {
  it('wrong PINs on 12000 self-made copies do not push a locked copy\'s guessers out: they stay held off', async () => {
    let t = Date.parse('2026-11-23T10:00:00Z')
    const now = () => t
    const { pool, add } = stubPool(now)
    const gm = createGlobalMatches({ pool, logger: silent, now: () => new Date(t) })
    const target = newKey()
    add(target, '7342')
    const guesser = { ip: '192.0.2.7' }
    for (let i = 0; i < 10; i++) assert.equal((await gm.load(target, String(1000 + i), guesser)).status, 403)
    assert.equal((await gm.load(target, '7342', guesser)).status, 429, 'locked for the guesser')
    // the flush: one wrong PIN on each of 12000 copies the guesser made itself
    for (let i = 0; i < 12000; i++) {
      const k = newKey()
      add(k, '1111')
      await gm.load(k, '2222', { ip: `2001:db8:${(i >> 8).toString(16)}:${(i & 255).toString(16)}00::1` })
      t += 5
    }
    assert.equal((await gm.load(target, '7342', guesser)).status, 429, 'still held off: no compare, no oracle')
    assert.ok(gm.pinMemory().entries <= PIN_MEMORY_ENTRIES)
  })

  it('the networks held in all stay bounded; the unlocked copies are given up first', async () => {
    let t = Date.parse('2026-11-23T10:00:00Z')
    const { pool, add } = stubPool(() => t)
    const gm = createGlobalMatches({ pool, logger: silent, now: () => new Date(t), pinMemoryEntries: 300 })
    const target = newKey()
    add(target, '7342')
    // 20 networks guess the target: locked after 10, the other 10 are noted too
    for (let i = 0; i < 20; i++) await gm.load(target, String(1000 + i), { ip: `192.0.${i}.7` })
    for (let i = 0; i < 2000; i++) {
      const k = newKey()
      add(k, '1111')
      await gm.load(k, '2222', { ip: `198.18.${i % 200}.${1 + (i % 7)}` })
      t += 5
    }
    const mem = gm.pinMemory()
    assert.ok(mem.entries <= 300, JSON.stringify(mem))
    for (let i = 0; i < 20; i++) assert.equal((await gm.load(target, '7342', { ip: `192.0.${i}.7` })).status, 429, `guesser ${i}`)
    assert.equal((await gm.load(target, '7342', { ip: '203.0.113.5' })).status, 200, 'another network with the right PIN')
  })
})
