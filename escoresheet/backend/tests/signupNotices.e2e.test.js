/**
 * "A new account signed up" (db/028, lib/signupNotices.js): once the address
 * is confirmed, the admins and the approvers of the account's requests get a
 * mail (to a local SMTP sink) and a notice in the manager
 * (GET /api/notifications, POST /api/notifications/read).
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep, waitUntil } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'
import { startFakeSmtp, linkToken } from './helpers/fakeSmtp.js'
import { recipientsOf } from '../lib/signupNotices.js'

const PW = 'correct-horse-battery'

describe('sign-up notices: recipients (pure)', () => {
  const U = 'u0000000-0000-4000-8000-000000000000'
  const parts = [
    { kind: 'scorer', club_id: 'c1', club: 'VBC A' },
    { kind: 'team_manager', club_id: 'c1', club: 'VBC A', team_id: 't1', team: 'VBC A H1' },
    { kind: 'referee', club_id: null, club: null }
  ]
  it('admins get every part, club managers their club (no referee), team managers their team', () => {
    const r = recipientsOf({
      userId: U,
      parts,
      admins: [{ user_id: 'a', email: 'a@x.ch' }],
      clubManagers: [{ user_id: 'cm', email: 'cm@x.ch', club_id: 'c1' }, { user_id: 'other', email: 'o@x.ch', club_id: 'c9' }],
      teamManagers: [{ user_id: 'tm', email: 'tm@x.ch', team_id: 't1' }]
    })
    assert.deepEqual(r.map((x) => [x.userId, x.target, x.parts.map((p) => p.kind)]), [
      ['a', `accounts/${U}`, ['scorer', 'referee', 'team_manager']],
      ['cm', 'myclub/c1', ['scorer', 'team_manager']],
      ['tm', 'myteams/t1', ['team_manager']]
    ])
  })
  it('one notice per person (the admin one first), never the account itself', () => {
    const r = recipientsOf({
      userId: U,
      parts,
      admins: [{ user_id: 'a', email: 'a@x.ch' }, { user_id: U, email: 'self@x.ch' }],
      clubManagers: [{ user_id: 'a', email: 'a@x.ch', club_id: 'c1' }],
      teamManagers: [{ user_id: U, email: 'self@x.ch', team_id: 't1' }]
    })
    assert.deepEqual(r.map((x) => [x.userId, x.admin]), [['a', true]])
  })
  it('without parts: admins only', () => {
    const r = recipientsOf({ userId: U, parts: [], admins: [{ user_id: 'a', email: 'a@x.ch' }], clubManagers: [{ user_id: 'cm', email: 'cm@x.ch', club_id: 'c1' }] })
    assert.deepEqual(r.map((x) => x.userId), ['a'])
  })
})

describe('sign-up notices end to end', { skip: SKIP }, () => {
  let db, srv, sql, smtp, storageRoot, statusDir
  let ipSeq = 1
  const users = {}
  let must, mustH1

  const ip = () => `198.51.100.${ipSeq++}`
  const call = (user, method, path, body) => api(srv.base, path, { method, token: user?.token, body, proto: method === 'GET' ? null : '2' })
  const mailsTo = (email) => smtp.mails.filter((m) => m.envelope.to.includes(email))
  async function signIn (email, from) {
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': from }, body: { email, password: PW } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    return inn
  }
  /** A new account; `confirm`: open its confirmation link (else confirmed by SQL, as a setup account). */
  async function account (name, { roles = null, requests, app, lang, confirm = false } = {}) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const from = ip()
    const up = await api(srv.base, '/api/auth/sign-up', {
      headers: { 'cf-connecting-ip': from },
      body: { email, password: PW, metadata: { first_name: name, last_name: 'Beispiel' }, ...(lang ? { lang } : {}), ...(app ? { app } : {}), ...(requests ? { requests } : {}) }
    })
    assert.equal(up.status, 200, up.text)
    const id = up.json.data.user.id
    const mail = await smtp.waitForMail((m) => m.envelope.to.includes(email) && linkToken(m)?.page === 'confirm')
    if (confirm) {
      const c = await api(srv.base, '/api/auth/confirm-email', { proto: null, headers: { 'cf-connecting-ip': ip() }, body: { token: linkToken(mail).token } })
      assert.equal(c.status, 200, c.text)
    } else {
      await sql.query('UPDATE auth.users SET email_confirmed_at = now() WHERE id = $1', [id])
    }
    const inn = await signIn(email, from)
    assert.equal(inn.status, 200, inn.text)
    const u = { id, token: inn.json.data.session.access_token, email, link: linkToken(mail) }
    if (roles) await grantRoles(sql, u.id, roles)
    users[name] = u
    return u
  }

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-notice-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-notice-status-'))
    writeFileSync(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    smtp = await startFakeSmtp({ implicitTls: false })
    srv = await bootServer({
      DATABASE_URL: db.url,
      STORAGE_ROOT: storageRoot,
      STATUS_DIR: statusDir,
      STORAGE_BACKUP_MIN_FREE_MB: '1',
      STORAGE_SCORESHEETS_MIN_FREE_MB: '1',
      TRUST_PROXY: 'cloudflare',
      TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
      ...smtp.env()
    })
    const admin = await account('admin', { roles: ['admin'], lang: 'de' })
    await account('clubmgr')
    await account('coach')
    await account('othermgr')
    await account('scorer', { roles: ['scorer'] })
    // a deactivated admin (db/027) is told nothing
    await account('goneadmin', { roles: ['admin'] })
    await sql.query("UPDATE auth.users SET banned_until = '9999-12-31' WHERE id = $1", [users.goneadmin.id])
    must = (await call(admin, 'POST', '/api/admin/clubs', { name: 'VBC Musterdorf', teams: ['VBC Musterdorf H1', 'VBC Musterdorf D2'] })).json.data.club
    const other = (await call(admin, 'POST', '/api/admin/clubs', { name: 'VBC Anderswo', teams: ['VBC Anderswo H1'] })).json.data.club
    await sql.query('INSERT INTO public.club_managers (club_id, user_id) VALUES ($1, $2)', [must.id, users.clubmgr.id])
    await sql.query('INSERT INTO public.club_managers (club_id, user_id) VALUES ($1, $2)', [other.id, users.othermgr.id])
    mustH1 = (await call(admin, 'GET', `/api/club/${must.id}/teams`)).json.data.teams.find((t) => t.name === 'VBC Musterdorf H1')
    await sql.query('INSERT INTO public.team_managers (team_id, user_id) VALUES ($1, $2)', [mustH1.id, users.coach.id])
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await smtp?.close()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  it('nothing before the address is confirmed; after: the admin, the club manager and the team manager, by mail and in the manager', async () => {
    const before = smtp.mails.length
    const email = `newbie-${randomBytes(3).toString('hex')}@example.ch`
    const up = await api(srv.base, '/api/auth/sign-up', {
      headers: { 'cf-connecting-ip': ip() },
      body: { email, password: PW, metadata: { first_name: 'Nora', last_name: 'Neu' }, requests: [{ kind: 'scorer', club_id: must.id }, { kind: 'team_manager', team_id: mustH1.id }, { kind: 'referee' }] }
    })
    assert.equal(up.status, 200, up.text)
    const newbie = up.json.data.user.id
    const confirmMail = await smtp.waitForMail((m) => m.envelope.to.includes(email))
    await sleep(300)
    // only the confirmation went out, and nobody has a notice
    assert.equal(smtp.mails.length, before + 1)
    assert.equal((await call(users.admin, 'GET', '/api/notifications?app=indoor')).json.data.unread, 0)

    const c = await api(srv.base, '/api/auth/confirm-email', { proto: null, headers: { 'cf-connecting-ip': ip() }, body: { token: linkToken(confirmMail).token } })
    assert.equal(c.status, 200, c.text)

    // the admin: German (its sign-up language), every part, its account page
    const adminMail = await smtp.waitForMail((m) => m.envelope.to.includes(users.admin.email) && /Registrierung/.test(m.subject))
    assert.equal(adminMail.subject, 'Neue OpenVolley-Registrierung: Nora Neu')
    assert.match(adminMail.text, new RegExp(`Nora Neu \\(${email.replace('.', '\\.')}\\)`))
    assert.match(adminMail.text, /Schreiber · VBC Musterdorf/)
    assert.match(adminMail.text, /Schiedsrichter/)
    assert.match(adminMail.text, /Teamverantwortliche\/r \/ Trainer · VBC Musterdorf H1 \(VBC Musterdorf\)/)
    assert.ok(adminMail.text.includes(`/#accounts/${newbie}`), adminMail.text)

    // the club manager: its club's parts (no referee), My club
    const cmMail = await smtp.waitForMail((m) => m.envelope.to.includes(users.clubmgr.email) && /New OpenVolley sign-up/.test(m.subject))
    assert.match(cmMail.text, /Scorer · VBC Musterdorf/)
    assert.match(cmMail.text, /Team manager \/ coach · VBC Musterdorf H1/)
    assert.doesNotMatch(cmMail.text, /Referee/)
    assert.ok(cmMail.text.includes(`/#myclub/${must.id}`))
    // the team manager: the team manager part only, My teams
    const tmMail = await smtp.waitForMail((m) => m.envelope.to.includes(users.coach.email) && /New OpenVolley sign-up/.test(m.subject))
    assert.doesNotMatch(tmMail.text, /Scorer ·/)
    assert.ok(tmMail.text.includes(`/#myteams/${mustH1.id}`))
    // nobody else: not another club's manager, not a scorer, not the newbie
    await sleep(300)
    for (const u of [users.othermgr, users.scorer, users.goneadmin]) assert.equal(mailsTo(u.email).filter((m) => /sign-up|Registrierung/i.test(m.subject)).length, 0)
    assert.equal(mailsTo(email).length, 1)

    // the manager's bell
    const list = (await call(users.admin, 'GET', '/api/notifications?app=indoor')).json.data
    assert.equal(list.unread, 1)
    const [n] = list.notifications
    assert.equal(n.kind, 'signup')
    assert.equal(n.read, false)
    assert.equal(n.open, true)
    assert.equal(n.target, `accounts/${newbie}`)
    assert.deepEqual(n.user, { id: newbie, email, name: 'Nora Neu' })
    assert.deepEqual(n.parts.map((p) => p.kind), ['scorer', 'referee', 'team_manager'])
    // not in the OpenBeach manager, and every account sees only its own
    assert.equal((await call(users.admin, 'GET', '/api/notifications?app=beach')).json.data.notifications.length, 0)
    assert.equal((await call(users.othermgr, 'GET', '/api/notifications')).json.data.notifications.length, 0)
    assert.equal((await call(users.coach, 'GET', '/api/notifications')).json.data.notifications[0].target, `myteams/${mustH1.id}`)

    // a second confirmation tells nobody again
    const again = await api(srv.base, '/api/auth/confirm-email', { proto: null, headers: { 'cf-connecting-ip': ip() }, body: { token: linkToken(confirmMail).token } })
    assert.equal(again.json.data.already_confirmed, true)
    await sleep(300)
    assert.equal(mailsTo(users.admin.email).filter((m) => /Registrierung/.test(m.subject)).length, 1)

    // read: someone else's id changes nothing; its own does
    const foreign = await call(users.othermgr, 'POST', '/api/notifications/read', { ids: [n.id] })
    assert.equal(foreign.status, 200)
    assert.equal((await call(users.admin, 'GET', '/api/notifications')).json.data.unread, 1)
    assert.equal((await call(users.admin, 'POST', '/api/notifications/read', { ids: [n.id] })).json.data.unread, 0)
    assert.equal((await call(users.admin, 'GET', '/api/notifications')).json.data.notifications[0].read, true)
    assert.equal((await call(users.coach, 'POST', '/api/notifications/read', { all: true })).json.data.unread, 0)
    assert.equal((await call(users.admin, 'POST', '/api/notifications/read', {})).status, 400)
    assert.equal((await call(users.admin, 'POST', '/api/notifications/read', { ids: ['nope'] })).status, 400)

    // approved: no longer open; the account deleted: the notice goes with it
    const parts = (await call(users.admin, 'GET', `/api/club/${must.id}/requests`)).json.data.requests.find((r) => r.user.id === newbie).parts
    const adminParts = parts.map((p) => p.id)
    const ref = (await sql.query("SELECT id FROM public.account_requests WHERE user_id = $1 AND kind = 'referee'", [newbie])).rows[0].id
    assert.equal((await call(users.admin, 'POST', `/api/admin/accounts/${newbie}/requests`, { approve: [...adminParts, ref] })).status, 200)
    assert.equal((await call(users.admin, 'GET', '/api/notifications')).json.data.notifications[0].open, false)
    await sql.query('DELETE FROM auth.users WHERE id = $1', [newbie])
    assert.equal((await call(users.admin, 'GET', '/api/notifications')).json.data.notifications.length, 0)
  })

  it('a sign-up without requests: the admins only; an OpenBeach one in the OpenBeach manager', async () => {
    const plain = await account('plain', { confirm: true })
    await waitUntil(async () => (await call(users.admin, 'GET', '/api/notifications?app=indoor')).json.data.notifications.some((n) => n.user?.id === plain.id), { what: 'plain notice' })
    const mail = await smtp.waitForMail((m) => m.envelope.to.includes(users.admin.email) && m.subject.includes('plain'))
    assert.match(mail.text, /fragt noch nach keiner Rolle/)
    assert.equal((await call(users.clubmgr, 'GET', '/api/notifications')).json.data.notifications.some((n) => n.user?.id === plain.id), false)

    const beach = await account('beachy', { confirm: true, app: 'beach' })
    await waitUntil(async () => (await call(users.admin, 'GET', '/api/notifications?app=beach')).json.data.notifications.some((n) => n.user?.id === beach.id), { what: 'beach notice' })
    const bm = await smtp.waitForMail((m) => m.envelope.to.includes(users.admin.email) && m.subject.includes('beachy'))
    assert.match(bm.text, /OpenBeach-Konto/)
    assert.equal(bm.subject, 'Neue OpenBeach-Registrierung: beachy Beispiel')
    assert.ok(bm.text.includes(`/#accounts/${beach.id}`))
    assert.equal((await call(users.admin, 'GET', '/api/notifications?app=indoor')).json.data.notifications.some((n) => n.user?.id === beach.id), false)
  })

  it('needs a session', async () => {
    assert.equal((await api(srv.base, '/api/notifications', { method: 'GET', proto: null })).status, 401)
  })
})
