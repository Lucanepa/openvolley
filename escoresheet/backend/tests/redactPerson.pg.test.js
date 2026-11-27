/**
 * scripts/redact-person.mjs (privacy policy section 19): one person erased
 * from every stored copy, as the owner role in one transaction; closed
 * matches stay closed; the person is found by name (db/048: no dates of
 * birth to tell namesakes apart; --match limits it to matches); a register
 * line (digest only) runs again after a restore, one written before db/048
 * with a date of birth still by that date where a record has one.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestDatabase, SKIP_PG } from './helpers/pgTestDb.js'
import { redactPerson, registerPerson, redactValue, matcherOf, nameTextRe, personDigest, parseArgs, dateOf, dropGlobalCopies, globalStoreDirOf, globalStoreDirsByHash, REDACTED } from '../scripts/redact-person.mjs'
import { redactedPeopleKey, nameHash, licenceHash } from '../lib/redactedPeople.js'
import { createScoresheets } from '../lib/scoresheets.js'
import { keyHash } from '../lib/globalMatches.js'

// the register's key in these tests (db/052); never a real secret
const PIN_SECRET = 'k'.repeat(40)
const ROLES_SQL = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'roles.sql'), 'utf8')

describe('redact-person: the walk', () => {
  const who = { first: 'Mia', last: 'Example' }
  it('redacts the person in nested JSON and free text by name, keeps the number and the others', () => {
    const roster = [
      { number: 4, firstName: 'mia', lastName: ' Example ', dob: '2011-03-02', licence: '123456', libero: '' },
      { number: 9, firstName: 'Mia', lastName: 'Example', dob: '2009-01-01' },
      { number: 5, firstName: 'Lea', lastName: 'Other', dob: '2011-03-02' }
    ]
    const { value, hits } = redactValue({ players: roster, remarks: 'Set 2, A 3:1, Mia Example (#4) and Example, Mia again; Miao Example stays' },
      { match: matcherOf(who), textRe: nameTextRe(who) })
    assert.equal(hits, 3)
    assert.deepEqual(value.players[0], { number: 4, firstName: REDACTED, lastName: REDACTED, dob: null, licence: null, libero: '' })
    assert.deepEqual(value.players[1], { number: 9, firstName: REDACTED, lastName: REDACTED, dob: null }, 'the name: no date tells them apart any more')
    assert.deepEqual(value.players[2], roster[2])
    assert.equal(value.remarks, `Set 2, A 3:1, ${REDACTED} (#4) and ${REDACTED} again; Miao Example stays`)
  })

  it('finds prefixed columns (referee_1_first_name ...)', () => {
    const row = { referee_1_first_name: 'Mia', referee_1_last_name: 'Example', referee_1_dob: '2011-03-02', referee_2_first_name: 'Ada', referee_2_last_name: 'Other' }
    const { value } = redactValue(row, { match: matcherOf(who) })
    assert.deepEqual([value.referee_1_first_name, value.referee_1_last_name, value.referee_1_dob], [REDACTED, REDACTED, null])
    assert.equal(value.referee_2_first_name, 'Ada')
  })

  it('a beach entry player ({ first, last, licence, country }) is a person; other first/last pairs are not', () => {
    const entry = { name: 'Pair One', player1: { first: 'Mia', last: 'Example', licence: '123456', country: 'SUI' }, player2: { first: 'Lea', last: 'Other', licence: '654321', country: 'SUI' }, range: { first: 1, last: 9 } }
    const { value, hits } = redactValue(entry, { match: matcherOf(who), textRe: nameTextRe(who) })
    assert.equal(hits, 1)
    assert.deepEqual(value.player1, { first: REDACTED, last: REDACTED, licence: null, country: 'SUI' })
    assert.deepEqual(value.player2, entry.player2)
    assert.deepEqual(value.range, entry.range)
  })

  it('a register line of before db/048 (with a date of birth): its date also in the display form (DD.MM.YYYY, DD/MM/YYYY)', () => {
    assert.equal(dateOf('2.3.2011'), '2011-03-02')
    assert.equal(dateOf('02/03/2011'), '2011-03-02')
    assert.equal(dateOf('2011-03-02T00:00:00Z'), '2011-03-02')
    assert.equal(dateOf('soon'), null)
    const officials = [
      { role: 'referee1', firstName: 'Mia', lastName: 'Example', dob: '02.03.2011' },
      { role: 'referee2', firstName: 'Mia', lastName: 'Example', dob: '05.05.2008' }
    ]
    const line = { digest: personDigest({ first: 'Mia', last: 'Example', dob: '2011-03-02' }), nameDigest: personDigest(who), withDob: true }
    const { value, hits } = redactValue({ officials }, { match: matcherOf(line) })
    assert.equal(hits, 1)
    assert.equal(value.officials[0].lastName, REDACTED)
    assert.deepEqual(value.officials[1], officials[1], 'another date in the display form: a namesake')
    // where no date is left (db/048), the name
    assert.equal(redactValue({ officials: [{ ...officials[1], dob: null }] }, { match: matcherOf(line) }).hits, 1)
  })

  it('the arguments', () => {
    assert.match(parseArgs([]).error, /--first/)
    assert.match(parseArgs(['--first', 'A', '--last', 'B', '--dob', '2011-02-01']).error, /--dob: gone with db\/048/)
    assert.match(parseArgs(['--first', 'A', '--last', 'B', '--set-dob', '2011-02-01']).error, /--set-dob: gone with db\/048/)
    assert.deepEqual(parseArgs(['--first', 'A', '--last', 'B', '--match', 'm1', '--apply']).matches, ['m1'])
    // --global-key (PERM-05): a Global match's backup code, with a name or alone
    const code = 'AbCdEfGhIjKlMnOpQrStUv'
    assert.deepEqual(parseArgs(['--first', 'A', '--last', 'B', '--global-key', code]).globalKeys, [code])
    assert.equal(parseArgs(['--global-key', code, '--apply']).globalOnly, true)
    assert.match(parseArgs(['--global-key', 'short']).error, /--global-key/)
    assert.match(parseArgs(['--global-key', code, '--match', 'm1']).error, /--first/)
    assert.equal(globalStoreDirOf('/data/storage', code), `/data/storage/global/Ab/${code}`)
    assert.equal(globalStoreDirOf('/data/storage', '../../etc'), null)
  })
})

describe('redact-person: the database', { skip: SKIP_PG }, () => {
  let tdb, owner
  const person = (extra = {}) => ({ number: 4, firstName: 'Mia', lastName: 'Example', dob: '2011-03-02', ...extra })
  const tx = async (fn) => {
    await owner.query('BEGIN')
    try { const r = await fn(); await owner.query('COMMIT'); return r } catch (e) { await owner.query('ROLLBACK'); throw e }
  }

  before(async () => {
    tdb = await createTestDatabase('redact')
    owner = new pg.Client({ connectionString: tdb.url })
    await owner.connect()
  })
  after(async () => {
    await owner?.end().catch(() => {})
    await tdb?.drop()
  })

  let gameN = 5100
  const seed = async (ext) => {
    const { rows: [m] } = await owner.query(
      `INSERT INTO public.matches (external_id, game_n, status, test, players_home, players_away, remarks)
       VALUES ($1, $4, 'live', false, $2::json, $3::json, 'Set 1, 10:02, A 3:1, #4 Mia Example substituted') RETURNING id`,
      [ext, JSON.stringify([person(), { number: 7, firstName: 'Mia', lastName: 'Example', dob: '2008-05-05' }]), JSON.stringify([{ number: 1, firstName: 'Lea', lastName: 'Other' }]), ++gameN])
    await owner.query("INSERT INTO public.events (match_id, set_index, type, payload) VALUES ($1, 1, 'remark', $2::json)",
      [m.id, JSON.stringify({ text: 'Mia Example injured' })])
    await owner.query("UPDATE public.matches SET status = 'final' WHERE id = $1", [m.id])
    return m.id
  }

  it('erases the person from a closed match, its events and the lists; the match stays closed; audited by the caller', async () => {
    const id = await seed('rp-1')
    const { rows: [club] } = await owner.query("INSERT INTO public.clubs (name) VALUES ('Club One') RETURNING id")
    await owner.query(`INSERT INTO public.club_licences (club_id, list, sv_number, last_name, first_name) VALUES
      ($1, 'players', '123456', 'Example', 'Mia'), ($1, 'players', '654321', 'Other', 'Lea')`, [club.id])
    await owner.query(`INSERT INTO public.svrz_games (game_number, referee_1, referee_1_first_name, referee_1_last_name, referee_1_licence)
      VALUES ('5101', 'Example Mia', 'Mia', 'Example', '512345')`)
    // the app role cannot do it: the match is closed
    const r = await tx(() => redactPerson(owner, { who: { first: 'Mia', last: 'Example' } }))
    assert.deepEqual(r.matches, [id])
    assert.equal(r.tables.matches, 1)
    assert.equal(r.tables.events, 1)
    assert.equal(r.tables.club_licences, 1)
    assert.equal(r.tables.svrz_games, 1)
    const { rows: [m] } = await owner.query('SELECT players_home, players_away, remarks, closed_at FROM public.matches WHERE id = $1', [id])
    assert.ok(m.closed_at, 'still closed')
    assert.deepEqual(m.players_home[0], { number: 4, firstName: REDACTED, lastName: REDACTED, dob: null })
    assert.deepEqual(m.players_home[1], { number: 7, firstName: REDACTED, lastName: REDACTED, dob: null }, 'by name: a namesake is left out with --match only')
    assert.equal(m.players_away[0].firstName, 'Lea')
    assert.equal(m.remarks, `Set 1, 10:02, A 3:1, #4 ${REDACTED} substituted`)
    const { rows: [e] } = await owner.query('SELECT payload FROM public.events WHERE match_id = $1', [id])
    assert.equal(e.payload.text, `${REDACTED} injured`)
    assert.deepEqual((await owner.query('SELECT sv_number FROM public.club_licences')).rows.map((x) => x.sv_number), ['654321'])
    const { rows: [g] } = await owner.query('SELECT referee_1, referee_1_first_name, referee_1_last_name, referee_1_licence FROM public.svrz_games')
    assert.deepEqual(g, { referee_1: REDACTED, referee_1_first_name: REDACTED, referee_1_last_name: REDACTED, referee_1_licence: null }, 'the licence number (db/051) goes too')
  })

  it('--match: only those matches (a namesake elsewhere is left)', async () => {
    const id = await seed('rp-2')
    const other = await seed('rp-2b')
    const r = await tx(() => redactPerson(owner, { who: { first: 'Mia', last: 'Example' }, matches: ['rp-2'] }))
    assert.deepEqual(r.matches, [id])
    const { rows: [m] } = await owner.query('SELECT players_home, remarks FROM public.matches WHERE id = $1', [id])
    assert.equal(m.players_home[0].firstName, REDACTED)
    assert.doesNotMatch(m.remarks, /Mia Example/)
    const { rows: [o] } = await owner.query('SELECT players_home, remarks FROM public.matches WHERE id = $1', [other])
    assert.equal(o.players_home[0].firstName, 'Mia')
    assert.match(o.remarks, /Mia Example/)
  })

  it('a register line (digest only) erases the structured copies again after a restore', async () => {
    const id = await seed('rp-3')
    const line = { mode: 'erase', digest: personDigest({ first: 'Mia', last: 'Example', dob: '2011-03-02' }), nameDigest: personDigest({ first: 'Mia', last: 'Example' }), withDob: true }
    assert.equal(JSON.stringify(line).includes('Example'), false)
    const r = await tx(() => redactPerson(owner, { who: line }))
    assert.ok(r.matches.includes(id))
    const { rows: [m] } = await owner.query('SELECT players_home FROM public.matches WHERE id = $1', [id])
    assert.equal(m.players_home[0].lastName, REDACTED)
    assert.equal(m.players_home[1].lastName, 'Example', 'another date of birth')
  })

  it('the command: a dry run changes nothing; --apply writes, audits (no name) and fills the register', async () => {
    await seed('rp-4')
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'redact-person.mjs')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-redact-'))
    const register = path.join(dir, 'register.jsonl')
    const run = (...args) => execFileSync(process.execPath, [script, '--first', 'Mia', '--last', 'Example', '--match', 'rp-4', ...args],
      { env: { ...process.env, OV_MIGRATE_DATABASE_URL: tdb.url }, encoding: 'utf8' })
    const roster = async () => (await owner.query("SELECT players_home FROM public.matches WHERE external_id = 'rp-4'")).rows[0].players_home[0]
    const audits = async () => (await owner.query("SELECT details FROM public.audit_log WHERE action = 'person.redact'")).rows
    try {
      assert.match(run(), /Dry run/)
      assert.equal((await roster()).lastName, 'Example')
      assert.equal((await audits()).length, 0)
      const out = run('--apply', '--register', register, '--actor', 'not-a-uuid')
      assert.match(out, /Applied/)
      assert.equal(out.includes('Example'), false, 'the output names nobody')
      assert.equal((await roster()).lastName, REDACTED)
      const [a] = await audits()
      assert.equal(a.details.mode, 'erase')
      assert.equal(a.details.tables.matches, 1)
      assert.equal(JSON.stringify(a).includes('Example'), false)
      const lines = fs.readFileSync(register, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      assert.equal(lines.length, 1)
      assert.equal(lines[0].digest, a.details.digest)
      assert.equal(JSON.stringify(lines).includes('Example'), false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('registers the person for the schedule sync (db/052): keyed hashes of the name and of the licence numbers erased, never the name', async () => {
    await owner.query(`INSERT INTO public.svrz_games (game_number, referee_1, referee_1_first_name, referee_1_last_name, referee_1_licence)
      VALUES ('5201', 'Exemplar Robin', 'Robin', 'Exemplar', '534567')`)
    const { rows: [club] } = await owner.query("INSERT INTO public.clubs (name) VALUES ('Club Two') RETURNING id")
    await owner.query(`INSERT INTO public.club_licences (club_id, list, sv_number, last_name, first_name) VALUES ($1, 'players', '765432', 'Exemplar', 'Robin')`, [club.id])
    const who = { first: 'Robin', last: 'Exemplar' }
    const key = redactedPeopleKey(PIN_SECRET)
    const reg = await tx(async () => {
      const r = await redactPerson(owner, { who })
      assert.deepEqual(r.licences.sort(), ['534567', '765432'])
      return registerPerson(owner, { key, who, licences: r.licences })
    })
    assert.equal(reg.registered, 3)
    const { rows } = await owner.query("SELECT kind, encode(hash, 'hex') AS hash FROM public.redacted_people ORDER BY kind, hash")
    const want = [nameHash(key, 'Robin', 'Exemplar'), licenceHash(key, '534567'), licenceHash(key, '765432')]
    assert.deepEqual(rows.map((x) => x.hash).sort(), want.sort())
    assert.equal(JSON.stringify(rows).match(/Exemplar|Robin|534567|765432/i), null)
    // again: nothing new
    assert.equal((await tx(() => registerPerson(owner, { key, who, licences: ['534567'] }))).registered, 0)
    // a register line's entries, as they are (no key needed)
    await owner.query('DELETE FROM public.redacted_people')
    assert.equal((await tx(() => registerPerson(owner, { entries: [...reg.entries, { kind: 'name', hash: 'not-a-hash' }] }))).registered, 3)
    await owner.query('DELETE FROM public.redacted_people')
  })

  it('the register is read only for the app (roles.sql): the sync reads it, nobody but the owner writes it', async () => {
    const appUrl = await tdb.createAppRole()
    const role = new URL(appUrl).username
    const block = [...ROLES_SQL.matchAll(/^SELECT format\([\s\S]*?\\gexec/gm)].map((m) => m[0]).find((b) => b.includes('public.redacted_people'))
    assert.ok(block, 'roles.sql: the REVOKE block of public.redacted_people')
    for (const row of (await owner.query(block.replace(/\\gexec$/, ''))).rows) {
      await owner.query(Object.values(row)[0].replace(/\bov_app\b/g, `"${role}"`))
    }
    await owner.query("INSERT INTO public.redacted_people (hash, kind) VALUES (decode(repeat('ab', 32), 'hex'), 'name')")
    const app = new pg.Client({ connectionString: appUrl })
    await app.connect()
    try {
      assert.equal((await app.query('SELECT count(*)::int AS n FROM public.redacted_people')).rows[0].n, 1)
      for (const sql of ['DELETE FROM public.redacted_people', "INSERT INTO public.redacted_people (hash, kind) VALUES (decode(repeat('cd', 32), 'hex'), 'name')",
        "UPDATE public.redacted_people SET kind = 'licence'"]) {
        await assert.rejects(app.query(sql), (err) => err.code === '42501', sql)
      }
    } finally {
      await app.end()
      await owner.query('DELETE FROM public.redacted_people')
    }
  })

  it('the command without --match: --apply needs OV_PIN_SECRET; with it the register gets the person, and --reapply puts the entries back after a restore', async () => {
    await owner.query(`INSERT INTO public.svrz_games (game_number, referee_2, referee_2_first_name, referee_2_last_name, referee_2_licence)
      VALUES ('5202', 'Sample Kim', 'Kim', 'Sample', '545678')`)
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'redact-person.mjs')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-redact-'))
    const register = path.join(dir, 'register.jsonl')
    const env = { ...process.env, OV_MIGRATE_DATABASE_URL: tdb.url }
    delete env.OV_PIN_SECRET
    const run = (args, extra = {}) => {
      try {
        return { code: 0, out: execFileSync(process.execPath, [script, ...args], { env: { ...env, ...extra }, encoding: 'utf8', stdio: 'pipe' }) }
      } catch (err) {
        return { code: err.status, out: `${err.stdout}${err.stderr}` }
      }
    }
    const count = async () => (await owner.query('SELECT count(*)::int AS n FROM public.redacted_people')).rows[0].n
    const game = async () => (await owner.query("SELECT referee_2_last_name, referee_2_licence FROM public.svrz_games WHERE game_number = '5202'")).rows[0]
    try {
      const refused = run(['--first', 'Kim', '--last', 'Sample', '--apply', '--register', register])
      assert.equal(refused.code, 2, refused.out)
      assert.match(refused.out, /OV_PIN_SECRET/)
      assert.equal((await game()).referee_2_last_name, 'Sample', 'nothing changed')
      assert.match(run(['--first', 'Kim', '--last', 'Sample']).out, /Note: OV_PIN_SECRET is not set/, 'a dry run says so')

      const done = run(['--first', 'Kim', '--last', 'Sample', '--apply', '--register', register], { OV_PIN_SECRET: PIN_SECRET })
      assert.equal(done.code, 0, done.out)
      assert.match(done.out, /schedule sync register \(db\/052\): 2 new of 2 keyed hash\(es\)/)
      assert.equal(/Sample|545678/.test(done.out), false, 'the output names nobody')
      assert.deepEqual(await game(), { referee_2_last_name: REDACTED, referee_2_licence: null })
      assert.equal(await count(), 2)
      const [line] = fs.readFileSync(register, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      assert.deepEqual(line.entries.map((e) => e.kind), ['name', 'licence'])
      assert.equal(/Sample|545678/.test(JSON.stringify(line)), false)
      const { rows: [a] } = await owner.query("SELECT details FROM public.audit_log WHERE action = 'person.redact' ORDER BY id DESC LIMIT 1")
      assert.equal(a.details.registered, 2)

      // a restore from an older backup: the register is gone; --reapply needs no key
      await owner.query('DELETE FROM public.redacted_people')
      const again = run(['--reapply', register, '--apply'])
      assert.equal(again.code, 0, again.out)
      assert.equal(await count(), 2)
      // a line of before db/052 (no keyed hashes): named for a run by name
      fs.appendFileSync(register, JSON.stringify({ mode: 'erase', digest: personDigest({ first: 'Old', last: 'Line' }), nameDigest: personDigest({ first: 'Old', last: 'Line' }), withDob: false, matches: [] }) + '\n')
      assert.match(run(['--reapply', register]).out, /1 register line\(s\) of before db\/052 hold no keyed hashes/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
      await owner.query('DELETE FROM public.redacted_people')
    }
  })

  it('erases a beach player from the tournament entries', async () => {
    const { rows: [t] } = await owner.query("INSERT INTO public.beach_tournaments (slug, title, starts_on, ends_on) VALUES ('beach-one', 'Beach One', '2026-06-01', '2026-06-02') RETURNING id")
    const { rows: [d] } = await owner.query("INSERT INTO public.beach_draws (tournament_id, gender, category) VALUES ($1, 'women', 'A') RETURNING id", [t.id])
    await owner.query(`INSERT INTO public.beach_entries (draw_id, seed, name, player1, player2) VALUES ($1, 1, 'Pair One', $2::jsonb, $3::jsonb)`,
      [d.id, JSON.stringify({ first: 'Mia', last: 'Example', licence: '123456', country: 'SUI' }), JSON.stringify({ first: 'Lea', last: 'Other', licence: '654321', country: 'SUI' })])
    const r = await tx(() => redactPerson(owner, { who: { first: 'Mia', last: 'Example' }, matches: [] }))
    assert.equal(r.tables.beach_entries, 1)
    const { rows: [e] } = await owner.query('SELECT player1, player2 FROM public.beach_entries WHERE draw_id = $1', [d.id])
    assert.deepEqual(e.player1, { first: REDACTED, last: REDACTED, licence: null, country: 'SUI' })
    assert.equal(e.player2.licence, '654321')
  })

  it('a register line reads a large table in blocks and locks only the rows it changes', async () => {
    const { rows: [m] } = await owner.query(
      "INSERT INTO public.matches (external_id, game_n, status, test) VALUES ('rp-big', $1, 'live', false) RETURNING id", [++gameN])
    // well over one block of pages (SCAN_PAGES), the person in the last rows only
    await owner.query(`INSERT INTO public.events (match_id, set_index, type, payload)
      SELECT $1, 1, 'remark', json_build_object('text', repeat('x', 600), 'n', g) FROM generate_series(1, 2000) g`, [m.id])
    await owner.query("INSERT INTO public.events (match_id, set_index, type, payload) VALUES ($1, 1, 'remark', $2::json)",
      [m.id, JSON.stringify({ captain: { firstName: 'Ada', lastName: 'Sample', dob: '2010-10-10' } })])
    const { rows: [{ pages }] } = await owner.query("SELECT pg_relation_size('public.events') / current_setting('block_size')::int AS pages")
    assert.ok(Number(pages) > 64, `events spans ${pages} pages`)
    const other = new pg.Client({ connectionString: tdb.url })
    await other.connect()
    try {
      const line = { mode: 'erase', digest: personDigest({ first: 'Ada', last: 'Sample', dob: '2010-10-10' }), nameDigest: personDigest({ first: 'Ada', last: 'Sample' }), withDob: true }
      await owner.query('BEGIN')
      const r = await redactPerson(owner, { who: line, mode: 'erase' })
      assert.equal(r.tables.events, 1)
      // another session can still lock a row the tool only read
      const { rows: free } = await other.query(
        "SELECT id FROM public.events WHERE match_id = $1 AND payload->>'n' = '1' FOR UPDATE NOWAIT", [m.id])
      assert.equal(free.length, 1)
      await owner.query('COMMIT')
      const { rows: [e] } = await owner.query("SELECT payload FROM public.events WHERE match_id = $1 AND payload->'captain' IS NOT NULL", [m.id])
      assert.deepEqual(e.payload.captain, { firstName: REDACTED, lastName: REDACTED, dob: null })
    } finally {
      await owner.query('ROLLBACK').catch(() => {})
      await other.end()
    }
  })

  // PERM-05 (audit 26.11): the approval's name, the tournament's referee and
  // the Global cloud copies were left, while the run said "Applied"; a rebuild
  // printed the erased referee's name again ("Approved electronically · <name>")
  const approvalMatch = async (ext) => {
    const { rows: [m] } = await owner.query(
      `INSERT INTO public.matches (external_id, game_n, status, test, home_team, away_team, officials)
       VALUES ($1, $2, 'ended', false, '{"name":"Home"}', '{"name":"Away"}', $3::json) RETURNING id`,
      [ext, ++gameN, JSON.stringify([{ role: '1st referee', firstName: 'Rita', lastName: 'Referee' }])])
    await owner.query('INSERT INTO public.sets (match_id, index, home_points, away_points, finished) VALUES ($1, 1, 25, 20, true)', [m.id])
    for (const [slot, name] of [['referee1', 'Referee Rita'], ['scorer', 'Other Ada']]) {
      await owner.query(
        `INSERT INTO public.match_approvals (match_id, slot, display_name, match_status, result_key, result_hash)
         VALUES ($1, $2, $3, 'ended', 'ov-result-v1|1:25:20', decode(repeat('ab', 32), 'hex'))`, [m.id, slot, name])
    }
    await owner.query("UPDATE public.matches SET status = 'final' WHERE id = $1", [m.id])
    return m.id
  }

  it('the approving account\'s name: "[redacted]" in match_approvals (slot, time, hash kept), so no old sheet record carries it', async () => {
    const id = await approvalMatch('rp-appr-1')
    const before = (await owner.query('SELECT id, slot, approved_at, result_key, encode(result_hash, \'hex\') AS hash FROM public.match_approvals WHERE match_id = $1 ORDER BY slot', [id])).rows
    await owner.query("UPDATE public.match_sheet_changes SET changed_at = now() - interval '1 day' WHERE match_id = $1", [id])
    const r = await tx(() => redactPerson(owner, { who: { first: 'Rita', last: 'Referee' } }))
    assert.equal(r.tables.match_approvals, 1)
    assert.ok(r.matches.includes(id))
    const after = (await owner.query('SELECT id, slot, approved_at, result_key, encode(result_hash, \'hex\') AS hash, display_name FROM public.match_approvals WHERE match_id = $1 ORDER BY slot', [id])).rows
    assert.deepEqual(after.map(({ display_name: _, ...x }) => x), before, 'the slot, the time and the hash stay')
    assert.deepEqual(after.map((x) => [x.slot, x.display_name]), [['referee1', REDACTED], ['scorer', 'Other Ada']])
    const { rows: [m] } = await owner.query('SELECT closed_at, officials FROM public.matches WHERE id = $1', [id])
    assert.ok(m.closed_at, 'still closed')
    assert.equal(m.officials[0].lastName, REDACTED)
    // the sheet is out of date: the PDF is made anew (db/045, set by hand as its trigger was off)
    const { rows: [c] } = await owner.query('SELECT changed_at > now() - interval \'1 minute\' AS fresh FROM public.match_sheet_changes WHERE match_id = $1', [id])
    assert.equal(c?.fresh, true)

    // the render record (Rebuild PDF, rebuild-vector) carries no approvals (removed 27.11.2026)
    let printed = null
    const sheets = createScoresheets({
      pool: owner,
      storage: {},
      accounts: { audit: async () => {} },
      readMatch: async (mid) => ({ match: (await owner.query('SELECT * FROM public.matches WHERE id = $1', [mid])).rows[0], sets: [], events: [] }),
      vector: { enabled: true, render: async ({ record }) => { printed = record; return { ok: false, status: 503, code: 'OV_RENDER_BUSY' } } },
      logger: { warn () {}, error () {}, log () {} }
    })
    await sheets.rebuildVector({ actorId: null, matchId: id, reason: 'name erased' })
    assert.ok(printed, 'the record went to the render service')
    assert.deepEqual(printed.approvals, [])
    assert.equal(JSON.stringify(printed).includes('Rita'), false, 'the erased name is nowhere in what the sheet is drawn from')
  })

  it('a register line (digest only) finds the approval\'s name too ("Last First" read every way)', async () => {
    const id = await approvalMatch('rp-appr-2')
    const line = { mode: 'erase', digest: personDigest({ first: 'Rita', last: 'Referee' }), nameDigest: personDigest({ first: 'Rita', last: 'Referee' }), withDob: false }
    const r = await tx(() => redactPerson(owner, { who: line }))
    assert.ok(r.tables.match_approvals >= 1)
    const { rows } = await owner.query("SELECT display_name FROM public.match_approvals WHERE match_id = $1 AND slot = 'referee1'", [id])
    assert.equal(rows[0].display_name, REDACTED)
  })

  it('the tournament\'s referee (beach_tmatches.referee) is erased', async () => {
    const { rows: [t] } = await owner.query("INSERT INTO public.beach_tournaments (slug, title, starts_on, ends_on) VALUES ('beach-ref', 'Beach Ref', '2026-06-01', '2026-06-02') RETURNING id")
    const { rows: [d] } = await owner.query("INSERT INTO public.beach_draws (tournament_id, gender, category) VALUES ($1, 'women', 'A') RETURNING id", [t.id])
    await owner.query(`INSERT INTO public.beach_tmatches (tournament_id, draw_id, game_n, code, phase, round, position, wave, source1, source2, referee, scorer)
      VALUES ($1, $2, 1, 'W1', 'winners', 1, 1, 1, 'seed:1', 'seed:2', 'Mia Example', 'Lea Other')`, [t.id, d.id])
    const r = await tx(() => redactPerson(owner, { who: { first: 'Mia', last: 'Example' } }))
    assert.equal(r.tables.beach_tmatches, 1)
    const { rows: [m] } = await owner.query('SELECT referee, scorer FROM public.beach_tmatches WHERE draw_id = $1', [d.id])
    assert.deepEqual(m, { referee: REDACTED, scorer: 'Lea Other' })
  })

  it('the Global cloud copies (db/046): the person redacted in the bundle and its PDF gone; --global-key deletes a copy by its backup code', async () => {
    const code = 'GlobalBackupCode_0123456789'
    const other = 'GlobalBackupCode_9876543210'
    const bundle = { match: { homeTeam: 'U13 Musterdorf' }, players: [{ number: 7, firstName: 'Gina', lastName: 'Globus', dob: '2013-04-05' }, { number: 8, firstName: 'Lea', lastName: 'Other' }], remarks: 'Gina Globus injured' }
    for (const k of [code, other]) {
      await owner.query(
        `INSERT INTO public.global_matches (key_hash, pin_hash, summary, bundle, pdf) VALUES ($1, repeat('c', 64), $2::jsonb, $3::jsonb, $4)`,
        [keyHash(k), JSON.stringify({ home: { name: 'U13 Musterdorf' }, away: { name: 'U13 Beispiel' } }), JSON.stringify(bundle), Buffer.from('%PDF-1.4\n% Gina Globus 05.04.2013\n%%EOF\n')])
    }
    const r = await tx(() => redactPerson(owner, { who: { first: 'Gina', last: 'Globus' } }))
    assert.equal(r.tables.global_matches, 2)
    const rows = (await owner.query('SELECT key_hash, bundle, pdf FROM public.global_matches ORDER BY key_hash')).rows
    for (const g of rows) {
      assert.equal(g.pdf, null, 'the PDF prints the name: gone')
      assert.deepEqual(g.bundle.players[0], { number: 7, firstName: REDACTED, lastName: REDACTED, dob: null })
      assert.equal(g.bundle.players[1].lastName, 'Other')
      assert.equal(g.bundle.remarks, `${REDACTED} injured`)
    }
    assert.deepEqual(rows.map((g) => g.key_hash).sort(), [keyHash(code), keyHash(other)].sort(), 'the copies stay, found by their keys')

    // a parent with the backup code (privacy policy section 17): that copy goes
    assert.equal(await tx(() => dropGlobalCopies(owner, [keyHash(code), 'not-a-hash'])), 1)
    assert.deepEqual((await owner.query('SELECT key_hash FROM public.global_matches')).rows.map((g) => g.key_hash), [keyHash(other)])

    // the command with --global-key alone: deleted, audited and registered without the code
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'redact-person.mjs')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-redact-'))
    const register = path.join(dir, 'register.jsonl')
    const storeDir = path.join(dir, 'global', other.slice(0, 2), other)
    fs.mkdirSync(storeDir, { recursive: true })
    fs.writeFileSync(path.join(storeDir, 'scoresheet.pdf'), '%PDF-1.4 Gina Globus')
    try {
      const run = (...args) => execFileSync(process.execPath, [script, '--global-key', other, ...args],
        { env: { ...process.env, OV_MIGRATE_DATABASE_URL: tdb.url, STORAGE_ROOT: dir }, encoding: 'utf8' })
      assert.match(run(), /Dry run/)
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM public.global_matches')).rows[0].n, 1)
      const out = run('--apply', '--drop-files', '--register', register)
      assert.match(out, /global: 1 Global cloud copy deleted/)
      assert.equal(out.includes(other), false, 'the output never shows the code')
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM public.global_matches')).rows[0].n, 0)
      assert.equal(fs.existsSync(storeDir), false, 'the Global store\'s files of the code are gone')
      const { rows: [a] } = await owner.query("SELECT details FROM public.audit_log WHERE action = 'person.redact' AND details->>'mode' = 'global' ORDER BY id DESC LIMIT 1")
      assert.equal(a.details.global_copies, 1)
      const [line] = fs.readFileSync(register, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      assert.deepEqual(line.global, [keyHash(other)])
      assert.equal(JSON.stringify(line).includes(other), false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('by name, without the backup code: the Global store\'s scoresheet PDFs of a cloud copy the person is in go too (found by the copy\'s key hash); the encrypted backup and other matches stay', async () => {
    const hit = 'NordwindStoreCode_0123456789'
    const miss = 'NordwindStoreCode_9876543210'
    const bare = 'NordwindStoreCode_abcdefghij' // a store folder without a cloud copy
    const bundleOf = (last) => ({ players: [{ number: 3, firstName: 'Nora', lastName: last, dob: '2012-01-02' }] })
    for (const [k, last] of [[hit, 'Nordwind'], [miss, 'Other']]) {
      await owner.query(
        `INSERT INTO public.global_matches (key_hash, pin_hash, summary, bundle, pdf) VALUES ($1, repeat('c', 64), '{}'::jsonb, $2::jsonb, $3)`,
        [keyHash(k), JSON.stringify(bundleOf(last)), Buffer.from(`%PDF-1.4\n% Nora ${last}\n%%EOF\n`)])
    }
    // redactPerson names the copies it redacted by their key hash (the database has no backup code)
    await owner.query('BEGIN')
    try {
      const r = await redactPerson(owner, { who: { first: 'Nora', last: 'Nordwind' } })
      assert.deepEqual(r.globalKeyHashes, [keyHash(hit)])
    } finally {
      await owner.query('ROLLBACK')
    }

    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'redact-person.mjs')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-redact-'))
    const register = path.join(dir, 'register.jsonl')
    const storeOf = (k) => path.join(dir, 'global', k.slice(0, 2), k)
    for (const k of [hit, miss, bare]) {
      fs.mkdirSync(storeOf(k), { recursive: true })
      fs.writeFileSync(path.join(storeOf(k), 'backup.json'), '{"format":"openvolley-encrypted-backup"}')
      fs.writeFileSync(path.join(storeOf(k), 'scoresheet.pdf'), '%PDF-1.4 Nora Nordwind')
      fs.writeFileSync(path.join(storeOf(k), 'scoresheet-final.pdf'), '%PDF-1.4 Nora Nordwind 02.01.2012')
    }
    assert.deepEqual((await globalStoreDirsByHash(dir, [keyHash(hit), 'not-a-hash'])).map((x) => x.dir), [storeOf(hit)])
    const files = (k) => fs.readdirSync(storeOf(k)).sort()
    const env = { ...process.env, OV_MIGRATE_DATABASE_URL: tdb.url, STORAGE_ROOT: dir, OV_PIN_SECRET: PIN_SECRET }
    const run = (...args) => execFileSync(process.execPath, [script, ...args], { env, encoding: 'utf8' })
    try {
      const dry = run('--first', 'Nora', '--last', 'Nordwind', '--drop-files')
      assert.match(dry, /Dry run/)
      assert.match(dry, /Global store: 2 scoresheet PDF\(s\) of 1 Global match\(es\) the person is in stay/)
      assert.deepEqual(files(hit), ['backup.json', 'scoresheet-final.pdf', 'scoresheet.pdf'], 'a dry run removes nothing')

      const out = run('--first', 'Nora', '--last', 'Nordwind', '--drop-files', '--apply', '--register', register)
      assert.match(out, /Global store: 2 scoresheet PDF\(s\) of 1 Global match\(es\) removed/)
      assert.equal(/Nordwind|NordwindStoreCode/.test(out), false, 'the output names nobody and shows no backup code')
      assert.deepEqual(files(hit), ['backup.json'], 'the PDFs print the name: gone; the encrypted backup stays')
      assert.deepEqual(files(miss), ['backup.json', 'scoresheet-final.pdf', 'scoresheet.pdf'], 'another person\'s match')
      assert.deepEqual(files(bare), ['backup.json', 'scoresheet-final.pdf', 'scoresheet.pdf'])
      const { rows: [g] } = await owner.query('SELECT bundle, pdf FROM public.global_matches WHERE key_hash = $1', [keyHash(hit)])
      assert.equal(g.pdf, null)
      assert.equal(g.bundle.players[0].lastName, REDACTED)

      // a register line of --global-key (its hash only) after a restore: the store's folder found by the hash goes too
      fs.appendFileSync(register, JSON.stringify({ at: new Date().toISOString(), mode: 'global', matches: [], global: [keyHash(bare)] }) + '\n')
      assert.match(run('--reapply', register), /The Global store's files of 1 backup code\(s\) stay/)
      assert.equal(fs.existsSync(storeOf(bare)), true)
      run('--reapply', register, '--drop-files', '--apply')
      assert.equal(fs.existsSync(storeOf(bare)), false, 'the --global-key request again: the whole folder')
      assert.deepEqual(files(miss), ['backup.json', 'scoresheet-final.pdf', 'scoresheet.pdf'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
      await owner.query('DELETE FROM public.global_matches')
      await owner.query('DELETE FROM public.redacted_people')
    }
  })
})
