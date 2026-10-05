import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../contexts/AuthContext'
import { needsEmailConfirmation } from './signUpResult'
import { Check, X } from 'lucide-react'
import { Button, cn, Field, FOCUS_RING, IconButton, Input } from '../../ui'

export default function SignUpModal({ open, onClose, onSwitchToLogin }) {
  const { t } = useTranslation()
  const { signUp, signIn } = useAuth()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [country, setCountry] = useState('CHE')
  const [dob, setDob] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [confirmByEmail, setConfirmByEmail] = useState(false)

  if (!open) return null

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')

    if (password !== confirmPassword) {
      setError(t('auth.passwordsDoNotMatch', 'Passwords do not match'))
      return
    }

    if (password.length < 6) {
      setError(t('auth.passwordTooShort', 'Password must be at least 6 characters'))
      return
    }

    setLoading(true)

    const { data: signUpData, error: signUpError } = await signUp(email, password, {
      firstName,
      lastName,
      country,
      dob: dob || null,
      roles: ['scorer']
    })

    if (signUpError) {
      setError(signUpError.message)
      setLoading(false)
    } else {
      // The backend confirms the account at sign-up (no email is sent): sign
      // the user in right away. Only an unconfirmed account gets the email step.
      const mustConfirm = needsEmailConfirmation(signUpData)
      setConfirmByEmail(mustConfirm)
      if (!mustConfirm) {
        const { error: signInError } = await signIn(email, password)
        if (!signInError) {
          setLoading(false)
          onClose?.()
          return
        }
      }
      setSuccess(true)
      setLoading(false)
    }
  }

  return (
    <div className="ov-kit fixed inset-0 flex items-center justify-center bg-stone-900/50 p-4 backdrop-blur-sm" style={{ zIndex: 2000 }} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="signup-modal-title"
        className="relative flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-3xl border border-stone-200/70 bg-white shadow-card-lg"
        onClick={e => e.stopPropagation()}
      >
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-red-600 to-red-500" />
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-6 pt-6 pb-2">
          <h2 id="signup-modal-title" className="text-xl font-bold tracking-tight text-stone-900">
            {t('auth.createAccount', 'Create Account')}
          </h2>
          <IconButton variant="close" icon={X} label={t('common.close', 'Close')} onClick={onClose} className="-mr-2" />
        </div>

        {/* Body */}
        <div className="overflow-y-auto px-6 pb-6">
          {error && (
            <p role="alert" className="mb-4 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}

          {success ? (
            <div className="py-4 text-center">
              <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-green-50 text-green-600">
                <Check size={26} strokeWidth={2.25} aria-hidden="true" />
              </div>
              <p className="mb-1 text-sm font-semibold text-stone-900">{t('auth.accountCreated', 'Account created successfully!')}</p>
              <p className="text-sm text-stone-600">
                {confirmByEmail
                  ? t('auth.checkEmail', 'Check your email to confirm your account')
                  : t('auth.accountReady', 'Your account is ready. You can sign in now.')}
              </p>
              <Button variant="hero" block onClick={onSwitchToLogin} className="mt-5">
                {t('auth.signIn', 'Sign In')}
              </Button>
            </div>
          ) : (
            <>
              <form onSubmit={handleSubmit} className="space-y-3">
                {/* Name fields */}
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t('auth.firstName', 'First name')}>
                    <Input
                      size="lg"
                      type="text"
                      value={firstName}
                      onChange={e => setFirstName(e.target.value)}
                      aria-label={t('auth.firstName', 'First name')}
                      autoComplete="given-name"
                    />
                  </Field>
                  <Field label={t('auth.lastName', 'Last name')}>
                    <Input
                      size="lg"
                      type="text"
                      value={lastName}
                      onChange={e => setLastName(e.target.value)}
                      aria-label={t('auth.lastName', 'Last name')}
                      autoComplete="family-name"
                    />
                  </Field>
                </div>

                {/* Country and DOB */}
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t('auth.country', 'Country')}>
                    <Input
                      size="lg"
                      type="text"
                      value={country}
                      onChange={e => setCountry(e.target.value.toUpperCase())}
                      placeholder="CHE"
                      maxLength={3}
                      aria-label={t('auth.country', 'Country')}
                      className="uppercase"
                    />
                  </Field>
                  <Field label={t('auth.dob', 'Date of birth')}>
                    <Input
                      size="lg"
                      type="date"
                      value={dob}
                      onChange={e => setDob(e.target.value)}
                      aria-label={t('auth.dob', 'Date of birth')}
                    />
                  </Field>
                </div>

                {/* Email */}
                <Field label={t('auth.email', 'Email')}>
                  <Input
                    size="lg"
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    aria-label={t('auth.email', 'Email')}
                    autoComplete="email"
                    required
                  />
                </Field>

                {/* Password */}
                <Field label={t('auth.password', 'Password')}>
                  <Input
                    size="lg"
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    aria-label={t('auth.password', 'Password')}
                    autoComplete="new-password"
                    required
                  />
                </Field>

                {/* Confirm password */}
                <Field label={t('auth.confirmPassword', 'Confirm password')}>
                  <Input
                    size="lg"
                    type="password"
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    aria-label={t('auth.confirmPassword', 'Confirm password')}
                    autoComplete="new-password"
                    required
                  />
                </Field>

                <Button variant="hero" block type="submit" disabled={loading} loading={loading} className="!mt-5">
                  {loading ? t('auth.creatingAccount', 'Creating account...') : t('auth.createAccount', 'Create Account')}
                </Button>
              </form>

              <div className="mt-4 border-t border-stone-100 pt-4 text-center text-sm text-stone-500">
                {t('auth.haveAccount', 'Already have an account?')}{' '}
                <button
                  type="button"
                  onClick={onSwitchToLogin}
                  className={cn('min-h-11 rounded font-medium text-red-600 underline decoration-red-300 underline-offset-2 transition-colors hover:text-red-700 hover:decoration-red-500', FOCUS_RING)}
                >
                  {t('auth.signIn', 'Sign In')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
