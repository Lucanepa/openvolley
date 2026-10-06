import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../contexts/AuthContext'
import { Check, X } from 'lucide-react'
import { Button, cn, Field, FOCUS_RING, IconButton, Input } from '../../ui'

export default function LoginModal({ open, onClose, onSwitchToSignUp }) {
  const { t } = useTranslation()
  const { signIn, resetPassword } = useAuth()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showForgotPassword, setShowForgotPassword] = useState(false)
  const [resetSent, setResetSent] = useState(false)

  if (!open) return null

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    const { error: signInError } = await signIn(email, password)

    if (signInError) {
      setError(signInError.message)
      setLoading(false)
    } else {
      setLoading(false)
      onClose()
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

    const { error: resetError } = await resetPassword(email)

    if (resetError) {
      setError(resetError.message)
    } else {
      setResetSent(true)
    }
    setLoading(false)
  }

  // Same auth recipe as SignUpModal: labelled kit Field + lg Input, hero submit.
  const quietLink = cn('inline-flex min-h-11 w-full items-center justify-center rounded-lg text-sm text-stone-500 transition-colors hover:text-stone-800', FOCUS_RING)

  return (
    <div className="ov-kit fixed inset-0 flex items-center justify-center bg-stone-900/50 p-4 backdrop-blur-sm" style={{ zIndex: 2000 }} onClick={onClose}>
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
              <p className="text-sm text-stone-700">{t('auth.resetEmailSent', 'Check your email for a password reset link')}</p>
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
                onClick={() => setShowForgotPassword(false)}
                className={quietLink}
              >
                {t('auth.backToSignIn', 'Back to sign in')}
              </button>
            </form>
          ) : (
            <>
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
                <Button variant="hero" block type="submit" disabled={loading} loading={loading}>
                  {loading ? t('common.signingIn', 'Signing in...') : t('auth.signIn', 'Sign in')}
                </Button>
              </form>

              <button
                type="button"
                onClick={() => setShowForgotPassword(true)}
                className={cn(quietLink, 'mt-1')}
              >
                {t('auth.forgotPassword', 'Forgot password?')}
              </button>

              <div className="mt-3 border-t border-stone-100 pt-4 text-center text-sm text-stone-500">
                {t('auth.noAccount', "Don't have an account?")}{' '}
                <button
                  type="button"
                  onClick={onSwitchToSignUp}
                  className={cn('min-h-11 rounded font-medium text-red-600 underline decoration-red-300 underline-offset-2 transition-colors hover:text-red-700 hover:decoration-red-500', FOCUS_RING)}
                >
                  {t('auth.signUp', 'Sign up')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
