// SEC-64: the cloud's page at backend.openvolley.app/ printed http:// role
// links and QR codes for /referee, /bench, ... which are 404 there (the cloud
// image serves no app pages). On the cloud each role now points to its own
// https site; a venue relay keeps http://<its address>/<role>.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import QRCode from 'qrcode'
import { renderLandingPage, roleUrl, INDOOR_ROLES, BEACH_ROLES } from '../lib/landingPage.js'
import { bootServer } from './helpers/e2eServer.js'

const qr = (url) => QRCode.toString(url, { type: 'svg', width: 200, margin: 1 })
const ROLES = [...INDOOR_ROLES, ...BEACH_ROLES]

describe('landing page roles (lib/landingPage.js)', () => {
  it('every role has an https site of its own for the cloud', () => {
    for (const r of ROLES) {
      const u = new URL(r.cloudUrl)
      assert.equal(u.protocol, 'https:', r.key)
      assert.match(u.hostname, /^[a-z-]+\.openvolley\.app$/, r.key)
      assert.equal(roleUrl(r, { cloud: true, baseUrl: 'https://backend.openvolley.app' }), r.cloudUrl)
      assert.equal(roleUrl(r, { cloud: false, baseUrl: 'http://192.168.1.20:8080' }), `http://192.168.1.20:8080${r.path}`)
    }
    assert.equal(INDOOR_ROLES.find((r) => r.key === 'bench_away').cloudUrl, 'https://bench.openvolley.app/?team=away')
  })

  it('the cloud page names no Wi-Fi step; a venue page does', () => {
    const page = (cloud) => renderLandingPage({ baseUrl: 'x', cloud, clientCount: null, matchCount: null, indoor: [], beach: [], matches: [] })
    assert.match(page(false), /same Wi-Fi network/)
    assert.doesNotMatch(page(true), /same Wi-Fi network/)
  })
})

describe('landing page: what server.js serves', () => {
  let cloud
  let venue
  before(async () => {
    cloud = await bootServer({ IS_CLOUD: '1' }, ['--local'])
    venue = await bootServer({}, ['--local'])
  })
  after(async () => {
    await cloud?.stop()
    await venue?.stop()
  })

  it('the cloud: https links and QR codes of the role sites, no http://<host>', async () => {
    const html = await (await fetch(`${cloud.base}/`)).text()
    const host = new URL(cloud.base).host
    assert.ok(!html.includes(`http://${host}`), 'no http:// link to the cloud itself')
    assert.match(html, new RegExp(`https://${host.replace(/\./g, '\\.')}`))
    for (const r of ROLES) {
      assert.ok(html.includes(`href="${r.cloudUrl.replace(/&/g, '&amp;')}"`), r.key)
      assert.ok(html.includes(await qr(r.cloudUrl)), `${r.key}: its QR code holds ${r.cloudUrl}`)
      assert.ok(!html.includes(`${host}${r.path}`), r.key)
    }
  })

  it('a venue relay: http://<host>/<role>, as before', async () => {
    const html = await (await fetch(`${venue.base}/`)).text()
    for (const r of ROLES) {
      const url = `${venue.base}${r.path}`
      assert.ok(html.includes(await qr(url)), r.key)
      assert.ok(!html.includes(r.cloudUrl), r.key)
    }
  })
})
