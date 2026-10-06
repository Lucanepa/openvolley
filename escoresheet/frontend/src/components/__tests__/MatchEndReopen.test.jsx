// "Reopen match" after approval (spec 6.8): the client reopen password is
// gone; a match the server has closed is reopened by an admin.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { planReopen, isClosingSyncJob } from '../../utils/matchReopen'

const SEED = 'match_100_aaa'
const match = (over = {}) => ({ id: 1, seed_key: SEED, test: false, status: 'approved', gameN: 4711, ...over })
const closing = (id, status, over = {}) => ({ id, resource: 'match', action: 'update', status, payload: { id: SEED, status: 'approved' }, ...over })

describe('planReopen', () => {
  const read = (row) => vi.fn(async () => ({ data: row, error: null }))

  it('a test match, or one without seed_key, reopens locally', async () => {
    const readServerMatch = read(null)
    expect(await planReopen({ match: match({ test: true }), queue: [closing(1, 'sent')], online: true, readServerMatch })).toEqual({ kind: 'local' })
    expect(await planReopen({ match: match({ seed_key: null }), queue: [], online: false, readServerMatch })).toEqual({ kind: 'local' })
    expect(readServerMatch).not.toHaveBeenCalled()
  })

  it('an approval that never reached the server: its jobs are superseded, nothing is asked, works offline', async () => {
    const readServerMatch = read(null)
    const queue = [
      closing(1, 'queued'),
      closing(2, 'error', { payload: { id: SEED, status: 'final' } }),
      closing(3, 'failed'),
      closing(4, 'superseded'),
      { id: 5, resource: 'match', action: 'update', status: 'sent', payload: { id: SEED, status: 'ended' } },
      closing(6, 'sent', { payload: { id: 'match_other', status: 'approved' } })
    ]
    expect(await planReopen({ match: match(), queue, online: false, readServerMatch })).toEqual({ kind: 'localUnsynced', supersedeIds: [1, 2, 3] })
    expect(readServerMatch).not.toHaveBeenCalled()
  })

  it('a sent (or in-flight) approval needs the connection', async () => {
    for (const status of ['sent', 'sending']) {
      expect(await planReopen({ match: match(), queue: [closing(1, status)], online: false, readServerMatch: read(null) })).toEqual({ kind: 'needsConnection' })
    }
  })

  it('closed on the server: a scorer gets "only an admin", an admin the reopen dialog', async () => {
    const row = { id: 'uuid-1', status: 'approved', closed_at: '2026-10-10T18:00:00Z' }
    const readServerMatch = read(row)
    expect(await planReopen({ match: match(), queue: [closing(1, 'sent')], online: true, access: { isAdmin: false }, readServerMatch }))
      .toEqual({ kind: 'adminOnly', row })
    expect(await planReopen({ match: match(), queue: [closing(1, 'sent')], online: true, access: { isAdmin: true }, readServerMatch }))
      .toEqual({ kind: 'adminReopen', row })
    expect(readServerMatch).toHaveBeenCalledWith(SEED)
  })

  it('already reopened on the server (closed_at null), or not in the cloud: local reopen', async () => {
    const row = { id: 'uuid-1', status: 'ended', closed_at: null }
    expect((await planReopen({ match: match(), queue: [closing(1, 'sent')], online: true, readServerMatch: read(row) })).kind).toBe('serverOpen')
    expect((await planReopen({ match: match(), queue: [closing(1, 'sent')], online: true, readServerMatch: read(null) })).kind).toBe('serverOpen')
  })

  it('a row without closed_at (public projection) counts as closed by its status', async () => {
    const plan = await planReopen({ match: match(), queue: [closing(1, 'sent')], online: true, readServerMatch: read({ id: 'u', status: 'final' }) })
    expect(plan.kind).toBe('adminOnly')
  })

  it('a failed read is reported', async () => {
    expect((await planReopen({ match: match(), queue: [closing(1, 'sent')], online: true, readServerMatch: async () => ({ data: null, error: { status: 503 } }) })).kind).toBe('checkFailed')
    expect((await planReopen({ match: match(), queue: [closing(1, 'sent')], online: true, readServerMatch: async () => { throw new Error('x') } })).kind).toBe('checkFailed')
  })

  it('counts restore jobs that carry a closed status as closing', () => {
    expect(isClosingSyncJob({ resource: 'match', action: 'restore', payload: { match: { external_id: SEED, status: 'final' } } })).toBe(true)
    expect(isClosingSyncJob({ resource: 'set', action: 'update', payload: { status: 'approved' } })).toBe(false)
  })
})

describe('MatchEnd wiring', () => {
  const src = readFileSync(resolve(__dirname, '../MatchEnd.jsx'), 'utf8')

  it('uses the plan and the admin reopen endpoint', () => {
    expect(src).toContain('planReopen(')
    expect(src).toContain('adminApi.reopenMatch(')
    expect(src).toMatch(/handleReopenMatch\(\{ queue: false \}\)/)
  })

  it('no reopen password remains anywhere in the frontend source', () => {
    const root = resolve(__dirname, '../..')
    const hits = []
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) { if (name !== '__tests__') walk(full); continue }
        if (!/\.(jsx?|tsx?)$/.test(name)) continue
        const text = readFileSync(full, 'utf8')
        if (/VITE_REOPEN_PASSWORD_HASH|verify-reopen-password|hashPassword/.test(text)) hits.push(full)
      }
    }
    walk(root)
    expect(hits).toEqual([])
    expect(readFileSync(resolve(root, '../vite.config.js'), 'utf8')).not.toContain('REOPEN_PASSWORD')
  })
})
