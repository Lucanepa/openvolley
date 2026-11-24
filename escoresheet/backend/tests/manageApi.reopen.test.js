// lib/manageApi.js: who reaches POST /api/admin/matches/:id/reopen, without a
// database. A beach competition manager reaches it for a beach match it
// manages (owner decision 5, PERM-09: lib/beachTournaments.js managesMatch;
// accounts.reopenMatch then checks the match's own sport); every other admin
// route stays admin-only.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createManageApi } from '../lib/manageApi.js'
import { accessFromRoles } from '../lib/access.js'

const ID = '6f1c2a9b-0000-4000-8000-000000000001'

const USER = '6f1c2a9b-0000-4000-8000-0000000000aa'

function setup ({ manages = { sport: 'beach', manages: true } } = {}) {
  const calls = []
  const asked = []
  const accounts = {
    reopenMatch: async (args) => { calls.push(args); return { status: 200, body: { data: 'reopened', error: null } } },
    releaseGame: async () => ({ status: 200, body: { data: 'released', error: null } }),
    listMatches: async () => ({ status: 200, body: { data: [], error: null } })
  }
  const beach = { managesMatch: async (args) => { asked.push(args); return manages } }
  const api = createManageApi({ accounts, savedTeams: {}, beach })
  const route = (roles, method, pathname, body) =>
    api.route({ method, pathname, query: new URLSearchParams(), body, user: { id: USER }, access: accessFromRoles(roles), ip: '203.0.113.7' })
  return { calls, asked, route }
}

describe('manageApi: reopening a closed match', () => {
  it('an admin and a beach competition manager of the match reach the handler, with their access', async () => {
    for (const roles of [['admin'], ['super_admin'], ['beach:competition_manager']]) {
      const { calls, asked, route } = setup()
      const r = await route(roles, 'POST', `/api/admin/matches/${ID}/reopen`, { reason: 'Wrong pair' })
      assert.equal(r.status, 200, roles.join())
      assert.equal(calls.length, 1)
      assert.equal(calls[0].matchId, ID)
      assert.equal(calls[0].access.isAdmin, roles[0] !== 'beach:competition_manager')
      assert.deepEqual(calls[0].body, { reason: 'Wrong pair' })
      // only a beach competition manager is asked about the match (an admin reopens every one)
      assert.deepEqual(asked, roles[0] === 'beach:competition_manager' ? [{ userId: USER, matchId: ID }] : [])
    }
  })

  it('owner decision 5: a beach competition manager is refused a match it does not manage, and an indoor one', async () => {
    for (const manages of [{ sport: 'beach', manages: false }, { sport: 'indoor', manages: true }, { sport: 'indoor', manages: false }]) {
      const { calls, route } = setup({ manages })
      const r = await route(['beach:competition_manager'], 'POST', `/api/admin/matches/${ID}/reopen`, { reason: 'Wrong pair' })
      assert.equal(r.status, 403, JSON.stringify(manages))
      assert.equal(r.body.error.code, 'OV_FORBIDDEN')
      assert.equal(calls.length, 0)
    }
    // an admin still reopens it
    const { calls, route } = setup({ manages: { sport: 'beach', manages: false } })
    assert.equal((await route(['admin'], 'POST', `/api/admin/matches/${ID}/reopen`, { reason: 'Wrong pair' })).status, 200)
    assert.equal(calls.length, 1)
  })

  it('an unknown match is the handler\'s answer; a database error is 503', async () => {
    const unknown = setup({ manages: null })
    assert.equal((await unknown.route(['beach:competition_manager'], 'POST', `/api/admin/matches/${ID}/reopen`, { reason: 'Wrong pair' })).status, 200)
    assert.equal(unknown.calls.length, 1, 'reopenMatch answers 404 itself')
    const down = setup({ manages: { error: { status: 503, body: { data: null, error: { code: 'OV_DB_UNAVAILABLE' } } } } })
    const r = await down.route(['beach:competition_manager'], 'POST', `/api/admin/matches/${ID}/reopen`, { reason: 'Wrong pair' })
    assert.equal(r.status, 503)
    assert.equal(down.calls.length, 0)
  })

  it('a server built without the tournaments module: a beach competition manager is refused', async () => {
    const calls = []
    const api = createManageApi({ accounts: { reopenMatch: async (a) => { calls.push(a); return { status: 200, body: {} } } }, savedTeams: {} })
    const r = await api.route({ method: 'POST', pathname: `/api/admin/matches/${ID}/reopen`, query: new URLSearchParams(), body: { reason: 'Wrong pair' }, user: { id: USER }, access: accessFromRoles(['beach:competition_manager']) })
    assert.equal(r.status, 403)
    assert.equal(calls.length, 0)
  })

  it('scorers, referees and an indoor competition manager are refused before the handler', async () => {
    for (const roles of [['scorer'], ['referee'], ['competition_manager'], ['beach:scorer'], ['beach:referee'], []]) {
      const { calls, route } = setup()
      const r = await route(roles, 'POST', `/api/admin/matches/${ID}/reopen`, { reason: 'Wrong pair' })
      assert.equal(r.status, 403, roles.join())
      assert.equal(r.body.error.code, 'OV_FORBIDDEN')
      assert.equal(calls.length, 0)
    }
  })

  it('a beach competition manager reaches no other admin route', async () => {
    const { route } = setup()
    for (const [method, path] of [['POST', `/api/admin/matches/${ID}/release-game`], ['GET', '/api/admin/matches'], ['GET', `/api/admin/matches/${ID}/reopen`], ['POST', `/api/admin/matches/${ID}/reopen/x`],
      // the game PIN (read and new one): admins only
      ['GET', `/api/admin/matches/${ID}/pin`], ['POST', `/api/admin/matches/${ID}/pin`]]) {
      const r = await route(['beach:competition_manager'], method, path, { reason: 'Wrong pair' })
      assert.equal(r.status, 403, `${method} ${path}`)
    }
  })
})
