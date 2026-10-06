// lib/access.js: role normalisation, the access matrix (spec section 1) and the
// per-process resolver cache.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeRoles, accessFromRoles, createAccessResolver, ADMIN_ROLES, KNOWN_ROLES, API_GRANTABLE_ROLES } from '../lib/access.js'

describe('normalizeRoles', () => {
  it('reads text[], JSON strings, {a,b} literals and nothing', () => {
    assert.deepEqual(normalizeRoles(['Scorer', ' ADMIN ']), ['scorer', 'admin'])
    assert.deepEqual(normalizeRoles('["scorer","referee"]'), ['scorer', 'referee'])
    assert.deepEqual(normalizeRoles('{scorer,competition_manager}'), ['scorer', 'competition_manager'])
    assert.deepEqual(normalizeRoles('{"super_admin"}'), ['super_admin'])
    assert.deepEqual(normalizeRoles('{}'), [])
    assert.deepEqual(normalizeRoles(null), [])
    assert.deepEqual(normalizeRoles(undefined), [])
    assert.deepEqual(normalizeRoles(42), [])
    assert.deepEqual(normalizeRoles(['scorer', 'scorer', null, '']), ['scorer'])
  })
})

describe('accessFromRoles', () => {
  const flags = (roles) => {
    const a = accessFromRoles(roles)
    return [a.isAdmin, a.isSuperAdmin, a.canScore, a.canManageTeams, a.canReadTeams, a.isPending]
  }
  it('follows the spec matrix', () => {
    //                                          admin  super  score  manage read   pending
    assert.deepEqual(flags([]), [false, false, false, false, false, true])
    assert.deepEqual(flags(['visitor']), [false, false, false, false, false, true])
    assert.deepEqual(flags(['referee']), [false, false, false, false, false, false])
    assert.deepEqual(flags(['scorer']), [false, false, true, false, true, false])
    assert.deepEqual(flags(['competition_manager']), [false, false, false, true, true, false])
    assert.deepEqual(flags(['admin']), [true, false, true, true, true, false])
    assert.deepEqual(flags(['super_admin']), [true, true, true, true, true, false])
    assert.deepEqual(flags('{Scorer}'), [false, false, true, false, true, false])
  })
  it('exports the role lists', () => {
    assert.deepEqual([...ADMIN_ROLES], ['admin', 'super_admin'])
    assert.ok(KNOWN_ROLES.includes('super_admin'))
    assert.equal(API_GRANTABLE_ROLES.includes('super_admin'), false)
    assert.deepEqual([...API_GRANTABLE_ROLES], ['scorer', 'referee', 'competition_manager', 'admin'])
  })
})

describe('createAccessResolver', () => {
  function fakePool (rolesByUser) {
    const pool = {
      calls: 0,
      fail: false,
      async query (sql, [id]) {
        pool.calls++
        if (pool.fail) throw new Error('connection refused')
        return { rows: id in rolesByUser ? [{ roles: rolesByUser[id] }] : [] }
      }
    }
    return pool
  }

  it('caches per user for ttlMs and can be invalidated', async () => {
    const roles = { u1: ['scorer'] }
    const pool = fakePool(roles)
    let t = 0
    const r = createAccessResolver({ pool, ttlMs: 1000, now: () => t })
    assert.equal((await r.get('u1')).canScore, true)
    roles.u1 = []
    assert.equal((await r.get('u1')).canScore, true, 'cached')
    assert.equal(pool.calls, 1)
    r.invalidate('u1')
    assert.equal((await r.get('u1')).canScore, false)
    roles.u1 = ['admin']
    t = 1001
    assert.equal((await r.get('u1')).isAdmin, true, 'expired')
    r.clear()
    assert.equal(r.size, 0)
  })

  it('a missing profile row is pending', async () => {
    const r = createAccessResolver({ pool: fakePool({}) })
    const a = await r.get('nobody')
    assert.equal(a.isPending, true)
    assert.equal(a.canScore, false)
  })

  it('throws on a database error (callers answer 503) and caches nothing', async () => {
    const pool = fakePool({ u1: ['admin'] })
    pool.fail = true
    const r = createAccessResolver({ pool })
    await assert.rejects(() => r.get('u1'), /connection refused/)
    pool.fail = false
    assert.equal((await r.get('u1')).isAdmin, true)
  })

  it('stays bounded', async () => {
    const r = createAccessResolver({ pool: fakePool({}), maxEntries: 3 })
    for (const id of ['a', 'b', 'c', 'd']) await r.get(id)
    assert.ok(r.size <= 3)
  })
})
