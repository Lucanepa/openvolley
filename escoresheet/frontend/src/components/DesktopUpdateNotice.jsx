import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Download, RefreshCw } from 'lucide-react'
import { Button, toast } from '../ui'
import { useDesktopUpdate } from '../hooks/useDesktopUpdate'
import { getLiveMatch, onLiveMatchChange } from '../utils/appLifecycle'
import { REPO_COMMAND, blockerText, failureText, mainBlocker, noticeFor } from '../utils/desktopUpdate'
import { copyToClipboard } from '../utils/networkInfo'

// "Later" hides the notice for that version until the app starts again.
let laterVersion = null

/** Tests: forget "Later". */
export function resetDesktopUpdateNoticeForTests() {
  laterVersion = null
}

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
 * - a .deb installed by hand: the command that adds the repo, with Copy.
 */
export default function DesktopUpdateNotice() {
  const { t } = useTranslation()
  const { active, status, installNow } = useDesktopUpdate()
  const [live, setLive] = useState(getLiveMatch)
  const [hidden, setHidden] = useState(laterVersion)
  const [busy, setBusy] = useState(false)

  useEffect(() => onLiveMatchChange(setLive), [])

  if (!active || live !== 'none') return null
  const notice = noticeFor(status, { hidden })
  if (!notice) return null
  const { version } = notice

  const later = () => {
    laterVersion = version
    setHidden(version)
  }

  const restart = async () => {
    setBusy(true)
    const result = await installNow()
    setBusy(false)
    if (result.ok) return
    const err = result.error || {}
    if (err.code === 'blocked') toast.info(blockerText(mainBlocker(err.blockers), t))
    else toast.error(failureText(err.code, t))
  }

  const copy = async () => {
    const r = await copyToClipboard(REPO_COMMAND)
    if (r?.success) toast.success(t('update.copied', 'Copied.'))
  }

  let title
  let body
  if (notice.type === 'restartPending') {
    title = t('update.restartToFinish', { version, defaultValue: 'Restart to finish the update to {{version}}' })
    body = t('update.restartTakes', 'Takes about 20 seconds.')
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

      {(notice.type === 'ready' || notice.type === 'restartPending' || notice.type === 'noRepo') && (
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" size="md" onClick={later}>
            {t('common.later', 'Later')}
          </Button>
          {notice.type !== 'noRepo' && (
            <Button variant="dark" size="md" icon={RefreshCw} loading={busy} onClick={restart}>
              {t('update.restartNow', 'Restart and update')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
