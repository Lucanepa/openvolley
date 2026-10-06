import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, LogIn, LogOut, RotateCw, ShieldOff } from 'lucide-react'
import { useAuth } from './contexts/AuthContext'
import ManageConsole, { manageTabsFor } from './components/manage/ManageConsole'
import LoginModal from './components/auth/LoginModal'
import InviteCodeForm from './components/auth/InviteCodeForm'
import { AppSpinner, Button, cn, consoleHeaderBtn, FOCUS_RING, GateScreen } from './ui'
import { mainAppUrl } from './utils/managerSite'

/**
 * manager.openvolley.app: the manage console as a site of its own, for
 * admins (every tab) and competition managers (saved teams).
 *
 *   signed out                  -> sign-in card (the app's LoginModal)
 *   signed in, profile unknown  -> loading, then "try again"
 *   no manage role              -> "no access, ask an admin" + invite code
 *   admin / competition manager -> ManageConsole, full screen
 *
 * Hiding tabs is cosmetic, as in the app: the server refuses every action
 * the account's roles do not allow.
 */

// How long a signed-in account may show "loading" before offering a retry.
export const ACCOUNT_LOAD_TIMEOUT_MS = 8000

const LANGUAGES = [
  { code: 'en', short: 'EN', name: 'English' },
  { code: 'de', short: 'DE', name: 'Deutsch' },
  { code: 'de-CH', short: 'DE-CH', name: 'Schweizerdeutsch' },
  { code: 'fr', short: 'FR', name: 'Français' },
  { code: 'it', short: 'IT', name: 'Italiano' }
]

/**
 * The tab named in the URL hash, or null. No list of tab ids here: the
 * console owns them and opens its first allowed tab for an id it does not
 * know (or this account may not see), so a tab added to ManageConsole is
 * restored from the hash without a change in this file.
 */
export function tabFromHash() {
  try {
    return window.location.hash.replace(/^#/, '') || null
  } catch {
    return null
  }
}

const logo = (cls) => (
  <img src={`${import.meta.env.BASE_URL}openvolley_no_bg.png`} alt="OpenVolley" className={cls} />
)

const quietLink = cn('rounded font-medium text-red-600 underline decoration-red-300 underline-offset-2 transition-colors hover:text-red-700 hover:decoration-red-500', FOCUS_RING)

function LanguageSelect({ compact = false }) {
  const { t, i18n } = useTranslation()
  const label = t('managerSite.language')
  const current = LANGUAGES.some(l => l.code === i18n.language) ? i18n.language : 'en'
  return (
    <select
      aria-label={label}
      title={label}
      value={current}
      onChange={e => i18n.changeLanguage(e.target.value)}
      className={cn('h-9 rounded-lg border border-stone-200 bg-white px-2 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-100', FOCUS_RING)}
    >
      {LANGUAGES.map(l => <option key={l.code} value={l.code}>{compact ? l.short : l.name}</option>)}
    </select>
  )
}

function accountName(user, profile) {
  const name = [profile?.first_name, profile?.last_name].filter(Boolean).join(' ').trim()
  return name || user?.email || ''
}

function Gate({ children }) {
  const { t } = useTranslation()
  return (
    <GateScreen
      logo={logo('h-11 w-auto')}
      eyebrow={t('managerSite.eyebrow')}
      corner={<LanguageSelect compact />}
      footer={`OpenVolley ${typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''}`.trim()}
    >
      {children}
    </GateScreen>
  )
}

function SignInScreen() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const appUrl = mainAppUrl()
  return (
    <>
      <Gate>
        <div data-testid="manager-sign-in" className="text-center">
          <h1 className="text-xl font-bold tracking-tight text-stone-900">{t('managerSite.signInHeading')}</h1>
          <p className="mt-2 text-sm text-stone-600">{t('managerSite.signInBody')}</p>
          <Button variant="hero" block icon={LogIn} onClick={() => setOpen(true)} className="mt-6">
            {t('managerSite.signIn')}
          </Button>
          <p className="mt-5 border-t border-stone-100 pt-4 text-xs text-stone-500">
            {t('managerSite.noAccountYet')}{' '}
            <a href={appUrl} className={quietLink}>{t('managerSite.openAppLong')}</a>
          </p>
        </div>
      </Gate>
      {/* "Sign up" in the dialog goes to the scorer app, where accounts are made */}
      <LoginModal open={open} onClose={() => setOpen(false)} onSwitchToSignUp={() => window.location.assign(appUrl)} />
    </>
  )
}

function SignOutButton({ block = false }) {
  const { t } = useTranslation()
  const { signOut } = useAuth()
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try { await signOut() } finally { setBusy(false) }
  }
  if (block) {
    return (
      <Button variant="secondary" block size="lg" icon={LogOut} loading={busy} onClick={run}>
        {t('managerSite.signOut')}
      </Button>
    )
  }
  return (
    <button type="button" className={consoleHeaderBtn} onClick={run} disabled={busy} aria-label={t('managerSite.signOut')} title={t('managerSite.signOut')}>
      <LogOut size={14} aria-hidden />
      <span className="hidden sm:inline">{t('managerSite.signOut')}</span>
    </button>
  )
}

function SignedInAs() {
  const { t } = useTranslation()
  const { user, profile } = useAuth()
  const name = accountName(user, profile)
  if (!name) return null
  return <p className="mt-4 truncate text-xs text-stone-500">{t('managerSite.signedInAs', { name })}</p>
}

/** Signed in, but the profile (roles) is not known yet. */
function AccountLoadingScreen() {
  const { t } = useTranslation()
  const { user, fetchProfile } = useAuth()
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setFailed(true), ACCOUNT_LOAD_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [])

  const retry = async () => {
    setBusy(true)
    const row = await fetchProfile(user.id)
    setBusy(false)
    setFailed(!row)
  }

  return (
    <Gate>
      <div data-testid="manager-account-loading" className="text-center">
        {failed ? (
          <>
            <p role="alert" className="text-sm text-stone-700">{t('managerSite.accountNotLoaded')}</p>
            <Button variant="hero" block icon={RotateCw} loading={busy} onClick={retry} className="mt-5">
              {t('managerSite.retry')}
            </Button>
          </>
        ) : (
          <AppSpinner size={72} label={t('managerSite.loadingAccount')} srLabel={t('managerSite.loadingAccount')} />
        )}
        <SignedInAs />
        <div className="mt-4"><SignOutButton block /></div>
      </div>
    </Gate>
  )
}

/** Pending, scorer- or referee-only accounts. */
function NoAccessScreen() {
  const { t } = useTranslation()
  const { access } = useAuth()
  return (
    <Gate>
      <div data-testid="manager-no-access">
        <div className="text-center">
          <ShieldOff className="mx-auto h-8 w-8 text-stone-400" aria-hidden />
          <h1 className="mt-3 text-base font-semibold text-stone-900">{t('managerSite.noAccessTitle')}</h1>
          <p className="mt-1.5 text-sm text-stone-600">
            {access.isPending ? t('managerSite.pendingBody') : t('managerSite.noAccessBody')}
          </p>
          <SignedInAs />
        </div>
        {/* A code that grants a manage role opens the console at once (AuthContext re-reads the roles) */}
        <InviteCodeForm className="mt-5 border-t border-stone-100 pt-4" />
        <div className="mt-5"><SignOutButton block /></div>
        <p className="mt-3 text-center text-xs">
          <a href={mainAppUrl()} className={quietLink}>{t('managerSite.openAppLong')}</a>
        </p>
      </div>
    </Gate>
  )
}

function ConsoleHeaderActions() {
  const { t } = useTranslation()
  const { user, profile } = useAuth()
  const name = accountName(user, profile)
  return (
    <>
      {name && <span className="hidden min-w-0 max-w-[16rem] truncate text-xs text-stone-500 md:inline" title={name}>{name}</span>}
      <a href={mainAppUrl()} className={consoleHeaderBtn} aria-label={t('managerSite.openAppLong')} title={t('managerSite.openAppLong')}>
        <ExternalLink size={14} aria-hidden />
        <span className="hidden sm:inline">{t('managerSite.openApp')}</span>
      </a>
      <LanguageSelect compact />
      <SignOutButton />
    </>
  )
}

export default function ManagerApp() {
  const { t } = useTranslation()
  const { user, access, loading } = useAuth()
  const [tab, setTab] = useState(tabFromHash)

  // The open tab lives in the URL hash, so a reload or a bookmark keeps it
  const selectTab = useCallback((id) => {
    setTab(id)
    try { window.history.replaceState(window.history.state, '', `#${id}`) } catch { /* no history */ }
  }, [])

  if (loading) {
    return (
      <div className="ov-kit flex min-h-screen items-center justify-center bg-gradient-to-br from-stone-100 via-stone-50 to-stone-100 p-4">
        <AppSpinner size={72} label={t('managerSite.loadingAccount')} srLabel={t('managerSite.loadingAccount')} />
      </div>
    )
  }
  if (!user) return <div className="ov-kit"><SignInScreen /></div>
  if (!access.known) return <div className="ov-kit"><AccountLoadingScreen /></div>
  if (manageTabsFor(access).length === 0) return <div className="ov-kit"><NoAccessScreen /></div>

  // No onClose: there is no app to go back to; the header links to it instead
  return <ManageConsole tab={tab} onTab={selectTab} headerActions={<ConsoleHeaderActions />} />
}
