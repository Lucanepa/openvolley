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
import { redactPerson, registerPerson, redactValue, matcherOf, nameTextRe, personDigest, parseArgs, dateOf, REDACTED } from '../scripts/redact-person.mjs'
import { redactedPeopleKey, nameHash, licenceHash } from '../lib/redactedPeople.js'

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
})
