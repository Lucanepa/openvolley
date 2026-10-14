/**
 * The status and navigation bars in the Android app (Capacitor).
 *
 * The screens behind the size gate (the scoring screen and its match end, on
 * a tablet) hide them (App): an 8" tablet held sideways (1280x800 at 213 dpi,
 * Lenovo Tab M8, Galaxy Tab A9) leaves the page 962x539 between them, under
 * the 600 px minimum height, and showed only the "use a larger screen"
 * notice (device check 2026-10-14). Without them the page is 962x601. A swipe
 * from the screen's edge shows them over the page for a few seconds
 * (android/.../MainActivity.setSystemBarsHidden).
 *
 * In a browser both are no-ops: its fullscreen does this there.
 *
 * Calls run one after the other, so a show sent while a hide is still in
 * flight (the scoring screen left at once) is never overtaken by it.
 */
import { useLayoutEffect, useState } from 'react'
import { isNativeApp } from './backendConfig'

let queue = Promise.resolve()
let plugin = null

function enqueue(task) {
  queue = queue.then(task, task).catch(() => {})
  return queue
}

// The app's native plugin (ScoringBarsPlugin.java). window.Capacitor gets
// registerPlugin only once @capacitor/core is loaded, and the app loads it
// lazily. The proxy answers every property, `then` too, so it is handed
// around in a box and never resolved from a promise.
async function pluginBox() {
  if (!plugin) {
    let register = window.Capacitor?.registerPlugin
    if (typeof register !== 'function') register = (await import('@capacitor/core')).registerPlugin
    if (!plugin) plugin = register('OpenVolleyBars')
  }
  return { plugin }
}

/** Hide the status and navigation bars. @returns {Promise<void>} */
export function hideSystemBars() {
  if (!isNativeApp()) return Promise.resolve()
  return enqueue(async () => {
    await (await pluginBox()).plugin.hide()
  })
}

/** Show them again. @returns {Promise<void>} */
export function showSystemBars() {
  if (!isNativeApp()) return Promise.resolve()
  return enqueue(async () => {
    await (await pluginBox()).plugin.show()
  })
}

/**
 * Hides the bars while `active` and shows them again after. Returns true
 * while they are going: for a frame or two the page still has its shorter
 * size, and the size gate waits that long (it flashed on the way in).
 * @param {boolean} active
 * @returns {boolean}
 */
export function useSystemBarsHidden(active) {
  const [going, setGoing] = useState(false)
  // before the first paint, so the gate is never drawn in between
  useLayoutEffect(() => {
    if (!active) return undefined
    let live = true
    let timer = null
    if (isNativeApp()) setGoing(true)
    hideSystemBars().then(() => {
      // the WebView takes the freed space on its next layout
      timer = setTimeout(() => { if (live) setGoing(false) }, 300)
    })
    return () => {
      live = false
      clearTimeout(timer)
      setGoing(false)
      showSystemBars()
    }
  }, [active])
  return going
}
