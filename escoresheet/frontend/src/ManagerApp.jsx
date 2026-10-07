import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleCheck, ExternalLink, KeyRound, LogIn, LogOut, MailCheck, RotateCw, ShieldOff, UserPlus, Users } from 'lucide-react'
import { useAuth } from './contexts/AuthContext'
import ManageConsole, { manageTabsFor } from './components/manage/ManageConsole'
import LoginModal from './components/auth/LoginModal'
import SignUpForm from './components/auth/SignUpForm'
import InviteCodeForm from './components/auth/InviteCodeForm'
import EmailConfirmBanner from './components/auth/EmailConfirmBanner'
import { ConfirmEmailPage, ResetPasswordPage } from './components/auth/AuthLinkPages'
import { AppSpinner, BUTTON_SIZES, BUTTON_VARIANTS, Button, cn, consoleHeaderBtn, FOCUS_RING, GateScreen, Select } from './ui'
import { scorerAppUrlFor, SIGN_UP_HASH } from './utils/managerSite'
import { parseAuthLinkHash, takeAuthLinkFromLocation } from './utils/authLinks'
import { useManagerBrand } from './managerBrand'
import LegalLinks from './legal/LegalLinks'
import { accessForApp } from './lib/access'
import { fetchMe, joinApp } from './lib/accountApi'

/**
 * manager.openvolley.app: the manage console as a site of its own, for
 * admins (every tab) and competition managers (saved teams).
 *
 *   #reset?token= / #confirm?token= (the links of the account emails;
 *   manager-main.jsx strips them from the URL before the first render and
 *   passes them in as `authLink`; a link opened in a tab that already shows
 *   the site only changes the hash, useHashRoute takes it then) -> set a new
 *   password / confirm the email, whether or not someone is signed in. These
 *   are never routes or tabs.
 *   signed out                  -> sign-in card (the app's LoginModal)
 *   signed out, #signup         -> "Create account" page (SignUpForm); the
 *                                  scorer apps link here: accounts are made
 *                                  on this site only
 *   signed in, profile unknown  -> loading, then "try again"
 *   pending (no role yet)       -> next step: the club's invite code ("confirm
 *                                  your email" first while the address is not)
 *   scorer, no manage role      -> "you're all set, sign in in the scorer app"
 *   other roles (referee only)  -> "no access, ask an admin" + invite code
 *   admin / competition manager -> ManageConsole, full screen
 *
 * Hiding tabs is cosmetic, as in the app: the server refuses every action
 * the account's roles do not allow.
 *
 * Built twice (src/managerBrand.js): OpenVolley's manager as above, and
 * OpenBeach's (manager-beach.openvolley.app), where the roles are the beach
 * ones and an account that has not joined OpenBeach yet first gets "Join
 * OpenBeach" (POST /api/account/join; one login for both apps, plan 1.1).
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
    const hash = window.location.hash
    // An email link (#reset?token= / #confirm?token=) is no tab
    if (parseAuthLinkHash(hash)) return null
    return hash.replace(/^#/, '') || null
  } catch {
    return null
  }
}

/**
 * The hash route of a signed-out visitor ('signup' or ''), kept in step with
 * the URL. An email link that arrives as a hash change (opened in a tab that
 * already shows the site: no reload, so manager-main.jsx never saw it) is no
 * route: it is taken out of the URL at once and handed to `onAuthLink`.
 */
function useHashRoute(onAuthLink) {
  const [route, setRoute] = useState(() => tabFromHash() || '')
  useEffect(() => {
    const onHash = () => {
      const link = takeAuthLinkFromLocation()
      if (link) {
        setRoute('')
        onAuthLink?.(link)
        return
      }
      setRoute(tabFromHash() || '')
    }
    window.addEventListener('hashchange', onHash)
    window.addEventListener('popstate', onHash)
    return () => {
      window.removeEventListener('hashchange', onHash)
      window.removeEventListener('popstate', onHash)
    }
  }, [onAuthLink])
  // A new history entry, so the browser's Back returns to the sign-in card
  const go = useCallback((next) => {
    try {
      const { pathname, search } = window.location
      window.history.pushState(window.history.state, '', next ? `#${next}` : `${pathname}${search}`)
    } catch { /* no history */ }
    setRoute(next || '')
  }, [])
  // The same, in place: no history entry (replaceState fires no hashchange,
  // so the route state is set here too, or it would keep the old hash)
  const replace = useCallback((next) => {
    try {
      const { pathname, search } = window.location
      window.history.replaceState(window.history.state, '', next ? `#${next}` : `${pathname}${search}`)
    } catch { /* no history */ }
    setRoute(next || '')
  }, [])
  return [route, go, replace]
}

/** The brand's text for `key`: OpenBeach's own (managerBeach.*) where it has one. */
function useBrandText() {
  const { t } = useTranslation()
  const brand = useManagerBrand()
  const beach = brand.app === 'beach'
  return {
    brand,
    beach,
    signInHeading: t(beach ? 'managerBeach.signInHeading' : 'managerSite.signInHeading'),
    signInBody: t(beach ? 'managerBeach.signInBody' : 'managerSite.signInBody'),
    noAccountYet: t(beach ? 'managerBeach.noAccountYet' : 'managerSite.noAccountYet'),
    signUpBody: t(beach ? 'managerBeach.signUpBody' : 'managerSite.signUpBody'),
    inviteStepBody: t(beach ? 'managerBeach.inviteStepBody' : 'managerSite.inviteStepBody'),
    nativeAppsNote: t(beach ? 'managerBeach.nativeAppsNote' : 'managerSite.nativeAppsNote'),
    allSetBody: t(beach ? 'managerBeach.allSetBody' : 'managerSite.allSetBody'),
    openApp: t(beach ? 'managerBeach.openApp' : 'managerSite.openApp'),
    openAppLong: t(beach ? 'managerBeach.openAppLong' : 'managerSite.openAppLong'),
    appUrl: scorerAppUrlFor(brand)
  }
}

function Logo({ className }) {
  const brand = useManagerBrand()
  return <img src={brand.lockup} alt={brand.name} className={className} />
}

// "Open the scorer app" as a full-width link button
const linkButton = (variant, size) => cn('inline-flex w-full items-center justify-center font-medium transition-colors', FOCUS_RING, size && BUTTON_SIZES[size], BUTTON_VARIANTS[variant])

const quietLink = cn('rounded font-medium text-red-600 underline decoration-red-300 underline-offset-2 transition-colors hover:text-red-700 hover:decoration-red-500', FOCUS_RING)

function LanguageSelect({ compact = false }) {
  const { t, i18n } = useTranslation()
  const label = t('managerSite.language')
  const current = LANGUAGES.some(l => l.code === i18n.language) ? i18n.language : 'en'
  return (
    <Select
      aria-label={label}
      title={label}
      value={current}
      onChange={e => i18n.changeLanguage(e.target.value)}
      className={cn('border-stone-200 pl-2.5 pr-7 text-xs leading-[34px] font-medium text-stone-600 transition-colors hover:bg-stone-100 focus:ring-0', FOCUS_RING)}
    >
      {LANGUAGES.map(l => <option key={l.code} value={l.code}>{compact ? l.short : l.name}</option>)}
    </Select>
  )
}

function accountName(user, profile) {
  const name = [profile?.first_name, profile?.last_name].filter(Boolean).join(' ').trim()
  return name || user?.email || ''
}

/**
 * The gate's footer: the product and the version of the code it runs. The
 * version is OpenVolley's (one code base, two builds), so the OpenBeach
 * build names it as such instead of "OpenBeach 2.x" (OpenBeach has its own
 * version numbers).
 */
export function managerFooter(brand, version = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '') {
  const v = String(version || '').trim()
  if (brand?.app === 'beach') return v ? `${brand.name} · OpenVolley ${v}` : brand.name
  return `${brand?.name || 'OpenVolley'} ${v}`.trim()
}

function Gate({ width, className, children }) {
  const { t } = useTranslation()
  const brand = useManagerBrand()
  return (
    <GateScreen
      width={width}
      className={className}
      logo={<Logo className="h-9 w-auto" />}
      eyebrow={t('managerSite.eyebrow')}
      corner={<LanguageSelect compact />}
      footer={managerFooter(brand)}
      below={<LegalLinks className="text-[11px] text-stone-400" />}
    >
      {children}
    </GateScreen>
  )
}

function SignInScreen({ initialMode = null, onCreateAccount }) {
  const { t } = useTranslation()
  const text = useBrandText()
  // initialMode 'signin' | 'forgot': opened from an email-link page
  const [open, setOpen] = useState(!!initialMode)
  return (
    <>
      <Gate>
        <div data-testid="manager-sign-in" className="text-center">
          <h1 className="text-xl font-bold tracking-tight text-stone-900">{text.signInHeading}</h1>
          <p className="mt-2 text-sm text-stone-600">{text.signInBody}</p>
          <Button variant="hero" block icon={LogIn} onClick={() => setOpen(true)} className="mt-6">
            {t('managerSite.signIn')}
          </Button>
          <div className="mt-5 border-t border-stone-100 pt-4">
            <p className="text-xs text-stone-500">{text.noAccountYet}</p>
            <Button variant="secondary" size="lg" block icon={UserPlus} onClick={onCreateAccount} className="mt-2">
              {t('managerSite.createAccount')}
            </Button>
          </div>
        </div>
      </Gate>
      <LoginModal
        open={open}
        initialForgot={initialMode === 'forgot'}
        onClose={() => setOpen(false)}
        onSwitchToSignUp={() => { setOpen(false); onCreateAccount() }}
      />
    </>
  )
}

/** #signup: accounts are made here (the scorer apps link to this page). */
function SignUpScreen({ onSignedUp, onBack }) {
  const { t } = useTranslation()
  const text = useBrandText()
  const [loginOpen, setLoginOpen] = useState(false)
  return (
    <>
      <Gate width="md" className="p-6 sm:p-8">
        <div data-testid="manager-sign-up">
          <div className="mb-5 text-center">
            <h1 className="text-xl font-bold tracking-tight text-stone-900">{t('managerSite.signUpHeading')}</h1>
            <p className="mt-2 text-sm text-stone-600">{text.signUpBody}</p>
          </div>
          <SignUpForm
            onSignedUp={onSignedUp}
            onSwitchToLogin={() => setLoginOpen(true)}
            // OpenBeach: an address that already has an account (OpenVolley's
            // or OpenBeach's) signs in with its password and then joins
            existingAccountMessage={text.beach ? t('managerBeach.existingAccount') : undefined}
          />
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
  const text = useBrandText()
  return (
    <div data-testid="scorer-app-links">
      <a href={text.appUrl} className={primary ? cn(linkButton('hero'), 'gap-2') : cn(linkButton('secondary', 'lg'))}>
        <ExternalLink size={16} aria-hidden />
        {text.openAppLong}
      </a>
      <p className="mt-2 text-center text-xs text-stone-500">{text.nativeAppsNote}</p>
    </div>
  )
}

/**
 * A new (pending) account: the next step is the club's invite code. A code
 * gives the account its role at once (scorer, referee or competition manager) (AuthContext re-reads the roles and this
 * page turns into "you're all set"); without one an admin approves it, which
 * AuthContext picks up on its own (it re-reads a pending profile every minute).
 */
function InviteStepScreen({ justSignedUp, linkSentTo = null }) {
  const { t } = useTranslation()
  const text = useBrandText()
  return (
    <Gate>
      <div data-testid="manager-invite-step">
        {justSignedUp && (
          <p role="status" className="mb-4 flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm font-medium text-green-800">
            <CircleCheck size={16} aria-hidden className="shrink-0 text-green-600" />
            {t('managerSite.accountCreated')}
          </p>
        )}
        {/* The server mailed a confirmation link: the account gets no role
            (no invite code either) until the address is confirmed */}
        {justSignedUp && linkSentTo && (
          <p role="status" data-testid="signup-link-sent" className="-mt-2 mb-4 flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">
            <MailCheck size={16} aria-hidden className="mt-0.5 shrink-0 text-sky-600" />
            {t('authEmail.signUpLinkSent', { email: linkSentTo })}
          </p>
        )}
        {/* Any unconfirmed account, not only a new one: no code works before
            the confirmation (the server answers OV_EMAIL_UNCONFIRMED) */}
        <EmailConfirmBanner className="mb-4" />
        <div className="text-center">
          <KeyRound className="mx-auto h-8 w-8 text-stone-400" aria-hidden />
          <h1 className="mt-3 text-base font-semibold text-stone-900">{t('managerSite.inviteStepTitle')}</h1>
          <p className="mt-1.5 text-sm text-stone-600">{text.inviteStepBody}</p>
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
  const text = useBrandText()
  const [showCode, setShowCode] = useState(false)
  return (
    <Gate>
      <div data-testid="manager-all-set">
        <div className="text-center">
          <CircleCheck className="mx-auto h-8 w-8 text-emerald-600" aria-hidden />
          <h1 className="mt-3 text-base font-semibold text-stone-900">{t('managerSite.allSetTitle')}</h1>
          <p className="mt-1.5 text-sm text-stone-600">{text.allSetBody}</p>
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
  const text = useBrandText()
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
          <a href={text.appUrl} className={quietLink}>{text.openAppLong}</a>
        </p>
      </div>
    </Gate>
  )
}

function ConsoleHeaderActions() {
  const text = useBrandText()
  const { user, profile } = useAuth()
  const name = accountName(user, profile)
  return (
    <>
      {name && <span className="hidden min-w-0 max-w-[16rem] truncate text-xs text-stone-500 md:inline" title={name}>{name}</span>}
      <a href={text.appUrl} className={consoleHeaderBtn} aria-label={text.openAppLong} title={text.openAppLong}>
        <ExternalLink size={14} aria-hidden />
        <span className="hidden sm:inline">{text.openApp}</span>
      </a>
      <LanguageSelect compact />
      <SignOutButton />
    </>
  )
}

/**
 * OpenBeach's manager: has the signed-in account joined OpenBeach? A role of
 * the app or the global admin counts as joined (as on the server); otherwise
 * GET /api/me says. null while unknown. OpenVolley's manager never asks (an
 * account without any membership counts as indoor there).
 */
function useAppMembership(app, userId, ownAccess) {
  // Nothing to ask: OpenVolley's manager, nobody signed in, roles not known
  // yet, or a role of the app / the global admin (members by definition)
  const ask = app === 'beach' && !!userId && !!ownAccess && !ownAccess.isAdmin && !(ownAccess.roles?.length > 0)
  const key = ask ? `${app}:${userId}` : null
  const [state, setState] = useState({ key: null, member: null })
  useEffect(() => {
    if (!key) return undefined
    let live = true
    fetchMe().then((res) => {
      if (!live) return
      // Unreadable (offline, server error): carry on to the invite step; a
      // beach invite code makes the account a member too
      setState({ key, member: res?.error ? true : res?.data?.apps?.[app]?.member !== false })
    })
    return () => { live = false }
  }, [key, app])
  const joined = useCallback(() => setState({ key, member: true }), [key])
  if (!key) return { member: true, joined }
  return { member: state.key === key ? state.member : null, joined }
}

/** Signed in on OpenBeach's manager with an account that has not joined OpenBeach. */
function JoinAppScreen({ app, onJoined }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const join = async () => {
    setBusy(true)
    setError('')
    const res = await joinApp(app)
    setBusy(false)
    if (res?.error) return setError(t('managerBeach.joinFailed'))
    onJoined()
  }
  return (
    <Gate>
      <div data-testid="manager-join-app">
        <div className="text-center">
          <Users className="mx-auto h-8 w-8 text-stone-400" aria-hidden />
          <h1 className="mt-3 text-base font-semibold text-stone-900">{t('managerBeach.joinTitle')}</h1>
          <p className="mt-1.5 text-sm text-stone-600">{t('managerBeach.joinBody')}</p>
        </div>
        {error && <p role="alert" className="mt-4 text-xs font-medium text-red-600">{error}</p>}
        <Button variant="hero" block icon={UserPlus} loading={busy} disabled={busy} onClick={join} className="mt-5">
          {t('managerBeach.joinButton')}
        </Button>
        <div className="text-center"><SignedInAs /></div>
        <div className="mt-4"><SignOutButton block /></div>
      </div>
    </Gate>
  )
}

/** The page behind an email link, in the gate card. */
function AuthLinkScreen({ link, onDone }) {
  return (
    <Gate>
      {link.page === 'reset'
        ? <ResetPasswordPage token={link.token} lang={link.lang} onSignIn={() => onDone('signin')} onRequestNew={() => onDone('forgot')} />
        : <ConfirmEmailPage token={link.token} onSignIn={() => onDone('signin')} />}
    </Gate>
  )
}

export default function ManagerApp({ authLink = null }) {
  const { t, i18n } = useTranslation()
  const { user, access, loading, signOut, refreshUser } = useAuth()
  const brand = useManagerBrand()
  // OpenVolley's manager: the access itself; OpenBeach's: the beach flags
  const own = accessForApp(access, brand.app)
  const membership = useAppMembership(brand.app, user?.id ?? null, user && access?.known ? own : null)
  const [tab, setTab] = useState(tabFromHash)
  const [link, setLink] = useState(authLink)
  const [signInMode, setSignInMode] = useState(null)
  const takeLink = useCallback((next) => {
    setLink(next)
    setSignInMode(null)
  }, [])
  const [route, goRoute, replaceRoute] = useHashRoute(takeLink)
  const [justSignedUp, setJustSignedUp] = useState(false)
  // The address a confirmation link was mailed to at sign-up (this session only)
  const [linkSentTo, setLinkSentTo] = useState(null)

  // The link carries the language the email was written in (en/de/fr/it):
  // follow it unless the site already shows that language (de-CH for de).
  const linkLang = link?.lang
  useEffect(() => {
    if (linkLang && String(i18n.language || '').split('-')[0] !== linkLang) i18n.changeLanguage(linkLang)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkLang])

  const leaveLink = useCallback(async (mode) => {
    // After a reset every session of the account is revoked: drop this one too.
    if (link?.page === 'reset' && user) {
      try { await signOut() } catch { /* the server already revoked it */ }
    }
    // Confirmed while signed in: the session still holds the unconfirmed user
    if (link?.page === 'confirm' && user) refreshUser?.()
    setLink(null)
    setSignInMode(mode)
  }, [link, user, signOut, refreshUser])

  // Signed in: #signup has done its job (and is no console tab). The route is
  // cleared too, so signing out later shows the sign-in card, not the sign-up page
  useEffect(() => {
    if (!user || route !== SIGN_UP_HASH) return
    replaceRoute('')
    setTab(null)
  }, [user, route, replaceRoute])

  // "Account created" belongs to the session that made the account only
  const isSignedIn = Boolean(user)
  useEffect(() => {
    if (isSignedIn) return
    setJustSignedUp(false)
    setLinkSentTo(null)
  }, [isSignedIn])

  const openSignUp = useCallback(() => {
    // "Back to sign in" shows the card, not the dialog an email link opened
    setSignInMode(null)
    goRoute(SIGN_UP_HASH)
  }, [goRoute])
  const onSignedUp = useCallback(({ signedIn, linkSentTo: sentTo = null }) => {
    if (!signedIn) return
    setJustSignedUp(true)
    setLinkSentTo(sentTo)
  }, [])

  // The open tab lives in the URL hash, so a reload or a bookmark keeps it
  const selectTab = useCallback((id) => {
    setTab(id)
    try { window.history.replaceState(window.history.state, '', `#${id}`) } catch { /* no history */ }
  }, [])

  if (link) return <div className="ov-kit"><AuthLinkScreen link={link} onDone={leaveLink} /></div>

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
          ? <SignUpScreen onSignedUp={onSignedUp} onBack={() => goRoute('')} />
          : <SignInScreen initialMode={signInMode} onCreateAccount={openSignUp} />}
      </div>
    )
  }
  if (!access.known) return <div className="ov-kit"><AccountLoadingScreen /></div>
  if (manageTabsFor(access, brand).length === 0) {
    if (membership.member === null) return <div className="ov-kit"><AccountLoadingScreen /></div>
    if (membership.member === false) return <div className="ov-kit"><JoinAppScreen app={brand.app} onJoined={membership.joined} /></div>
    let screen = <NoAccessScreen />
    if (own.isPending) screen = <InviteStepScreen justSignedUp={justSignedUp} linkSentTo={linkSentTo} />
    else if (own.canScore) screen = <AllSetScreen />
    return <div className="ov-kit">{screen}</div>
  }

  // No onClose: there is no app to go back to; the header links to it instead
  return <ManageConsole tab={tab} onTab={selectTab} headerActions={<ConsoleHeaderActions />} />
}
