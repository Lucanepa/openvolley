import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { settingsApi } from '../../lib/accountApi'
import { usePanelData, useOnline, OfflineBanner, PanelHead, useErrorText } from './common'
import { Notice, SkeletonRows, Switch, confirmDialog, dayLabel, toast } from '../../ui'

/**
 * Settings (db/021, lib/finalMail.js): OpenVolley's switches, for admins and
 * competition managers. "Send final email": once an official match is closed,
 * its scoresheet PDF goes to the scorer, the referees and the contact of each
 * team's club. Off by default, so nothing goes out while the app is tested;
 * matches closed before it was turned on are never mailed.
 */
export default function SettingsPanel() {
  const { t } = useTranslation()
  const online = useOnline()
  const errorText = useErrorText()
  const { data, error, loading, reload } = usePanelData(() => settingsApi.get(), [], { enabled: online })
  const on = data?.settings?.send_final_email === true
  const [busy, setBusy] = useState(false)

  const setFinalEmail = async (next) => {
    if (next) {
      const ok = await confirmDialog({
        title: t('manage.settings.finalEmailOnTitle'),
        message: t('manage.settings.finalEmailOnBody'),
        confirmLabel: t('manage.settings.finalEmailOnConfirm'),
        cancelLabel: t('common.cancel', 'Cancel')
      })
      if (!ok) return
    }
    setBusy(true)
    const res = await settingsApi.setFinalEmail(next)
    setBusy(false)
    if (res.error) {
      toast.error(errorText(res.error))
      return
    }
    toast.success(next ? t('manage.settings.finalEmailIsOn') : t('manage.settings.finalEmailIsOff'))
    reload()
  }

  return (
    <section data-testid="manage-settings">
      <PanelHead title={t('manage.tabs.settings')} />
      <OfflineBanner online={online} />
      {error && <Notice className="mb-3">{errorText(error)}</Notice>}
      {loading && !data ? <SkeletonRows rows={1} pill={false} /> : (
        <div className="flex items-start gap-3 rounded-lg border border-stone-200 bg-white px-3 py-3">
          <Switch
            checked={on}
            onCheckedChange={setFinalEmail}
            disabled={!online || busy || !data}
            aria-labelledby="final-email-title"
            data-testid="final-email-switch"
          />
          <div className="min-w-0">
            <p id="final-email-title" className="text-sm font-semibold text-stone-900">{t('manage.settings.finalEmail')}</p>
            <p className="mt-0.5 text-xs text-stone-600">{on ? t('manage.settings.finalEmailOnHint') : t('manage.settings.finalEmailOffHint')}</p>
            {data?.settings?.changed_at && (
              <p className="mt-1 text-[11px] text-stone-500">{t('manage.settings.changed')} {dayLabel(data.settings.changed_at, { year: true })}</p>
            )}
            {data && data.mail === false && (
              <p className="mt-1 text-xs font-medium text-amber-800" data-testid="final-email-no-mail">{t('manage.settings.noMail')}</p>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
