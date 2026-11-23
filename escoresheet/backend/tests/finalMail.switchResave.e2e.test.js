/**
 * SEC-12 (audit 26.11): saving the final-mail switch again, even with the same
 * value, or turning it off and on, must not drop a close that is already on
 * its way: one waiting for its PDF, a round the budget deferred, a mail sent
 * without the PDF whose PDF follows, nor the reopen notice of a mailed close.
 * Only a close the sweep has not started must be after the switch was turned
 * on (never the backlog).
 *
 * The sweep on a real database with a fake mailer and storage (as
 * finalMail.e2e.test.js). Needs PG_TEST_URL (see tests/helpers/pgTestDb.js).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP_PG, createTestDatabase, grantRoles, quietLogger } from './helpers/pgTestDb.js'
import { createFinalMail, PDF_GRACE_MS } from '../lib/finalMail.js'

const PDF = Buffer.from('%PDF-1.4\n% final scoresheet\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n')

describe('final mail: the switch saved again keeps the closes on their way (SEC-12)', { skip: SKIP_PG }, () => {
  let db, sql, pool, fm
  let clock = Date.now()
  const minutes = (n) => n * 60 * 1000
  const ts = (ms) => new Date(ms).toISOString()
  const mails = []
  const pdfs = new Map()
  let refuse = null
  const mailer = {
    enabled: true,
    async send (kind, { to, lang, vars, attachments } = {}) {
      if (refuse?.(kind, to, vars) === 'budget') return { sent: false, skipped: 'budget' }
      mails.push({ kind, to, lang, vars, attachments: attachments || [] })
      return { sent: true }
    }
  }
  const scoresheets = { async latestPdf (m) { return pdfs.get(m.id) ?? null } }
  const of = (game, kind = 'scoresheet') => mails.filter((m) => m.kind === kind && m.vars?.game === String(game))
  const people = {}
  let actor

  async function person (name, roles) {
    const email = `${name}@example.ch`
    const { rows: [u] } = await sql.query('INSERT INTO auth.users (email, email_confirmed_at) VALUES ($1, now()) RETURNING id', [email])
    if (roles) await grantRoles(sql, u.id, roles)
    people[name] = { id: u.id, email }
    return people[name]
  }
  async function replica (fn) {
    await sql.query('SET session_replication_role = replica')
    try { return await fn() } finally { await sql.query('SET session_replication_role = origin') }
  }
  async function closed ({ gameN, closedMinAgo = 5 }) {
    return replica(async () => {
      const { rows: [m] } = await sql.query(
        `INSERT INTO public.matches (external_id, status, game_n, scheduled_at, home_team, away_team, officials, created_by, closed_by, closed_at)
         VALUES ($1, 'final', $2, $3, '{"name":"Alpha H1"}', '{"name":"Beta H1"}', '[]', $4, $4, $5::timestamptz + interval '123 microseconds') RETURNING id`,
        [`match_${randomBytes(6).toString('hex')}`, gameN, ts(clock - minutes(90)), people.scorer.id, ts(clock - minutes(closedMinAgo))])
      return m.id
    })
  }
  const storePdf = (matchId) => pdfs.set(matchId, { data: PDF, filename: 'Scoresheet.pdf', mtimeMs: clock })
  const stateOf = async (id) => (await sql.query('SELECT outcome FROM public.match_final_mails WHERE match_id = $1', [id])).rows[0]?.outcome ?? null
  const changedAt = async () => (await sql.query('SELECT changed_at FROM public.app_settings')).rows[0].changed_at?.toISOString() ?? null
  const save = (value) => fm.setSettings({ actorId: actor.id, body: { send_final_email: value } })

  before(async () => {
    db = await createTestDatabase('mail_switch_resave')
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    pool = new pg.Pool({ connectionString: db.url, max: 4 })
    // setSettings stamps changed_at with the database's now(): the test clock follows it
    clock = Date.parse((await sql.query('SELECT now() AS t')).rows[0].t.toISOString())
    fm = createFinalMail({ pool, mailer, scoresheets, audit: async () => {}, logger: quietLogger(), now: () => clock })
    await person('scorer', ['scorer'])
    actor = await person('admin', ['admin'])
  })
  after(async () => {
    await pool?.end().catch(() => {})
    await sql?.end().catch(() => {})
    await db?.drop()
  })

  it('saving the switch again with the same value does not move changed_at; off -> on does', async () => {
    assert.equal((await save(true)).status, 200)
    const on = await changedAt()
    assert.ok(on, 'turned on: stamped')
    assert.equal((await save(true)).status, 200)
    assert.equal(await changedAt(), on, 'the same value again: when it was turned on stays')
    // as if it had been on for a day (the closes below are after it)
    await sql.query('UPDATE public.app_settings SET changed_at = $1', [ts(clock - minutes(24 * 60))])
  })

  it('a close waiting for its PDF is still mailed after the switch is saved again (true, true)', async () => {
    const id = await closed({ gameN: 960001, closedMinAgo: 5 })
    await fm.sweep()
    assert.equal(await stateOf(id), 'pending', 'waits for its PDF')
    const before = await changedAt()
    assert.equal((await save(true)).status, 200, 'a stale tab saves the switch again')
    assert.equal(await changedAt(), before)
    storePdf(id)
    clock += minutes(2)
    await fm.sweep()
    assert.equal(of(960001).length, 1, 'mailed to the scorer once the PDF is there')
    assert.equal(await stateOf(id), 'sent')
  })

  it('off and on again: the closes on their way are finished, a close made while it was off is not mailed', async () => {
    const waiting = await closed({ gameN: 960002, closedMinAgo: 3 })
    const deferred = await closed({ gameN: 960003, closedMinAgo: 3 })
    storePdf(deferred)
    refuse = (kind, to, vars) => (vars?.game === '960003' ? 'budget' : null)
    await fm.sweep()
    refuse = null
    assert.equal(await stateOf(waiting), 'pending')
    assert.equal(await stateOf(deferred), 'deferred')
    clock += minutes(1)
    assert.equal((await save(false)).status, 200)
    const whileOff = await closed({ gameN: 960004, closedMinAgo: 1 })
    storePdf(whileOff)
    clock += minutes(1)
    assert.equal((await save(true)).status, 200)
    // the database's now() stamped it: the test clock is a few minutes ahead of it, so stamp it at the test clock
    await sql.query('UPDATE public.app_settings SET changed_at = $1', [ts(clock)])
    storePdf(waiting)
    clock += minutes(6)
    await fm.sweep()
    assert.equal(of(960002).length, 1, 'the close that waited for its PDF')
    assert.equal(of(960003).length, 1, 'the deferred round')
    assert.equal(of(960004).length, 0, 'closed while the switch was off: never (no backlog)')
    assert.equal(await stateOf(whileOff), null)
  })

  it('a mail sent without its PDF: the PDF still follows after the switch is saved again', async () => {
    const id = await closed({ gameN: 960005, closedMinAgo: 3 })
    await fm.sweep()
    clock += PDF_GRACE_MS + minutes(1)
    await fm.sweep()
    assert.equal(await stateOf(id), 'sent_no_pdf')
    assert.equal(of(960005).length, 1)
    assert.equal(of(960005)[0].attachments.length, 0)
    assert.equal((await save(true)).status, 200)
    storePdf(id)
    clock += minutes(11)
    await fm.sweep()
    assert.equal(of(960005).length, 2, 'the PDF on its own')
    assert.equal(of(960005)[1].attachments.length, 1)
    assert.equal(await stateOf(id), 'sent')
  })

  it('a mailed close reopened while the switch was off: its officials are still told once it is on again', async () => {
    const ref = await person('ref', ['referee'])
    const id = await closed({ gameN: 960006, closedMinAgo: 3 })
    await replica(() => sql.query(
      `INSERT INTO public.match_approvals (match_id, slot, user_id, display_name, approved_at, match_status, result_key, result_hash)
       VALUES ($1, 'referee1', $2, 'Official', $3, 'ended', '3:0', $4)`, [id, ref.id, ts(clock - minutes(30)), createHash('sha256').update('3:0').digest()]))
    storePdf(id)
    await fm.sweep()
    assert.ok(of(960006).some((m) => m.to === ref.email), 'mailed to the referee')
    clock += minutes(1)
    assert.equal((await save(false)).status, 200)
    await replica(async () => {
      await sql.query("UPDATE public.matches SET closed_at = NULL, closed_by = NULL, status = 'ended' WHERE id = $1", [id])
      await sql.query("UPDATE public.match_approvals SET revoked_at = $2, revoked_reason = 'match_reopened' WHERE match_id = $1 AND revoked_at IS NULL", [id, ts(clock)])
      await sql.query(`INSERT INTO public.audit_log (action, match_id, details, at) VALUES ('match.reopen', $1, '{"reason":"wrong final score"}', $2)`, [id, ts(clock)])
    })
    clock += minutes(1)
    assert.equal((await save(true)).status, 200)
    await sql.query('UPDATE public.app_settings SET changed_at = $1', [ts(clock)])
    await fm.sweep()
    assert.equal(of(960006, 'scoresheet_reopened').length, 1, 'the referee hears of the reopen')
  })
})
