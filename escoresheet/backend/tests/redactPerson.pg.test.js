/**
 * scripts/redact-person.mjs (privacy policy section 19): one person erased
 * from every stored copy, or their date of birth corrected, as the owner
 * role in one transaction; closed matches stay closed; a namesake with
 * another date of birth is left; a register line (digest only) runs again
 * after a restore.
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
import { redactPerson, redactValue, matcherOf, nameTextRe, personDigest, parseArgs, REDACTED } from '../scripts/redact-person.mjs'

describe('redact-person: the walk', () => {
  const who = { first: 'Mia', last: 'Example', dob: '2011-03-02' }
  it('redacts the person in nested JSON and free text, keeps the number and a namesake', () => {
    const roster = [
      { number: 4, firstName: 'mia', lastName: ' Example ', dob: '2011-03-02', licence: '123456', libero: '' },
      { number: 9, firstName: 'Mia', lastName: 'Example', dob: '2009-01-01' },
      { number: 5, firstName: 'Lea', lastName: 'Other', dob: '2011-03-02' }
    ]
    const { value, hits } = redactValue({ players: roster, remarks: 'Set 2, A 3:1, Mia Example (#4) and Example, Mia again; Miao Example stays' },
      { match: matcherOf(who), textRe: nameTextRe(who) })
    assert.equal(hits, 2)
    assert.deepEqual(value.players[0], { number: 4, firstName: REDACTED, lastName: REDACTED, dob: null, licence: null, libero: '' })
    assert.deepEqual(value.players[1], roster[1], 'another date of birth: a namesake')
    assert.deepEqual(value.players[2], roster[2])
    assert.equal(value.remarks, `Set 2, A 3:1, ${REDACTED} (#4) and ${REDACTED} again; Miao Example stays`)
  })

  it('finds prefixed columns (referee_1_first_name ...) and corrects a date', () => {
    const row = { referee_1_first_name: 'Mia', referee_1_last_name: 'Example', referee_1_dob: '2011-03-02', referee_2_first_name: 'Ada', referee_2_last_name: 'Other' }
    const { value } = redactValue(row, { match: matcherOf(who), mode: 'correct', setDob: '2011-03-20' })
    assert.equal(value.referee_1_dob, '2011-03-20')
    assert.equal(value.referee_2_first_name, 'Ada')
  })

  it('the arguments', () => {
    assert.match(parseArgs([]).error, /--first/)
    assert.match(parseArgs(['--first', 'A', '--last', 'B', '--dob', '1.2.2011']).error, /YYYY-MM-DD/)
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
    await owner.query(`INSERT INTO public.club_licences (club_id, list, sv_number, last_name, first_name, dob) VALUES
      ($1, 'players', '123456', 'Example', 'Mia', '2011-03-02'), ($1, 'players', '654321', 'Other', 'Lea', '2010-01-01')`, [club.id])
    await owner.query(`INSERT INTO public.svrz_games (game_number, referee_1, referee_1_first_name, referee_1_last_name, referee_1_dob)
      VALUES ('5101', 'Example Mia', 'Mia', 'Example', '2011-03-02')`)
    // the app role cannot do it: the match is closed
    const r = await tx(() => redactPerson(owner, { who: { first: 'Mia', last: 'Example', dob: '2011-03-02' } }))
    assert.deepEqual(r.matches, [id])
    assert.equal(r.tables.matches, 1)
    assert.equal(r.tables.events, 1)
    assert.equal(r.tables.club_licences, 1)
    assert.equal(r.tables.svrz_games, 1)
    const { rows: [m] } = await owner.query('SELECT players_home, players_away, remarks, closed_at FROM public.matches WHERE id = $1', [id])
    assert.ok(m.closed_at, 'still closed')
    assert.deepEqual(m.players_home[0], { number: 4, firstName: REDACTED, lastName: REDACTED, dob: null })
    assert.equal(m.players_home[1].dob, '2008-05-05', 'the namesake stays')
    assert.equal(m.players_away[0].firstName, 'Lea')
    assert.equal(m.remarks, `Set 1, 10:02, A 3:1, #4 ${REDACTED} substituted`)
    const { rows: [e] } = await owner.query('SELECT payload FROM public.events WHERE match_id = $1', [id])
    assert.equal(e.payload.text, `${REDACTED} injured`)
    assert.deepEqual((await owner.query('SELECT sv_number FROM public.club_licences')).rows.map((x) => x.sv_number), ['654321'])
    const { rows: [g] } = await owner.query('SELECT referee_1, referee_1_first_name, referee_1_dob FROM public.svrz_games')
    assert.deepEqual(g, { referee_1: REDACTED, referee_1_first_name: REDACTED, referee_1_dob: null })
  })

  it('corrects a date of birth everywhere, nothing else', async () => {
    const id = await seed('rp-2')
    const r = await tx(() => redactPerson(owner, { who: { first: 'Mia', last: 'Example', dob: '2011-03-02' }, mode: 'correct', setDob: '2011-03-20', matches: ['rp-2'] }))
    assert.deepEqual(r.matches, [id])
    const { rows: [m] } = await owner.query('SELECT players_home, remarks FROM public.matches WHERE id = $1', [id])
    assert.equal(m.players_home[0].dob, '2011-03-20')
    assert.equal(m.players_home[0].firstName, 'Mia')
    assert.match(m.remarks, /Mia Example/)
    // --match: the other match's roster was not touched
    const { rows: [o] } = await owner.query("SELECT players_home FROM public.matches WHERE external_id = 'rp-1'")
    assert.equal(o.players_home[0].firstName, REDACTED)
  })

  it('a register line (digest only) erases the structured copies again after a restore', async () => {
    const id = await seed('rp-3')
    const line = { mode: 'erase', digest: personDigest({ first: 'Mia', last: 'Example', dob: '2011-03-02' }), nameDigest: personDigest({ first: 'Mia', last: 'Example' }), withDob: true }
    assert.equal(JSON.stringify(line).includes('Example'), false)
    const r = await tx(() => redactPerson(owner, { who: line, mode: 'erase' }))
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
    const run = (...args) => execFileSync(process.execPath, [script, '--first', 'Mia', '--last', 'Example', '--dob', '2011-03-02', '--match', 'rp-4', ...args],
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
})
