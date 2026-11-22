// Lite graphics for the Android app: <html> carries ov-lite, and then
//  - dialog scrims dim without their backdrop blur (tailwind.css, at the end);
//  - the line-up privacy cover on the court is a near-opaque panel instead of
//    a blurred one (privacyCoverFill, Scoreboard.jsx).
// The hall tablet (Galaxy Tab A7 Lite, PowerVR GE8320) runs a full-screen
// two-pass blur for every frame anything under a dialog changes, at least once
// a second for the toolbar clock. On in the Android app since the owner said
// yes (performance pass 22.11.2026): LITE_GRAPHICS_ON_ANDROID. Never on the
// web, the desktop apps or iOS.
import { isNativeApp } from './backendConfig'

/** The owner's call (yes, 22.11.2026): true puts ov-lite on <html> in the Android app. */
export const LITE_GRAPHICS_ON_ANDROID = true

export const LITE_GRAPHICS_CLASS = 'ov-lite'

/** The Android app (Capacitor): not the web (Android's Chrome too), the desktop apps or iOS. */
export function isAndroidApp(nav = typeof navigator !== 'undefined' ? navigator : null) {
  return isNativeApp() && /Android/i.test(nav?.userAgent || '')
}

/**
 * At start (main.jsx): ov-lite on <html> in the Android app while lite
 * graphics are switched on.
 * @param {object} [options] for tests: the document, the switch, the platform
 * @returns {boolean} whether it applied
 */
export function applyLiteGraphics({
  doc = typeof document !== 'undefined' ? document : null,
  enabled = LITE_GRAPHICS_ON_ANDROID,
  android = isAndroidApp()
} = {}) {
  if (!doc || !enabled || !android) return false
  doc.documentElement.classList.add(LITE_GRAPHICS_CLASS)
  return true
}

/** Whether <html> carries ov-lite. */
export function liteGraphicsOn(doc = typeof document !== 'undefined' ? document : null) {
  return !!doc?.documentElement?.classList.contains(LITE_GRAPHICS_CLASS)
}

/**
 * The fill of the cover over a team's line-up on the court until the other
 * team has entered its own: frosted glass, or under ov-lite a dark panel at
 * 92 % (at least 90 %: the other team must not read the line-up through it).
 */
export function privacyCoverFill(doc) {
  return liteGraphicsOn(doc)
    ? { background: 'rgba(15, 23, 42, 0.92)' }
    : { background: 'rgba(15, 23, 42, 0.5)', backdropFilter: 'blur(8px)' }
}
