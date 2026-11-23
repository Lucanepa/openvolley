/**
 * The public livescore list and the codes it gives away (lib/globalLive.js),
 * audit round 3 PERM-21 and SEC-07 (part E), owner decision 8 (23.11.2026):
 * "a listed court's code shows only listed courts. Unlisted courts need
 * their own code." GET /api/global/live gives each listed event's code to
 * anyone; GET /api/global/live/<code> showed every court of that code, also
 * the U13 Easy and OpenBeach courts that never opted in.
 *
 *   cd escoresheet/backend && node --test tests/globalLive.listed.test.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createGlobalLive, LIVE_CODE_ALPHABET } from '../lib/globalLive.js'

const CODE = 'AVDTPRVC'
const live = (over = {}) => ({ team_a_name: 'Global A', team_b_name: 'Global B', points_a: 3, points_b: 1, match_status: 'live', ...over })
const entry = (hall, names = {}) => ({ match: { hall }, homeTeam: { name: names.home ?? null }, awayTeam: { name: names.away ?? null }, sets: [] })
const hex = () => randomBytes(16).toString('hex')

describe('a code with a listed court (owner decision 8)', () => {
  it('shows its listed courts only; an unlisted court is seen under its own code', () => {
    const store = createGlobalLive()
    store.put(CODE, null, live(), entry('Halle A', { home: 'Global A', away: 'Global B' }), { room: 'match_global_1', listed: true })
    store.put(CODE, null, live({ team_a_name: 'U13 Easy Muster' }), entry('Turnhalle X', { home: 'U13 Easy Muster', away: 'U13 Easy Beispiel' }), { room: 'match_easy_2', listed: false })
    store.put(CODE, hex(), live({ team_a_name: 'Muster/Beispiel' }), entry('Court 3', { home: 'Muster/Beispiel', away: 'Test/Probe' }), { listed: false })

    const listed = store.list().events.find((e) => e.code === CODE)
    assert.deepEqual(listed.courts.map((c) => c.home.name), ['Global A'])
    const page = store.get(CODE)
    assert.deepEqual(page.courts.map((c) => c.home.name), ['Global A'])
    const text = JSON.stringify(page)
    for (const hidden of ['U13 Easy Muster', 'Turnhalle X', 'Muster/Beispiel']) assert.equal(text.includes(hidden), false, hidden)
    // and one court of the code by its number: only a listed one too
    assert.deepEqual(store.get(CODE, { screen: 3 }).courts, [])

    // under a code of its own (no listed court), the Easy court is shown as before
    store.put('PRVT2345', null, live({ team_a_name: 'U13 Easy Muster' }), entry('Turnhalle X', { home: 'U13 Easy Muster' }), { room: 'match_easy_2' })
    assert.deepEqual(store.get('PRVT2345').courts.map((c) => c.home.name), ['U13 Easy Muster'])
  })

  it('once no court of the code is listed any more, the code shows all its courts again', () => {
    const store = createGlobalLive()
    store.put(CODE, null, live(), entry('Halle A', { home: 'Global A' }), { room: 'match_global_1', listed: true })
    store.put(CODE, null, live({ team_a_name: 'Easy' }), entry('Halle B', { home: 'Easy' }), { room: 'match_easy_2' })
    assert.equal(store.get(CODE).courts.length, 1)
    store.put(CODE, null, live(), entry('Halle A', { home: 'Global A' }), { room: 'match_global_1', listed: false })
    assert.equal(store.get(CODE).courts.length, 2)
    assert.equal(store.list().events.some((e) => e.code === CODE), false)
  })
})

describe('invented listed events (SEC-07 E)', () => {
  it('pushes from strangers cannot crowd the relay\'s events off the 50 places of the list', () => {
    let t = 1_000_000
    const store = createGlobalLive({ now: () => t })
    const realCodes = []
    for (let i = 0; i < 3; i++) {
      const code = Array.from(randomBytes(8)).map((b) => LIVE_CODE_ALPHABET[b % 32]).join('')
      realCodes.push(code)
      store.put(code, null, live({ team_a_name: `Real ${i}` }), {}, { room: `match_real_${i}`, listed: true })
    }
    for (let a = 0; a < 10; a++) {
      for (let i = 0; i < 12; i++) {
        t += 1
        const code = Array.from(randomBytes(8)).map((b) => LIVE_CODE_ALPHABET[b % 32]).join('')
        store.put(code, hex(), live({ team_a_name: 'SPOOF FC' }), {}, { source: `2001:db8:${a.toString(16)}::/64`, listed: true })
      }
    }
    const events = store.list().events
    assert.equal(events.length, 50)
    for (const code of realCodes) assert.ok(events.some((e) => e.code === code), code)
  })
})
