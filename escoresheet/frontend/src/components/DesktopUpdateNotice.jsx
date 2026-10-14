import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Download, RefreshCw } from 'lucide-react'
import { Button, toast } from '../ui'
import { useDesktopUpdate } from '../hooks/useDesktopUpdate'
import { getLiveMatch, onLiveMatchChange } from '../utils/appLifecycle'
import { REPO_COMMAND, blockerText, failureText, mainBlocker, noticeFor } from '../utils/desktopUpdate'
import { copyToClipboard } from '../utils/networkInfo'

// "Later" hides the notice for that version until the app starts again.
let laterVersion = null
// The version the automatic restart was tried for: never a second time (a
// refused or failed restart leaves the button).
let autoTriedVersion = null

/** Seconds the card counts down before the automatic restart. */
export const AUTO_RESTART_SECONDS = 10

/** Tests: forget "Later" and the automatic restart. */
export function resetDesktopUpdateNoticeForTests() {
  laterVersion = null
  autoTriedVersion = null
}

// A dialog is open (the page's own, or the web update's): the scorer is busy.
const dialogOpen = () => !!document.querySelector('[aria-modal="true"]')

/**
 * The desktop app's "Update {v} is ready" (src-tauri/src/updater.rs): a
 * small non-modal card, bottom right, on the home screen only (App.jsx mounts
 * it there, never over the scoreboard), and never while a match is live. It
 * says nothing while checking or downloading: Options > App version shows that.
 *
 * - ready, the app's gate open: "It installs when you quit OpenVolley." with
 *   Later and "Restart and update";
 * - ready, gate closed: one line with the reason, no button;
 * - deb installed by APT: "Restart to finish the update to {v}" + button;
 *   with automatic installs on, it restarts by itself after a countdown
 *   (AUTO_RESTART_SECONDS), which starts over at every tap or key and while
 *   a dialog is open or the window is hidden, so it never cuts what the
 *   scorer is doing;
 * - a .deb installed by hand: the command that adds the repo, with Copy.
 *
 * Every notice has Later.
 */
export default function DesktopUpdateNotice() {
  const { t } = useTranslation()
  const { active, status, installNow } = useDesktopUpdate()
  const [live, setLive] = useState(getLiveMatch)
  const [hidden, setHidden] = useState(laterVersion)
  const [busy, setBusy] = useState(false)
  const [autoTried, setAutoTried] = useState(autoTriedVersion)
  const [left, setLeft] = useState(AUTO_RESTART_SECONDS)

  useEffect(() => onLiveMatchChange(setLive), [])

  const notice = active && live === 'none' ? noticeFor(status, { hidden }) : null
  // installed, only the restart is missing, and the app's gate is open
  const autoVersion = notice?.type === 'restartPending' && status?.autoInstall && autoTried !== notice.version
    ? notice.version
    : null

  useEffect(() => {
    if (!autoVersion) return undefined
    setLeft(AUTO_RESTART_SECONDS)
    const again = () => setLeft(AUTO_RESTART_SECONDS)
    window.addEventListener('pointerdown', again, true)
    window.addEventListener('keydown', again, true)
    const timer = setInterval(() => {
      if (document.visibilityState === 'hidden' || dialogOpen()) again()
      else setLeft((n) => Math.max(0, n - 1))
    }, 1000)
    return () => {
      clearInterval(timer)
      window.removeEventListener('pointerdown', again, true)
      window.removeEventListener('keydown', again, true)
    }
  }, [autoVersion])

  const restart = useCallback(async () => {
    setBusy(true)
    const result = await installNow()
    setBusy(false)
    if (result.ok) return
    const err = result.error || {}
    if (err.code === 'blocked') toast.info(blockerText(mainBlocker(err.blockers), t))
    else toast.error(failureText(err.code, t))
  }, [installNow, t])

  useEffect(() => {
    if (!autoVersion || left > 0) return
    // the scorer may have opened a dialog or hidden the window since the last tick
    if (document.visibilityState === 'hidden' || dialogOpen()) {
      setLeft(AUTO_RESTART_SECONDS)
      return
    }
    autoTriedVersion = autoVersion
    setAutoTried(autoVersion)
    restart()
  }, [autoVersion, left, restart])

  if (!notice) return null
  const { version } = notice

  const later = () => {
    laterVersion = version
    setHidden(version)
  }

  const copy = async () => {
    const r = await copyToClipboard(REPO_COMMAND)
    if (r?.success) toast.success(t('update.copied', 'Copied.'))
  }

  let title
  let body
  if (notice.type === 'restartPending') {
    title = t('update.restartToFinish', { version, defaultValue: 'Restart to finish the update to {{version}}' })
    body = autoVersion
      ? t('update.autoRestartIn', { seconds: left, defaultValue: 'OpenVolley restarts by itself in {{seconds}} s.' })
      : t('update.restartTakes', 'Takes about 20 seconds.')
  } else if (notice.type === 'noRepo') {
    title = t('update.ready', { version, defaultValue: 'Update {{version}} is ready' })
    body = t('update.noRepo', 'This copy does not update itself. Run once in a terminal:')
  } else {
    title = t('update.ready', { version, defaultValue: 'Update {{version}} is ready' })
    body = notice.type === 'blocked'
      ? blockerText(mainBlocker(status.blockers), t)
      : status.autoInstall
        ? `${t('update.readyOnQuit', 'It installs when you quit OpenVolley.')} ${t('update.restartTakes', 'Takes about 20 seconds.')}`
        : t('update.restartTakes', 'Takes about 20 seconds.')
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="desktop-update-notice"
      className="ov-kit no-print fixed bottom-4 right-4 z-40 w-[22rem] max-w-[calc(100vw-2rem)] rounded-2xl border border-stone-200/70 bg-white p-4 shadow-card-lg"
      style={{ marginBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sky-50 text-sky-600" aria-hidden="true">
          <Download size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-stone-900 tabular-nums">{title}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-stone-500">{body}</p>
        </div>
      </div>

      {notice.type === 'noRepo' && (
        <div className="mt-3 flex items-stretch gap-2">
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg border border-stone-200 bg-stone-50 px-2 py-1.5 font-mono text-[11px] text-stone-700">
            {REPO_COMMAND}
          </code>
          <Button variant="secondary" size="sm" icon={Copy} onClick={copy}>
            {t('update.copy', 'Copy')}
          </Button>
        </div>
      )}

      <div className="mt-3 flex justify-end gap-2">
        <Button variant="secondary" size="md" onClick={later}>
          {t('common.later', 'Later')}
        </Button>
        {(notice.type === 'ready' || notice.type === 'restartPending') && (
          <Button variant="dark" size="md" icon={RefreshCw} loading={busy} onClick={restart}>
            {t('update.restartNow', 'Restart and update')}
          </Button>
        )}
      </div>
    </div>
  )
}
