import { useCallback, useMemo, useRef } from 'react'
import Dexie from 'dexie'
import { withActivityContext, currentActivityContext } from '../db/eventHistory'
import { randomUuid } from '../utils/deviceId'
import { diag } from '../diagnostics/recorder'

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

// A live-state push that only re-sent the lineup after a side-out (the 'point'
// push used to carry the lineup from before the rotation): it names no event
// of its own
const LINEUP_ONLY_PUSHES = new Set(['rotation'])

/**
 * One live-state push per action. Every push of an action that goes out with
 * the action's final snapshot (pickLiveStateSnapshot) sends the same state,
 * so the tablets, the livescore and the cloud got it two or three times (a
 * side-out: 'point' + 'rotation'; with the automatic libero exit: 'point' +
 * 'libero_exit' + 'rotation'). They are merged into one push, sent at the
 * first one's position and named after the action's last event that is more
 * than a re-sent lineup (the libero exit: the referee flashes it, as it did
 * when it came last). A push that keeps its own snapshot (the set end of an
 * action that is already in the next set) is sent as it is.
 * @param {Array<{ liveState?: { cachedSnapshot?: object|null, eventType?: string|null } }>} effects
 * @param {object|null} finalSnapshot
 */
export function mergeLiveStatePushes(effects, finalSnapshot) {
  if (!finalSnapshot) return effects
  const finalPushes = effects.filter(e => e.liveState &&
    pickLiveStateSnapshot(e.liveState.cachedSnapshot ?? null, finalSnapshot) === finalSnapshot)
  if (finalPushes.length < 2) return effects
  const named = finalPushes.filter(e => !LINEUP_ONLY_PUSHES.has(e.liveState.eventType))
  const keep = named.length > 0 ? named[named.length - 1] : finalPushes[finalPushes.length - 1]
  const first = finalPushes[0]
  const merged = new Set(finalPushes)
  const out = []
  for (const effect of effects) {
    if (effect === first) out.push(keep)
    else if (!merged.has(effect)) out.push(effect)
  }
  return out
}

/**
 * Run the given side effects of one committed action: in their original
 * order, a `once` kind (the full referee sync, the backup) only at its first
 * position, the live-state pushes of the final state as one
 * (mergeLiveStatePushes).
 */
export function runActionEffects(effects, finalSnapshot) {
  const seen = new Set()
  for (const effect of mergeLiveStatePushes(effects, finalSnapshot)) {
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
 * Run `fn` with the event-history reason of an action (db/eventHistory: why
 * its deletes and edits void or edit the server's events). A top-level action
 * gets its own action id; an action that joins a running one (the replay of a
 * decision change) keeps the outer reason and id, so the rows it voids are
 * labelled as what the scorer did.
 */
export function inActivityContext(reason, fn, { joined = false } = {}) {
  if (!reason) return fn()
  const current = currentActivityContext()
  if (joined && current?.reason) return fn()
  return withActivityContext({ reason, actionId: current?.actionId ?? randomUuid() }, fn)
}

/** An action failure already shown to the scorer (onError, or by the action itself). */
export function isReportedActionError(err) {
  return !!(err && typeof err === 'object' && err.scorerActionReported)
}

/** Mark a failure as shown to the scorer, so it is not reported twice. */
export function markActionErrorReported(err) {
  if (err && typeof err === 'object') {
    try { err.scorerActionReported = true } catch { /* frozen error object */ }
  }
  return err
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
 * - The transaction covers every table (db.tables), the event history's
 *   included (EVENT_HISTORY_SCOPE): the void / edit rows and their sync jobs
 *   the db.events hooks write for a delete or an edit commit or roll back with
 *   the action. `reason` ('undo', 'decision_change', ...) labels them
 *   (inActivityContext); without it a delete is 'delete', an edit 'other'.
 * - If the transaction fails nothing of it is written, its screen changes and
 *   side effects are dropped and the error is rethrown. A keyed action (a
 *   scorer tap) also passes it to `onError` (the scorer must see that nothing
 *   was saved) unless it is marked reported already (markActionErrorReported),
 *   and marks it. So a body must NOT catch a failed write and carry on: the
 *   writes before it would commit alone (a half-done undo). Rethrow instead.
 * - Only calls from inside the action's transaction (its body and what it
 *   awaits) are part of it: a tap, a timer or an effect that runs meanwhile
 *   is applied / sent at once, as without an action.
 */
export function useScorerActions({ db, commits, mutexRef, captureFinalSnapshot, onError }) {
  const ctxRef = useRef(null)
  const inFlightRef = useRef(new Set())
  const captureRef = useRef(captureFinalSnapshot)
  captureRef.current = captureFinalSnapshot
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

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

  const runAction = useCallback(async (key, body, { skipMutex = false, reason = null } = {}) => {
    // Called from inside a running action (e.g. the delay penalty's point): join it
    const outer = actionOfCaller()
    if (outer) return inActivityContext(reason, () => body(outer), { joined: true })

    const inFlight = inFlightRef.current
    if (key != null) {
      if (inFlight.has(key)) {
        diag('action.drop', { key })
        return undefined
      }
      inFlight.add(key)
    }
    const t0 = performance.now()
    diag('action.start', { key, reason })
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
          const value = await inActivityContext(reason, () => body(ctx))
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
        diag('action.fail', { key, ms: Math.round(performance.now() - t0), message: failure?.message || String(failure) })
        release()
        if (key != null && onErrorRef.current && !isReportedActionError(failure)) {
          try { onErrorRef.current(failure) } catch (err) { console.error('[action] onError failed', err) }
          markActionErrorReported(failure)
        }
        throw failure
      }
      // The screen changes with the data; then the side effects (their reads,
      // e.g. the backup export, would otherwise delay the live query's
      // re-read); the key is free once the change is shown
      const committedAt = performance.now()
      diag('action.commit', { key, ms: Math.round(committedAt - t0), wrote: !!ctx.wrote, gen: ctx.gen, ui: ctx.ui.length, effects: ctx.effects.length })
      commits.afterCommit(ctx.wrote ? ctx.gen : 0, () => {
        diag('action.ui', { key, gen: ctx.wrote ? ctx.gen : 0, ui: ctx.ui.length, ms: Math.round(performance.now() - committedAt) })
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
