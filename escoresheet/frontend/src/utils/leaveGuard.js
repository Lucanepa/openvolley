// The browser's "Leave site?" while a match is live (appLifecycle.js) must not
// stop the app's own intended reloads: an update, clearing the cache, the
// reload after a restore. Those call allowLeaving() first.
//
// No imports on purpose: the update hook (useServiceWorker) is shared by every
// app entry.

let allowed = false

/** The next unload is intended: no "Leave site?" for it. */
export function allowLeaving() {
  allowed = true
}

export const isLeavingAllowed = () => allowed

/** Tests only. */
export function resetLeaveGuardForTests() {
  allowed = false
}
