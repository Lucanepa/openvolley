/**
 * lib/addressProofs.js: what an address bucket proved recently (the match
 * tokens issued or accepted for it), the stand-in for the match token the
 * apps in the halls do not send on their live sockets (review of the audit
 * 2611 PERM-03 and SEC-08 fixes).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAddressProofs } from '../lib/addressProofs.js'

const payload = (u, r = 'referee') => ({ m: `ext-${u}`, u, r, exp: 1e15 })

describe('addressProofs', () => {
  it('remembers a bucket\'s proof of a match for its time, and nothing else', () => {
    let t = 1000
    const proofs = createAddressProofs({ ttlMs: 100, now: () => t })
    assert.equal(proofs.note('198.51.100.7', payload('m-1')), true)
    assert.deepEqual(proofs.proofOf('198.51.100.7', 'm-1'), payload('m-1'))
    assert.equal(proofs.proofOf('198.51.100.7', 'm-2'), null, 'another match')
    assert.equal(proofs.proofOf('198.51.100.8', 'm-1'), null, 'another bucket')
    assert.equal(proofs.provedAny('198.51.100.7'), true)
    assert.equal(proofs.provedAny('198.51.100.8'), false)
    t += 100
    assert.equal(proofs.proofOf('198.51.100.7', 'm-1'), null, 'expired')
    assert.equal(proofs.provedAny('198.51.100.7'), false)
  })

  it('takes only payloads that name a database match (u)', () => {
    const proofs = createAddressProofs()
    assert.equal(proofs.note('198.51.100.7', { m: 'ext', r: 'referee' }), false)
    assert.equal(proofs.note('198.51.100.7', null), false)
    assert.equal(proofs.note('', payload('m-1')), false)
    assert.equal(proofs.provedAny('198.51.100.7'), false)
  })

  it('keeps a match for its first buckets only: one PIN does not mark every /64 of a network', () => {
    let t = 0
    const proofs = createAddressProofs({ maxBucketsPerMatch: 2, ttlMs: 100, now: () => t })
    assert.equal(proofs.note('a', payload('m-1')), true)
    assert.equal(proofs.note('b', payload('m-1')), true)
    assert.equal(proofs.note('c', payload('m-1')), false)
    assert.equal(proofs.proofOf('c', 'm-1'), null)
    assert.equal(proofs.note('a', payload('m-1')), true, 'a bucket that has it renews it')
    t += 100
    assert.equal(proofs.note('c', payload('m-1')), true, 'once the first ones expired')
  })

  it('is bounded per bucket and in buckets', () => {
    const proofs = createAddressProofs({ maxPerBucket: 2, maxBuckets: 2 })
    proofs.note('a', payload('m-1'))
    proofs.note('a', payload('m-2'))
    proofs.note('a', payload('m-3'))
    assert.equal(proofs.proofOf('a', 'm-1'), null, 'the bucket\'s oldest went')
    assert.ok(proofs.proofOf('a', 'm-3'))
    proofs.note('b', payload('m-4'))
    proofs.note('c', payload('m-5'))
    assert.equal(proofs.provedAny('a'), false, 'the least recently proved bucket went')
    assert.equal(proofs.provedAny('c'), true)
    assert.deepEqual(proofs.stats(), { buckets: 2, matches: 2 })
  })
})
