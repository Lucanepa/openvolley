import { useCallback, useMemo, useRef } from 'react'
import Dexie from 'dexie'

// The event mutex (eventInProgressRef) is waited for at most this long, as
// logEvent always did, before an action goes ahead anyway.
const MUTEX_MAX_WAIT_MS = 5000

async function waitForMutex(mutexRef) {
  const start = Date.now()
  while (mutexRef.current && Date.now() - start < MUTEX_MAX_WAIT_MS) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  if (mutexRef.current) console.warn('[action] Timeout waiting for the previous event, proceeding anyway')
}

/**
 * Which live-state snapshot a deferred push gets: the action's final one (it
 * sees everything the action wrote, e.g. the side-out rotation after the
 * point), unless the push was made for another set than the final state is
 * in (a set end that also opened the next set keeps the snapshot it had).
 */
export function pickLiveStateSnapshot(cached, final) {
  if (!final) return cached ?? null
  if (cached && cached.currentSetIndex !== final.currentSetIndex) return cached
  return final
}

/**
 * Run the given side effects of one committed action: in their original
 * order, a `once` kind (the full referee sync, the backup) only at its first
 * position.
 */
export function runActionEffects(effects, finalSnapshot) {
  const seen = new Set()
  for (const effect of effects) {
    if (effect.once) {
      if (seen.has(effect.once)) continue
      seen.add(effect.once)
    }
    try {
      const result = effect.run(finalSnapshot)
      if (result && typeof result.catch === 'function') {
        result.catch(err => console.error('[action] side effect failed', err))
      }
    } catch (err) {
      console.error('[action] side effect failed', err)
    }
  }
}

/**
 * Scorer actions as ONE database transaction each, so the live query emits
 * once per action ("first the ball moves, then the team rotates" came from
 * every write being its own transaction).
 *
 *   runAction(key, async (ctx) => { ...Dexie writes only... })
 *
 * - All writes of the body (and of any action it calls: they join) commit
 *   together. Inside, only Dexie operations may be awaited: awaiting a timer or
 *   a fetch commits the transaction early.
 * - Network and other side effects requested during the action
 *   (deferEffect) run once, after the commit (right after its screen change
 *   is applied), in their original order; a live-state push gets the
 *   action's final snapshot (captured inside the transaction, last, when one
 *   is wanted).
 * - Screen changes requested during the action (deferUi: dialogs opened or
 *   closed) are applied with the first live-query result that includes the
 *   commit, in the same render as the data (useActionLiveQuery).
 * - `key`: a second call with the same key while one runs is dropped (double
 *   tap), from the synchronous call on until its data is on screen.
 * - The event mutex (eventInProgressRef) is held for the whole transaction
 *   (skipMutex: the caller holds it).
 * - If the transaction fails nothing of it is written, its screen changes and
 *   side effects are dropped and the error is rethrown.
 * - Only calls from inside the action's transaction (its body and what it
 *   awaits) are part of it: a tap, a timer or an effect that runs meanwhile
 *   is applied / sent at once, as without an action.
 */
export function useScorerActions({ db, commits, mutexRef, captureFinalSnapshot }) {
  const ctxRef = useRef(null)
  const inFlightRef = useRef(new Set())
  const captureRef = useRef(captureFinalSnapshot)
  captureRef.current = captureFinalSnapshot

  // The running action, when called from inside its transaction (its body and
  // whatever it awaits); null when called from anywhere else (another tap, a
  // timer, an effect), even while an action runs: that is not part of it.
  const actionOfCaller = useCallback(() => {
    const ctx = ctxRef.current
    if (!ctx) return null
    const trans = Dexie.currentTransaction
    // a sub-transaction of the action shares its IDB transaction
    return trans && trans.idbtrans === ctx.idbtrans ? ctx : null
  }, [])

  const runAction = useCallback(async (key, body, { skipMutex = false } = {}) => {
    // Called from inside a running action (e.g. the delay penalty's point): join it
    const outer = actionOfCaller()
    if (outer) return body(outer)

    const inFlight = inFlightRef.current
    if (key != null) {
      if (inFlight.has(key)) return undefined
      inFlight.add(key)
    }
    let released = false
    const release = () => {
      if (released || key == null) return
      released = true
      inFlight.delete(key)
    }
    try {
      let acquired = false
      if (!skipMutex) {
        await waitForMutex(mutexRef)
        mutexRef.current = true
        acquired = true
      }
      const ctx = { effects: [], ui: [], pending: [], wrote: false, gen: 0, finalSnapshot: null, idbtrans: null }
      let result
      let failure = null
      try {
        result = await db.transaction('rw', db.tables, async () => {
          ctx.idbtrans = Dexie.currentTransaction.idbtrans
          ctxRef.current = ctx
          const value = await body(ctx)
          // Writes started without awaiting them (logManualChange) finish inside
          while (ctx.pending.length > 0) await ctx.pending.shift()
          ctx.wrote = 'mutatedParts' in ctx.idbtrans
          // Last, so it sees every write of the action (the rotation)
          if (ctx.effects.some(e => e.wantsSnapshot)) {
            ctx.finalSnapshot = await captureRef.current()
          }
          ctx.gen = commits.nextGen()
          return value
        })
      } catch (err) {
        failure = err
      } finally {
        if (ctxRef.current === ctx) ctxRef.current = null
        if (acquired) mutexRef.current = false
      }
      if (failure) {
        release()
        throw failure
      }
      // The screen changes with the data; then the side effects (their reads,
      // e.g. the backup export, would otherwise delay the live query's
      // re-read); the key is free once the change is shown
      commits.afterCommit(ctx.wrote ? ctx.gen : 0, () => {
        for (const apply of ctx.ui) {
          try { apply() } catch (err) { console.error('[action] screen change failed', err) }
        }
        runActionEffects(ctx.effects, ctx.finalSnapshot)
        setTimeout(release, 0)
      })
      return result
    } catch (err) {
      release()
      throw err
    }
  }, [db, commits, mutexRef, actionOfCaller])

  /** A screen change of the running action (applied with its data), else now. */
  const deferUi = useCallback((apply) => {
    const ctx = actionOfCaller()
    if (ctx) ctx.ui.push(apply)
    else apply()
  }, [actionOfCaller])

  /**
   * A side effect of the running action, run after its commit. Returns false
   * (and does nothing) outside an action: the caller then runs it now.
   * @param {{ run: (finalSnapshot: object|null) => any, once?: string, wantsSnapshot?: boolean }} effect
   */
  const deferEffect = useCallback((effect) => {
    const ctx = actionOfCaller()
    if (!ctx) return false
    ctx.effects.push(effect)
    return true
  }, [actionOfCaller])

  /** A Dexie write started inside the action without awaiting it: awaited before the commit. */
  const trackWrite = useCallback((promise) => {
    const ctx = actionOfCaller()
    if (ctx && promise) ctx.pending.push(promise)
    return promise
  }, [actionOfCaller])

  const inAction = useCallback(() => actionOfCaller() !== null, [actionOfCaller])

  return useMemo(() => ({ runAction, deferUi, deferEffect, trackWrite, inAction }),
    [runAction, deferUi, deferEffect, trackWrite, inAction])
}
