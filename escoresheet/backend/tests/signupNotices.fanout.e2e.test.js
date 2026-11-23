/**
 * SEC-34 (audit 26.11): one sign-up asking for parts of many clubs and teams
 * must not mail its self-chosen name to the managers of all of them, and a
 * few such sign-ups must not use up the hour's sign-up notices.
 *   - every recipient gets the notice in the bell; the admins get the mail;
 *     of the managers only those of the club of the sign-up's first part;
 *   - at most MANAGER_MAILS_PER_SIGNUP manager mails per sign-up,
 *     SIGNUPS_MAILED_PER_CLUB_DAY sign-ups mailed per club and day,
 *     MANAGER_MAILS_PER_HOUR manager mails an hour in all;
 *   - the name is letters, spaces, hyphens and apostrophes only, in the
 *     sign-up notice and a team manager proposal's proposer.
 *
 * lib/signupNotices.js on Postgres with the real mailer (lib/mailer.js) over
 * the local fake SMTP sink (the PoC signup-notice-fanout.mjs). Needs
 * PG_TEST_URL (see tests/helpers/pgTestDb.js).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP_PG, createTestDatabase, grantRoles, quietLogger } from './helpers/pgTestDb.js'
import { startFakeSmtp, SMTP_USER, SMTP_PASS } from './helpers/fakeSmtp.js'
import { createMailer } from '../lib/mailer.js'
import {
  createSignupNotices, firstClubOf, MANAGER_MAILS_PER_SIGNUP, SIGNUPS_MAILED_PER_CLUB_DAY, MANAGER_MAILS_PER_HOUR
} from '../lib/signupNotices.js'

describe('sign-up notices: the first part\'s club (pure)', () => {
  it('by kind, then club name; a referee has none', () => {
    assert.equal(firstClubOf([
      { kind: 'club_manager', club_id: 'a', club: 'Alpha' },
      { kind: 'team_manager', club_id: 'b', club: 'Beta', team_id: 't', team: 'Beta H1' },
      { kind: 'scorer', club_id: 'g', club: 'Gamma' },
      { kind: 'scorer', club_id: 'c', club: 'Delta' }
    ]), 'c')
    assert.equal(firstClubOf([{ kind: 'referee', club_id: null }]), null)
    assert.equal(firstClubOf([]), null)
  })
})

describe('sign-up notices: one club\'s managers mailed, the rest in the bell, capped (SEC-34)', { skip: SKIP_PG }, () => {
  let db, sql, pool, smtp, mailer, notices
  let clock = Date.now()
  const logger = quietLogger()
  const people = {}
  const clubs = {}
  const mailsTo = (email) => smtp.mails.filter((m) => m.envelope.to.includes(email))
  const signupMailsTo = (email, subject) => mailsTo(email).filter((m) => m.subject === 'New OpenVolley sign-up' && (!subject || m.text.includes(subject)))
  const bellOf = async (who, subjectId) => (await sql.query(
    "SELECT kind FROM public.notifications WHERE user_id = $1 AND subject_user_id = $2", [people[who].id, subjectId])).rows

  async function person (name, { roles, first = name, last = 'Test' } = {}) {
    const email = `${name.toLowerCase()}-${randomBytes(3).toString('hex')}@example.ch`
    const { rows: [u] } = await sql.query('INSERT INTO auth.users (email, email_confirmed_at) VALUES ($1, now()) RETURNING id', [email])
    await grantRoles(sql, u.id, roles || [])
    await sql.query('UPDATE public.profiles SET first_name = $2, last_name = $3 WHERE user_id = $1', [u.id, first, last])
    people[name] = { id: u.id, email }
    return people[name]
  }
  async function club (key, name, teams) {
    const { rows: [c] } = await sql.query('INSERT INTO public.clubs (name) VALUES ($1) RETURNING id', [name])
    clubs[key] = { id: c.id, teams: {} }
    for (const t of teams) {
      const { rows: [ct] } = await sql.query('INSERT INTO public.club_teams (club_id, team_name) VALUES ($1, $2) RETURNING id', [c.id, t])
      clubs[key].teams[t] = ct.id
    }
  }
  /** A confirmed sign-up asking for `requests` ([kind, clubKey, team?]). */
  async function signUp (name, requests, { first = name, last = 'Neu' } = {}) {
    const u = await person(name, { first, last })
    for (const [kind, key, team] of requests) {
      await sql.query('INSERT INTO public.account_requests (user_id, kind, club_id, team_id) VALUES ($1, $2, $3, $4)',
        [u.id, kind, key ? clubs[key].id : null, team ? clubs[key].teams[team] : null])
    }
    return notices.notify(u.id)
  }

  before(async () => {
    db = await createTestDatabase('mail_signup_fanout')
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    pool = new pg.Pool({ connectionString: db.url, max: 4 })
    smtp = await startFakeSmtp({ implicitTls: true })
    mailer = createMailer({
      host: 'localhost', port: smtp.port, secure: true, user: SMTP_USER, pass: SMTP_PASS, from: 'OpenVolley <noreply@example.test>',
      managerUrl: 'https://manager.example.test', tls: { ca: smtp.ca }, logger, budgets: { signup: 500 }
    })
    notices = createSignupNotices({ pool, mailer, logger, now: () => clock })
    await person('admin', { roles: ['admin'] })
    await person('superadmin', { roles: ['super_admin'] })
    await club('A', 'Alpha club', ['Alpha H1', 'Alpha D2'])
    await club('B', 'Beta club', ['Beta H1'])
    await club('C', 'Gamma club', ['Gamma H1'])
    for (const [who, key] of [['cmA', 'A'], ['cmB', 'B'], ['cmC', 'C']]) {
      await person(who, { roles: ['club_manager'] })
      await sql.query('INSERT INTO public.club_managers (club_id, user_id) VALUES ($1, $2)', [clubs[key].id, people[who].id])
    }
    for (const [who, key, team] of [['tmA', 'A', 'Alpha H1'], ['tmB', 'B', 'Beta H1']]) {
      await person(who, { roles: ['team_manager'] })
      await sql.query('INSERT INTO public.team_managers (team_id, user_id) VALUES ($1, $2)', [clubs[key].teams[team], people[who].id])
    }
  })
  after(async () => {
    mailer?.close()
    await smtp?.close?.()
    await pool?.end().catch(() => {})
    await sql?.end().catch(() => {})
    await db?.drop()
  })

  it('a sign-up for many clubs: the admins and the first part\'s club\'s managers by mail, the others in the bell only; the name without its lure', async () => {
    const r = await signUp('fanout', [
      ['scorer', 'A'], ['scorer', 'B'], ['scorer', 'C'], ['club_manager', 'A'], ['club_manager', 'B'],
      ['team_manager', 'A', 'Alpha H1'], ['team_manager', 'B', 'Beta H1']
    ], { first: 'Club office: new licence fees due', last: 'reply with IBAN at evil.example/pay' })
    assert.equal(r.recipients, 7, 'all seven have the notice')
    const subject = people.fanout.id
    for (const who of ['admin', 'superadmin', 'cmA', 'cmB', 'cmC', 'tmA', 'tmB']) assert.deepEqual(await bellOf(who, subject), [{ kind: 'signup' }], `${who}: in the bell`)
    for (const who of ['admin', 'superadmin', 'cmA', 'tmA']) assert.equal(signupMailsTo(people[who].email, people.fanout.email).length, 1, `${who}: mailed`)
    for (const who of ['cmB', 'cmC', 'tmB']) assert.equal(signupMailsTo(people[who].email, people.fanout.email).length, 0, `${who}: the bell only`)
    assert.equal(r.mailed, 4)
    const [mail] = signupMailsTo(people.cmA.email, people.fanout.email)
    assert.ok(mail.text.includes(`Club office new licence fees due reply with IBAN at (${people.fanout.email}) just created an OpenVolley account`), mail.text)
    assert.doesNotMatch(mail.text, /evil|:\s*new licence|\/ reply/)
    // the bell keeps the same name
    const { rows: [n] } = await sql.query("SELECT details FROM public.notifications WHERE user_id = $1 AND subject_user_id = $2", [people.cmB.id, subject])
    assert.equal(n.details.name, 'Club office new licence fees due reply with IBAN at')
  })

  it(`at most ${SIGNUPS_MAILED_PER_CLUB_DAY} sign-ups mailed per club and day: the next one is in the bell only (the admins still mailed); a new day mails again`, async () => {
    // Beta: none mailed yet today
    for (let i = 0; i < SIGNUPS_MAILED_PER_CLUB_DAY; i++) await signUp(`beta${i}`, [['scorer', 'B']])
    for (let i = 0; i < SIGNUPS_MAILED_PER_CLUB_DAY; i++) assert.equal(signupMailsTo(people.cmB.email, people[`beta${i}`].email).length, 1)
    await signUp('betaOver', [['scorer', 'B']])
    assert.equal(signupMailsTo(people.cmB.email, people.betaOver.email).length, 0, 'over the club\'s day: the bell only')
    assert.deepEqual(await bellOf('cmB', people.betaOver.id), [{ kind: 'signup' }])
    assert.equal(signupMailsTo(people.admin.email, people.betaOver.email).length, 1, 'the admins still mailed')
    clock += 24 * 60 * 60 * 1000 + 60 * 1000
    await signUp('betaNextDay', [['scorer', 'B']])
    assert.equal(signupMailsTo(people.cmB.email, people.betaNextDay.email).length, 1)
  })

  it(`at most ${MANAGER_MAILS_PER_SIGNUP} managers mailed per sign-up, ${MANAGER_MAILS_PER_HOUR} manager mails an hour in all`, async () => {
    clock += 24 * 60 * 60 * 1000 + 60 * 1000
    // Gamma gets 6 more club managers: 7 in all, 5 mailed
    for (let i = 0; i < 6; i++) {
      await person(`cmC${i}`, { roles: ['club_manager'] })
      await sql.query('INSERT INTO public.club_managers (club_id, user_id) VALUES ($1, $2)', [clubs.C.id, people[`cmC${i}`].id])
    }
    await signUp('gammaMany', [['scorer', 'C']])
    const gammaManagers = ['cmC', ...Array.from({ length: 6 }, (_, i) => `cmC${i}`)]
    const mailedManagers = gammaManagers.filter((w) => signupMailsTo(people[w].email, people.gammaMany.email).length)
    assert.equal(mailedManagers.length, MANAGER_MAILS_PER_SIGNUP)
    // the hour: Gamma's 5, then sign-ups for new clubs with 5 managers each until the hour's manager mails are used up
    let used = MANAGER_MAILS_PER_SIGNUP
    let n = 0
    while (used < MANAGER_MAILS_PER_HOUR) {
      const key = `X${n}`
      await club(key, `Club ${String.fromCharCode(65 + n)}${n}`, [])
      for (let i = 0; i < MANAGER_MAILS_PER_SIGNUP; i++) {
        await person(`m${key}${i}`, { roles: ['club_manager'] })
        await sql.query('INSERT INTO public.club_managers (club_id, user_id) VALUES ($1, $2)', [clubs[key].id, people[`m${key}${i}`].id])
      }
      await signUp(`s${key}`, [['scorer', key]])
      used += MANAGER_MAILS_PER_SIGNUP
      n++
    }
    const key = 'Last'
    await club(key, 'Club Last', [])
    await person('mLast', { roles: ['club_manager'] })
    await sql.query('INSERT INTO public.club_managers (club_id, user_id) VALUES ($1, $2)', [clubs[key].id, people.mLast.id])
    await signUp('sLast', [['scorer', key]])
    assert.equal(signupMailsTo(people.mLast.email, people.sLast.email).length, 0, 'the hour\'s manager mails are used up: the bell only')
    assert.deepEqual(await bellOf('mLast', people.sLast.id), [{ kind: 'signup' }])
    assert.equal(signupMailsTo(people.admin.email, people.sLast.email).length, 1, 'the admins still mailed')
    clock += 60 * 60 * 1000 + 60 * 1000
    await signUp('sLater', [['scorer', key]])
    assert.equal(signupMailsTo(people.mLast.email, people.sLater.email).length, 1, 'a new hour')
  })

  it('a team manager\'s proposal: the proposer\'s name letters, spaces and hyphens only', async () => {
    const proposer = await person('proposer', { roles: ['team_manager'], first: 'Club office:', last: 'pay at evil.example/pay +41 79' })
    const subject = await person('proposed', { first: 'Pia', last: 'Proposed' })
    await sql.query("INSERT INTO public.account_requests (user_id, kind, club_id, team_id) VALUES ($1, 'team_manager', $2, $3)", [subject.id, clubs.A.id, clubs.A.teams['Alpha D2']])
    const r = await notices.proposal({ userId: subject.id, teamId: clubs.A.teams['Alpha D2'], proposerId: proposer.id })
    assert.equal(r.mailed, 1)
    const [mail] = mailsTo(people.cmA.email).filter((m) => m.subject === 'Confirm a team manager')
    assert.ok(mail.text.includes(`Club office pay at proposes Pia Proposed (${subject.email}) as team manager of Alpha D2 (Alpha club).`), mail.text)
  })
})
