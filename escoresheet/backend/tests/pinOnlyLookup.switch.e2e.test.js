/**
 * SEC06-RESIDUAL-PIN-ONLY (audit 2611 review): the referee and bench PIN
 * checks that name no match test one guess against every open match of a
 * sport, and owner decision 1 (lock the guessers only) gives a guesser one
 * share per address range. OV_PIN_ONLY_LOOKUP ends them once the old builds
 * are gone: `on` (default) as before, `beach` OpenBeach only, `off` none.
 *
 *   1. the parser: default on, case and spaces ignored, a typo throws
 *   2. a backend with OV_PIN_ONLY_LOOKUP=beach: an indoor check without its
 *      match answers 409 match-required on both endpoints before any PIN is
 *      compared (the right PIN too); the indoor check that names its match
 *      passes from the same address, and so does OpenBeach's lookup without one
 *   3. the same with OV_PIN_ONLY_LOOKUP=off: OpenBeach's lookup is refused too
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'
import { pinOnlyLookupFromEnv } from '../lib/matchAccess.js'

describe('OV_PIN_ONLY_LOOKUP: the parser', () => {
  it('defaults to on, ignores case and spaces, throws on anything else', () => {
    assert.equal(pinOnlyLookupFromEnv({}).mode, 'on')
    assert.equal(pinOnlyLookupFromEnv({ OV_PIN_ONLY_LOOKUP: '' }).mode, 'on')
    assert.equal(pinOnlyLookupFromEnv({ OV_PIN_ONLY_LOOKUP: ' Beach ' }).mode, 'beach')
    assert.equal(pinOnlyLookupFromEnv({ OV_PIN_ONLY_LOOKUP: 'OFF' }).mode, 'off')
    assert.throws(() => pinOnlyLookupFromEnv({ OV_PIN_ONLY_LOOKUP: 'of' }), /OV_PIN_ONLY_LOOKUP must be on, beach or off/)
    const on = pinOnlyLookupFromEnv({})
    const beach = pinOnlyLookupFromEnv({ OV_PIN_ONLY_LOOKUP: 'beach' })
    const off = pinOnlyLookupFromEnv({ OV_PIN_ONLY_LOOKUP: 'off' })
    assert.deepEqual([on.allows('indoor'), on.allows('beach')], [true, true])
    assert.deepEqual([beach.allows('indoor'), beach.allows('beach')], [false, true])
    assert.deepEqual([off.allows('indoor'), off.allows('beach')], [false, false])
  })
})

const tag = randomBytes(3).toString('hex')
const BEACH = { ext: `pol_b_${tag}`, n: 7, gamePin: '157159', pins: { referee: '569232', bench_team1: '670343', bench_team2: '781454' } }
const INDOOR = { ext: `pol_i_${tag}`, n: 9802, gamePin: '247803', pins: { referee: '865814', bench_home: '976925', bench_away: '187036' } }

for (const mode of ['beach', 'off']) {
  describe(`OV_PIN_ONLY_LOOKUP=${mode}: lookups without a match`, { skip: SKIP }, () => {
    let db
    let srv
    let sql
    let storageRoot
    let statusDir
    const as = (ip, origin) => ({ 'cf-connecting-ip': ip, origin })
    const check = (ip, body) => api(srv.base, '/api/match/validate-connection-pin', { proto: null, headers: as(ip, body.sport === 'beach' ? 'https://beach-referee.openvolley.app' : 'https://referee.openvolley.app'), body })
    const relay = (ip, body) => api(srv.base, '/api/match/validate-pin', { proto: null, headers: as(ip, 'https://referee.openvolley.app'), body })

    before(async () => {
      db = await provisionDatabase()
      sql = new pg.Client({ connectionString: db.url })
      await sql.connect()
      storageRoot = mkdtempSync(join(tmpdir(), 'ov-pol-storage-'))
      writeFileSync(join(storageRoot, '.ovdata'), '')
      statusDir = mkdtempSync(join(tmpdir(), 'ov-pol-status-'))
      writeFileSync(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
      srv = await bootServer({
        DATABASE_URL: db.appUrl(),
        STORAGE_ROOT: storageRoot,
        STATUS_DIR: statusDir,
        TRUST_PROXY: 'cloudflare',
        TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
        STORAGE_BACKUP_MIN_FREE_MB: '1',
        STORAGE_SCORESHEETS_MIN_FREE_MB: '1',
        OV_PIN_SECRET: randomBytes(32).toString('base64url'),
        ERROR_ALERTS: 'off',
        OV_PIN_ONLY_LOOKUP: mode
      })
      const email = `pol-${mode}-${tag}@example.ch`
      const password = 'correct-horse-battery'
      const headers = { 'cf-connecting-ip': '192.0.2.201' }
      assert.equal((await api(srv.base, '/api/auth/sign-up', { headers, body: { email, password, metadata: { first_name: 'Scorer' } } })).status, 200)
      const inn = await api(srv.base, '/api/auth/sign-in', { headers, body: { email, password } })
      assert.equal(inn.status, 200, inn.text)
      await grantRoles(sql, inn.json.data.user.id, ['scorer', 'beach:scorer'])
      const token = inn.json.data.session.access_token
      for (const [m, beach] of [[BEACH, true], [INDOOR, false]]) {
        const up = await api(srv.base, '/api/db', {
          token,
          headers,
          body: {
            table: 'matches',
            action: 'upsert',
            params: {
              data: {
                external_id: m.ext,
                game_n: m.n,
                game_pin: m.gamePin,
                connection_pins: m.pins,
                connections: beach
                  ? { referee_enabled: true, team1_bench_enabled: true, team2_bench_enabled: true }
                  : { referee_enabled: true, home_bench_enabled: true, away_bench_enabled: true },
                status: 'live',
                sport_type: beach ? 'beach' : 'indoor',
                ...(beach ? { team1_data: { name: 'Pair One' }, team2_data: { name: 'Pair Two' } } : { home_team: { name: 'Home VC' }, away_team: { name: 'Away VC' } }),
                scheduled_at: new Date().toISOString()
              },
              onConflict: 'external_id',
              returning: 'id',
              single: true
            }
          }
        })
        assert.equal(up.status, 200, up.text)
      }
    })

    after(async () => {
      await sql?.end().catch(() => {})
      await srv?.stop()
      await db?.drop()
      if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
      if (statusDir) rmSync(statusDir, { recursive: true, force: true })
    })

    it('an indoor check without its match is refused with 409 match-required on both endpoints, nothing compared', async () => {
      const ip = '203.0.113.71'
      // the right PIN, PIN-only: refused all the same (nothing is compared)
      const right = await check(ip, { pin: INDOOR.pins.referee, type: 'referee' })
      assert.equal(right.status, 409, right.text)
      assert.equal(right.json.code, 'match-required')
      assert.equal(right.json.token, undefined)
      for (const type of ['referee', 'homeTeam', 'awayTeam']) {
        const r = await relay(ip, { pin: INDOOR.pins.referee, type })
        assert.equal(r.status, 409, r.text)
        assert.equal(r.json.code, 'match-required')
      }
      // more PIN-only guesses from the address: refused the same, no wrong-PIN answer
      for (let i = 0; i < 10; i++) assert.equal((await check(ip, { pin: String(300000 + i), type: 'bench_home' })).status, 409)
      // the check that names its match passes, from the same address
      const named = await check(ip, { pin: INDOOR.pins.bench_home, type: 'bench_home', matchExternalId: INDOOR.ext })
      assert.equal(named.status, 200, named.text)
      assert.equal(named.json.match.id, INDOOR.ext)
      assert.ok(named.json.token)
      // a relay check that names its match or its game is no lookup without a match
      assert.equal((await relay(ip, { pin: INDOOR.pins.referee, type: 'referee', matchId: INDOOR.ext })).status, 404)
      assert.equal((await relay(ip, { pin: INDOOR.pins.referee, type: 'referee', gameNumber: String(INDOOR.n) })).status, 404)
      assert.match(srv.output.join(''), /\[PIN\] lookup without a match: indoor:referee on validate-connection-pin: refused/)
    })

    it(mode === 'beach' ? 'OpenBeach\'s lookup without a match still passes' : 'OpenBeach\'s lookup without a match is refused too', async () => {
      const ip = '203.0.113.72'
      const r = await check(ip, { pin: BEACH.pins.referee, type: 'referee', sport: 'beach' })
      if (mode === 'beach') {
        assert.equal(r.status, 200, r.text)
        assert.equal(r.json.match.id, BEACH.ext)
        // the relay holds no room for it here: a plain miss, not a refusal
        assert.equal((await relay(ip, { pin: BEACH.pins.referee, type: 'referee', sport: 'beach' })).status, 404)
      } else {
        assert.equal(r.status, 409, r.text)
        assert.equal(r.json.code, 'match-required')
        const rr = await relay(ip, { pin: BEACH.pins.referee, type: 'referee', sport: 'beach' })
        assert.equal(rr.status, 409, rr.text)
        // the beach check that names its match passes
        const named = await check(ip, { pin: BEACH.pins.referee, type: 'referee', sport: 'beach', matchExternalId: BEACH.ext })
        assert.equal(named.status, 200, named.text)
      }
    })
  })
}
