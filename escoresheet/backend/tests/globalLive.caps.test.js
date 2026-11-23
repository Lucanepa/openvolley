/**
 * The live screen's store cannot be filled by strangers (lib/globalLive.js,
 * audit round 3 SEC-10): 1000 anonymous new codes in a minute filled it for
 * 3 hours, and every real tournament's new code then got 503.
 *
 *   - new codes and new courts per address (/64 bucket and its /56) and hour
 *     are capped;
 *   - an unproved court posted only once goes after minutes, not hours;
 *   - a full store gives a new code the place of a code with nothing live,
 *     and a relay court also the place of a code the relay never proved;
 *   - what is refused is counted (stats, /health).
 *
 *   cd escoresheet/backend && node --test tests/globalLive.caps.test.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createGlobalLive, LIVE_CODE_ALPHABET, netOfBucket } from '../lib/globalLive.js'

const live = (over = {}) => ({ team_a_name: 'Bergtal IS', team_b_name: 'Seeblick IS', points_a: 1, points_b: 0, match_status: 'live', ...over })
const hex = () => randomBytes(16).toString('hex')
const newCode = () => Array.from(randomBytes(8)).map((b) => LIVE_CODE_ALPHABET[b % 32]).join('')

describe('caps per address and hour', () => {
  it('new codes: 12 per /64, 36 per /56; refused pushes are counted', () => {
    let t = 1_000_000
    const store = createGlobalLive({ now: () => t })
    const results = []
    for (let i = 0; i < 20; i++) results.push(store.put(newCode(), hex(), live(), {}, { source: '2001:db8:0:100::/64' }).reason || 'ok')
    assert.equal(results.filter((r) => r === 'ok').length, 12)
    assert.equal(results.filter((r) => r === 'rate').length, 8)
    // the other /64s of the same /56 share 36
    let ok = 0
    for (let net = 1; net <= 4; net++) for (let i = 0; i < 12; i++) if (store.put(newCode(), hex(), live(), {}, { source: `2001:db8:0:1${net.toString(16).padStart(2, '0')}::/64` }).ok) ok++
    assert.equal(ok, 36 - 12)
    assert.equal(store.stats().refused.rate, 8 + (48 - 24))
    // an hour later the budget is back
    t += 61 * 60 * 1000
    assert.equal(store.put(newCode(), hex(), live(), {}, { source: '2001:db8:0:100::/64' }).ok, true)
    // updates of courts it made do not count
    const code = newCode()
    const token = hex()
    store.put(code, token, live(), {}, { source: '198.51.100.9' })
    for (let i = 0; i < 300; i++) assert.equal(store.put(code, token, live({ points_a: i }), {}, { source: '198.51.100.9' }).ok, true)
  })

  it('new courts: 120 per address and hour', () => {
    const store = createGlobalLive({ maxCourtsPerCode: 1000 })
    let ok = 0
    const code = newCode()
    for (let i = 0; i < 130; i++) if (store.put(code, hex(), live(), {}, { source: '203.0.113.5' }).ok) ok++
    assert.equal(ok, 120)
  })

  it('the /56 of a /64 bucket; an IPv4 address is its own', () => {
    assert.equal(netOfBucket('2001:db8:0:1a7::/64'), '2001:db8:0:100::/56')
    assert.equal(netOfBucket('203.0.113.5'), '203.0.113.5')
  })
})

describe('a full store', () => {
  it('1000 anonymous codes from many addresses: a real scorer\'s new code over the relay still gets a place', () => {
    let t = 1_000_000
    const store = createGlobalLive({ now: () => t })
    let filled = 0
    for (let a = 0; a < 100 && filled < 1000; a++) {
      for (let i = 0; i < 12 && filled < 1000; i++) {
        t += 1
        if (store.put(newCode(), hex(), live({ team_a_name: 'SPOOF' }), {}, { source: `2001:db8:${a.toString(16)}::/64`, listed: true }).ok) filled++
      }
    }
    assert.equal(store.size(), 1000)
    // an unproved newcomer finds nothing it may replace: refused, counted
    assert.equal(store.put(newCode(), hex(), live(), {}, { source: '198.51.100.20' }).reason, 'full')
    assert.equal(store.stats().refused.full, 1)
    // the scorer of a real tournament over the relay
    const real = newCode()
    assert.equal(store.put(real, null, live({ team_a_name: 'Real' }), {}, { room: 'match_real_1', source: '198.51.100.30' }).ok, true)
    assert.equal(store.get(real).courts[0].home.name, 'Real')
    // the public list: the spoofed events filled its places; once the real
    // event is listed, the relay's code takes a place first
    assert.notEqual(store.list({ maxEvents: 50 }).events.some((e) => e.code === real), true)
    t += 1
    store.put(real, null, live({ team_a_name: 'Real' }), {}, { room: 'match_real_1', listed: true })
    t += 1
    for (let i = 0; i < 5; i++) store.put(newCode(), hex(), live({ team_a_name: 'SPOOF' }), {}, { source: '198.51.100.40', listed: true })
    const events = store.list({ maxEvents: 50 }).events
    assert.equal(events.length, 50)
    assert.ok(events.some((e) => e.code === real), 'the real event is listed')
  })

  it('a code whose courts all ended or went stale gives way to a new one, also from an HTTP push', () => {
    let t = 1_000_000
    const store = createGlobalLive({ maxCodes: 2, now: () => t })
    store.put('AAAA2345', hex(), live({ match_status: 'final' }), {})
    store.put('BBBB2345', hex(), live(), {})
    t += 1000
    assert.equal(store.put('CCCC2345', hex(), live(), {}).ok, true)
    assert.equal(store.get('AAAA2345'), null)
    assert.ok(store.get('BBBB2345'))
  })

  it('an unproved court posted only once goes after 15 minutes; a court being scored stays', () => {
    let t = 1_000_000
    const store = createGlobalLive({ now: () => t })
    const once = newCode()
    const scored = newCode()
    const token = hex()
    store.put(once, hex(), live(), {})
    store.put(scored, token, live(), {})
    for (let i = 0; i < 10; i++) { t += 60_000; store.put(scored, token, live({ points_a: i }), {}) }
    t += 6 * 60_000
    assert.equal(store.get(once), null)
    assert.ok(store.get(scored))
    // a relay court posted once stays (its scorer holds the room)
    const relayCode = newCode()
    store.put(relayCode, null, live(), {}, { room: 'match_warmup' })
    t += 60 * 60_000
    assert.ok(store.get(relayCode))
  })
})
