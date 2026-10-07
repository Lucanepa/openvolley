import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleCheck, ExternalLink, KeyRound, LogIn, LogOut, RotateCw, ShieldOff, UserPlus } from 'lucide-react'
import { useAuth } from './contexts/AuthContext'
import ManageConsole, { manageTabsFor } from './components/manage/ManageConsole'
import LoginModal from './components/auth/LoginModal'
import SignUpForm from './components/auth/SignUpForm'
import InviteCodeForm from './components/auth/InviteCodeForm'
import { AppSpinner, BUTTON_SIZES, BUTTON_VARIANTS, Button, cn, consoleHeaderBtn, FOCUS_RING, GateScreen } from './ui'
import { mainAppUrl, SIGN_UP_HASH } from './utils/managerSite'

/**
 * manager.openvolley.app: the manage console as a site of its own, for
 * admins (every tab) and competition managers (saved teams).
 *
 *   signed out                  -> sign-in card (the app's LoginModal)
 *   signed out, #signup         -> "Create account" page (SignUpForm); the
 *                                  scorer apps link here: accounts are made
 *                                  on this site only
 *   signed in, profile unknown  -> loading, then "try again"
 *   pending (no role yet)       -> next step: the club's invite code
 *   scorer, no manage role      -> "you're all set, sign in in the scorer app"
 *   other roles (referee only)  -> "no access, ask an admin" + invite code
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

/** The hash route of a signed-out visitor ('signup' or ''), kept in step with the URL. */
function useHashRoute() {
  const [route, setRoute] = useState(() => tabFromHash() || '')
  useEffect(() => {
    const onHash = () => setRoute(tabFromHash() || '')
    window.addEventListener('hashchange', onHash)
    window.addEventListener('popstate', onHash)
    return () => {
      window.removeEventListener('hashchange', onHash)
      window.removeEventListener('popstate', onHash)
    }
  }, [])
  // A new history entry, so the browser's Back returns to the sign-in card
  const go = useCallback((next) => {
    try {
      const { pathname, search } = window.location
      window.history.pushState(window.history.state, '', next ? `#${next}` : `${pathname}${search}`)
    } catch { /* no history */ }
    setRoute(next || '')
  }, [])
  return [route, go]
}

const logo = (cls) => (
  <img src={`${import.meta.env.BASE_URL}openvolley_no_bg.png`} alt="OpenVolley" className={cls} />
)

// "Open the scorer app" as a full-width link button
const linkButton = (variant, size) => cn('inline-flex w-full items-center justify-center font-medium transition-colors', FOCUS_RING, size && BUTTON_SIZES[size], BUTTON_VARIANTS[variant])

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

function Gate({ width, className, children }) {
  const { t } = useTranslation()
  return (
    <GateScreen
      width={width}
      className={className}
      logo={logo('h-11 w-auto')}
      eyebrow={t('managerSite.eyebrow')}
      corner={<LanguageSelect compact />}
      footer={`OpenVolley ${typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''}`.trim()}
    >
      {children}
    </GateScreen>
  )
}

function SignInScreen({ onCreateAccount }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <>
      <Gate>
        <div data-testid="manager-sign-in" className="text-center">
          <h1 className="text-xl font-bold tracking-tight text-stone-900">{t('managerSite.signInHeading')}</h1>
          <p className="mt-2 text-sm text-stone-600">{t('managerSite.signInBody')}</p>
          <Button variant="hero" block icon={LogIn} onClick={() => setOpen(true)} className="mt-6">
            {t('managerSite.signIn')}
          </Button>
          <div className="mt-5 border-t border-stone-100 pt-4">
            <p className="text-xs text-stone-500">{t('managerSite.noAccountYet')}</p>
            <Button variant="secondary" size="lg" block icon={UserPlus} onClick={onCreateAccount} className="mt-2">
              {t('managerSite.createAccount')}
            </Button>
          </div>
        </div>
      </Gate>
      <LoginModal
        open={open}
        onClose={() => setOpen(false)}
        onSwitchToSignUp={() => { setOpen(false); onCreateAccount() }}
      />
    </>
  )
}

/** #signup: accounts are made here (the scorer apps link to this page). */
function SignUpScreen({ onSignedUp, onBack }) {
  const { t } = useTranslation()
  const [loginOpen, setLoginOpen] = useState(false)
  return (
    <>
      <Gate width="md" className="p-6 sm:p-8">
        <div data-testid="manager-sign-up">
          <div className="mb-5 text-center">
            <h1 className="text-xl font-bold tracking-tight text-stone-900">{t('managerSite.signUpHeading')}</h1>
            <p className="mt-2 text-sm text-stone-600">{t('managerSite.signUpBody')}</p>
          </div>
          <SignUpForm onSignedUp={onSignedUp} onSwitchToLogin={() => setLoginOpen(true)} />
          <p className="mt-2 text-center">
            <button type="button" onClick={onBack} className={cn('min-h-11 text-xs text-stone-500 transition-colors hover:text-stone-800', FOCUS_RING, 'rounded')}>
              {t('managerSite.backToSignIn')}
            </button>
          </p>
        </div>
      </Gate>
      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} onSwitchToSignUp={() => setLoginOpen(false)} />
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

/** "Desktop / Android app? Just sign in there" + the link to the web app. */
function ScorerAppLinks({ primary = false }) {
  const { t } = useTranslation()
  return (
    <div data-testid="scorer-app-links">
      <a href={mainAppUrl()} className={primary ? cn(linkButton('hero'), 'gap-2') : cn(linkButton('secondary', 'lg'))}>
        <ExternalLink size={16} aria-hidden />
        {t('managerSite.openAppLong')}
      </a>
      <p className="mt-2 text-center text-xs text-stone-500">{t('managerSite.nativeAppsNote')}</p>
    </div>
  )
}

/**
 * A new (pending) account: the next step is the club's invite code. A code
 * makes the account a scorer at once (AuthContext re-reads the roles and this
 * page turns into "you're all set"); without one an admin approves it, which
 * AuthContext picks up on its own (it re-reads a pending profile every minute).
 */
function InviteStepScreen({ justSignedUp }) {
  const { t } = useTranslation()
  return (
    <Gate>
      <div data-testid="manager-invite-step">
        {justSignedUp && (
          <p role="status" className="mb-4 flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm font-medium text-green-800">
            <CircleCheck size={16} aria-hidden className="shrink-0 text-green-600" />
            {t('managerSite.accountCreated')}
          </p>
        )}
        <div className="text-center">
          <KeyRound className="mx-auto h-8 w-8 text-stone-400" aria-hidden />
          <h1 className="mt-3 text-base font-semibold text-stone-900">{t('managerSite.inviteStepTitle')}</h1>
          <p className="mt-1.5 text-sm text-stone-600">{t('managerSite.inviteStepBody')}</p>
        </div>
        <InviteCodeForm className="mt-4" />
        <p className="mt-3 text-xs text-stone-500">{t('managerSite.inviteStepNoCode')}</p>
        <div className="mt-5 border-t border-stone-100 pt-4">
          <ScorerAppLinks />
        </div>
        <div className="text-center"><SignedInAs /></div>
        <div className="mt-4"><SignOutButton block /></div>
      </div>
    </Gate>
  )
}

/** An approved scorer without a manage role: nothing to do here, score in the app. */
function AllSetScreen() {
  const { t } = useTranslation()
  const [showCode, setShowCode] = useState(false)
  return (
    <Gate>
      <div data-testid="manager-all-set">
        <div className="text-center">
          <CircleCheck className="mx-auto h-8 w-8 text-emerald-600" aria-hidden />
          <h1 className="mt-3 text-base font-semibold text-stone-900">{t('managerSite.allSetTitle')}</h1>
          <p className="mt-1.5 text-sm text-stone-600">{t('managerSite.allSetBody')}</p>
        </div>
        <div className="mt-5"><ScorerAppLinks primary /></div>
        <div className="mt-5 border-t border-stone-100 pt-3">
          {showCode ? (
            // A code for a manage role opens the console at once
            <InviteCodeForm autoFocus />
          ) : (
            <button type="button" onClick={() => setShowCode(true)} className={cn('min-h-11 w-full rounded text-xs text-stone-500 transition-colors hover:text-stone-800', FOCUS_RING)}>
              {t('managerSite.haveManagerCode')}
            </button>
          )}
        </div>
        <div className="text-center"><SignedInAs /></div>
        <div className="mt-4"><SignOutButton block /></div>
      </div>
    </Gate>
  )
}

/** Accounts with a role that gives nothing here (referee only). */
function NoAccessScreen() {
  const { t } = useTranslation()
  return (
    <Gate>
      <div data-testid="manager-no-access">
        <div className="text-center">
          <ShieldOff className="mx-auto h-8 w-8 text-stone-400" aria-hidden />
          <h1 className="mt-3 text-base font-semibold text-stone-900">{t('managerSite.noAccessTitle')}</h1>
          <p className="mt-1.5 text-sm text-stone-600">
            {t('managerSite.noAccessBody')}
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
  const [route, goRoute] = useHashRoute()
  const [justSignedUp, setJustSignedUp] = useState(false)

  // Signed in: #signup has done its job (and is no console tab)
  useEffect(() => {
    if (!user || route !== SIGN_UP_HASH) return
    try {
      const { pathname, search } = window.location
      window.history.replaceState(window.history.state, '', `${pathname}${search}`)
    } catch { /* no history */ }
    setTab(null)
  }, [user, route])

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
  if (!user) {
    return (
      <div className="ov-kit">
        {route === SIGN_UP_HASH
          ? <SignUpScreen onSignedUp={({ signedIn }) => { if (signedIn) setJustSignedUp(true) }} onBack={() => goRoute('')} />
          : <SignInScreen onCreateAccount={() => goRoute(SIGN_UP_HASH)} />}
      </div>
    )
  }
  if (!access.known) return <div className="ov-kit"><AccountLoadingScreen /></div>
  if (manageTabsFor(access).length === 0) {
    let screen = <NoAccessScreen />
    if (access.isPending) screen = <InviteStepScreen justSignedUp={justSignedUp} />
    else if (access.canScore) screen = <AllSetScreen />
    return <div className="ov-kit">{screen}</div>
  }

  // No onClose: there is no app to go back to; the header links to it instead
  return <ManageConsole tab={tab} onTab={selectTab} headerActions={<ConsoleHeaderActions />} />
}
