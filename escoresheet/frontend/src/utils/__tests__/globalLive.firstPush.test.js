// The live screen's court token (utils/globalLive.js), audit round 3:
//   SEC-07  the token was SHA-256 of the seed key, a league or OpenBeach
//           match's public id: anyone could compute it and take over the court
//           on every TV. Now it comes from a random liveSecret of the match,
//           made once on the device (a Global match: its globalKey; since
//           the 2611 review, SR-3, a match with a game PIN: an HMAC of its
//           seed key keyed with the PIN), never from the seed key alone; no
//           secret, no token.
//   LOG-11  the first live push after a page load went without the token (it
//           was still being worked out), and the relay made a second, frozen
//           court of it. liveScreenFieldsFor works it out before the push.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import Dexie from 'dexie'
import { courtTokenFor, ensureLiveSecret, isLiveSecret, liveScreenFieldsFor, newLiveSecret, setLiveCode, setLiveCourt, setLiveListed } from '../globalLive.js'

const sha = async (text) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32)

let n = 0
async function freshDb() {
  const database = new Dexie(`ov-live-first-push-${++n}`)
  database.version(1).stores({ matches: '++id' })
  await database.open()
  return database
}

beforeEach(() => {
  localStorage.clear()
  setLiveCode(null)
  setLiveCourt(null)
})

describe('the court token never comes from the seed key (SEC-07)', () => {
  it('a match with only its public seed key has no token', async () => {
    expect(await courtTokenFor({ seed_key: 'match_1_public', seedKey: 'match_1_public' })).toBe(null)
  })

  it('the liveSecret gives the token; a Global match without one keeps its globalKey\'s', async () => {
    const liveSecret = newLiveSecret()
    expect(isLiveSecret(liveSecret)).toBe(true)
    expect(await courtTokenFor({ seed_key: 'match_1_public', liveSecret })).toBe(await sha(`court\0${liveSecret}`))
    expect(await courtTokenFor({ seed_key: 'match_1_public', liveSecret })).not.toBe(await sha('court\0match_1_public'))
    const globalKey = 'g'.repeat(22)
    expect(await courtTokenFor({ seed_key: 'match_2', globalKey })).toBe(await sha(`court\0${globalKey}`))
  })

  it('ensureLiveSecret makes one secret per match and stores it, also for two pushes at once', async () => {
    const database = await freshDb()
    const id = await database.matches.add({ seed_key: 'match_3_public' })
    const match = await database.matches.get(id)
    const [a, b] = await Promise.all([ensureLiveSecret(database, id, match), ensureLiveSecret(database, id, match)])
    expect(isLiveSecret(a.liveSecret)).toBe(true)
    expect(b.liveSecret).toBe(a.liveSecret)
    expect((await database.matches.get(id)).liveSecret).toBe(a.liveSecret)
    // the next push reads it from the row: the same secret again
    expect((await ensureLiveSecret(database, id, await database.matches.get(id))).liveSecret).toBe(a.liveSecret)
    // a Global match keeps its globalKey (no second secret)
    const gid = await database.matches.add({ seed_key: 'm4', global: true, globalKey: 'k'.repeat(22) })
    expect((await ensureLiveSecret(database, gid, await database.matches.get(gid))).liveSecret).toBeUndefined()
    database.close()
  })
})

// 2611 review, SR-3: the random liveSecret was made on each device, never
// relayed and stripped from native backups, so a second tablet of the match
// (a handover, a restore) made its own token: a second, frozen court on every
// TV of the desktop relay and of an HTTP push, for up to 3 hours. A match with
// a game PIN takes its token from it now, which every scoring device knows.
const hmac = async (key, text) => {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32)
}
describe('every scoring device of a match pushes the same court token (SR-3)', () => {
  it('two devices with the same match and game PIN, each with a liveSecret of its own, push one token; never the seed key\'s', async () => {
    const tablet = { seed_key: 'match_7_public', gamePin: '482913', liveSecret: newLiveSecret() }
    const second = { seed_key: 'match_7_public', gamePin: 482913, liveSecret: newLiveSecret() }
    const token = await courtTokenFor(tablet)
    expect(token).toMatch(/^[0-9a-f]{32}$/)
    expect(await courtTokenFor(second)).toBe(token)
    expect(token).toBe(await hmac('482913', 'court\0match_7_public'))
    expect(token).not.toBe(await sha('court\0match_7_public'))
    expect(token).not.toBe(await sha(`court\0${tablet.liveSecret}`))
    // another match, or another PIN: another court
    expect(await courtTokenFor({ ...tablet, seed_key: 'match_8_public' })).not.toBe(token)
    expect(await courtTokenFor({ ...tablet, gamePin: '482914' })).not.toBe(token)
    // a Global match keeps its globalKey's token (its devices hold the backup code)
    expect(await courtTokenFor({ ...tablet, globalKey: 'g'.repeat(22) })).toBe(await sha(`court\0${'g'.repeat(22)}`))
  })

  it('a match with a game PIN needs no liveSecret: none is made or stored; one without keeps getting its own', async () => {
    const database = await freshDb()
    const id = await database.matches.add({ seed_key: 'match_9_public', gamePin: '135792' })
    setLiveCode('ABCD2345')
    const first = await liveScreenFieldsFor({ match: await database.matches.get(id), db: database, matchId: id })
    expect(first.fields.globalLiveCourt).toBe(await hmac('135792', 'court\0match_9_public'))
    expect((await database.matches.get(id)).liveSecret).toBeUndefined()
    // the same match restored on another device (another Dexie id, the same PIN): the same court
    const other = await freshDb()
    const oid = await other.matches.add({ seed_key: 'match_9_public', gamePin: '135792', restored: true })
    expect((await liveScreenFieldsFor({ match: await other.matches.get(oid), db: other, matchId: oid })).fields.globalLiveCourt).toBe(first.fields.globalLiveCourt)
    database.close()
    other.close()
  })
})

describe('the first push already carries the court token (LOG-11)', () => {
  it('liveScreenFieldsFor: the code, the token, the court number and the opt-in on the first call', async () => {
    const database = await freshDb()
    const id = await database.matches.add({ seed_key: 'match_5_public', global: true, globalKey: 'h'.repeat(22) })
    setLiveCode('ABCD2345')
    setLiveCourt(3)
    setLiveListed(true)
    const first = await liveScreenFieldsFor({ match: await database.matches.get(id), db: database, matchId: id })
    expect(first.fields).toEqual({ globalLive: 'ABCD2345', globalLiveCourt: await sha(`court\0${'h'.repeat(22)}`), globalLiveScreen: 3, globalLiveListed: true })
    const second = await liveScreenFieldsFor({ match: await database.matches.get(id), db: database, matchId: id })
    expect(second.fields).toEqual(first.fields)
    database.close()
  })

  it('a league match gets its liveSecret on the first push, and the same token on every push', async () => {
    const database = await freshDb()
    const id = await database.matches.add({ seed_key: 'match_6_public' })
    setLiveCode('ABCD2345')
    const first = await liveScreenFieldsFor({ match: await database.matches.get(id), db: database, matchId: id })
    expect(first.fields.globalLiveCourt).toMatch(/^[0-9a-f]{32}$/)
    expect(first.fields.globalLiveCourt).not.toBe(await sha('court\0match_6_public'))
    expect(first.fields).not.toHaveProperty('globalLiveListed') // not a Global match
    expect(first.match.liveSecret).toBe((await database.matches.get(id)).liveSecret)
    const second = await liveScreenFieldsFor({ match: await database.matches.get(id), db: database, matchId: id })
    expect(second.fields.globalLiveCourt).toBe(first.fields.globalLiveCourt)
    database.close()
  })

  it('without a code nothing goes along; without a secret the code goes without a token', async () => {
    expect((await liveScreenFieldsFor({ match: { seed_key: 'x' }, db: null, matchId: 1 })).fields).toEqual({})
    setLiveCode('ABCD2345')
    // no database to keep a secret in: no token rather than one from the seed key
    expect((await liveScreenFieldsFor({ match: { seed_key: 'x' }, db: null, matchId: 1 })).fields).toEqual({ globalLive: 'ABCD2345' })
  })
})
