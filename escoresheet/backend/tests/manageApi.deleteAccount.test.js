// An admin deletes an account or rejects a sign-up (POST
// /api/admin/accounts/:id/delete|reject), without a database: who reaches
// the handler (lib/manageApi.js) and the answers lib/accounts.js gives before
// it reads anything. The database rules (super admins, the deletion itself)
// are in tests/accountDelete.e2e.test.js.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createManageApi } from '../lib/manageApi.js'
import { createAccounts, AUDIT_ACTIONS } from '../lib/accounts.js'
import { accessFromRoles } from '../lib/access.js'

const ID = '6f1c2a9b-0000-4000-8000-000000000001'
const SELF = '6f1c2a9b-0000-4000-8000-0000000000aa'

function setup () {
  const calls = []
  const accounts = {
    deleteAccount: async (args) => { calls.push(args); return { status: 200, body: { data: { id: args.userId, deleted: true }, error: null } } }
  }
  const api = createManageApi({ accounts, savedTeams: {} })
  const route = (roles, method, pathname, body) =>
    api.route({ method, pathname, query: new URLSearchParams(), body, user: { id: SELF }, access: accessFromRoles(roles), ip: '203.0.113.7' })
  return { calls, route }
}

describe('manageApi: deleting an account', () => {
  it('admins and super admins reach the handler, with their access; reject is the same handler with reject: true', async () => {
    for (const roles of [['admin'], ['super_admin']]) {
      const { calls, route } = setup()
      assert.equal((await route(roles, 'POST', `/api/admin/accounts/${ID}/delete`, { email: 'a@example.ch' })).status, 200)
      assert.equal((await route(roles, 'POST', `/api/admin/accounts/${ID.toUpperCase()}/reject`, { email: 'a@example.ch' })).status, 200)
      assert.equal(calls.length, 2)
      assert.equal(calls[0].userId, ID)
      assert.equal(calls[1].userId, ID, 'ids are compared lower-case')
      assert.equal(calls[0].reject, undefined)
      assert.equal(calls[1].reject, true)
      assert.equal(calls[0].actor.id, SELF)
      assert.equal(calls[0].actor.access.isSuperAdmin, roles[0] === 'super_admin')
      assert.deepEqual(calls[0].body, { email: 'a@example.ch' })
    }
  })

  it('everyone else is refused before the handler', async () => {
    for (const roles of [['scorer'], ['referee'], ['competition_manager'], ['beach:competition_manager'], ['beach:scorer'], []]) {
      const { calls, route } = setup()
      for (const action of ['delete', 'reject']) {
        const r = await route(roles, 'POST', `/api/admin/accounts/${ID}/${action}`, { email: 'a@example.ch' })
        assert.equal(r.status, 403, `${roles.join()} ${action}`)
        assert.equal(r.body.error.code, 'OV_FORBIDDEN')
      }
      assert.equal(calls.length, 0)
    }
  })

  it('only POST; a malformed id is 404', async () => {
    const { calls, route } = setup()
    assert.equal((await route(['admin'], 'GET', `/api/admin/accounts/${ID}/delete`)).status, 405)
    assert.equal((await route(['admin'], 'DELETE', `/api/admin/accounts/${ID}/delete`)).status, 405)
    assert.equal((await route(['admin'], 'POST', '/api/admin/accounts/not-a-uuid/delete', {})).status, 404)
    assert.equal(calls.length, 0)
  })
})

describe('accounts.deleteAccount: the answers before the database', () => {
  // A pool that fails the test when it is touched
  const pool = { query: () => { throw new Error('the database was used') }, connect: () => { throw new Error('the database was used') } }
  const actor = { id: SELF, access: accessFromRoles(['admin']) }
  const erase = async () => { throw new Error('erase was called') }

  it('a server without the deletion (no eraseAccount) answers 404, as an older backend does, and its list says so', async () => {
    const accounts = createAccounts({ pool, db: {}, restore: {}, access: null })
    const r = await accounts.deleteAccount({ actor, userId: ID, body: { email: 'a@example.ch' } })
    assert.equal(r.status, 404)
    assert.equal(r.body.error.code, 'OV_NOT_FOUND')
  })

  it('the caller\'s own account, a missing address and a bad id are refused', async () => {
    const accounts = createAccounts({ pool, db: {}, restore: {}, access: null, eraseAccount: erase })
    let r = await accounts.deleteAccount({ actor, userId: SELF, body: { email: 'me@example.ch' } })
    assert.equal(r.status, 409)
    assert.equal(r.body.error.code, 'OV_SELF_DELETE')
    r = await accounts.deleteAccount({ actor, userId: SELF, body: { email: 'me@example.ch' }, reject: true })
    assert.equal(r.body.error.code, 'OV_SELF_DELETE')
    for (const body of [undefined, {}, { email: '' }, { email: 7 }, { email: 'x'.repeat(255) }]) {
      r = await accounts.deleteAccount({ actor, userId: ID, body })
      assert.equal(r.status, 400, JSON.stringify(body))
      assert.equal(r.body.error.code, 'OV_INVALID_REQUEST')
    }
    r = await accounts.deleteAccount({ actor, userId: 'nope', body: { email: 'a@example.ch' } })
    assert.equal(r.status, 404)
  })

  it('the two audit actions are known', () => {
    assert.ok(AUDIT_ACTIONS.includes('account.delete'))
    assert.ok(AUDIT_ACTIONS.includes('account.reject'))
  })
})
