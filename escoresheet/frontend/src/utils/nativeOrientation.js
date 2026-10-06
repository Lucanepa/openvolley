/**
 * Screen orientation in the Android app (Capacitor).
 *
 * The app rotates freely (manifest screenOrientation="unspecified"): home,
 * match setup and every form also work in portrait. Only the scoreboard is
 * landscape-only, so it locks the activity while it is mounted
 * (lockLandscape on mount, unlockOrientation on unmount). Android's WebView
 * ignores screen.orientation.lock(), hence the native plugin.
 *
 * In a browser both are no-ops: the scoreboard keeps its rotate overlay there.
 *
 * Calls run one after the other, so an unlock sent while a lock is still in
 * flight (scoreboard mounted and left at once) is never overtaken by it.
 */
import { isNativeApp } from './backendConfig'

let queue = Promise.resolve()

function enqueue(task) {
  queue = queue.then(task, task).catch(() => {})
  return queue
}

// Resolves to the module, never to the plugin itself: a Capacitor plugin is a
// Proxy that answers every property, `then` included, so a promise resolved
// with it would call a native "then" method and never settle.
function pluginModule() {
  return import('@capacitor/screen-orientation')
}

/**
 * The side to lock: the one the tablet is already on when it is held the
 * other way up (landscape-secondary), so it is not flipped by 180°; plain
 * 'landscape' (Android's fixed SCREEN_ORIENTATION_LANDSCAPE) otherwise.
 * Read from the WebView's screen.orientation, not the plugin's orientation():
 * that one maps display rotations as if every device were portrait-natural,
 * so a landscape-natural tablet held upright reads 'landscape-secondary'.
 * @returns {'landscape'|'landscape-secondary'}
 */
export function landscapeSide() {
  try {
    if (window.screen?.orientation?.type === 'landscape-secondary') return 'landscape-secondary'
  } catch {
    // Unknown: plain landscape.
  }
  return 'landscape'
}

/** Lock to landscape (see landscapeSide). @returns {Promise<void>} */
export function lockLandscape() {
  if (!isNativeApp()) return Promise.resolve()
  return enqueue(async () => {
    const so = (await pluginModule()).ScreenOrientation
    await so.lock({ orientation: landscapeSide() })
  })
}

/** Rotate freely again. @returns {Promise<void>} */
export function unlockOrientation() {
  if (!isNativeApp()) return Promise.resolve()
  return enqueue(async () => {
    const so = (await pluginModule()).ScreenOrientation
    await so.unlock()
  })
}
