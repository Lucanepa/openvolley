// lib/manageApi.js: who reaches POST /api/admin/matches/:id/reopen, without a
// database. A beach competition manager reaches it (accounts.reopenMatch then
// checks the match's own sport); every other admin route stays admin-only.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createManageApi } from '../lib/manageApi.js'
import { accessFromRoles } from '../lib/access.js'

const ID = '6f1c2a9b-0000-4000-8000-000000000001'

function setup () {
  const calls = []
  const accounts = {
    reopenMatch: async (args) => { calls.push(args); return { status: 200, body: { data: 'reopened', error: null } } },
    releaseGame: async () => ({ status: 200, body: { data: 'released', error: null } }),
    listMatches: async () => ({ status: 200, body: { data: [], error: null } })
  }
  const api = createManageApi({ accounts, savedTeams: {} })
  const route = (roles, method, pathname, body) =>
    api.route({ method, pathname, query: new URLSearchParams(), body, user: { id: 'u1' }, access: accessFromRoles(roles), ip: '203.0.113.7' })
  return { calls, route }
}

describe('manageApi: reopening a closed match', () => {
  it('an admin and a beach competition manager reach the handler, with their access', async () => {
    for (const roles of [['admin'], ['super_admin'], ['beach:competition_manager']]) {
      const { calls, route } = setup()
      const r = await route(roles, 'POST', `/api/admin/matches/${ID}/reopen`, { reason: 'Wrong pair' })
      assert.equal(r.status, 200, roles.join())
      assert.equal(calls.length, 1)
      assert.equal(calls[0].matchId, ID)
      assert.equal(calls[0].access.isAdmin, roles[0] !== 'beach:competition_manager')
      assert.deepEqual(calls[0].body, { reason: 'Wrong pair' })
    }
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
    for (const [method, path] of [['POST', `/api/admin/matches/${ID}/release-game`], ['GET', '/api/admin/matches'], ['GET', `/api/admin/matches/${ID}/reopen`], ['POST', `/api/admin/matches/${ID}/reopen/x`]]) {
      const r = await route(['beach:competition_manager'], method, path, { reason: 'Wrong pair' })
      assert.equal(r.status, 403, `${method} ${path}`)
    }
  })
})
