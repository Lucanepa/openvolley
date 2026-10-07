import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleCheck, KeyRound, LinkIcon, MailCheck } from 'lucide-react'
import { apiAuth } from '../../lib/apiClient'
import { BUTTON_VARIANTS, Button, cn, Field, FOCUS_RING, FormError, Input } from '../../ui'
import { scorerAppUrlFor } from '../../utils/managerSite'
import { useManagerBrand } from '../../managerBrand'

/**
 * The pages behind the links of the account emails, shown by the manager
 * (manager.openvolley.app/#reset?token=... and #confirm?token=...). The token
 * was already removed from the address bar (utils/authLinks.js) and is only
 * ever sent to its endpoint.
 */

const MIN_PASSWORD = 6
const MAX_PASSWORD_BYTES = 72

const quietLink = cn('inline-flex min-h-11 w-full items-center justify-center rounded-lg text-sm text-stone-500 transition-colors hover:text-stone-800', FOCUS_RING)
const heroLink = cn('inline-flex w-full items-center justify-center', BUTTON_VARIANTS.hero, FOCUS_RING)

function Heading({ icon: Icon, tone = 'stone', title, children }) {
  const ring = tone === 'green' ? 'bg-green-50 text-green-600' : 'bg-stone-100 text-stone-500'
  return (
    <div className="text-center">
      <div className={cn('mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full', ring)}>
        <Icon size={26} strokeWidth={2.25} aria-hidden="true" />
      </div>
      <h1 className="text-xl font-bold tracking-tight text-stone-900">{title}</h1>
      {children && <p className="mt-2 text-sm text-stone-600">{children}</p>}
    </div>
  )
}

/** Error text of a failed link request (never the raw token, never logged). */
function linkErrorText(t, error) {
  if (error?.status === 429) return t('authEmail.tooManyAttempts')
  if (error?.network || error?.status === 0) return t('authEmail.offline')
  return t('authEmail.genericError')
}

function AppLinks({ onSignIn }) {
  const brand = useManagerBrand()
  const { t } = useTranslation()
  return (
    <div className="mt-6 space-y-1">
      <a href={scorerAppUrlFor(brand)} className={heroLink}>{t(brand.app === 'beach' ? 'managerBeach.openAppLong' : 'managerSite.openAppLong')}</a>
      <button type="button" onClick={onSignIn} className={quietLink}>{t('managerSite.signIn')}</button>
    </div>
  )
}

function InvalidLink({ body, onRequestNew, onSignIn }) {
  const brand = useManagerBrand()
  const { t } = useTranslation()
  return (
    <div data-testid="auth-link-invalid">
      <Heading icon={LinkIcon} title={t('authEmail.invalidLinkTitle')}>{body}</Heading>
      <div className="mt-6 space-y-1">
        {onRequestNew
          ? <Button variant="hero" block onClick={onRequestNew}>{t('authEmail.requestNewLink')}</Button>
          : <a href={scorerAppUrlFor(brand)} className={heroLink}>{t(brand.app === 'beach' ? 'managerBeach.openAppLong' : 'managerSite.openAppLong')}</a>}
        <button type="button" onClick={onSignIn} className={quietLink}>{t('managerSite.signIn')}</button>
      </div>
    </div>
  )
}

/** #reset?token=: a new password, twice. */
export function ResetPasswordPage({ token, lang, onSignIn, onRequestNew }) {
  const { t } = useTranslation()
  const brand = useManagerBrand()
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [state, setState] = useState(token ? 'form' : 'invalid')

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setError('')
    if (password.length < MIN_PASSWORD) return setError(t('auth.passwordTooShort'))
    if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) return setError(t('authEmail.genericError'))
    if (password !== repeat) return setError(t('auth.passwordsDoNotMatch'))
    setBusy(true)
    // OpenBeach's manager: the "password changed" notice is OpenBeach's
    const res = brand.app === 'beach'
      ? await apiAuth.confirmPasswordReset(token, password, lang || undefined, brand.app)
      : await apiAuth.confirmPasswordReset(token, password, lang || undefined)
    setBusy(false)
    if (!res?.error) {
      setPassword('')
      setRepeat('')
      setState('done')
      return
    }
    if (res.error.code === 'invalid_link') return setState('invalid')
    if (res.error.code === 'weak_password') return setError(res.error.message || t('auth.passwordTooShort'))
    setError(linkErrorText(t, res.error))
  }

  if (state === 'invalid') {
    return <InvalidLink body={t('authEmail.invalidLink')} onRequestNew={onRequestNew} onSignIn={onSignIn} />
  }
  if (state === 'done') {
    return (
      <div data-testid="reset-done">
        <Heading icon={CircleCheck} tone="green" title={t('authEmail.passwordSavedTitle')}>{t('authEmail.passwordSaved')}</Heading>
        <AppLinks onSignIn={onSignIn} />
      </div>
    )
  }
  return (
    <form data-testid="reset-form" onSubmit={submit} className="space-y-3" noValidate>
      <Heading icon={KeyRound} title={t('authEmail.newPasswordTitle')}>{t(brand.app === 'beach' ? 'managerBeach.newPasswordBody' : 'authEmail.newPasswordBody')}</Heading>
      <FormError size="md">{error}</FormError>
      <Field label={t('authEmail.newPassword')} hint={t('authEmail.passwordHint')}>
        <Input size="lg" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" required minLength={MIN_PASSWORD} />
      </Field>
      <Field label={t('authEmail.repeatPassword')}>
        <Input size="lg" type="password" value={repeat} onChange={e => setRepeat(e.target.value)} autoComplete="new-password" required />
      </Field>
      <Button variant="hero" block type="submit" disabled={busy || !password || !repeat} loading={busy}>
        {busy ? t('authEmail.saving') : t('authEmail.savePassword')}
      </Button>
    </form>
  )
}

/**
 * #confirm?token=: confirms on a click, not on load, so a mail scanner that
 * opens links cannot confirm an address for whoever signed up with it.
 */
export function ConfirmEmailPage({ token, onSignIn }) {
  const { t } = useTranslation()
  const brand = useManagerBrand()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [state, setState] = useState(token ? 'ask' : 'invalid')

  const confirm = async () => {
    if (busy) return
    setError('')
    setBusy(true)
    const res = await apiAuth.confirmEmail(token)
    setBusy(false)
    if (!res?.error) return setState(res?.data?.already_confirmed ? 'already' : 'done')
    if (res.error.code === 'invalid_link') return setState('invalid')
    setError(linkErrorText(t, res.error))
  }

  if (state === 'invalid') return <InvalidLink body={t('authEmail.confirmInvalid')} onSignIn={onSignIn} />
  if (state === 'done' || state === 'already') {
    return (
      <div data-testid="confirm-done">
        <Heading icon={CircleCheck} tone="green" title={t('authEmail.confirmedTitle')}>
          {state === 'already' ? t('authEmail.alreadyConfirmed') : t('authEmail.confirmed')}
        </Heading>
        <AppLinks onSignIn={onSignIn} />
      </div>
    )
  }
  return (
    <div data-testid="confirm-ask" className="space-y-3">
      <Heading icon={MailCheck} title={t('authEmail.confirmTitle')}>{t(brand.app === 'beach' ? 'managerBeach.confirmBody' : 'authEmail.confirmBody')}</Heading>
      <FormError size="md">{error}</FormError>
      <Button variant="hero" block onClick={confirm} disabled={busy} loading={busy} className="mt-3">
        {busy ? t('authEmail.confirming') : t('authEmail.confirmButton')}
      </Button>
    </div>
  )
}
