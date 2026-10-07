// lib/manageApi.js routing of the account-approval endpoints
// (docs/account-approval-spec.md section 3), without a database.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createManageApi, manageFamilyOf } from '../lib/manageApi.js'

const SERVER_JS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'server.js'), 'utf8')
const ID = '6f1c2a9b-0000-4000-8000-000000000001'

describe('manageApi: account approvals', () => {
  it('families: approval PIN, approvals; the admin search is admin', () => {
    assert.equal(manageFamilyOf('/api/account/approval-pin'), 'approvalPin')
    assert.equal(manageFamilyOf('/api/account/approval-pin/remove'), 'approvalPin')
    assert.equal(manageFamilyOf('/api/account/approval-pinx'), null)
    assert.equal(manageFamilyOf('/api/approvals'), 'approvals')
    assert.equal(manageFamilyOf(`/api/approvals/${ID}`), 'approvals')
    assert.equal(manageFamilyOf('/api/approvalsx'), null)
    assert.equal(manageFamilyOf('/api/account/approvals'), 'approvals')
    assert.equal(manageFamilyOf('/api/account/approvalsx'), null)
    assert.equal(manageFamilyOf('/api/admin/approvals'), 'admin')
  })

  it("server.js's copy of manageFamilyOf has the same lines", () => {
    const src = manageFamilyOf.toString()
    for (const line of src.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('if ('))) {
      assert.ok(SERVER_JS.includes(line), `server.js lacks: ${line}`)
    }
  })

  it('dispatches with the caller, access, body, query and ip', async () => {
    const calls = []
    const rec = (name) => async (args) => { calls.push([name, args]); return { status: 200, body: { data: name, error: null } } }
    const approvals = Object.fromEntries(['getPinStatus', 'setPin', 'removePin', 'approve', 'listForMatch', 'listMine', 'revoke', 'adminSearch'].map((n) => [n, rec(n)]))
    const api = createManageApi({ accounts: {}, savedTeams: {}, approvals })
    const user = { id: 'u1' }
    const access = { isAdmin: false }
    const route = (method, pathname, extra = {}) => api.route({ method, pathname, query: new URLSearchParams(extra.query || ''), body: extra.body, user, access: extra.access || access, ip: '203.0.113.7', lang: 'de-CH,de;q=0.9' })
    assert.equal((await route('GET', '/api/account/approval-pin')).body.data, 'getPinStatus')
    assert.equal((await route('POST', '/api/account/approval-pin', { body: { pin: '1' } })).body.data, 'setPin')
    assert.equal((await route('POST', '/api/account/approval-pin/remove', { body: {} })).body.data, 'removePin')
    assert.equal((await route('POST', '/api/approvals', { body: { slot: 'scorer' } })).body.data, 'approve')
    assert.equal((await route('GET', '/api/approvals', { query: 'external_id=abc' })).body.data, 'listForMatch')
    assert.equal((await route('DELETE', `/api/approvals/${ID.toUpperCase()}`)).body.data, 'revoke')
    assert.equal((await route('GET', '/api/account/approvals', { query: 'limit=10' })).body.data, 'listMine')
    assert.deepEqual(calls.find(([n]) => n === 'approve')[1], { callerId: 'u1', access, body: { slot: 'scorer' }, ip: '203.0.113.7', lang: 'de-CH,de;q=0.9' })
    assert.deepEqual(calls.find(([n]) => n === 'listMine')[1], { callerId: 'u1', limit: '10' })
    assert.equal((await route('POST', '/api/account/approvals')).status, 405)
    assert.deepEqual(calls.find(([n]) => n === 'listForMatch')[1], { callerId: 'u1', access, externalId: 'abc' })
    assert.deepEqual(calls.find(([n]) => n === 'revoke')[1], { callerId: 'u1', access, id: ID })
    assert.deepEqual(calls.find(([n]) => n === 'setPin')[1], { userId: 'u1', body: { pin: '1' } })
    // methods and ids
    assert.equal((await route('PUT', '/api/approvals')).status, 405)
    assert.equal((await route('DELETE', '/api/approvals/not-a-uuid')).status, 404)
    assert.equal((await route('GET', '/api/account/approval-pin/remove')).status, 405)
    // the admin search is admin only
    assert.equal((await route('GET', '/api/admin/approvals')).status, 403)
    const admin = await route('GET', '/api/admin/approvals', { access: { isAdmin: true }, query: 'q=3F9A2C1B&include_revoked=1&limit=5' })
    assert.equal(admin.body.data, 'adminSearch')
    assert.deepEqual(calls.at(-1)[1], { q: '3F9A2C1B', includeRevoked: '1', limit: '5' })
  })

  it('answers 503 OV_APPROVAL_UNAVAILABLE without lib/approvals.js', async () => {
    const api = createManageApi({ accounts: {}, savedTeams: {} })
    const r = await api.route({ method: 'GET', pathname: '/api/account/approval-pin', query: new URLSearchParams(), user: { id: 'u' }, access: {} })
    assert.equal(r.status, 503)
    assert.equal(r.body.error.code, 'OV_APPROVAL_UNAVAILABLE')
  })
})
