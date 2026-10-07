// A scorer action is ONE Dexie transaction and ONE screen change
// (useScorerActions + useActionLiveQuery). The harness is a tiny scoreboard
// over a real Dexie database (fake-indexeddb): a side-out writes the score,
// the point event and the rotation, and opens a dialog; every committed render
// is recorded, so an intermediate screen ("first the ball moves, then the team
// rotates") shows up as an extra signature.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useLayoutEffect, useRef, useState } from 'react'
import { render, waitFor } from '@testing-library/react'
import Dexie from 'dexie'
import { useActionLiveQuery } from '../useActionLiveQuery'
import { useScorerActions, pickLiveStateSnapshot, runActionEffects, isReportedActionError, markActionErrorReported } from '../useScorerActions'

// React renders as it would in the app (no act() batching): an intermediate
// screen must be able to show up
let previousActEnvironment
beforeEach(() => {
  previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
})
afterEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment })

let db
let dbCount = 0
beforeEach(async () => {
  db = new Dexie(`scorer-actions-${++dbCount}`)
  db.version(1).stores({ sets: '++id', events: '++id,seq', sync_queue: '++id' })
  await db.open()
  await db.sets.add({ id: 1, home: 0, away: 0 })
  await db.events.add({ seq: 1, type: 'lineup', lineup: ['1', '2', '3', '4', '5', '6'] })
})
afterEach(async () => {
  db.close()
  await Dexie.delete(db.name)
})

const sleep = ms => new Promise(r => setTimeout(r, ms))

function rotate(lineup) {
  return [...lineup.slice(1), lineup[0]]
}

// The scoreboard under test; `api` exposes the actions and what was rendered
function Board({ api, captureFinalSnapshot, onError }) {
  const mutexRef = useRef(false)
  const [data, commits] = useActionLiveQuery(() => db.transaction('r', db.sets, db.events, async () => {
    const set = await db.sets.get(1)
    const events = await db.events.orderBy('seq').toArray()
    const lineup = [...events].reverse().find(e => e.type === 'lineup')?.lineup
    return { score: `${set.home}:${set.away}`, server: lineup?.[0], events: events.length }
  }), [])
  const [dialog, setDialog] = useState(null)
  const actions = useScorerActions({ db, commits, mutexRef, captureFinalSnapshot: captureFinalSnapshot || (async () => null), onError })
  api.actions = actions
  api.mutexRef = mutexRef
  api.setDialog = setDialog
  const sig = data ? `${data.score} server=${data.server} events=${data.events} dialog=${dialog}` : 'loading'
  useLayoutEffect(() => {
    if (api.renders[api.renders.length - 1] !== sig) api.renders.push(sig)
  })
  return <div>{sig}</div>
}

async function mount(props = {}) {
  const api = { renders: [] }
  render(<Board api={api} {...props} />)
  await waitFor(() => expect(api.renders[api.renders.length - 1]).toMatch(/^0:0/))
  return api
}

// A side-out for the away team: score, point, rotation, then a dialog
function sideOut(api, { onEffect = () => {} } = {}) {
  const { runAction, deferUi, deferEffect } = api.actions
  return runAction('point', async () => {
    const set = await db.sets.get(1)
    await db.sets.update(1, { away: set.away + 1 })
    const seq = (await db.events.orderBy('seq').last()).seq + 1
    await db.events.add({ seq, type: 'point', team: 'away' })
    deferEffect({ run: () => onEffect('point') })
    const lineup = [...await db.events.orderBy('seq').toArray()].reverse().find(e => e.type === 'lineup').lineup
    await db.events.add({ seq: seq + 0.1, type: 'lineup', lineup: rotate(lineup) })
    deferEffect({ run: () => onEffect('rotation') })
    deferUi(() => api.setDialog('libero'))
  })
}

describe('useScorerActions: one transaction, one screen change', () => {
  it('a side-out shows the score, the rotation and its dialog in one render', async () => {
    const api = await mount()
    const before = api.renders.length
    await sideOut(api)
    await waitFor(() => expect(api.renders[api.renders.length - 1]).toBe('0:1 server=2 events=3 dialog=libero'))
    await sleep(50)
    expect(api.renders.slice(before)).toEqual(['0:1 server=2 events=3 dialog=libero'])
  })

  it('without runAction the same writes show up one by one (what the scorer saw)', async () => {
    const api = await mount()
    const last = () => api.renders[api.renders.length - 1]
    await db.sets.update(1, { away: 1 })
    await waitFor(() => expect(last()).toBe('0:1 server=1 events=1 dialog=null'))
    await db.events.add({ seq: 2, type: 'point', team: 'away' })
    // the new score with the old server: the frame the owner saw
    await waitFor(() => expect(last()).toBe('0:1 server=1 events=2 dialog=null'))
    await db.events.add({ seq: 2.1, type: 'lineup', lineup: ['2', '3', '4', '5', '6', '1'] })
    await waitFor(() => expect(last()).toBe('0:1 server=2 events=3 dialog=null'))
  })

  it('a double tap writes once: the second call with the same key is dropped', async () => {
    const api = await mount()
    await Promise.all([sideOut(api), sideOut(api)])
    expect(await db.events.filter(e => e.type === 'point').count()).toBe(1)
    expect((await db.sets.get(1)).away).toBe(1)
  })

  it('the key is free again once the action is on screen', async () => {
    const api = await mount()
    await sideOut(api)
    await waitFor(() => expect(api.renders[api.renders.length - 1]).toMatch(/^0:1/))
    await sleep(10)
    await sideOut(api)
    await waitFor(() => expect(api.renders[api.renders.length - 1]).toMatch(/^0:2/))
  })

  it('side effects run after the commit, in order, once per `once` kind', async () => {
    const order = []
    const api = await mount()
    const { runAction, deferEffect } = api.actions
    await runAction('x', async () => {
      await db.events.add({ seq: 2, type: 'timeout' })
      deferEffect({ once: 'sync', run: () => order.push('sync') })
      deferEffect({ run: () => order.push('action') })
      deferEffect({ once: 'sync', run: () => order.push('sync again') })
      expect(order).toEqual([])
    })
    await waitFor(() => expect(order).toEqual(['sync', 'action']))
  })

  it('an action called inside another one joins its transaction (one commit, one render)', async () => {
    const api = await mount()
    const { runAction, deferUi } = api.actions
    const before = api.renders.length
    await runAction('sanction', async () => {
      await db.events.add({ seq: 2, type: 'sanction' })
      deferUi(() => api.setDialog(null))
      // the delay penalty's point: the same transaction
      await sideOut(api)
      expect(Dexie.currentTransaction).toBeTruthy()
    })
    await waitFor(() => expect(api.renders[api.renders.length - 1]).toBe('0:1 server=2 events=4 dialog=libero'))
    await sleep(50)
    expect(api.renders.slice(before)).toEqual(['0:1 server=2 events=4 dialog=libero'])
  })

  it('a failed action writes nothing, changes no screen state, runs no effect and rethrows', async () => {
    const effect = vi.fn()
    const api = await mount()
    const { runAction, deferUi, deferEffect } = api.actions
    await expect(runAction('point', async () => {
      await db.sets.update(1, { away: 9 })
      deferUi(() => api.setDialog('open'))
      deferEffect({ run: effect })
      throw new Error('boom')
    })).rejects.toThrow('boom')
    await sleep(50)
    expect((await db.sets.get(1)).away).toBe(0)
    expect(effect).not.toHaveBeenCalled()
    expect(api.renders[api.renders.length - 1]).toBe('0:0 server=1 events=1 dialog=null')
    expect(api.mutexRef.current).toBe(false)
  })

  it('a body that catches a failed write and carries on commits the writes before it (why bodies rethrow)', async () => {
    const api = await mount()
    await db.events.add({ id: 99, seq: 9, type: 'taken' })
    await api.actions.runAction('undo', async () => {
      await db.sets.update(1, { away: 5 })
      try { await db.events.add({ id: 99, seq: 10, type: 'duplicate key' }) } catch { /* swallowed */ }
    })
    expect((await db.sets.get(1)).away).toBe(5)
  })

  it('a failed scorer tap is reported once through onError; a nested or unkeyed failure is not', async () => {
    const onError = vi.fn()
    const api = await mount({ onError })
    const { runAction } = api.actions
    const err = new Error('write failed')
    await expect(runAction('point', async () => {
      await db.sets.update(1, { away: 9 })
      // the failure of a joined action (logEvent's) is the outer action's
      await runAction(null, async () => { throw err })
    })).rejects.toBe(err)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(err)
    expect(isReportedActionError(err)).toBe(true)
    expect((await db.sets.get(1)).away).toBe(0)

    // logEvent outside an action (no key): its caller reports
    await expect(runAction(null, async () => { throw new Error('unkeyed') })).rejects.toThrow('unkeyed')
    expect(onError).toHaveBeenCalledTimes(1)

    // a failure the action has shown itself (the time-out's own message)
    await expect(runAction('timeout', async () => { throw markActionErrorReported(new Error('shown')) })).rejects.toThrow('shown')
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('a call made meanwhile from outside the action (a timer, an effect) is not part of it', async () => {
    const order = []
    const api = await mount()
    const { runAction, deferEffect, deferUi } = api.actions
    await runAction('x', async () => {
      await db.events.add({ seq: 2, type: 'timeout' })
      deferEffect({ run: () => order.push('action effect') })
      // outside the transaction zone, as a timer callback would be
      Dexie.ignoreTransaction(() => {
        if (!deferEffect({ run: () => order.push('deferred by mistake') })) order.push('outside, at once')
        deferUi(() => order.push('outside ui, at once'))
      })
    })
    expect(order).toEqual(['outside, at once', 'outside ui, at once'])
    await waitFor(() => expect(order).toEqual(['outside, at once', 'outside ui, at once', 'action effect']))
  })

  it('an action that writes nothing applies its screen change at once', async () => {
    const api = await mount()
    const { runAction, deferUi } = api.actions
    await runAction('rally', async () => { deferUi(() => api.setDialog('reminder')) })
    // well before the fallback for a commit the live query does not report
    await waitFor(() => expect(api.renders[api.renders.length - 1]).toBe('0:0 server=1 events=1 dialog=reminder'), { timeout: 100 })
  })

  it('holds the event mutex for the whole transaction and waits for a held one', async () => {
    const api = await mount()
    const { runAction } = api.actions
    api.mutexRef.current = true // e.g. a write that is not an action yet
    let ran = false
    const running = runAction('x', async () => {
      ran = true
      expect(api.mutexRef.current).toBe(true)
      await db.events.add({ seq: 2, type: 'timeout' })
    })
    await sleep(40)
    expect(ran).toBe(false)
    api.mutexRef.current = false
    await running
    expect(ran).toBe(true)
    expect(api.mutexRef.current).toBe(false)
  })

  it('deferred effects get the final snapshot, captured inside the transaction after every write', async () => {
    const seen = []
    const api = await mount({
      captureFinalSnapshot: async () => ({ currentSetIndex: 1, events: await db.events.count() })
    })
    const { runAction, deferEffect } = api.actions
    await runAction('point', async () => {
      await db.events.add({ seq: 2, type: 'point' })
      // a push made before the rotation, with the point's own snapshot
      deferEffect({ wantsSnapshot: true, run: (final) => seen.push(pickLiveStateSnapshot({ currentSetIndex: 1, events: 2 }, final)) })
      await db.events.add({ seq: 2.1, type: 'lineup', lineup: ['2', '3', '4', '5', '6', '1'] })
    })
    await waitFor(() => expect(seen).toEqual([{ currentSetIndex: 1, events: 3 }]))
  })
})

describe('pickLiveStateSnapshot', () => {
  const final = { currentSetIndex: 2, pointsA: 0 }
  it('uses the final snapshot for a push of the same set, or with none of its own', () => {
    expect(pickLiveStateSnapshot({ currentSetIndex: 2, pointsA: 5 }, final)).toBe(final)
    expect(pickLiveStateSnapshot(null, final)).toBe(final)
  })
  it('keeps the push its own snapshot when the final state is another set, or there is none', () => {
    const setEnd = { currentSetIndex: 1, pointsA: 25 }
    expect(pickLiveStateSnapshot(setEnd, final)).toBe(setEnd)
    expect(pickLiveStateSnapshot(setEnd, null)).toBe(setEnd)
    expect(pickLiveStateSnapshot(null, null)).toBe(null)
  })
})

describe('runActionEffects', () => {
  it('a failing effect does not stop the next ones', () => {
    const order = []
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    runActionEffects([
      { run: () => { throw new Error('x') } },
      { run: () => Promise.reject(new Error('y')) },
      { run: (s) => order.push(s) }
    ], 'final')
    expect(order).toEqual(['final'])
    spy.mockRestore()
  })
})
