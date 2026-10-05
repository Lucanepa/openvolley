/** scripts/hash-pins.mjs: rewrites plaintext PINs in matches, idempotently. */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { hashStoredPins, hasPlaintextPin } from '../scripts/hash-pins.mjs'
import { createPinHasher, isHashedPin } from '../lib/pinHash.js'
import { SKIP_PG, createTestDatabase } from './helpers/pgTestDb.js'

const hasher = createPinHasher('s'.repeat(40))

describe('hasPlaintextPin', () => {
  it('sees plaintext game_pin / connection_pins values, not hashed or empty ones', () => {
    assert.equal(hasPlaintextPin({ game_pin: '123456' }), true)
    assert.equal(hasPlaintextPin({ game_pin: hasher.hash('game', '123456') }), false)
    assert.equal(hasPlaintextPin({ connection_pins: { referee: hasher.hash('referee', '1'), bench_home: '222222' } }), true)
    assert.equal(hasPlaintextPin({ game_pin: '', connection_pins: {} }), false)
    assert.equal(hasPlaintextPin({ game_pin: null, connection_pins: null }), false)
  })
})

describe('hash-pins on Postgres', { skip: SKIP_PG }, () => {
  let tdb, c
  before(async () => {
    tdb = await createTestDatabase('hashpins')
    c = new pg.Client({ connectionString: tdb.url })
    await c.connect()
  })
  after(async () => {
    await c?.end()
    await tdb?.drop()
  })

  it('dry run counts, --apply rewrites, a second run finds nothing; the hashes verify', async () => {
    await c.query(`INSERT INTO matches (external_id, game_pin, connection_pins) VALUES
      ('a', '111111', '{"referee":"222222","upload_home":"333333"}'),
      ('b', NULL, NULL),
      ('c', $1, $2)`, [hasher.hash('game', '444444'), JSON.stringify({ referee: hasher.hash('referee', '555555') })])
    assert.deepEqual(await hashStoredPins(c, hasher), { scanned: 3, rewritten: 1 })
    assert.equal((await c.query("SELECT game_pin FROM matches WHERE external_id = 'a'")).rows[0].game_pin, '111111', 'dry run changes nothing')
    assert.deepEqual(await hashStoredPins(c, hasher, { apply: true, batch: 2 }), { scanned: 3, rewritten: 1 })
    const { rows: [a] } = await c.query("SELECT game_pin, connection_pins FROM matches WHERE external_id = 'a'")
    assert.ok(isHashedPin(a.game_pin))
    assert.equal(hasher.matches('game', '111111', a.game_pin), true)
    assert.equal(hasher.matches('referee', '222222', a.connection_pins.referee), true)
    assert.equal(hasher.matches('upload_home', '333333', a.connection_pins.upload_home), true)
    assert.deepEqual(await hashStoredPins(c, hasher, { apply: true }), { scanned: 3, rewritten: 0 })
    await assert.rejects(hashStoredPins(c, createPinHasher(null)), /OV_PIN_SECRET/)
  })
})
