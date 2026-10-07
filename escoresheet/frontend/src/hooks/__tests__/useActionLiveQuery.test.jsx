// useActionLiveQuery applies an action's screen changes in the render that
// shows its data, also when the re-read is slow (busy tablet), and applies
// them anyway when the query does not read what the action wrote.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useLayoutEffect, useState } from 'react'
import { render, waitFor } from '@testing-library/react'
import Dexie from 'dexie'
import { useActionLiveQuery, COMMIT_FLUSH_FALLBACK_MS } from '../useActionLiveQuery'

let previousActEnvironment
let db
let n = 0
beforeEach(async () => {
  previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  db = new Dexie(`action-live-query-${++n}`)
  db.version(1).stores({ sets: '++id', other: '++id' })
  await db.open()
  await db.sets.add({ id: 1, home: 0 })
})
afterEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  db.close()
  await Dexie.delete(db.name)
})

const sleep = ms => new Promise(r => setTimeout(r, ms))

function Harness({ api }) {
  const [data, commits] = useActionLiveQuery(async () => {
    const value = await db.transaction('r', db.sets, () => db.sets.get(1))
    if (api.slowMs) await sleep(api.slowMs) // a busy main thread
    return value
  }, [])
  const [dialog, setDialog] = useState('open')
  api.commits = commits
  api.setDialog = setDialog
  const sig = data ? `home=${data.home} dialog=${dialog}` : 'loading'
  useLayoutEffect(() => {
    if (api.renders[api.renders.length - 1] !== sig) api.renders.push(sig)
  })
  return null
}

async function mount() {
  const api = { renders: [], slowMs: 0 }
  render(<Harness api={api} />)
  await waitFor(() => expect(api.renders[api.renders.length - 1]).toBe('home=0 dialog=open'))
  return api
}

// What runAction does: write, take the generation inside the transaction,
// hand the screen change over after the commit
async function action(api, table, apply) {
  let gen
  await db.transaction('rw', db.sets, db.other, async () => {
    if (table === 'sets') await db.sets.update(1, { home: 1 })
    else await db.other.add({ x: 1 })
    gen = api.commits.nextGen()
  })
  api.commits.afterCommit(gen, apply)
}

describe('useActionLiveQuery', () => {
  it('applies the screen change in the render that shows the data', async () => {
    const api = await mount()
    const before = api.renders.length
    await action(api, 'sets', () => api.setDialog(null))
    await waitFor(() => expect(api.renders[api.renders.length - 1]).toBe('home=1 dialog=null'))
    await sleep(50)
    expect(api.renders.slice(before)).toEqual(['home=1 dialog=null'])
  })

  it('waits for a slow re-read instead of closing the dialog over the old data', async () => {
    const api = await mount()
    api.slowMs = COMMIT_FLUSH_FALLBACK_MS + 400
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = api.renders.length
    await action(api, 'sets', () => api.setDialog(null))
    await waitFor(() => expect(api.renders[api.renders.length - 1]).toBe('home=1 dialog=null'), { timeout: 3000 })
    expect(api.renders.slice(before)).toEqual(['home=1 dialog=null'])
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('applies it anyway when the query does not read what the action wrote', async () => {
    const api = await mount()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t0 = Date.now()
    await action(api, 'other', () => api.setDialog(null))
    await waitFor(() => expect(api.renders[api.renders.length - 1]).toBe('home=0 dialog=null'), { timeout: 2000 })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(COMMIT_FLUSH_FALLBACK_MS - 20)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('applies it at once when the data is already on screen', async () => {
    const api = await mount()
    await action(api, 'sets', () => {})
    await waitFor(() => expect(api.renders[api.renders.length - 1]).toBe('home=1 dialog=open'))
    // generation 1 is shown: a late hand-over applies immediately
    let applied = false
    api.commits.afterCommit(1, () => { applied = true })
    expect(applied).toBe(true)
  })
})
