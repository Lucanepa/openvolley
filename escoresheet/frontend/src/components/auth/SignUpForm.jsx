import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { confirmationLinkSent, needsEmailConfirmation } from './signUpResult'
import DateOfBirthInput from './DateOfBirthInput'
import { Button, cn, Field, FOCUS_RING, Input } from '../../ui'

export const MIN_PASSWORD_LENGTH = 6

/**
 * The sign-up form: name, country, date of birth (starts empty), email,
 * password + confirmation. Accounts are made on manager.openvolley.app only;
 * the scorer apps link there (CreateAccountLink).
 *
 * Our backend lets a new account sign in at once: it either confirms the
 * address at sign-up (no mail server) or mails a confirmation link
 * (`email_confirmation: 'sent'`, see ./signUpResult). The user is signed in
 * right away and `onSignedUp({ signedIn: true, linkSentTo })` runs, with
 * `linkSentTo` the address the link went to (null when none was mailed); the
 * page then follows the account (pending -> invite code step) and says where
 * the link went. Otherwise the form shows "check your email" (or where the
 * link went, or "you can sign in now") with a sign-in button.
 *
 * @param {object} props
 * @param {(result: { signedIn: boolean, confirmByEmail: boolean, linkSentTo: string | null }) => void} [props.onSignedUp]
 * @param {() => void} [props.onSwitchToLogin] "Already have an account? Sign in"
 */
export default function SignUpForm({ onSignedUp, onSwitchToLogin }) {
  const { t } = useTranslation()
  const { signUp, signIn } = useAuth()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [country, setCountry] = useState('CHE')
  // Empty until the user types one: never today's date
  const [dob, setDob] = useState('')
  const [dobError, setDobError] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [confirmByEmail, setConfirmByEmail] = useState(false)
  const [linkSentTo, setLinkSentTo] = useState(null)

  const dobInvalidText = t('auth.dobInvalid', 'Enter the date of birth as DD.MM.YYYY.')

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')

    // null: unfinished or impossible (DateOfBirthInput); '' is fine (optional)
    if (dob === null) {
      setDobError(dobInvalidText)
      return
    }
    if (password !== confirmPassword) {
      setError(t('auth.passwordsDoNotMatch', 'Passwords do not match'))
      return
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(t('auth.passwordTooShort', 'Password must be at least 6 characters'))
      return
    }

    setLoading(true)
    const { data: signUpData, error: signUpError } = await signUp(email.trim(), password, {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      country,
      dob: dob || null
    })

    if (signUpError) {
      setError(signUpError.message)
      setLoading(false)
      return
    }

    // The backend confirms the account at sign-up, or mails a link and lets it
    // sign in anyway: sign the user in right away. Only an account the server
    // will not let in before the confirmation gets the "check your email" step.
    const mustConfirm = needsEmailConfirmation(signUpData)
    // A confirmation link went out, but the account may sign in already
    const sentTo = confirmationLinkSent(signUpData) ? email.trim() : null
    setConfirmByEmail(mustConfirm)
    setLinkSentTo(sentTo)
    if (!mustConfirm) {
      const { error: signInError } = await signIn(email.trim(), password)
      if (!signInError) {
        setLoading(false)
        onSignedUp?.({ signedIn: true, confirmByEmail: false, linkSentTo: sentTo })
        return
      }
    }
    setSuccess(true)
    setLoading(false)
    onSignedUp?.({ signedIn: false, confirmByEmail: mustConfirm, linkSentTo: sentTo })
  }

  if (success) {
    return (
      <div className="py-2 text-center" data-testid="signup-done">
        <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-green-50 text-green-600">
          <Check size={26} strokeWidth={2.25} aria-hidden="true" />
        </div>
        <p className="mb-1 text-sm font-semibold text-stone-900">{t('auth.accountCreated', 'Account created successfully!')}</p>
        <p className="text-sm text-stone-600">
          {confirmByEmail
            ? t('auth.checkEmail', 'Check your email to confirm your account')
            : linkSentTo
              ? t('authEmail.signUpLinkSent', { email: linkSentTo })
              : t('auth.accountReady', 'Your account is ready. You can sign in now.')}
        </p>
        {onSwitchToLogin && (
          <Button variant="hero" block onClick={onSwitchToLogin} className="mt-5">
            {t('auth.signIn', 'Sign in')}
          </Button>
        )}
      </div>
    )
  }

  return (
    <>
      {error && (
        <p role="alert" className="mb-4 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <form onSubmit={handleSubmit} className="space-y-3" data-testid="signup-form">
        {/* Two per row on a wide screen, one per row in portrait / on a phone */}
        <div className="grid grid-cols-2 gap-3 stack:grid-cols-1">
          <Field label={t('auth.firstName', 'First name')}>
            <Input size="lg" type="text" value={firstName} onChange={e => setFirstName(e.target.value)} autoComplete="given-name" />
          </Field>
          <Field label={t('auth.lastName', 'Last name')}>
            <Input size="lg" type="text" value={lastName} onChange={e => setLastName(e.target.value)} autoComplete="family-name" />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3 stack:grid-cols-1">
          <Field label={t('auth.country', 'Country')}>
            <Input
              size="lg"
              type="text"
              value={country}
              onChange={e => setCountry(e.target.value.toUpperCase())}
              placeholder="CHE"
              maxLength={3}
              autoComplete="off"
              className="uppercase"
            />
          </Field>
          <Field label={t('auth.dob', 'Date of birth')} error={dobError}>
            <DateOfBirthInput value={dob} onChange={(iso) => { setDob(iso); setDobError('') }} />
          </Field>
        </div>

        <Field label={t('auth.email', 'Email')}>
          <Input size="lg" type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" required />
        </Field>

        <Field label={t('auth.password', 'Password')}>
          <Input size="lg" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" required />
        </Field>

        <Field label={t('auth.confirmPassword', 'Confirm password')}>
          <Input size="lg" type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} autoComplete="new-password" required />
        </Field>

        <Button variant="hero" block type="submit" disabled={loading} loading={loading} className="!mt-5">
          {loading ? t('auth.creatingAccount', 'Creating account...') : t('auth.createAccount', 'Create account')}
        </Button>
      </form>

      <p className="mt-3 text-xs text-stone-500">{t('access.signUpPendingNote')}</p>

      {onSwitchToLogin && (
        <div className="mt-4 border-t border-stone-100 pt-4 text-center text-sm text-stone-500">
          {t('auth.haveAccount', 'Already have an account?')}{' '}
          <button
            type="button"
            onClick={onSwitchToLogin}
            className={cn('min-h-11 rounded px-1 font-medium text-red-600 underline decoration-red-300 underline-offset-2 transition-colors hover:text-red-700 hover:decoration-red-500', FOCUS_RING)}
          >
            {t('auth.signIn', 'Sign in')}
          </button>
        </div>
      )}
    </>
  )
}
