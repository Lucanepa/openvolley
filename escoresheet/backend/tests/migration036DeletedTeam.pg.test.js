// db/036: a team link manager whose team was taken off the club's list since
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP_PG, createTestDatabase } from './helpers/pgTestDb.js'

const here = dirname(fileURLToPath(import.meta.url))
const sqlOf = (f) => readFileSync(join(here, '..', 'db', f), 'utf8')
const files = readFileSync(join(here, 'helpers', 'pgTestDb.js'), 'utf8').match(/MIGRATIONS_SQL = \[([^\]]*)\]/)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1)).filter((f) => f !== '036_team_manager_confirm.sql')
const BEFORE = [readFileSync(join(here, 'fixtures', 'synthetic_schema.sql'), 'utf8'), ...files.map(sqlOf)].join('\n')
const MIGRATION = sqlOf('036_team_manager_confirm.sql') + '\n' + sqlOf('current_definitions.sql')

describe('db/036: a team deleted since', { skip: SKIP_PG }, () => {
  let t, raw
  before(async () => { t = await createTestDatabase('rv036', { schemaSql: BEFORE }); raw = new pg.Client({ connectionString: t.url }); await raw.connect() })
  after(async () => { await raw?.end().catch(() => {}); await t?.drop?.() })
  it('a team link manager of a team deleted since loses the club membership db/030 gave', async () => {
    const club = (await raw.query("INSERT INTO public.clubs (name) VALUES ('VBC Muster') RETURNING id")).rows[0].id
    const team = (await raw.query("INSERT INTO public.club_teams (club_id, team_name) VALUES ($1, 'VBC Muster H1') RETURNING id", [club])).rows[0].id
    const uid = randomUUID()
    await raw.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [uid, 'coach@example.ch'])
    await raw.query("INSERT INTO public.profiles (user_id, roles) VALUES ($1, '{}')", [uid])
    const { rows: [inv] } = await raw.query(`INSERT INTO public.invite_codes (code_hash, code_hint, label, role, club_id, team_id, sport)
      VALUES ($1, 'ABCD', 'Team link', 'team_manager', $2, $3, 'indoor') RETURNING id`, [randomBytes(32), club, team])
    await raw.query('BEGIN') // one transaction, as lib/accounts.js redeemTeamLink
    await raw.query('INSERT INTO public.invite_redemptions (invite_id, user_id) VALUES ($1, $2)', [inv.id, uid])
    await raw.query('INSERT INTO public.team_managers (team_id, user_id) VALUES ($1, $2)', [team, uid])
    await raw.query("INSERT INTO public.audit_log (action, target_user_id, details) VALUES ('invite.redeem', $1, jsonb_build_object('invite_id', $2::text, 'role', 'team_manager', 'team_id', $3::text, 'club_id', $4::text))", [uid, inv.id, team, club])
    await raw.query('COMMIT')
    assert.equal((await raw.query('SELECT 1 FROM public.account_clubs WHERE user_id = $1', [uid])).rowCount, 1, 'db/030 made it a member')
    await raw.query('DELETE FROM public.club_teams WHERE id = $1', [team]) // lib/clubs.js: a team taken off the club's list
    await raw.query(MIGRATION)
    const left = (await raw.query('SELECT club_id FROM public.account_clubs WHERE user_id = $1', [uid])).rowCount
    assert.equal(left, 0, 'no club membership after 036')
  })
})
