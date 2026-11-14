/**
 * "Update needed": this page runs a build that can no longer do its work.
 *
 * - 'server': the backend refuses this app version's writes (426
 *   OV_CLIENT_TOO_OLD, its minimum write protocol was raised). The sync
 *   queue keeps every write on the device and sets this; the sync indicator
 *   says "Update needed" and the update banner shows on the match screens
 *   too, so the scorer reloads after the rally instead of scoring a whole
 *   match that never reaches the cloud. Cleared when a write goes through.
 * - 'files': a file of this build is gone from the site (a lazy chunk:
 *   language, backup key, passkey sign-in), so a newer version replaced it
 *   (vite:preloadError). Scoring goes on; the next lazy load fails until a
 *   reload.
 *
 * Either way the service worker looks for the newer build at once
 * (registration.update()), so "Refresh to update" can apply it. Per page.
 */
import { isNativeApp } from './backendConfig'

export const APP_UPDATE_NEEDED_EVENT = 'ov-app-update-needed'
export const UPDATE_NEEDED_SERVER = 'server'
export const UPDATE_NEEDED_FILES = 'files'

let needed = null
const listeners = new Set()

function emit() {
  for (const listener of listeners) listener(needed)
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(APP_UPDATE_NEEDED_EVENT, { detail: { reason: needed } }))
  } catch { /* no window (tests tearing down) */ }
}

/** Why this page needs an update ('server' | 'files'), or null. */
export function appUpdateNeeded() {
  return needed
}

/** Listen for changes (the reason or null); returns the unsubscribe. */
export function subscribeAppUpdateNeeded(listener) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Ask the service worker to look for a newer build now (it checks every
 * 5 minutes on its own). Without a worker (Android app, no support): nothing.
 */
export function checkForAppUpdate(sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : null) {
  try {
    sw?.getRegistration?.().then((reg) => reg?.update?.()).catch(() => {})
  } catch { /* never block the caller */ }
}

/**
 * This page needs an update. 'server' wins over 'files' (it also stops the
 * sync). The worker is asked for the newer build when the state begins.
 */
export function noteAppUpdateNeeded(reason, { check = checkForAppUpdate } = {}) {
  if (reason !== UPDATE_NEEDED_SERVER && reason !== UPDATE_NEEDED_FILES) return
  if (needed === reason || needed === UPDATE_NEEDED_SERVER) return
  needed = reason
  check()
  emit()
}

/** The reason no longer holds (a write went through again): back to normal. */
export function clearAppUpdateNeeded(reason) {
  if (needed == null || (reason && needed !== reason)) return
  needed = null
  emit()
}

/**
 * Does a reload of the page get the newer build? On the web (browser, PWA)
 * yes, through the service worker. The Android and desktop apps carry their
 * build: they need the app's own update (F-Droid / the APK, the desktop
 * updater) first.
 */
export function updatesByReload(win = typeof window !== 'undefined' ? window : undefined) {
  if (isNativeApp()) return false
  try {
    return typeof win?.__TAURI_INTERNALS__?.invoke !== 'function'
  } catch {
    return true
  }
}

/** Tests: back to the start state. */
export function resetAppUpdateNeededForTests() {
  needed = null
  listeners.clear()
}
