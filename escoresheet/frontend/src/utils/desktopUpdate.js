/**
 * Automatic updates of the desktop app: what the page shows of them.
 *
 * The app decides everything (src-tauri/src/updater.rs): when to check, when
 * to download, and whether a restart may run now (no live match, no tablet
 * connected, no tablet Wi-Fi of the app). The page only shows the status the
 * app sends (`update_status`, the window event `ov-update`) and asks it to
 * check, to restart into the update, or to change the two settings. These
 * helpers are plain data (tested); useDesktopUpdate.js wires them.
 */

export const UPDATE_EVENT = 'ov-update'
/** AuthContext fires this on a sign-in: the app checks (at most every 15 min). */
export const SIGNED_IN_EVENT = 'ov-signed-in'

/** The one-time command that adds the APT repo (a .deb installed by hand). */
export const REPO_COMMAND = 'curl -fsSL https://get.openvolley.app/install.sh | sudo sh'
/** Without pkexec (or polkit refused): the update by hand. */
export const APT_COMMAND = 'sudo apt update && sudo apt upgrade'

const BLOCKER_ORDER = ['matchLive', 'tablets', 'tabletNetwork', 'pageNotReady']

/** Why "Restart and update" has to wait, as one sentence. */
export function blockerText(blocker, t) {
  switch (blocker?.kind) {
    case 'matchLive':
      return t('update.waitMatch', 'The update waits until the match is over.')
    case 'tablets':
      return t('update.waitTablets', {
        count: blocker.count || 1,
        defaultValue_one: 'The update waits until the tablet is disconnected.',
        defaultValue_other: 'The update waits until the {{count}} tablets are disconnected.',
      })
    case 'tabletNetwork':
      return t('update.waitNetwork', 'The update waits until the tablet Wi-Fi is off.')
    default:
      return t('update.waitPage', 'The update waits until OpenVolley has finished loading.')
  }
}

/** The most important of the blockers (a live match first), or null. */
export function mainBlocker(blockers) {
  if (!Array.isArray(blockers) || blockers.length === 0) return null
  return [...blockers].sort((a, b) => BLOCKER_ORDER.indexOf(a?.kind) - BLOCKER_ORDER.indexOf(b?.kind))[0]
}

/** A failure code from the app, as a sentence. */
export function failureText(msg, t) {
  switch (msg) {
    case 'checkFailed':
      return t('update.checkFailed', 'Could not check for updates. OpenVolley tries again later.')
    case 'downloadFailed':
      return t('update.downloadFailed', 'Could not download the update. OpenVolley tries again later.')
    case 'needsAdmin':
      return t('update.needsAdmin', 'Windows needs administrator approval to install the update.')
    case 'noPkexec':
      return t('update.installManually', 'Install it in a terminal:')
    default:
      return t('update.installFailed', 'The update could not be installed.')
  }
}

export const isDownloadingKind = (kind) => kind === 'nsis' || kind === 'appImage' || kind === 'macApp'

/**
 * The home screen's notice, or null for none. Quiet by default: a check,
 * a download, an update waiting for the match say nothing here (Options >
 * App version shows them).
 * @param {object|null} status the app's status
 * @param {{ hidden?: string|null }} opts `hidden`: the version the scorer chose "Later" for
 * @returns {null | { type: 'ready'|'blocked'|'restartPending'|'noRepo', version: string }}
 */
export function noticeFor(status, { hidden = null } = {}) {
  if (!status || !status.available?.version) return null
  const version = status.available.version
  if (hidden && hidden === version) return null
  if (status.kind === 'debNoRepo') return { type: 'noRepo', version }
  if (status.phase === 'restartPending') {
    return status.canRestart ? { type: 'restartPending', version } : { type: 'blocked', version }
  }
  if (status.phase !== 'ready') return null
  // deb from the repo: the app installs it in the background, then says
  // "Restart to finish"
  if (status.kind === 'debApt') return null
  if (!isDownloadingKind(status.kind)) return null
  return status.canRestart ? { type: 'ready', version } : { type: 'blocked', version }
}

/** The status line in Options > App version. */
export function statusLine(status, t) {
  if (!status) return ''
  const version = status.available?.version || ''
  switch (status.phase) {
    case 'checking':
      return t('options.checking', 'Checking...')
    case 'available':
      return t('update.availableLater', { version, defaultValue: 'Update {{version}} downloads after the match.' })
    case 'downloading': {
      const pct = status.total ? Math.min(100, Math.floor((status.got / status.total) * 100)) : null
      const text = t('update.downloading', { version, defaultValue: 'Downloading update {{version}}…' })
      return pct === null ? text : `${text} ${pct}%`
    }
    case 'ready':
      if (status.kind === 'debApt') {
        return `${t('update.ready', { version, defaultValue: 'Update {{version}} is ready' })} · ${t('update.installsInBackground', 'It installs in the background.')}`
      }
      return t('update.ready', { version, defaultValue: 'Update {{version}} is ready' })
    case 'installing':
      return t('update.installing', 'Installing update…')
    case 'restartPending':
      return t('update.restartToFinish', { version, defaultValue: 'Restart to finish the update to {{version}}' })
    case 'upToDate':
      return t('update.upToDate', 'You have the latest version.')
    case 'failed':
      return status.manual || status.msg !== 'checkFailed' ? failureText(status.msg, t) : ''
    default:
      return ''
  }
}
