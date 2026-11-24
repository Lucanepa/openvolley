/**
 * Cross-site GETs from a hall's browser no longer spend the budgets the hall's
 * apps need (audit 2026-11-23 SEC-42). Any page may make its visitors fire
 * simple GETs (an <img> of an API address): 121 of them blocked the hall's
 * Global cloud saves (one 'global-cloud' counter for reads and writes), and
 * 11 blocked "Load official match" (one 'ical' counter for the feeds and the
 * leagues list). Now writes and reads count apart, the anonymous reads per
 * address and kind of page (lib/globalQuota.js pageKindOf), the leagues list
 * on its own, and a feed request only when it fetches.
 *
 * server.js --local (the routes' limits come before the database check);
 * tests/helpers/noEgress.mjs keeps the iCal feed requests on this machine.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { bootServer } from './helpers/e2eServer.js'
import { pageKindOf } from '../lib/globalQuota.js'

const NO_EGRESS = fileURLToPath(new URL('./helpers/noEgress.mjs', import.meta.url))
const APP = 'https://app.openvolley.app'
// what a browser sends for an <img> or a no-cors fetch of another site's address
const crossSite = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' }

describe('pageKindOf', () => {
  it('app for a trusted Origin, other for a foreign one or a cross-site fetch, plain without a browser signal', () => {
    const trusted = (o) => o === APP
    assert.equal(pageKindOf({ origin: APP }, trusted), 'app')
    assert.equal(pageKindOf({ origin: 'https://evil.example' }, trusted), 'other')
    assert.equal(pageKindOf({ 'sec-fetch-site': 'cross-site' }, trusted), 'other')
    assert.equal(pageKindOf({ 'sec-fetch-site': 'same-site' }, trusted), 'plain')
    assert.equal(pageKindOf({}, trusted), 'plain')
  })
})

describe('anonymous GET budgets per kind of page (server.js --local)', () => {
  let srv
  before(async () => {
    srv = await bootServer({
      TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${NO_EGRESS}`].filter(Boolean).join(' ')
    }, ['--local'])
  })
  after(async () => { await srv?.stop() })
  const get = (path, ip, headers = {}) => fetch(`${srv.base}${path}`, { headers: { 'cf-connecting-ip': ip, ...headers } }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))
  const statuses = async (n, fn) => {
    const out = []
    for (let i = 0; i < n; i++) out.push((await fn(i)).status)
    return out
  }

  it('125 cross-site GETs of share links do not block the hall\'s Global cloud save or load', async () => {
    const hall = '203.0.113.90'
    const reads = await statuses(125, (i) => get(`/api/global/shared/zzzz${i}`, hall, crossSite))
    assert.ok(reads.every((s) => s !== 429), 'under the read budget')
    for (const action of ['load', 'save']) {
      const r = await fetch(`${srv.base}/api/global/cloud/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: APP, 'cf-connecting-ip': hall }, body: JSON.stringify({ key: 'k'.repeat(22), pin: '1234', bundle: {} }) })
      assert.notEqual(r.status, 429, `${action}: the writes have a budget of their own`)
      assert.equal((await r.json()).error.code, 'OV_NO_CLOUD') // --local: no database, past the limit
    }
  })

  it('a foreign page that spends its whole read budget leaves the app\'s own reads alone', async () => {
    const hall = '203.0.113.91'
    const reads = await statuses(605, (i) => get(`/api/global/organizer/ABCDEFGH${(i % 10)}K`, hall, crossSite))
    assert.equal(reads.filter((s) => s === 429).length, 5, 'the foreign kind still has its limit (600 a minute)')
    const mine = await get(`/api/global/shared/${'a'.repeat(22)}`, hall, { Origin: 'https://livescore.openvolley.app' })
    assert.notEqual(mine.status, 429)
  })

  it('11 cross-site GETs of the iCal routes do not block "Load official match" from the app', async () => {
    const hall = '203.0.113.92'
    // the leagues list: its own budget, not the feeds'
    const leagues = await statuses(11, () => get('/api/official-matches/leagues', hall, crossSite))
    assert.deepEqual([...new Set(leagues)], [200])
    // a feed (not cached: the fetch is refused here, 503): the foreign kind's 10
    const feeds = await statuses(11, () => get('/api/official-matches?federation=SV&league=1LD', hall, crossSite))
    assert.deepEqual(feeds, [...Array(10).fill(503), 429])
    const app = await get('/api/official-matches/leagues', hall, { Origin: APP })
    assert.equal(app.status, 200)
    assert.ok(app.json.leagues.length > 0)
    const load = await get('/api/official-matches?federation=SV&league=1LD', hall, { Origin: APP })
    assert.notEqual(load.status, 429, 'the app\'s own budget')
    // an invalid request is answered without counting or fetching
    assert.equal((await get('/api/official-matches?federation=XX', hall, { Origin: APP })).status, 400)
  })
})
