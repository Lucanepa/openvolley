/**
 * Hands a file to the user in a way that works on every device.
 *
 * A hidden `<a download>` of a blob does nothing visible in an iPad or iPhone
 * app (WKWebView), and in Safari it ends up in a Downloads folder that school
 * iPads often hide. There the share sheet is what people can use: Mail,
 * AirDrop, "Save to Files". So on iOS (browser or app) the match-end files are
 * shared, not downloaded:
 *
 * - the native app: the file is written with @capacitor/filesystem and given
 *   to the app's own OpenVolleyFiles plugin (share sheet / Android intent);
 * - a browser with Web Share for files (iOS and iPadOS Safari, Chrome on
 *   Android): navigator.share({ files }), which needs a tap, so it is called
 *   from a button, never from an await chain that began earlier;
 * - anything else: the plain download.
 */
import { detectOs } from './deviceKind.js'
import { writePdfNative } from './openAppWindow.js'

const isNative = (win) => {
  try { return !!win?.Capacitor?.isNativePlatform?.() } catch { return false }
}

/** iOS / iPadOS (browser or app), where a hidden download is not usable. */
export function prefersShare(win = typeof window !== 'undefined' ? window : undefined) {
  if (!win) return false
  return isNative(win) || detectOs(win) === 'ios'
}

async function filesPlugin(win) {
  let register = win.Capacitor?.registerPlugin
  if (typeof register !== 'function') register = (await import('@capacitor/core')).registerPlugin
  return register('OpenVolleyFiles')
}

function downloadBlob(blob, filename, win) {
  const doc = win.document
  const a = doc.createElement('a')
  a.download = filename
  a.href = win.URL.createObjectURL(blob)
  a.click()
  setTimeout(() => { try { win.URL.revokeObjectURL(a.href) } catch { /* gone */ } }, 60000)
}

/**
 * @returns {Promise<'shared'|'downloaded'|'cancelled'>} 'cancelled': the user
 *   closed the share sheet. Throws when nothing worked.
 */
export async function shareFile(blob, filename, { mime = blob?.type || 'application/octet-stream', title = filename, win = window } = {}) {
  if (isNative(win)) {
    const fs = await import('@capacitor/filesystem')
    const { uri } = await writePdfNative(fs, await blob.arrayBuffer(), filename)
    const plugin = await filesPlugin(win)
    await plugin.share({ uri })
    return 'shared'
  }
  const nav = win.navigator
  if (typeof nav?.share === 'function' && typeof nav?.canShare === 'function' && typeof win.File === 'function') {
    const file = new win.File([blob], filename, { type: mime })
    if (nav.canShare({ files: [file] })) {
      try {
        await nav.share({ files: [file], title })
        return 'shared'
      } catch (e) {
        if (e?.name === 'AbortError') return 'cancelled'
        // NotAllowedError (no tap) or the like: fall through to the download
      }
    }
  }
  downloadBlob(blob, filename, win)
  return 'downloaded'
}
