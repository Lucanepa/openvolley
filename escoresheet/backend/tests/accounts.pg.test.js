// lib/accounts.js on Postgres: invite codes, role changes, admin match
// actions (reopen, release game, editors) and the audit log.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { createPgQuery } from '../lib/pgQuery.js'
import { createMatchRestore } from '../lib/matchRestore.js'
import { createAccessResolver, accessFromRoles } from '../lib/access.js'
import { createAccounts, normalizeInviteCode, hashInviteCode, generateInviteCode, INVITE_ALPHABET } from '../lib/accounts.js'
import { SKIP_PG, createTestDatabase, quietLogger } from './helpers/pgTestDb.js'

describe('invite code helpers (pure)', () => {
  it('generates 12 Crockford characters shown as XXXX-XXXX-XXXX', () => {
    for (let i = 0; i < 50; i++) {
      const { code, normalized } = generateInviteCode()
      assert.match(code, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/)
      assert.equal(code.replace(/-/g, ''), normalized)
      for (const ch of normalized) assert.ok(INVITE_ALPHABET.includes(ch), ch)
    }
  })
  it('normalises case, spaces, dashes and O/I/L', () => {
    assert.equal(normalizeInviteCode(' abcd-efgh-jkmn '), 'ABCDEFGHJKMN')
    assert.equal(normalizeInviteCode('oOiI LlAB CDEF'), '001111ABCDEF')
    assert.equal(normalizeInviteCode('ABCD-EFGH-JKM'), null, 'too short')
    assert.equal(normalizeInviteCode('ABCD-EFGH-JKMU'), null, 'U is not in the alphabet')
    assert.equal(normalizeInviteCode(42), null)
    assert.equal(hashInviteCode('ABCDEFGHJKMN').length, 32)
  })
})

describe('accounts on Postgres', { skip: SKIP_PG }, () => {
  let tdb, pool, db, restore, access, accounts, logger
  const ids = {}
  let gameSeq = 81000

  async function user (name, roles = [], { profile = true } = {}) {
    const id = randomUUID()
    await pool.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `${name}@example.ch`])
    if (profile) await pool.query('INSERT INTO public.profiles (user_id, first_name, last_name, roles) VALUES ($1, $2, $3, $4)', [id, name[0].toUpperCase() + name.slice(1), 'Test', roles])
    ids[name] = id
    return id
  }
  const rolesOf = async (id) => (await pool.query('SELECT roles FROM public.profiles WHERE user_id = $1', [id])).rows[0]?.roles
  const auditOf = async (action) => (await pool.query('SELECT * FROM public.audit_log WHERE action = $1 ORDER BY id', [action])).rows
  const actor = (name, roles) => ({ id: ids[name], access: accessFromRoles(roles) })

  before(async () => {
    tdb = await createTestDatabase('accounts')
    logger = quietLogger()
    pool = new pg.Pool({ connectionString: tdb.url, options: '-c TimeZone=UTC' })
    db = createPgQuery({ pool, logger })
    restore = createMatchRestore(db, { logger })
    access = createAccessResolver({ pool })
    accounts = createAccounts({ pool, db, restore, access, logger })
    await user('admin', ['admin'])
    await user('boss', ['super_admin'])
    await user('pending', [])
    await user('pending2', [])
    await user('scorer', ['scorer'])
    await user('noprofile', [], { profile: false })
  })
  after(async () => {
    await pool?.end()
    await tdb?.drop()
  })

  describe('invites', () => {
    it('creates a code that is shown once and stored only as a hash', async () => {
      const r = await accounts.createInvite({ actorId: ids.admin, body: { label: 'VBC Test', club: 'VBC', max_uses: 2 } })
      assert.equal(r.status, 201, JSON.stringify(r.body))
      const { invite, code } = r.body.data
      assert.match(code, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/)
      assert.equal(invite.code_hint, code.slice(-4))
      assert.equal(invite.role, 'scorer')
      assert.equal(invite.state, 'active')
      assert.equal(invite.max_uses, 2)
      assert.equal(invite.created_by_name, 'Admin Test')
      assert.ok(Math.abs(new Date(invite.expires_at) - Date.now() - 30 * 86400000) < 60000, 'expires in 30 days')
      // No plaintext anywhere in the table or the audit log
      const plain = code.replace(/-/g, '')
      const { rows } = await pool.query('SELECT row_to_json(i)::text AS t FROM public.invite_codes i')
      for (const { t } of rows) assert.equal(t.includes(plain) || t.includes(code), false)
      const { rows: [h] } = await pool.query('SELECT code_hash FROM public.invite_codes WHERE id = $1', [invite.id])
      assert.deepEqual(h.code_hash, hashInviteCode(plain))
      assert.equal(JSON.stringify(await auditOf('invite.create')).includes(plain), false)
      assert.equal(JSON.stringify(logger.lines).includes(plain), false)
      // listed without the code
      const list = await accounts.listInvites()
      assert.equal(JSON.stringify(list.body).includes(plain), false)
      assert.ok(list.body.data.invites.some((i) => i.id === invite.id))
    })

    it('validates the create body', async () => {
      const bad = async (body, code = 'OV_INVALID_REQUEST') => {
        const r = await accounts.createInvite({ actorId: ids.admin, body })
        assert.equal(r.status, 400, JSON.stringify(body))
        assert.equal(r.body.error.code, code)
      }
      await bad({})
      await bad({ label: 'x'.repeat(121) })
      await bad({ label: 'ok', role: 'admin' }, 'OV_INVALID_ROLE')
      await bad({ label: 'ok', max_uses: 0 })
      await bad({ label: 'ok', max_uses: 10001 })
      await bad({ label: 'ok', expires_at: 'soon' })
      await bad({ label: 'ok', expires_at: '2001-01-01T00:00:00Z' })
      const unlimited = await accounts.createInvite({ actorId: ids.admin, body: { label: 'Open', role: 'referee', max_uses: null, expires_at: null } })
      assert.equal(unlimited.status, 201)
      assert.equal(unlimited.body.data.invite.max_uses, null)
      assert.equal(unlimited.body.data.invite.expires_at, null)
    })

    it('redeems once per account, normalising the typed code; max uses, idempotent re-redeem', async () => {
      const { body: { data: { code, invite } } } = await accounts.createInvite({ actorId: ids.admin, body: { label: 'Two uses', max_uses: 2 } })
      const typed = code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l')
      const r = await accounts.redeemInvite({ userId: ids.pending, code: typed })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.deepEqual(r.body.data, { roles: ['scorer'], role_granted: 'scorer', already_had: false })
      assert.deepEqual(await rolesOf(ids.pending), ['scorer'])
      assert.equal((await access.get(ids.pending)).canScore, true, 'access cache invalidated')
      // again: idempotent, not counted
      const again = await accounts.redeemInvite({ userId: ids.pending, code })
      assert.equal(again.status, 200)
      assert.equal(again.body.data.already_had, true)
      assert.deepEqual(await rolesOf(ids.pending), ['scorer'], 'role added once')
      // an account without a profile row gets one
      assert.equal((await accounts.redeemInvite({ userId: ids.noprofile, code })).status, 200)
      assert.deepEqual(await rolesOf(ids.noprofile), ['scorer'])
      // used up
      const used = await accounts.redeemInvite({ userId: ids.pending2, code })
      assert.equal(used.status, 409)
      assert.equal(used.body.error.code, 'OV_INVITE_USED_UP')
      const { rows: [inv] } = await pool.query('SELECT uses FROM public.invite_codes WHERE id = $1', [invite.id])
      assert.equal(inv.uses, 2)
      const redeems = (await auditOf('invite.redeem')).filter((a) => a.details.invite_id === invite.id)
      assert.equal(redeems.length, 2)
      assert.equal(redeems[0].target_user_id, ids.pending)
      assert.deepEqual(redeems[0].details, { invite_id: invite.id, label: 'Two uses', role: 'scorer' })
    })

    it('expired is 410, revoked and unknown are 404, garbage is 400', async () => {
      const exp = await accounts.createInvite({ actorId: ids.admin, body: { label: 'Expiring', expires_at: new Date(Date.now() + 60000).toISOString() } })
      await pool.query("UPDATE public.invite_codes SET expires_at = now() - interval '1 minute' WHERE id = $1", [exp.body.data.invite.id])
      const r1 = await accounts.redeemInvite({ userId: ids.pending2, code: exp.body.data.code })
      assert.equal(r1.status, 410)
      assert.equal(r1.body.error.code, 'OV_INVITE_EXPIRED')

      const rev = await accounts.createInvite({ actorId: ids.admin, body: { label: 'Revoked' } })
      const rv = await accounts.revokeInvite({ actorId: ids.admin, id: rev.body.data.invite.id })
      assert.equal(rv.status, 200)
      assert.equal(rv.body.data.invite.state, 'revoked')
      assert.equal((await accounts.revokeInvite({ actorId: ids.admin, id: rev.body.data.invite.id })).status, 200, 'idempotent')
      assert.equal((await auditOf('invite.revoke')).filter((a) => a.details.invite_id === rev.body.data.invite.id).length, 1)
      const r2 = await accounts.redeemInvite({ userId: ids.pending2, code: rev.body.data.code })
      assert.equal(r2.status, 404)
      assert.equal(r2.body.error.code, 'OV_INVITE_INVALID')
      assert.equal((await accounts.redeemInvite({ userId: ids.pending2, code: 'ZZZZ-ZZZZ-ZZZZ' })).body.error.code, 'OV_INVITE_INVALID')
      assert.equal((await accounts.redeemInvite({ userId: ids.pending2, code: 'nope' })).status, 404)
      assert.equal((await accounts.redeemInvite({ userId: ids.pending2 })).status, 400)
      assert.equal((await accounts.revokeInvite({ actorId: ids.admin, id: randomUUID() })).status, 404)
      assert.deepEqual(await rolesOf(ids.pending2), [])
    })

    it('a competition manager code grants that role', async () => {
      const { body: { data: { code } } } = await accounts.createInvite({ actorId: ids.admin, body: { label: 'CM', role: 'competition_manager' } })
      const id = await user('cm', [])
      const r = await accounts.redeemInvite({ userId: id, code })
      assert.deepEqual(r.body.data.roles, ['competition_manager'])
    })
  })

  describe('roles', () => {
    it('lists pending accounts and all accounts, with search', async () => {
      const id = await user('fresh', [])
      const pend = await accounts.listAccounts({ filter: 'pending' })
      assert.equal(pend.status, 200)
      const fresh = pend.body.data.accounts.find((a) => a.id === id)
      assert.deepEqual(Object.keys(fresh).sort(), ['created_at', 'email', 'first_name', 'id', 'last_name', 'last_sign_in_at', 'pending', 'roles'])
      assert.equal(fresh.pending, true)
      assert.equal(pend.body.data.accounts.some((a) => a.id === ids.admin), false)
      const all = await accounts.listAccounts({ filter: 'all', q: 'adm' })
      assert.deepEqual(all.body.data.accounts.map((a) => a.id), [ids.admin])
      assert.equal((await accounts.listAccounts({ filter: 'x' })).status, 400)
      assert.equal((await accounts.listAccounts({ limit: '0' })).status, 400)
      assert.equal((await accounts.listAccounts({ q: '%' })).body.data.accounts.length, 0, 'LIKE wildcards are literal')
    })

    it('grants and revokes, audits, invalidates the access cache', async () => {
      const id = await user('approve', [])
      assert.equal((await access.get(id)).canScore, false)
      const r = await accounts.setRoles({ actor: actor('admin', ['admin']), userId: id, body: { add: ['scorer', 'Referee'] } })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.deepEqual(r.body.data, { id, roles: ['scorer', 'referee'] })
      assert.equal((await access.get(id)).canScore, true)
      const r2 = await accounts.setRoles({ actor: actor('admin', ['admin']), userId: id, body: { remove: ['referee'], add: ['competition_manager'] } })
      assert.deepEqual(r2.body.data.roles, ['scorer', 'competition_manager'])
      const entries = (await auditOf('account.roles')).filter((a) => a.target_user_id === id)
      assert.equal(entries.length, 2)
      assert.deepEqual(entries[1].details, { added: ['competition_manager'], removed: ['referee'], before: ['scorer', 'referee'], after: ['scorer', 'competition_manager'] })
      assert.equal(entries[1].actor_id, ids.admin)
    })

    it('refuses unknown roles, super_admin targets (unless super admin), self-demotion; creates a missing profile', async () => {
      const a = actor('admin', ['admin'])
      const bad = await accounts.setRoles({ actor: a, userId: ids.scorer, body: { add: ['super_admin'] } })
      assert.equal(bad.status, 400)
      assert.equal(bad.body.error.code, 'OV_INVALID_ROLE')
      assert.equal((await accounts.setRoles({ actor: a, userId: ids.scorer, body: { add: ['wizard'] } })).body.error.code, 'OV_INVALID_ROLE')
      assert.equal((await accounts.setRoles({ actor: a, userId: ids.scorer, body: {} })).status, 400)
      assert.equal((await accounts.setRoles({ actor: a, userId: ids.scorer, body: { add: ['a', 'b', 'c', 'd', 'e'] } })).status, 400)

      const sup = await accounts.setRoles({ actor: a, userId: ids.boss, body: { add: ['scorer'] } })
      assert.equal(sup.status, 403)
      assert.equal(sup.body.error.code, 'OV_FORBIDDEN')
      const bySuper = await accounts.setRoles({ actor: actor('boss', ['super_admin']), userId: ids.boss, body: { add: ['scorer'] } })
      assert.deepEqual(bySuper.body.data.roles, ['super_admin', 'scorer'], 'super_admin itself is kept')

      const self = await accounts.setRoles({ actor: a, userId: ids.admin, body: { remove: ['admin'] } })
      assert.equal(self.status, 409)
      assert.equal(self.body.error.code, 'OV_SELF_DEMOTE')
      assert.deepEqual(await rolesOf(ids.admin), ['admin'])

      assert.equal((await accounts.setRoles({ actor: a, userId: randomUUID(), body: { add: ['scorer'] } })).status, 404)
      const np = await user('np2', [], { profile: false })
      assert.equal((await accounts.setRoles({ actor: a, userId: np, body: { add: ['referee'] } })).status, 200)
      assert.deepEqual(await rolesOf(np), ['referee'])
    })
  })

  describe('matches', () => {
    async function closedMatch ({ status = 'final' } = {}) {
      const ext = `adm_${randomUUID().slice(0, 8)}`
      const n = gameSeq++
      const r = await db.runQuery({ table: 'matches', action: 'insert', params: { data: { external_id: ext, game_n: n, status: 'live', home_team: { name: 'Home Club' } }, returning: 'id', single: true } },
        { proto: 2, matchOwner: { userId: ids.scorer }, actorId: ids.scorer })
      const id = r.body.data.id
      await db.runQuery({ table: 'matches', action: 'update', params: { data: { status, approval: { ok: true } }, filters: [{ type: 'eq', column: 'id', value: id }] } },
        { proto: 2, matchOwner: { userId: ids.scorer }, actorId: ids.scorer })
      return { id, ext, n }
    }

    it('reopen: 409 on an open match, clears closed_*, audits the reason, writes work after', async () => {
      const m = await closedMatch()
      const lst = await accounts.listMatches({ state: 'closed', q: String(m.n) })
      assert.equal(lst.body.data.matches.length, 1)
      assert.equal(lst.body.data.matches[0].closed_by_name, 'Scorer Test')
      assert.equal(lst.body.data.matches[0].scorer_email, 'scorer@example.ch')
      assert.equal((await accounts.listMatches({ state: 'open', q: String(m.n) })).body.data.matches.length, 0)
      assert.equal((await accounts.listMatches({ q: 'home club', state: 'all' })).body.data.matches.length > 0, true)

      assert.equal((await accounts.reopenMatch({ actorId: ids.admin, matchId: m.id, body: { reason: 'x' } })).status, 400)
      const r = await accounts.reopenMatch({ actorId: ids.admin, matchId: m.id, body: { reason: 'Wrong final score' } })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.deepEqual(r.body.data.match, { id: m.id, external_id: m.ext, status: 'ended', closed_at: null })
      assert.equal(r.changes[0].row.status, 'ended')
      const { rows: [row] } = await pool.query('SELECT status, approval, closed_at, closed_by FROM matches WHERE id = $1', [m.id])
      assert.deepEqual(row, { status: 'ended', approval: null, closed_at: null, closed_by: null })
      const [entry] = (await auditOf('match.reopen')).filter((a) => a.match_id === m.id)
      assert.equal(entry.actor_id, ids.admin)
      assert.deepEqual(entry.details, { reason: 'Wrong final score', from_status: 'final', external_id: m.ext, game_n: m.n })
      // the scorer may write again, and closing again closes again
      const w = await db.runQuery({ table: 'sets', action: 'insert', params: { data: { external_id: `${m.ext}:s:9`, match_id: m.id, index: 9 } } },
        { proto: 2, matchOwner: { userId: ids.scorer }, actorId: ids.scorer })
      assert.equal(w.status, 200, JSON.stringify(w.body))
      const again = await accounts.reopenMatch({ actorId: ids.admin, matchId: m.id, body: { reason: 'Again please' } })
      assert.equal(again.status, 409)
      assert.equal(again.body.error.code, 'OV_NOT_CLOSED')
      assert.equal((await accounts.reopenMatch({ actorId: ids.admin, matchId: randomUUID(), body: { reason: 'nope nope' } })).status, 404)
    })

    it('release game works on a closed match and frees the key', async () => {
      const m = await closedMatch()
      const r = await accounts.releaseGame({ actorId: ids.admin, matchId: m.id, body: { reason: 'Wrong game number' } })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.deepEqual(r.body.data.match, { id: m.id, official_game_exempt: true })
      const { rows: [row] } = await pool.query('SELECT official_game_exempt, closed_at, status FROM matches WHERE id = $1', [m.id])
      assert.equal(row.official_game_exempt, true)
      assert.ok(row.closed_at, 'still closed')
      // another scorer may now create the game
      const other = await user('other', ['scorer'])
      const ins = await db.runQuery({ table: 'matches', action: 'insert', params: { data: { external_id: `rel_${m.n}`, game_n: m.n } } }, { proto: 2, matchOwner: { userId: other }, actorId: other })
      assert.equal(ins.status, 200, JSON.stringify(ins.body))
      assert.equal((await auditOf('match.release_game')).filter((a) => a.match_id === m.id).length, 1)
    })

    it('adds an editor by email', async () => {
      const m = await closedMatch({ status: 'live' })
      const r = await accounts.addMatchEditor({ actorId: ids.admin, matchId: m.id, body: { email: 'PENDING2@example.ch' } })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.deepEqual(r.body.data, { role: 'editor' })
      assert.equal((await pool.query('SELECT granted_via FROM match_editors WHERE match_id = $1 AND user_id = $2', [m.id, ids.pending2])).rows[0].granted_via, 'admin')
      assert.equal((await accounts.addMatchEditor({ actorId: ids.admin, matchId: m.id, body: { email: 'scorer@example.ch' } })).body.data.role, 'creator')
      assert.equal((await accounts.addMatchEditor({ actorId: ids.admin, matchId: m.id, body: { email: 'ghost@example.ch' } })).status, 404)
      assert.equal((await accounts.addMatchEditor({ actorId: ids.admin, matchId: randomUUID(), body: { email: 'scorer@example.ch' } })).status, 404)
      const [entry] = (await auditOf('match.editor_add')).filter((a) => a.match_id === m.id)
      assert.equal(entry.target_user_id, ids.pending2)
    })

    it('official games list the claim matched by number and season', async () => {
      await pool.query(`INSERT INTO public.svrz_games (game_number, datetime, league, team_home, team_away) VALUES
        ('${gameSeq}', '2026-10-10T16:00:00', '2L', 'A', 'B'), ('${gameSeq + 1}', '2026-10-11T16:00:00', '3L', 'C', 'D')`)
      await db.runQuery({ table: 'matches', action: 'insert', params: { data: { external_id: `og_${gameSeq}`, game_n: gameSeq, scheduled_at: '2026-10-10T14:00:00Z' } } },
        { proto: 2, matchOwner: { userId: ids.scorer }, actorId: ids.scorer })
      // the same number last season is not this game's claim
      await db.runQuery({ table: 'matches', action: 'insert', params: { data: { external_id: `og_old_${gameSeq + 1}`, game_n: gameSeq + 1, scheduled_at: '2025-10-10T14:00:00Z' } } },
        { proto: 2, matchOwner: { userId: ids.scorer }, actorId: ids.scorer })
      const r = await accounts.listOfficialGames({ from: '2026-10-09', to: '2026-10-12' })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      const [g1, g2] = r.body.data.games
      assert.equal(g1.claim.scorer_name, 'Scorer Test')
      assert.equal(g1.claim.external_id, `og_${gameSeq}`)
      assert.equal(g2.claim, null)
      assert.equal((await accounts.listOfficialGames({ from: '2026-10-09', to: '2026-10-12', q: '3l' })).body.data.games.length, 1)
      assert.equal((await accounts.listOfficialGames({ from: '2026-01-01', to: '2026-12-31' })).status, 400, 'span')
      assert.equal((await accounts.listOfficialGames({ from: '2026-13-01' })).status, 400)
      assert.equal((await accounts.listOfficialGames({})).status, 200, 'default window')
      gameSeq += 2
    })
  })

  describe('findTakenGame (the friendly official-game check)', () => {
    const asScorer = (id) => ({ proto: 2, matchOwner: { userId: id }, actorId: id })
    const insert = (data, id = ids.scorer) => db.runQuery({ table: 'matches', action: 'insert', params: { data } }, asScorer(id))

    it('checks the season VolleyManager knows, so a shifted date cannot open a second match', async () => {
      const n = gameSeq++
      await pool.query("INSERT INTO public.svrz_games (game_number, datetime, league) VALUES ($1, '2026-10-10T18:00:00', '2L')", [String(n)])
      assert.equal((await insert({ external_id: `vm_a_${n}`, game_n: n, scheduled_at: '2026-10-10T16:00:00Z' })).status, 200)
      const rival = await user(`rival${n}`, ['scorer'])
      // same key: taken (as before)
      assert.equal((await accounts.findTakenGame({ userId: rival, rows: [{ external_id: `vm_b_${n}`, game_n: n, scheduled_at: '2026-10-10T16:00:00Z' }] }))?.game_n, n)
      // review: a date one season later, or no date and an old created_at
      for (const row of [
        { external_id: `vm_c_${n}`, game_n: n, scheduled_at: '2027-10-10T16:00:00Z' },
        { external_id: `vm_d_${n}`, game_n: n, scheduled_at: null, created_at: '2024-10-10T16:00:00Z' }
      ]) {
        const claim = await accounts.findTakenGame({ userId: rival, rows: [row] })
        assert.ok(claim, JSON.stringify(row))
        assert.equal(claim.season, 2026)
        assert.equal(claim.mine, false)
      }
      // beach, a test match: no claim
      assert.equal(await accounts.findTakenGame({ userId: rival, rows: [{ external_id: `vm_e_${n}`, game_n: n, sport_type: 'beach', scheduled_at: '2027-10-10T16:00:00Z' }] }), null)
      assert.equal(await accounts.findTakenGame({ userId: rival, rows: [{ external_id: `vm_f_${n}`, game_n: n, test: true }] }), null)
    })

    it('leaves a stored match whose key does not change alone (an old season re-synced), and merges partial upserts', async () => {
      const n = gameSeq++
      // last season's match, then the number comes back this season and is claimed
      assert.equal((await insert({ external_id: `old_${n}`, game_n: n, scheduled_at: '2025-10-10T16:00:00Z' })).status, 200)
      await pool.query("INSERT INTO public.svrz_games (game_number, datetime, league) VALUES ($1, '2026-11-10T18:00:00', '2L')", [String(n)])
      const rival = await user(`now${n}`, ['scorer'])
      assert.equal((await insert({ external_id: `new_${n}`, game_n: n, scheduled_at: '2026-11-10T16:00:00Z' }, rival)).status, 200)
      // the old match's sync upserts (full, or partial without the date) pass
      assert.equal(await accounts.findTakenGame({ userId: ids.scorer, rows: [{ external_id: `old_${n}`, game_n: n, scheduled_at: '2025-10-10T16:00:00Z', status: 'live' }] }), null)
      assert.equal(await accounts.findTakenGame({ userId: ids.scorer, rows: [{ external_id: `old_${n}`, status: 'ended' }] }), null)
      // moving it onto this season's game is caught
      assert.ok(await accounts.findTakenGame({ userId: ids.scorer, rows: [{ external_id: `old_${n}`, scheduled_at: '2026-11-10T16:00:00Z' }] }))
    })

    it('findTakenGameForUpdate checks the stored rows with the update over them', async () => {
      const a = gameSeq++
      const b = gameSeq++
      assert.equal((await insert({ external_id: `upd_a_${a}`, game_n: a, scheduled_at: '2026-10-10T16:00:00Z' })).status, 200)
      const rival = await user(`upd${b}`, ['scorer'])
      assert.equal((await insert({ external_id: `upd_b_${b}`, game_n: b, scheduled_at: '2026-10-10T16:00:00Z' }, rival)).status, 200)
      const filters = [{ type: 'eq', column: 'external_id', value: `upd_b_${b}` }]
      assert.equal((await accounts.findTakenGameForUpdate({ userId: rival, filters, data: { game_n: a } }))?.game_n, a)
      assert.equal(await accounts.findTakenGameForUpdate({ userId: rival, filters, data: { status: 'live' } }), null, 'not a key column')
      assert.equal(await accounts.findTakenGameForUpdate({ userId: rival, filters, data: { scheduled_at: '2026-10-12T16:00:00Z' } }), null, 'same key')
    })
  })

  describe('audit log', () => {
    it('pages newest first with next_before and filters by action', async () => {
      const p1 = await accounts.listAudit({ limit: 3 })
      assert.equal(p1.status, 200)
      assert.equal(p1.body.data.entries.length, 3)
      const idsDesc = p1.body.data.entries.map((e) => e.id)
      assert.deepEqual([...idsDesc].sort((a, b) => b - a), idsDesc)
      assert.equal(p1.body.data.next_before, idsDesc[2])
      const p2 = await accounts.listAudit({ limit: 3, before: p1.body.data.next_before })
      assert.ok(p2.body.data.entries.every((e) => e.id < idsDesc[2]))
      const only = await accounts.listAudit({ action: 'match.reopen', limit: 200 })
      assert.ok(only.body.data.entries.length >= 1)
      assert.ok(only.body.data.entries.every((e) => e.action === 'match.reopen'))
      assert.equal(only.body.data.next_before, null)
      assert.equal(only.body.data.entries[0].actor_email, 'admin@example.ch')
      assert.equal((await accounts.listAudit({ action: 'drop.table' })).status, 400)
      assert.equal((await accounts.listAudit({ limit: 201 })).status, 400)
      assert.equal((await accounts.listAudit({ before: 'x' })).status, 400)
      const closes = await accounts.listAudit({ action: 'match.close' })
      assert.ok(closes.body.data.entries.length >= 1, 'written by the trigger')
      assert.equal(closes.body.data.entries[0].actor_name, 'Scorer Test')
    })

    it('match.game_taken is written once per actor, game and season in 24 h', async () => {
      const claim = { match_id: randomUUID(), game_n: 99001, season: 2026, sport: 'indoor' }
      await accounts.auditGameTaken({ actorId: ids.scorer, claim })
      await accounts.auditGameTaken({ actorId: ids.scorer, claim })
      await accounts.auditGameTaken({ actorId: ids.scorer, claim: { ...claim, season: 2027 } })
      await accounts.auditGameTaken({ actorId: ids.admin, claim })
      const rows = (await auditOf('match.game_taken')).filter((a) => a.details.game_n === 99001)
      assert.equal(rows.length, 3)
    })
  })

  it('a database outage is 503 OV_DB_UNAVAILABLE, never a throw', async () => {
    const deadPool = new pg.Pool({ connectionString: 'postgres://nobody:x@127.0.0.1:1/none', connectionTimeoutMillis: 500 })
    const dead = createAccounts({ pool: deadPool, db, restore, access, logger })
    for (const r of [await dead.listInvites(), await dead.redeemInvite({ userId: ids.pending2, code: 'ABCD-EFGH-JKMN' }), await dead.listAudit({})]) {
      assert.equal(r.status, 503)
      assert.equal(r.body.error.code, 'OV_DB_UNAVAILABLE')
      assert.equal(r.body.error.retryable, true)
    }
    await deadPool.end()
  })
})
