/**
 * The referee view is upright only on phones and tablets (owner,
 * 2026-11-09: "scorer on an upright tablet gets asked to rotate, referees on
 * their own referee dashboard only show portrait"). The scorer is the
 * mirror image: landscape only (Scoreboard.jsx).
 *
 * - useUprightLock (RefereeApp: the game and PIN page and the dashboard)
 *   locks the screen to portrait where the platform lets a page do it, and
 *   rotates freely again when the referee view is left.
 * - useUprightOnlyDevice (Referee) tells a phone or tablet from a computer:
 *   held sideways, the first gets TurnUprightNotice instead of the
 *   dashboard; a computer keeps the landscape layout (refereeLayout.js).
 */
import { useEffect, useState } from 'react'
import { isNativeApp } from '../../utils/backendConfig'
import { lockPortrait, unlockOrientation } from '../../utils/nativeOrientation'
import { isUprightOnlyDevice } from './refereeLayout.js'

// A browser locks only an installed web app or a page in fullscreen: elsewhere
// the promise rejects (or lock is missing, as on iOS), and the dashboard asks
// for the device to be turned upright instead. Never an unhandled rejection.
function lockPortraitWeb() {
  try {
    const pending = window.screen?.orientation?.lock?.('portrait')
    if (pending && typeof pending.catch === 'function') pending.catch(() => {})
  } catch {
    // Orientation lock not supported
  }
}

/**
 * Lock the screen upright while the referee view is mounted:
 * - the Android app natively (its WebView ignores screen.orientation.lock),
 *   unlocked on unmount; a page load that leaves the view keeps the
 *   activity's lock, so the scorer app also rotates freely again at start
 *   (main.jsx);
 * - a browser with screen.orientation.lock('portrait'), tried again when the
 *   page goes fullscreen (the referee's fullscreen button), unlocked on
 *   unmount.
 */
export function useUprightLock() {
  useEffect(() => {
    if (isNativeApp()) {
      lockPortrait()
      return () => { unlockOrientation() }
    }
    lockPortraitWeb()
    const onFullscreenChange = () => { if (document.fullscreenElement) lockPortraitWeb() }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange)
      try {
        window.screen?.orientation?.unlock?.()
      } catch {
        // Ignore unlock errors
      }
    }
  }, [])
}

/**
 * True on a phone or tablet (isUprightOnlyDevice). Followed while mounted: a
 * mouse plugged into a tablet makes it a computer, and back.
 */
export function useUprightOnlyDevice() {
  const [uprightOnly, setUprightOnly] = useState(() => isUprightOnlyDevice())
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    let query
    try {
      query = window.matchMedia('(pointer: coarse)')
    } catch {
      return
    }
    if (!query || typeof query.addEventListener !== 'function') return
    const onChange = () => setUprightOnly(isUprightOnlyDevice())
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return uprightOnly
}
