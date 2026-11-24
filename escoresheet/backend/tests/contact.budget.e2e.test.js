/**
 * SEC-31 (audit 26.11): one client with a dozen addresses and a throwaway
 * account, or a few slow uploads, must not shut the support form for
 * everyone. The budget's reserved share is for trusted accounts (a confirmed
 * address and a role) only, a P1 message of anyone else has a share of its
 * own, each account and each network (IPv4 address, IPv6 /56) sends at most
 * CONTACT_PER_SOURCE_PER_HOUR an hour, at most 2 bodies are in flight per
 * address, 2 of the 10 slots are kept for trusted accounts, and the mail says
 * whether its Reply-To is verified.
 *
 * Unit cases on lib/contact.js, then server.js with a database and the local
 * fake SMTP sink (the PoCs contact-budget.mjs and contact-slots.mjs). Needs
 * PG_TEST_URL for the second part (see tests/helpers/pgTestDb.js).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import nodemailer from 'nodemailer'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'
import { startFakeSmtp } from './helpers/fakeSmtp.js'
import {
  createContactMailer, createContactSlots, handleContact, contactNetworkKey,
  CONTACT_MAILS_PER_HOUR, CONTACT_PUBLIC_SHARE, CONTACT_SIGNED_IN_SHARE, CONTACT_PER_SOURCE_PER_HOUR
} from '../lib/contact.js'

const silent = { log () {}, warn () {}, error () {} }
const json = (fields) => ({ body: Buffer.from(JSON.stringify(fields)), contentType: 'application/json' })
const FEEDBACK = { contactType: 'feedback', email: 'someone@outside.example', comments: 'spam' }
const P1 = { contactType: 'support', supportType: 'bug', severity: '1', email: 'real-user@outside.example', comments: 'the app crashed during the match' }

function streamMailer (opts = {}) {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' })
  const sent = []
  const mailer = createContactMailer({
    transport: { async sendMail (m) { const info = await transport.sendMail(m); sent.push({ mail: m, raw: info.message.toString('utf8') }); return info } },
    from: 'OpenVolley <noreply@example.test>', to: 'support@example.test', ...opts
  })
  return { mailer, sent }
}

describe('contact: budget shares, per-source caps, slots, Reply-To (unit)', () => {
  it('another sender\'s non-P1 messages use half the hour, its P1 ones two thirds, a trusted account the rest', async () => {
    const { mailer } = streamMailer()
    const send = async (fields, sender = {}) => (await handleContact({ ...json(fields), mailer, sender, logger: silent })).status
    const publicCap = Math.floor(CONTACT_MAILS_PER_HOUR * CONTACT_PUBLIC_SHARE)
    const p1Cap = Math.floor(CONTACT_MAILS_PER_HOUR * (1 - CONTACT_SIGNED_IN_SHARE))
    for (let i = 0; i < publicCap; i++) assert.equal(await send(FEEDBACK), 200)
    assert.equal(await send(FEEDBACK), 503, 'junk stops at half')
    // a throwaway account (signed in, nothing confirmed, no role) is no trusted one
    assert.equal(await send(FEEDBACK, { signedIn: true, confirmed: false, trusted: false, accountId: 'u-throwaway' }), 503)
    for (let i = publicCap; i < p1Cap; i++) assert.equal(await send(P1), 200, 'a P1 message still goes')
    assert.equal(await send(P1), 503)
    for (let i = p1Cap; i < CONTACT_MAILS_PER_HOUR; i++) assert.equal(await send(P1, { signedIn: true, confirmed: true, trusted: true, accountId: `u${i}` }), 200, 'a trusted account still goes')
    assert.equal(await send(P1, { signedIn: true, confirmed: true, trusted: true, accountId: 'u-last' }), 503, 'the whole budget')
  })

  it(`at most ${CONTACT_PER_SOURCE_PER_HOUR} an hour per account and per network (not per network for a trusted account): 429 rate_limited`, async () => {
    let t = 0
    const { mailer } = streamMailer({ now: () => t })
    const send = async (sender) => handleContact({ ...json(P1), mailer, sender, logger: silent })
    for (let i = 0; i < CONTACT_PER_SOURCE_PER_HOUR; i++) assert.equal((await send({ network: '2001:db8:1:100::/56' })).status, 200)
    const over = await send({ network: '2001:db8:1:100::/56' })
    assert.deepEqual([over.status, over.body.code], [429, 'rate_limited'])
    assert.equal((await send({ network: '2001:db8:1:200::/56' })).status, 200, 'another network')
    const trusted = { signedIn: true, confirmed: true, trusted: true, accountId: 'u-scorer', network: '2001:db8:1:100::/56' }
    for (let i = 0; i < CONTACT_PER_SOURCE_PER_HOUR; i++) assert.equal((await send(trusted)).status, 200, 'a trusted account is not held by its network')
    assert.equal((await send(trusted)).status, 429, 'but by its own hour')
    t += 60 * 60 * 1000
    assert.equal((await send(trusted)).status, 200, 'a new hour')
  })

  it('the mail says whether its Reply-To is verified: the signed-in account\'s own confirmed address only', async () => {
    const { mailer, sent } = streamMailer()
    await handleContact({ ...json({ ...P1, email: 'Scorer@Example.ch' }), mailer, sender: { signedIn: true, confirmed: true, trusted: true, accountId: 'u1', email: 'scorer@example.ch' }, logger: silent })
    await handleContact({ ...json({ ...P1, email: 'victim@example.org' }), mailer, sender: { signedIn: true, confirmed: true, trusted: true, accountId: 'u1', email: 'scorer@example.ch' }, logger: silent })
    await handleContact({ ...json({ ...P1, email: 'someone@example.org' }), mailer, sender: { signedIn: true, confirmed: false, accountId: 'u2', email: 'someone@example.org' }, logger: silent })
    await handleContact({ ...json(P1), mailer, logger: silent })
    assert.match(sent[0].mail.text, /^Reply-To: +verified \(the signed-in account's confirmed address\)$/m)
    assert.match(sent[0].raw, /^X-OpenVolley-Reply-To: verified$/im)
    for (const s of sent.slice(1)) {
      assert.match(s.mail.text, /^Reply-To: +not verified \(typed into the form\)$/m)
      assert.match(s.raw, /^X-OpenVolley-Reply-To: unverified$/im)
    }
    assert.match(sent[0].mail.text, /^Priority: +P1/, 'the priority stays the first line')
  })

  it('the network of an address: an IPv6 /56, an IPv4 address as is', () => {
    assert.equal(contactNetworkKey('2001:db8:1:2a7::/64'), '2001:db8:1:200::/56')
    assert.equal(contactNetworkKey('2001:db8:1:2ff::/64'), '2001:db8:1:200::/56')
    assert.equal(contactNetworkKey('203.0.113.5'), '203.0.113.5')
    assert.equal(contactNetworkKey(''), 'unknown')
  })

  it('slots: at most 2 per address; the last 2 kept for trusted accounts', async () => {
    const slots = createContactSlots(10)
    const pending = []
    const hold = (opts) => {
      let done
      const p = new Promise((r) => { done = r })
      const job = slots.run(() => p, opts)
      if (job) pending.push(done)
      return job
    }
    assert.ok(hold({ key: 'a', trusted: false }))
    assert.ok(hold({ key: 'a', trusted: false }))
    assert.equal(hold({ key: 'a', trusted: false }), null, 'a third from one address')
    for (const k of ['b', 'b', 'c', 'c', 'd', 'd']) assert.ok(hold({ key: k, trusted: false }))
    assert.equal(slots.inFlight, 8)
    assert.equal(hold({ key: 'e', trusted: false }), null, 'the last two are not for other senders')
    assert.ok(hold({ key: 'e', trusted: true }), 'a trusted account gets one')
    assert.ok(hold({ key: 'f', trusted: true }))
    assert.equal(hold({ key: 'g', trusted: true }), null, 'all ten taken')
    for (const done of pending) done()
    await sleep(10)
    assert.equal(slots.inFlight, 0)
  })
})

describe('POST /api/contact: a flood and slow uploads leave the form open (server.js, SEC-31)', { skip: SKIP }, () => {
  let db, sql, srv, smtp
  let ipSeq = 1
  const accounts = {}
  const supportMails = () => smtp.mails.filter((m) => m.envelope.to.includes('support@example.test'))
  const post = async (fields, { ip, token } = {}) => {
    const r = await fetch(`${srv.base}/api/contact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(fields)
    })
    return { status: r.status, json: await r.json().catch(() => null) }
  }
  async function account (name, { confirm, roles }) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const ip = `198.51.100.${ipSeq++}`
    await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password: 'correct-horse-battery', metadata: { first_name: name, last_name: 'Test' } } })
    if (confirm) await sql.query('UPDATE auth.users SET email_confirmed_at = now() WHERE lower(email) = lower($1)', [email])
    const inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password: 'correct-horse-battery' } })
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, email }
    if (roles) await grantRoles(sql, u.id, roles)
    accounts[name] = u
    return u
  }
  /** A body that never finishes (a slow upload): it holds a slot until destroyed. */
  function slowUpload (ip) {
    const s = net.connect(srv.port, '127.0.0.1')
    s.on('error', () => {})
    s.write(`POST /api/contact HTTP/1.1\r\nHost: x\r\ncf-connecting-ip: ${ip}\r\nContent-Type: application/json\r\nContent-Length: 10000000\r\n\r\n{"a":"`)
    return s
  }

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    smtp = await startFakeSmtp({ implicitTls: false })
    srv = await bootServer({
      DATABASE_URL: db.url, ...smtp.env(), CONTACT_EMAIL: 'support@example.test',
      TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128'
    })
    await account('scorer', { confirm: true, roles: ['scorer'] })
    await account('throwaway', { confirm: false })
    await account('noRole', { confirm: true })
  })
  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await smtp?.close?.()
    await db?.drop()
  })

  it('10 slow uploads from 4 addresses hold at most 2 slots each: a real user still gets through; with the 8 public slots full a trusted account still does', async () => {
    const socks = []
    for (let i = 0; i < 10; i++) socks.push(slowUpload(`203.0.113.${200 + Math.floor(i / 3)}`))
    await sleep(800)
    const r = await post(P1, { ip: '198.51.100.88' })
    assert.equal(r.status, 200, 'the real user\'s report is mailed, not 503 busy')
    // 4 more slow uploads from 2 new addresses: the 8 slots of other senders are full
    for (const ip of ['203.0.113.210', '203.0.113.210', '203.0.113.211', '203.0.113.211']) socks.push(slowUpload(ip))
    await sleep(800)
    assert.equal((await post(P1, { ip: '198.51.100.89' })).json?.code, 'busy', 'an anonymous sender: busy')
    const trusted = await post({ ...P1, email: accounts.scorer.email }, { ip: '198.51.100.90', token: accounts.scorer.token })
    assert.equal(trusted.status, 200, 'a trusted account gets a kept slot')
    for (const s of socks) s.destroy()
    await sleep(300)
    const mail = supportMails().find((m) => m.text.includes(accounts.scorer.email))
    assert.ok(mail, 'mailed to the support mailbox (the sink)')
    assert.match(mail.text, /Reply-To: +verified/)
  })

  it('36 junk messages from 12 addresses and a throwaway account: a P1 report and a trusted scorer still get through', async () => {
    const used = supportMails().length
    const out = {}
    for (let i = 0; i < 12; i++) {
      for (let k = 0; k < 3; k++) {
        const token = i >= 7 ? accounts.throwaway.token : (i === 6 ? accounts.noRole.token : null)
        const r = await post({ ...FEEDBACK, comments: `spam ${i}.${k}` }, { ip: `203.0.113.${100 + i}`, token })
        out[r.status] = (out[r.status] || 0) + 1
      }
    }
    const publicCap = Math.floor(CONTACT_MAILS_PER_HOUR * CONTACT_PUBLIC_SHARE)
    assert.equal(out[200], publicCap - used, 'the junk stops at the public share')
    assert.equal((out[200] || 0) + (out[503] || 0) + (out[429] || 0), 36)
    assert.equal((await post(P1, { ip: '198.51.100.77' })).status, 200, 'an anonymous P1 report: mailed')
    assert.equal((await post({ ...FEEDBACK, comments: 'a feature request' }, { ip: '198.51.100.78', token: accounts.scorer.token })).status, 200, 'a trusted scorer: mailed')
    assert.equal((await post({ ...FEEDBACK, comments: 'more spam' }, { ip: '198.51.100.79' })).json?.code, 'busy', 'more junk: busy')
    const junk = supportMails().find((m) => m.text.includes('spam 0.0'))
    assert.match(junk.text, /Reply-To: +not verified \(typed into the form\)/)
  })
})
