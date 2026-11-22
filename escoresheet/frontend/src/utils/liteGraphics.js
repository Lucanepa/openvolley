// Lite graphics: <html> carries ov-lite while Options › Effects and speed ›
// Blur behind dialogs is off (utils/lookSettings), and then
//  - dialog scrims dim without their backdrop blur (tailwind.css, at the end);
//  - the line-up privacy cover on the court is an opaque panel instead of a
//    blurred one (privacyCoverFill: Scoreboard.jsx, the phone court's
//    LineupSetOverlay, the referee view);
//  - full-screen notices over the scoring screen dim without their blur.
// The hall tablet (Galaxy Tab A7 Lite, PowerVR GE8320) runs a full-screen
// two-pass blur for every frame anything under a dialog changes, at least once
// a second for the toolbar clock. Off by default in the Android app since the
// owner said yes (performance pass 22.11.2026): LITE_GRAPHICS_ON_ANDROID. On
// by default on the web, the desktop apps and iOS; the device check
// (utils/deviceCheck) may recommend otherwise, the scorer decides.
import { isNativeApp } from './backendConfig'
import { detectAppPlatform, isInAppView } from './openAppWindow'

/**
 * The owner's call (yes, 22.11.2026): true makes the blur's default off in
 * the Android app (ov-lite on <html> until the scorer turns the blur on).
 */
export const LITE_GRAPHICS_ON_ANDROID = true

export const LITE_GRAPHICS_CLASS = 'ov-lite'

/** The Android app (Capacitor): not the web (Android's Chrome too), the desktop apps or iOS. */
export function isAndroidApp(nav = typeof navigator !== 'undefined' ? navigator : null) {
  return isNativeApp() && /Android/i.test(nav?.userAgent || '')
}

/**
 * isAndroidApp for a page that may be shown in the app's in-app view (a
 * same-origin iframe of the app, utils/openAppWindow: the scoresheet): the
 * check is made on the app's own window, the one with Capacitor. The app's
 * page itself is checked as it is.
 */
export function inAndroidApp(win = typeof window !== 'undefined' ? window : undefined) {
  if (!win) return false
  try {
    const host = isInAppView(win) ? win.parent : win
    return detectAppPlatform(host) === 'capacitor' && /Android/i.test(host.navigator?.userAgent || '')
  } catch {
    return false
  }
}

/**
 * ov-lite on <html> or not (utils/lookSettings applyLook, at start and at
 * each change of the blur switch).
 * @param {boolean} on lite graphics: no blur
 * @param {Document} [doc]
 * @returns {boolean} whether <html> carries it now
 */
export function applyLiteGraphics(on, doc = typeof document !== 'undefined' ? document : null) {
  const root = doc?.documentElement
  if (!root) return false
  root.classList.toggle(LITE_GRAPHICS_CLASS, !!on)
  return !!on
}

/** Whether <html> carries ov-lite. */
export function liteGraphicsOn(doc = typeof document !== 'undefined' ? document : null) {
  return !!doc?.documentElement?.classList.contains(LITE_GRAPHICS_CLASS)
}

/** The scorer's court cover with the blur on (Scoreboard.jsx, tablet court). */
export const PRIVACY_COVER_FROSTED = Object.freeze({ background: 'rgba(15, 23, 42, 0.5)', backdropFilter: 'blur(8px)' })

/**
 * The fill of the cover over a team's line-up on the court until the other
 * team has entered its own: frosted glass (`frosted`: the scorer's tablet
 * court by default; the phone court and the referee view pass their own), or
 * under ov-lite an opaque dark panel. Without the blur nothing may show
 * through: at 92 % the shirt numbers, the position labels and the captain's
 * mark stayed sharp enough to read at close range (the Android emulator,
 * 22.11.2026), most of all under the two see-through buttons on the cover.
 */
export function privacyCoverFill(doc, frosted = PRIVACY_COVER_FROSTED) {
  return liteGraphicsOn(doc)
    ? { background: 'rgb(15, 23, 42)' }
    : { ...frosted }
}
