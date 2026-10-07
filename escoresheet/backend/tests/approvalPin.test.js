// lib/approvalPin.js: the spec's test vectors (docs/account-approval-spec.md
// 1.1, 1.3, 1.4), weak PINs, constant-time verification.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  PIN_RE, KEY_ID, isWeakPin, deriveKeys, macPin, verifyPin, isCurrentPinRow, resultKey, resultHash, triplesOf,
  ipHash, deviceHash, shortId
} from '../lib/approvalPin.js'
import { ipBucketKey } from '../lib/auth.js'

const SECRET = 'x'.repeat(40)
const SALT = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex')
const USER = '00000000-0000-4000-8000-000000000001'
const MAC = 'd08eed15f4699da574c7903c6fa92901d53d9fd0e218d33a0b40b1812509203d'

describe('approval PIN helpers', () => {
  it('derives the keys of the test vector (HKDF-SHA256, info ov-approval-pin-v1)', () => {
    const { pinKey, ipKey } = deriveKeys(SECRET)
    assert.equal(pinKey.toString('hex'), '221f185ca88913fc317852cebe6db11e0f2f2babbdfe8b6627ae64252ea37599')
    assert.equal(ipKey.length, 32)
    assert.notDeepEqual(ipKey, pinKey)
  })

  it('MACs the test vector', () => {
    const { pinKey } = deriveKeys(SECRET)
    assert.equal(macPin(pinKey, SALT, USER, '482917').toString('hex'), MAC)
    assert.equal(macPin(pinKey, SALT, USER.toUpperCase(), '482917').toString('hex'), MAC, 'the user id is lower-cased')
  })

  it('refuses a missing or short secret', () => {
    assert.throws(() => deriveKeys(null), /at least 32/)
    assert.throws(() => deriveKeys('x'.repeat(31)), /at least 32/)
    assert.doesNotThrow(() => deriveKeys('x'.repeat(32)))
  })

  it('hashes the IP bucket (test vector) and the device id', () => {
    const { ipKey } = deriveKeys(SECRET)
    assert.equal(ipHash(ipKey, ipBucketKey('203.0.113.7')).toString('hex'), '95eef55bcfc176347ee83e195b4b67d6919c3d60684254dc30d46f4a1969cfc1')
    // an IPv6 client hashes as its /64
    assert.deepEqual(ipHash(ipKey, ipBucketKey('2001:db8:1:2::5')), ipHash(ipKey, ipBucketKey('2001:db8:1:2:ffff::9')))
    const d = deviceHash('6F1C2A9B-0000-4000-8000-000000000001')
    assert.equal(d.length, 32)
    assert.deepEqual(d, deviceHash('6f1c2a9b-0000-4000-8000-000000000001'))
    assert.equal(deviceHash(undefined), null)
    assert.equal(deviceHash(''), null)
  })

  it('builds the canonical result key (test vector), from triples or set rows', () => {
    const key = resultKey([[1, 25, 20], [2, 23, 25], [3, 25, 18], [4, 25, 22]])
    assert.equal(key, 'ov-result-v1|1:25:20,2:23:25,3:25:18,4:25:22')
    assert.equal(resultHash(key).toString('hex'), '50cc98ab59081eaafcd703ce412ee1b82c9505e7af7cea8693a2c6143e1fa123')
    assert.equal(resultKey([[4, 25, 22], [2, 23, 25], [1, 25, 20], [3, 25, 18]]), key, 'sorted by index')
    const rows = [
      { index: 3, home_points: 25, away_points: 18, finished: true },
      { index: 5, home_points: 3, away_points: 1, finished: false },
      { index: 1, home_points: 25, away_points: 20, finished: true },
      { index: 4, home_points: 25, away_points: 22, finished: true },
      { index: 2, home_points: 23, away_points: 25, finished: true }
    ]
    assert.equal(resultKey(rows), key, 'unfinished sets do not count')
    assert.equal(resultKey([{ index: 1, home_points: 25, away_points: null, finished: true }]), 'ov-result-v1|1:25:0', 'missing points count as 0')
    assert.equal(resultKey([]), 'ov-result-v1|')
    assert.deepEqual(triplesOf(key), [[1, 25, 20], [2, 23, 25], [3, 25, 18], [4, 25, 22]])
    assert.deepEqual(triplesOf('ov-result-v1|'), [])
  })

  it('weak PINs: one repeated digit and strict runs', () => {
    for (const p of ['0000', '1234', '0123', '9876', '123456', '111111', '4321', '987654', '3456']) assert.equal(isWeakPin(p), true, p)
    for (const p of ['1357', '482917', '0420', '1235', '9870', '12345a', '']) assert.equal(isWeakPin(p), false, p)
  })

  it('PIN_RE: 4 to 6 digits only', () => {
    for (const p of ['123', '1234567', '12a4', ' 1234', '1234 ', '١٢٣٤']) assert.equal(PIN_RE.test(p), false, p)
    for (const p of ['1234', '12345', '482917', '0000']) assert.equal(PIN_RE.test(p), true, p)
  })

  it('verifyPin: true only for the right PIN, user, salt and key generation', () => {
    const { pinKey } = deriveKeys(SECRET)
    const row = { key_id: KEY_ID, salt: SALT, mac: Buffer.from(MAC, 'hex') }
    assert.equal(isCurrentPinRow(row), true)
    assert.equal(verifyPin(pinKey, row, USER, '482917'), true)
    assert.equal(verifyPin(pinKey, row, USER, '482918'), false)
    assert.equal(verifyPin(pinKey, row, '00000000-0000-4000-8000-000000000002', '482917'), false, 'another user')
    const salt2 = Buffer.from(SALT)
    salt2[0] ^= 1
    assert.equal(verifyPin(pinKey, { ...row, salt: salt2 }, USER, '482917'), false, 'another salt')
    assert.equal(verifyPin(pinKey, { ...row, key_id: KEY_ID + 1 }, USER, '482917'), false, 'an older key generation')
    assert.equal(verifyPin(deriveKeys('y'.repeat(40)).pinKey, row, USER, '482917'), false, 'another secret')
    assert.equal(verifyPin(pinKey, row, USER, 482917), false, 'a number is not a PIN')
    assert.equal(verifyPin(pinKey, row, USER, '48291'), false, 'malformed / wrong length')
    assert.equal(verifyPin(pinKey, null, USER, '482917'), false)
  })

  it('verifyPin computes exactly one HMAC on every path', () => {
    const { pinKey } = deriveKeys(SECRET)
    const row = { key_id: KEY_ID, salt: SALT, mac: Buffer.from(MAC, 'hex') }
    const cases = [
      [row, USER, '482917'], // right
      [row, USER, '000001'], // wrong
      [null, null, '482917'], // unknown user, no row
      [null, USER, '482917'], // no PIN set
      [{ ...row, key_id: 2 }, USER, '482917'], // old key
      [row, USER, 'abc'], // malformed
      [row, USER, undefined]
    ]
    for (const [r, u, p] of cases) {
      let calls = 0
      const spy = (...a) => { calls++; return macPin(...a) }
      verifyPin(pinKey, r, u, p, { mac: spy })
      assert.equal(calls, 1, JSON.stringify([!!r, u, p]))
    }
  })

  it('shortId: the first 8 hex characters, upper case', () => {
    assert.equal(shortId('3f9a2c1b-1234-4000-8000-000000000001'), '3F9A2C1B')
  })
})
