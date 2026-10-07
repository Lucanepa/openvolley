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
 * The returned `run(action)` also refuses to start while a previous run is
 * still in flight, so a double tap (or Enter + click) writes once. It resolves
 * to false when the call was refused.
 *
 *   const runConfirm = useConfirmAction()
 *   const confirmX = useCallback(() => runConfirm(async () => {
 *     const snap = xModal
 *     if (!snap) return
 *     setXModal(null)          // close first
 *     await write(snap)        // then write, from the snapshot
 *   }), [runConfirm, xModal])
 */
export function useConfirmAction() {
  const inFlight = useRef(false)
  return useCallback(async (action) => {
    if (inFlight.current) return false
    inFlight.current = true
    try {
      await action()
      return true
    } finally {
      inFlight.current = false
    }
  }, [])
}
