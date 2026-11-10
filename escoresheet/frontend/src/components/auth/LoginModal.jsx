import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../contexts/AuthContext'
import { Check, Fingerprint, X } from 'lucide-react'
import { Button, cn, Field, FOCUS_RING, IconButton, Input } from '../../ui'
import {
  anyPasskeyHere, deviceCanHoldPasskey, isPasskeyCancel, markPasskeyHere,
  passkeyHere, passkeyOfferDismissed, passkeysPossible
} from '../../lib/passkeys'
import { passkeyErrorText } from './passkeyErrors'
import { showPasskeyOffer } from './passkeyOffer'
import CreateAccountLink from './CreateAccountLink'
import LegalLinks from '../../legal/LegalLinks'
import { backdropDismiss } from '../../ui/backdropDismiss.js'

// The contact address in the server's 503 answer ("... Contact x@y.")
const DEFAULT_CONTACT = 'support@openvolley.app'
export function contactFromMessage(message) {
  const m = /Contact\s+([^\s@]+@[^\s@]+?)\.?$/.exec(String(message || '').trim())
  return m ? m[1] : DEFAULT_CONTACT
}

/**
 * The text for a failed reset request. 503 reset_unavailable: the server sends
 * no emails (SMTP not configured), so the contact address is the way out.
 */
export function resetErrorText(t, error) {
  if (error?.code === 'reset_unavailable' || error?.status === 503) {
    return t('authEmail.resetUnavailable', { contact: contactFromMessage(error?.message) })
  }
  if (error?.status === 429) return t('authEmail.tooManyAttempts')
  if (error?.network || error?.status === 0) return t('authEmail.offline')
  return error?.message || t('authEmail.genericError')
}

export default function LoginModal({ open, onClose, onSwitchToSignUp, initialForgot = false }) {
  const { t } = useTranslation()
  const { signIn, signInWithPasskey, resetPassword } = useAuth()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showForgotPassword, setShowForgotPassword] = useState(initialForgot)
  const [resetSent, setResetSent] = useState(false)
  // Passkeys (lib/passkeys.js): web only, decided once per open modal.
  const [canPasskey] = useState(() => passkeysPossible())
  const [passkeyBusy, setPasskeyBusy] = useState(false)

  if (!open) return null
  // Somebody set one up in this browser: the passkey button leads.
  const passkeyFirst = canPasskey && anyPasskeyHere()

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    const { data, error: signInError } = await signIn(email, password)

    if (signInError) {
      setError(signInError.message)
      setLoading(false)
      return
    }
    const userId = data?.user?.id
    // Offered once per account and browser, and only where the device can
    // keep the key itself; everyone else goes straight in, as before.
    // The offer is shown by PasskeyOfferHost: this dialog may be gone the
    // moment the account counts as signed in.
    if (canPasskey && userId && !passkeyHere(userId) && !passkeyOfferDismissed(userId) && await deviceCanHoldPasskey()) {
      showPasskeyOffer({ userId, password })
    }
    setPassword('')
    setLoading(false)
    onClose()
  }

  const handlePasskeySignIn = async () => {
    if (passkeyBusy) return
    setError('')
    setPasskeyBusy(true)
    try {
      const { data, error: passkeyError } = await signInWithPasskey()
      if (passkeyError) {
        setError(passkeyErrorText(t, passkeyError))
        return
      }
      if (data?.user?.id) markPasskeyHere(data.user.id, true)
      onClose()
    } catch (err) {
      if (!isPasskeyCancel(err)) setError(passkeyErrorText(t, err))
    } finally {
      setPasskeyBusy(false)
    }
  }

  const handleForgotPassword = async (e) => {
    e.preventDefault()
    if (!email) {
      setError(t('auth.enterEmail', 'Please enter your email'))
      return
    }
    setError('')
    setLoading(true)

    const { error: resetError } = await resetPassword(email.trim())

    if (resetError) {
      setError(resetErrorText(t, resetError))
    } else {
      // The same answer whether or not the address has an account
      setResetSent(true)
    }
    setLoading(false)
  }

  // Same auth recipe as SignUpForm: labelled kit Field + lg Input, hero submit.
  const quietLink = cn('inline-flex min-h-11 w-full items-center justify-center rounded-lg text-sm text-stone-500 transition-colors hover:text-stone-800', FOCUS_RING)

  const passkeyButton = (
    <Button
      variant="secondary"
      block
      type="button"
      onClick={handlePasskeySignIn}
      disabled={passkeyBusy || loading}
      loading={passkeyBusy}
      data-testid="passkey-sign-in"
    >
      {!passkeyBusy && <Fingerprint size={16} className="text-red-600" aria-hidden="true" />}
      {passkeyBusy ? t('passkeys.waiting') : t('passkeys.signInButton')}
    </Button>
  )

  return (
    <div className="ov-kit fixed inset-0 flex items-center justify-center bg-stone-900/50 p-4 backdrop-blur-sm" style={{ zIndex: 2000 }} {...backdropDismiss(onClose)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="login-modal-title"
        className="relative w-full max-w-sm overflow-hidden rounded-3xl border border-stone-200/70 bg-white shadow-card-lg"
        onClick={e => e.stopPropagation()}
      >
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-red-600 to-red-500" />
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-6 pt-6 pb-2">
          <h2 id="login-modal-title" className="text-xl font-bold tracking-tight text-stone-900">
            {showForgotPassword
              ? t('auth.resetPassword', 'Reset password')
              : t('auth.signIn', 'Sign in')}
          </h2>
          <IconButton variant="close" icon={X} label={t('common.close', 'Close')} onClick={onClose} className="-mr-2" />
        </div>

        {/* Body */}
        <div className="px-6 pb-6">
          {error && (
            <p role="alert" className="mb-4 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}

          {resetSent ? (
            <div className="py-4 text-center">
              <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-green-50 text-green-600">
                <Check size={26} strokeWidth={2.25} aria-hidden="true" />
              </div>
              <p className="text-sm font-semibold text-stone-900">{t('authEmail.resetSentTitle')}</p>
              <p data-testid="reset-sent" className="mt-1 text-sm text-stone-600">{t('authEmail.resetSent', { email: email.trim() })}</p>
              <Button
                variant="hero"
                block
                onClick={() => {
                  setShowForgotPassword(false)
                  setResetSent(false)
                }}
                className="mt-5"
              >
                {t('auth.backToSignIn', 'Back to sign in')}
              </Button>
            </div>
          ) : showForgotPassword ? (
            <form onSubmit={handleForgotPassword} className="space-y-3">
              <p className="text-sm text-stone-600">
                {t('auth.resetInstructions', 'Enter your email and we\'ll send you a reset link')}
              </p>
              <Field label={t('auth.email', 'Email')}>
                <Input
                  size="lg"
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  autoComplete="email"
                  required
                />
              </Field>
              <Button variant="hero" block type="submit" disabled={loading} loading={loading}>
                {loading ? t('auth.sending', 'Sending...') : t('auth.sendResetLink', 'Send reset link')}
              </Button>
              <button
                type="button"
                onClick={() => { setShowForgotPassword(false); setError('') }}
                className={quietLink}
              >
                {t('auth.backToSignIn', 'Back to sign in')}
              </button>
            </form>
          ) : (
            <>
              {passkeyFirst && (
                <>
                  {passkeyButton}
                  <p className="my-4 flex items-center gap-3 text-xs text-stone-400 before:h-px before:flex-1 before:bg-stone-200 after:h-px after:flex-1 after:bg-stone-200">
                    {t('passkeys.or')}
                  </p>
                </>
              )}
              <form onSubmit={handleSubmit} className="space-y-3">
                <Field label={t('auth.email', 'Email')}>
                  <Input
                    size="lg"
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    autoComplete="email"
                    required
                  />
                </Field>
                <Field label={t('auth.password', 'Password')}>
                  <Input
                    size="lg"
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    autoComplete="current-password"
                    required
                  />
                </Field>
                <Button variant="hero" block type="submit" disabled={loading || passkeyBusy} loading={loading}>
                  {loading ? t('common.signingIn', 'Signing in...') : t('auth.signIn', 'Sign in')}
                </Button>
              </form>
              {canPasskey && !passkeyFirst && <div className="mt-3">{passkeyButton}</div>}

              <button
                type="button"
                onClick={() => { setShowForgotPassword(true); setError('') }}
                className={cn(quietLink, 'mt-1')}
              >
                {t('auth.forgotPassword', 'Forgot password?')}
              </button>

              {/* Accounts are made on manager.openvolley.app: the scorer apps
                  link there; the manager passes onSwitchToSignUp (its own page) */}
              {onSwitchToSignUp ? (
                <div className="mt-3 border-t border-stone-100 pt-4 text-center text-sm text-stone-500">
                  {t('auth.noAccount', "Don't have an account?")}{' '}
                  <button
                    type="button"
                    onClick={onSwitchToSignUp}
                    className={cn('min-h-11 rounded font-medium text-red-600 underline decoration-red-300 underline-offset-2 transition-colors hover:text-red-700 hover:decoration-red-500', FOCUS_RING)}
                  >
                    {t('auth.createAccount', 'Create account')}
                  </button>
                </div>
              ) : (
                <CreateAccountLink className="mt-3 border-t border-stone-100 pt-3" />
              )}
            </>
          )}
          {/* The sign-in dialog keeps to signing in: no "Made by Swiss
              referees" line (Home, Options, the menus and the manager's
              sign-in card carry it) */}
          <LegalLinks docs={['privacy', 'terms', 'impressum']} madeBy={false} className="mt-4 text-center text-[11px] text-stone-400" />
        </div>
      </div>
    </div>
  )
}
