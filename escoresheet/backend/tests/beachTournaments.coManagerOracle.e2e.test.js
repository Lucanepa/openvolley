/**
 * PERM-18 (audit round 3), through server.js: adding a co-manager to a beach
 * tournament tells nothing about the address. Before, the answer was the
 * same, but only the address of a beach competition manager was added and
 * listed at once, so a throwaway tournament found out which addresses held
 * such an account (poc/beach/low-findings.sh, part c). Now every address
 * gets the same answer, the same audit entry and the same row in the
 * invitations list; the invited beach competition manager accepts (or
 * declines) and is listed as a co-manager only then.
 *
 * Needs PG_TEST_URL (a throwaway Postgres, see tests/helpers/pgTestDb.js).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'
import { MAX_OPEN_INVITES } from '../lib/beachTournaments.js'

describe('beach co-managers: no account oracle (PERM-18)', { skip: SKIP }, () => {
  let db, srv, sql, storageRoot, statusDir
  let ipSeq = 1
  const nextIp = () => `198.51.100.${ipSeq++}`
  const users = {}

  async function account (name, roles) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const password = 'correct-horse-battery'
    const ip = nextIp()
    const up = await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password, metadata: { first_name: name, last_name: 'Test' } } })
    assert.equal(up.status, 200, up.text)
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, email }
    if (roles) await grantRoles(sql, u.id, roles)
    users[name] = u
    return u
  }
  const call = (user, method, path, body) => api(srv.base, path, { method, token: user?.token, body, proto: null })
  const get = (user, path) => call(user, 'GET', path)
  const okData = (r, status = 200) => {
    assert.equal(r.status, status, r.text)
    return r.json.data
  }
  const expectCode = (r, status, code) => {
    assert.equal(r.status, status, r.text)
    if (code) assert.equal(r.json?.error?.code, code, r.text)
  }

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-oracle-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-oracle-status-'))
    writeFileSync(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    srv = await bootServer({
      DATABASE_URL: db.url,
      STORAGE_ROOT: storageRoot,
      STATUS_DIR: statusDir,
      TRUST_PROXY: 'cloudflare',
      TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
      STORAGE_BACKUP_MIN_FREE_MB: '1',
      STORAGE_SCORESHEETS_MIN_FREE_MB: '1'
    })
    await account('admin', ['admin'])
    await account('prober', ['beach:competition_manager']) // makes a throwaway tournament to probe addresses
    await account('target', ['beach:competition_manager']) // the account the prober looks for
    await account('scorer', ['beach:scorer'])
    await account('indoor', ['scorer'])
    await account('pending', null)
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  it('every address gets the same answer, audit entry and invitations row; nobody is listed before accepting', async () => {
    const t = okData(await call(users.prober, 'POST', '/api/beach/tournaments', { title: 'Oracle probe', starts_on: '2026-12-05', ends_on: '2026-12-05' }), 201).tournament
    const probed = [users.target.email, users.admin.email, users.scorer.email, users.indoor.email, users.pending.email, 'nobody@nowhere.example']
    const answers = []
    for (const email of probed) answers.push(await call(users.prober, 'POST', `/api/beach/tournaments/${t.id}/managers`, { email }))
    for (const r of answers) {
      assert.equal(r.status, 200, r.text)
      assert.equal(r.text, answers[0].text, 'the same bytes for every address')
    }
    const b = okData(await get(users.prober, `/api/beach/tournaments/${t.id}`))
    assert.deepEqual(b.managers.map((m) => m.email), [users.prober.email], 'nobody added')
    assert.deepEqual(b.invited.map((i) => i.email).sort(), probed.map((e) => e.toLowerCase()).sort())
    const shapes = new Set(b.invited.map((i) => Object.keys(i).sort().join()))
    assert.deepEqual([...shapes], ['email,id,invited_at'])
    for (const u of Object.values(users)) assert.equal(JSON.stringify(b.invited).includes(u.id), false, 'no account id')
    // the audit log tells nothing either
    const audit = okData(await get(users.admin, '/api/admin/audit?app=beach&action=tournament.managers&limit=50')).entries
      .filter((e) => e.details?.tournament_id === t.id)
    assert.equal(audit.length, probed.length)
    for (const e of audit) assert.deepEqual(e.details, { tournament_id: t.id, op: 'invite' })
  })

  it('the invited beach competition manager sees, accepts or declines its own invitation only', async () => {
    const t = okData(await call(users.prober, 'POST', '/api/beach/tournaments', { title: 'Team Cup', starts_on: '2026-12-06', ends_on: '2026-12-06' }), 201).tournament
    for (const email of [users.target.email, users.scorer.email]) okData(await call(users.prober, 'POST', `/api/beach/tournaments/${t.id}/managers`, { email }))
    const mine = okData(await get(users.target, '/api/beach/invites')).invites.filter((i) => i.tournament.id === t.id)
    assert.equal(mine.length, 1)
    assert.deepEqual(mine[0].tournament, { id: t.id, slug: t.slug, title: 'Team Cup', starts_on: '2026-12-06', ends_on: '2026-12-06', status: 'draft' })
    assert.equal(mine[0].invited_by, 'prober Test')
    // a beach scorer with an invitation to its address is no co-manager; another account cannot use it
    assert.deepEqual(okData(await get(users.scorer, '/api/beach/invites')).invites, [])
    expectCode(await call(users.scorer, 'POST', `/api/beach/invites/${mine[0].id}/accept`, {}), 404, 'OV_NOT_FOUND')
    expectCode(await call(users.admin, 'POST', `/api/beach/invites/${mine[0].id}/accept`, {}), 404, 'OV_NOT_FOUND')
    expectCode(await get(users.target, `/api/beach/tournaments/${t.id}`), 404, 'OV_NOT_FOUND')
    // declined: gone, nothing else
    okData(await call(users.target, 'POST', `/api/beach/invites/${mine[0].id}/decline`, {}))
    expectCode(await call(users.target, 'POST', `/api/beach/invites/${mine[0].id}/accept`, {}), 404, 'OV_NOT_FOUND')
    assert.deepEqual(okData(await get(users.prober, `/api/beach/tournaments/${t.id}`)).invited.map((i) => i.email), [users.scorer.email])
    // invited again and accepted: a co-manager, listed, who edits
    okData(await call(users.prober, 'POST', `/api/beach/tournaments/${t.id}/managers`, { email: users.target.email }))
    const [again] = okData(await get(users.target, '/api/beach/invites')).invites.filter((i) => i.tournament.id === t.id)
    okData(await call(users.target, 'POST', `/api/beach/invites/${again.id}/accept`, {}))
    const b = okData(await get(users.target, `/api/beach/tournaments/${t.id}`))
    assert.equal(b.tournament.can_edit, true)
    assert.deepEqual(b.managers.map((m) => [m.email, m.creator]), [[users.prober.email, true], [users.target.email, false]])
    // removed again as before
    okData(await call(users.prober, 'DELETE', `/api/beach/tournaments/${t.id}/managers/${users.target.id}`))
    expectCode(await get(users.target, `/api/beach/tournaments/${t.id}`), 404)
  })

  it(`at most ${MAX_OPEN_INVITES} open invitations a tournament, the same refusal for every address`, async () => {
    // another organiser (co-manager additions are limited a minute per account)
    const organiser = await account('organiser', ['beach:competition_manager'])
    const t = okData(await call(organiser, 'POST', '/api/beach/tournaments', { title: 'Full Cup', starts_on: '2026-12-07', ends_on: '2026-12-07' }), 201).tournament
    await sql.query(
      `INSERT INTO public.beach_tournament_invites (tournament_id, email, invited_by)
       SELECT $1, 'filler' || g || '@example.invalid', $2 FROM generate_series(1, $3) g`, [t.id, organiser.id, MAX_OPEN_INVITES])
    const a = await call(organiser, 'POST', `/api/beach/tournaments/${t.id}/managers`, { email: users.target.email })
    const b = await call(organiser, 'POST', `/api/beach/tournaments/${t.id}/managers`, { email: 'nobody@nowhere.example' })
    expectCode(a, 409, 'OV_TOO_MANY_INVITES')
    assert.equal(a.text, b.text)
    // expired ones make room
    await sql.query("UPDATE public.beach_tournament_invites SET invited_at = now() - interval '31 days' WHERE tournament_id = $1 AND email LIKE 'filler1%'", [t.id])
    okData(await call(organiser, 'POST', `/api/beach/tournaments/${t.id}/managers`, { email: users.target.email }))
  })
})
