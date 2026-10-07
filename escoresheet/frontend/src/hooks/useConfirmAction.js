import { useCallback, useRef } from 'react'

/**
 * The one pattern every scorer confirmation dialog follows when its "Yes" is
 * pressed:
 *
 *   1. snapshot  - read everything the action needs from the dialog's state
 *                  (taken when the dialog opened), never from live data;
 *   2. close     - clear the dialog state before the first await, so the
 *                  dialog is gone before the database write lands;
 *   3. write     - then await the writes.
 *
 * Dexie's live queries re-render the screen as soon as a write commits. A
 * dialog still open at that moment redraws from the new data: confirming the
 * first time-out showed "Confirm 2nd time-out request?" for a frame, a
 * decision change showed the already-swapped score. Closing first removes
 * that window.
 *
 * The scorer dialogs now run their writes as one transaction
 * (useScorerActions.runAction) and request the close with deferUi before the
 * first write: it is applied in the very render that shows the written data,
 * which keeps the guarantee (the dialog never draws the new data) without a
 * frame of the closed dialog over the old board.
 *
 * The returned `run(action)` also refuses to start while a previous run is
 * still in flight, so a double tap (or Enter + click) writes once. It resolves
 * to false when the call was refused.
 *
 * Because the dialog is already closed when a write fails, a failure must not
 * pass silently: pass `onError` and it is called with the error (the run then
 * resolves to false). Without `onError` the error is rethrown.
 *
 * Closing first has one side effect: the second tap of a double tap no longer
 * lands on the dialog (it is gone) but on whatever was under it - a court
 * player, or the next dialog the action opens (the substitute list after an
 * expulsion, the libero re-designation list). So for a short moment after a
 * confirm, clicks anywhere are swallowed (GHOST_CLICK_MS).
 *
 *   const runConfirm = useConfirmAction()
 *   const confirmX = useCallback(() => runConfirm(async () => {
 *     const snap = xModal
 *     if (!snap) return
 *     setXModal(null)          // close first
 *     await write(snap)        // then write, from the snapshot
 *   }), [runConfirm, xModal])
 */
// Longer than a double tap / double click, shorter than a deliberate next tap
export const GHOST_CLICK_MS = 450

const activeGuards = new Set()

function swallowFollowingClicks(ms) {
  if (typeof window === 'undefined') return
  const until = Date.now() + ms
  const swallow = (e) => {
    if (Date.now() >= until) return
    e.preventDefault()
    e.stopImmediatePropagation()
  }
  // Capture on window: runs before React's listener on the root. Added while
  // the confirming click is being dispatched, so it does not see that click.
  window.addEventListener('click', swallow, true)
  const remove = () => {
    window.removeEventListener('click', swallow, true)
    activeGuards.delete(remove)
  }
  activeGuards.add(remove)
  setTimeout(remove, ms)
}

/** Tests only: drop any click guard still active from a previous test. */
export function resetGhostClickGuard() {
  for (const remove of [...activeGuards]) remove()
}

export function useConfirmAction(onError) {
  const inFlight = useRef(false)
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  return useCallback(async (action) => {
    if (inFlight.current) return false
    inFlight.current = true
    swallowFollowingClicks(GHOST_CLICK_MS)
    try {
      await action()
      return true
    } catch (err) {
      if (!onErrorRef.current) throw err
      onErrorRef.current(err)
      return false
    } finally {
      inFlight.current = false
    }
  }, [])
}
