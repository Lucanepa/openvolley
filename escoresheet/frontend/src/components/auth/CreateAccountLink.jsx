import { useTranslation } from 'react-i18next'
import { ExternalLink } from 'lucide-react'
import { cn, FOCUS_RING } from '../../ui'
import { openAppWindow } from '../../utils/openAppWindow'
import { MANAGER_SITE_URL, managerSignUpUrl, signUpNeedsInternetNote } from '../../utils/managerSite'

const MANAGER_HOST = new URL(MANAGER_SITE_URL).host

/**
 * "Don't have an account? Create one at manager.openvolley.app" under the
 * scorer apps' sign-in form. Accounts are made on the manager site only: the
 * link opens manager.openvolley.app/#signup in a new tab (web), the system
 * browser (desktop app, via its new-window handler) or Android's browser
 * (Capacitor), through openAppWindow. Away from the public website (the apps,
 * the venue LAN server) or offline it says it needs internet; nothing here
 * ever stands in the way of scoring.
 */
export default function CreateAccountLink({ className = '' }) {
  const { t } = useTranslation()
  const needsInternet = signUpNeedsInternetNote()
  const open = () => {
    openAppWindow(managerSignUpUrl())
  }
  return (
    <div className={cn('text-center text-sm text-stone-500', className)} data-testid="create-account-link">
      {t('auth.noAccount', "Don't have an account?")}{' '}
      <button
        type="button"
        onClick={open}
        className={cn('inline-flex min-h-11 items-center gap-1 rounded font-medium text-red-600 underline decoration-red-300 underline-offset-2 transition-colors hover:text-red-700 hover:decoration-red-500', FOCUS_RING)}
      >
        {t('auth.createAtManager', { host: MANAGER_HOST, defaultValue: 'Create one at {{host}}' })}
        <ExternalLink size={13} aria-hidden="true" className="shrink-0" />
      </button>
      {needsInternet && (
        <p className="text-xs text-stone-400">{t('auth.createNeedsInternet', 'Needs an internet connection. Scoring works without an account.')}</p>
      )}
    </div>
  )
}
