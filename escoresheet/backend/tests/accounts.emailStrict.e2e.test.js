/**
 * SEC-35 (audit 2611): every stored or mailed address is ONE plain address
 * (lib/emailAddress.js EMAIL_RE). nodemailer reads a recipient as an RFC 5322
 * list, so 'x<inner@outside.example>' or 'a@b.ch,c@d.ch' would be delivered
 * to another inbox than the one the account, the duplicate check and the
 * per-inbox limits see. Sign-up and sign-in had the strict check already;
 * these did not:
 *   - the admin's address change (PATCH /api/admin/accounts/:id { email })
 *   - an invite's invited_email (POST /api/admin/invites, a club manager link)
 *   - server.js isValidEmail (the account's own address for send-info /
 *     send-pin): an address stored before the strict check is no address
 * Each answers 400 (or mails nothing) now. Made-up addresses only; the
 * Resend API is helpers/fakeResend.mjs.
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

const FAKE_RESEND = new URL('./helpers/fakeResend.mjs', import.meta.url).href
const LOOSE = ['x<inner-target@outside.example>', 'a@b.ch,c@outside.example', 'a@b.ch;x@outside.example', '"a b"@b.ch', 'a@b.ch (x)']

describe('one plain address everywhere (SEC-35)', { skip: SKIP }, () => {
  let db, srv, sql, dir, mailLog, club
  let ipSeq = 1
  const nextIp = () => `198.51.100.${ipSeq++}`
  const run = randomBytes(3).toString('hex')
  const users = {}
  const mails = () => (existsSync(mailLog) ? readFileSync(mailLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  const call = (user, method, path, body) => api(srv.base, path, { method, token: user?.token, body, proto: null, headers: { 'cf-connecting-ip': nextIp() } })

  const PASSWORD = 'correct-horse-battery'
  async function signIn (email) {
    let inn
    for (let i = 0; i < 10; i++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': nextIp() }, body: { email, password: PASSWORD } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    assert.equal(inn.status, 200, inn.text)
    return inn.json.data
  }

  async function account (name, roles = []) {
    const email = `${name}-${run}@example.ch`
    const up = await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': nextIp() }, body: { email, password: PASSWORD, metadata: { first_name: name } } })
    assert.equal(up.status, 200, up.text)
    const inn = await signIn(email)
    const u = { id: inn.user.id, token: inn.session.access_token, email }
    if (roles.length) await grantRoles(sql, u.id, roles)
    users[name] = u
    return u
  }

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    dir = mkdtempSync(join(tmpdir(), 'ov-email-strict-'))
    writeFileSync(join(dir, '.ovdata'), '')
    writeFileSync(join(dir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    mailLog = join(dir, 'resend.jsonl')
    srv = await bootServer({
      DATABASE_URL: db.appUrl(),
      STORAGE_ROOT: dir,
      STATUS_DIR: dir,
      TRUST_PROXY: 'cloudflare',
      TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
      STORAGE_BACKUP_MIN_FREE_MB: '1',
      STORAGE_SCORESHEETS_MIN_FREE_MB: '1',
      RESEND_API_KEY: 'example-resend-key',
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${FAKE_RESEND}`].filter(Boolean).join(' '),
      OV_TEST_RESEND_LOG: mailLog
    })
    await account('admin', ['admin'])
    await account('target', ['scorer'])
    club = (await call(users.admin, 'POST', '/api/admin/clubs', { name: `VBC Strikt ${run}`, teams: [] })).json.data.club
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('the admin\'s address change takes one plain address only', async () => {
    for (const email of LOOSE) {
      const r = await call(users.admin, 'PATCH', `/api/admin/accounts/${users.target.id}`, { email })
      assert.equal(r.status, 400, `${email}: ${r.text}`)
      assert.equal(r.json.error.code, 'OV_INVALID_REQUEST')
    }
    const { rows: [u] } = await sql.query('SELECT email FROM auth.users WHERE id = $1', [users.target.id])
    assert.equal(u.email, users.target.email, 'nothing stored')
    // a plain address still works (case and spaces aside)
    const fine = `  Target.New+tag-${run}@Example.CH `
    const ok = await call(users.admin, 'PATCH', `/api/admin/accounts/${users.target.id}`, { email: fine })
    assert.equal(ok.status, 200, ok.text)
    const { rows: [after] } = await sql.query('SELECT email FROM auth.users WHERE id = $1', [users.target.id])
    assert.equal(after.email, fine.trim().toLowerCase())
    await sql.query('UPDATE auth.users SET email = $2 WHERE id = $1', [users.target.id, users.target.email])
  })

  it('an invite\'s invited_email takes one plain address only', async () => {
    for (const email of LOOSE) {
      const r = await call(users.admin, 'POST', '/api/admin/invites', { label: 'Club manager', role: 'club_manager', club_id: club.id, invited_email: email, max_uses: 1 })
      assert.equal(r.status, 400, `${email}: ${r.text}`)
    }
    const ok = await call(users.admin, 'POST', '/api/admin/invites', { label: 'Club manager', role: 'club_manager', club_id: club.id, invited_email: `cm-${run}@example.ch`, max_uses: 1 })
    assert.equal(ok.status, 201, ok.text)
  })

  it('an address stored before the strict check gets no mail (send-info)', async () => {
    // the address change above ended the target's sessions
    users.target.token = (await signIn(users.target.email)).session.access_token
    const ext = `match_${Date.now()}_${run}`
    const ins = await api(srv.base, '/api/db', {
      token: users.target.token,
      body: { table: 'matches', action: 'insert', params: { data: { external_id: ext, test: true, status: 'setup', game_n: 1, home_team: { name: 'Alpha' }, away_team: { name: 'Beta' } } } }
    })
    assert.equal(ins.status, 200, ins.text)
    const send = () => api(srv.base, '/api/match/send-info', { token: users.target.token, proto: null, body: { externalId: ext }, headers: { 'cf-connecting-ip': nextIp() } })
    const good = await send()
    assert.equal(good.status, 200, good.text)
    assert.deepEqual(mails().at(-1).to, [users.target.email])
    const before = mails().length
    // as the old loose check let an admin store it
    await sql.query('UPDATE auth.users SET email = $2 WHERE id = $1', [users.target.id, `x<inner-target-${run}@outside.example>`])
    const bad = await send()
    assert.equal(bad.status, 409, bad.text)
    assert.equal(bad.json.code, 'OV_EMAIL_UNCONFIRMED')
    assert.equal(mails().length, before, 'nothing mailed')
    assert.equal(JSON.stringify(mails()).includes('outside.example'), false)
    await sql.query('UPDATE auth.users SET email = $2 WHERE id = $1', [users.target.id, users.target.email])
  })
})
