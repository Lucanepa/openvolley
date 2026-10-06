import { useTranslation } from 'react-i18next'
import useAndroidUpdate from '../../hooks/useAndroidUpdate'
import { Button, Switch } from '../../ui'

const currentVersion = __APP_VERSION__

// The options' settings row (HomeOptionsModal Row): flat, min 48px, the
// Section draws the hairlines between rows.
const ROW = 'flex min-h-12 shrink-0 py-3'

/**
 * Options → App version in the Android app (the web's version.json check
 * would always answer "latest" here: the APK bundles that file).
 * - installed by F-Droid: "Updates come from F-Droid." + Open in F-Droid
 * - otherwise: "Notify me about new versions" (the opt-in, default off)
 * - both: Check for updates (asked by the user, so allowed for every install)
 */
export default function AndroidVersionRows() {
  const { t } = useTranslation()
  const update = useAndroidUpdate()
  const fromFdroid = update.family === 'fdroid'
  const mayNotify = update.family === 'sideload' || update.family === 'other'
  const checking = update.status === 'checking'

  return (
    <>
      <div className={`${ROW} items-center justify-between gap-3`} data-testid="android-version-rows">
        <div>
          <div className="text-sm font-semibold text-stone-900">{t('options.currentVersion')}</div>
          <div className="mt-0.5 text-xs tabular-nums text-stone-500">v{currentVersion}</div>
        </div>
        <Button variant="secondary" size="xl" onClick={() => update.checkNow()} loading={checking} disabled={checking}>
          {checking ? t('options.checking') : t('options.checkForUpdates')}
        </Button>
      </div>

      {fromFdroid ? (
        <div className={`${ROW} items-center justify-between gap-3`}>
          <p className="text-sm text-stone-700">{t('androidUpdate.fromFdroid')}</p>
          <Button variant="secondary" size="xl" onClick={() => update.openInFdroid()}>
            {t('androidUpdate.openFdroid')}
          </Button>
        </div>
      ) : mayNotify ? (
        <label className={`${ROW} cursor-pointer items-center justify-between gap-4`}>
          <span>
            <span className="block text-sm font-semibold text-stone-900">{t('androidUpdate.notifyOption')}</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-stone-500">
              {t('androidUpdate.notFromFdroid')} {t('androidUpdate.notifyHint')}
            </span>
          </span>
          <Switch
            size="lg"
            checked={update.notify === 'yes'}
            onCheckedChange={(on) => update.setNotify(on)}
            aria-label={t('androidUpdate.notifyOption')}
          />
        </label>
      ) : null}

      {(update.status !== 'idle' && !checking) && (
        <div className={`${ROW} flex-col items-stretch`}>
          {update.newer ? (
            <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2">
              <div className="text-sm font-semibold text-green-800">
                {t('androidUpdate.available', { version: update.latest.versionName })}
              </div>
              <div className="mt-0.5 text-xs tabular-nums text-stone-600">
                {currentVersion} → {update.latest.versionName}
              </div>
              {/* the check reads the OpenVolley repo; an f-droid.org install
                  gets the version only once f-droid.org has built it */}
              {fromFdroid && (
                <p className="mt-1 text-xs leading-relaxed text-stone-600">{t('androidUpdate.fdroidRepoHint')}</p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                {fromFdroid ? (
                  <>
                    <Button variant="dark" size="md" onClick={() => update.openInFdroid()}>{t('androidUpdate.openFdroid')}</Button>
                    <Button variant="secondary" size="md" onClick={() => update.getFromFdroid()}>{t('androidUpdate.addRepo')}</Button>
                  </>
                ) : (
                  <>
                    <Button variant="dark" size="md" onClick={() => update.getFromFdroid()} className="h-auto min-h-9 py-1.5 text-left">
                      {t('androidUpdate.getFdroid')}
                    </Button>
                    <Button variant="secondary" size="md" onClick={() => update.downloadApk()}>{t('androidUpdate.downloadApk')}</Button>
                  </>
                )}
              </div>
            </div>
          ) : update.status === 'failed' ? (
            <div role="alert" className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">
              {t('options.couldNotCheckUpdates')}
            </div>
          ) : (
            <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">
              {t('options.latestVersion')}
            </div>
          )}
        </div>
      )}
    </>
  )
}
