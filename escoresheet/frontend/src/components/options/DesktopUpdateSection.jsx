import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, RefreshCw } from 'lucide-react'
import { Button, Switch, toast } from '../../ui'
import { APT_COMMAND, REPO_COMMAND, blockerText, failureText, isDownloadingKind, mainBlocker, statusLine } from '../../utils/desktopUpdate'
import { copyToClipboard } from '../../utils/networkInfo'

const currentVersion = __APP_VERSION__

// The settings rows of HomeOptionsModal: flat, min 48px, the section draws the hairlines.
function Row({ children, className = '' }) {
  return <div className={`flex min-h-12 shrink-0 items-center justify-between gap-3 py-3 ${className}`}>{children}</div>
}

function CommandBox({ command, t }) {
  const copy = async () => {
    const r = await copyToClipboard(command)
    if (r?.success) toast.success(t('update.copied', 'Copied.'))
  }
  return (
    <div className="flex items-stretch gap-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg border border-stone-200 bg-stone-50 px-2 py-2 font-mono text-xs text-stone-700">
        {command}
      </code>
      <Button variant="secondary" size="md" icon={Copy} onClick={copy}>
        {t('update.copy', 'Copy')}
      </Button>
    </div>
  )
}

/**
 * Options > App version in the desktop app (src-tauri/src/updater.rs): the
 * version, what the updater is doing, "Check for updates", "Restart and
 * update" when the app allows it (else why it waits), the two settings and
 * the release notes. The web build keeps its service-worker check
 * (HomeOptionsModal); the bundled version.json never knew about app updates.
 *
 * @param {{ update: ReturnType<typeof import('../../hooks/useDesktopUpdate').useDesktopUpdate> }} props
 */
export default function DesktopUpdateSection({ update }) {
  const { t } = useTranslation()
  const { status, checkNow, installNow, setPrefs } = update
  const [restarting, setRestarting] = useState(false)
  const kind = status?.kind
  const supported = !!kind && kind !== 'unsupported'
  const busy = ['checking', 'downloading', 'installing'].includes(status?.phase)
  const line = statusLine(status, t)
  const failed = status?.phase === 'failed'
  const version = status?.available?.version
  const offersRestart = supported && (
    status?.phase === 'restartPending'
    || (status?.phase === 'ready' && (isDownloadingKind(kind) || kind === 'debApt'))
  )
  const blocker = mainBlocker(status?.blockers)

  const restart = async () => {
    setRestarting(true)
    const result = await installNow()
    setRestarting(false)
    if (result.ok) return
    const err = result.error || {}
    if (err.code === 'blocked') toast.info(blockerText(mainBlocker(err.blockers), t))
    else toast.error(failureText(err.code, t))
  }

  return (
    <>
      <Row>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-stone-900">{t('options.currentVersion')}</div>
          <div className="mt-0.5 text-xs tabular-nums text-stone-500">v{status?.current || currentVersion}</div>
          {supported && line && (
            <div
              role={failed ? 'alert' : undefined}
              data-testid="desktop-update-status"
              className={`mt-1 text-xs tabular-nums ${failed ? 'text-red-700' : 'text-stone-600'}`}
            >
              {line}
            </div>
          )}
          {!supported && status && (
            <div className="mt-1 text-xs text-stone-500">{t('update.notSupported', 'This build does not update itself.')}</div>
          )}
        </div>
        {supported && (
          <Button variant="secondary" size="xl" onClick={checkNow} disabled={busy} loading={status?.phase === 'checking'}>
            {status?.phase === 'checking' ? t('options.checking') : t('options.checkForUpdates')}
          </Button>
        )}
      </Row>

      {offersRestart && (
        <Row className="flex-col !items-stretch">
          {status.canRestart ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs leading-relaxed text-stone-500">
                {status.phase === 'restartPending' || !status.autoInstall
                  ? t('update.restartTakes', 'Takes about 20 seconds.')
                  : `${t('update.readyOnQuit', 'It installs when you quit OpenVolley.')} ${t('update.restartTakes', 'Takes about 20 seconds.')}`}
              </p>
              <Button variant="dark" size="xl" icon={RefreshCw} loading={restarting} onClick={restart}>
                {t('update.restartNow', 'Restart and update')}
              </Button>
            </div>
          ) : (
            <p className="text-xs text-amber-800" data-testid="desktop-update-blocker">
              {blockerText(blocker, t)}
            </p>
          )}
        </Row>
      )}

      {kind === 'debNoRepo' && (
        <Row className="flex-col !items-stretch">
          <p className="text-xs text-stone-600">{t('update.noRepo', 'This copy does not update itself. Run once in a terminal:')}</p>
          <CommandBox command={REPO_COMMAND} t={t} />
        </Row>
      )}

      {failed && status.msg === 'noPkexec' && (
        <Row className="flex-col !items-stretch">
          <CommandBox command={APT_COMMAND} t={t} />
        </Row>
      )}

      {supported && (
        <>
          <Row>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-stone-900">{t('update.autoCheck', 'Check for updates automatically')}</div>
              <div className="mt-0.5 text-xs text-stone-500">{t('update.autoCheckHint', 'Asks get.openvolley.app every 6 hours.')}</div>
            </div>
            <Switch
              size="lg"
              checked={!!status.autoCheck}
              onCheckedChange={(v) => setPrefs({ autoCheck: v })}
              aria-label={t('update.autoCheck', 'Check for updates automatically')}
            />
          </Row>
          <Row>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-stone-900">{t('update.autoInstall', 'Install updates automatically')}</div>
              <div className="mt-0.5 text-xs text-stone-500">{t('update.autoInstallHint', 'Downloads in the background and installs when you quit, never during a match.')}</div>
            </div>
            <Switch
              size="lg"
              checked={!!status.autoInstall}
              onCheckedChange={(v) => setPrefs({ autoInstall: v })}
              aria-label={t('update.autoInstall', 'Install updates automatically')}
            />
          </Row>
        </>
      )}

      {supported && version && status.available?.notes && (
        <Row className="flex-col !items-stretch">
          <details>
            <summary className="cursor-pointer text-sm font-semibold text-stone-900">
              {t('update.whatsNew', "What's new")} <span className="font-normal tabular-nums text-stone-500">· {version}</span>
            </summary>
            <p className="mt-2 whitespace-pre-line text-xs leading-relaxed text-stone-600">{status.available.notes}</p>
          </details>
        </Row>
      )}
    </>
  )
}
