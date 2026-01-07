import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../contexts/AuthContext'

export default function SignUpModal({ open, onClose, onSwitchToLogin }) {
  const { t } = useTranslation()
  const { signUp } = useAuth()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [country, setCountry] = useState('CHE')
  const [dob, setDob] = useState('')
  const [roles, setRoles] = useState(['scorer'])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

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

    const { error: signUpError } = await signUp(email, password, {
      firstName,
      lastName,
      country,
      dob: dob || null,
      roles
    })

    if (signUpError) {
      setError(signUpError.message)
      setLoading(false)
    } else {
      setSuccess(true)
      setLoading(false)
    }
  }

  const toggleRole = (role) => {
    setRoles(prev =>
      prev.includes(role)
        ? prev.filter(r => r !== role)
        : [...prev, role]
    )
  }

  const modalStyle = {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,.85)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2000
  }

  const contentStyle = {
    width: 'min(90vw, 440px)',
    maxHeight: '90vh',
    background: '#111827',
    border: '2px solid #22c55e',
    borderRadius: 12,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column'
  }

  const headerStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 20px',
    background: 'rgba(34, 197, 94, 0.1)',
    borderBottom: '1px solid rgba(34, 197, 94, 0.3)'
  }

  const inputStyle = {
    width: '100%',
    padding: '12px 16px',
    background: '#1f2937',
    border: '1px solid #374151',
    borderRadius: 8,
    color: '#e5e7eb',
    fontSize: 16,
    outline: 'none',
    boxSizing: 'border-box'
  }

  const buttonStyle = {
    width: '100%',
    padding: '12px 16px',
    background: '#22c55e',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    fontWeight: 600,
    fontSize: 16,
    cursor: 'pointer'
  }

  const roleButtonStyle = (isActive) => ({
    padding: '8px 16px',
    background: isActive ? '#22c55e' : '#1f2937',
    color: isActive ? '#fff' : '#9ca3af',
    border: isActive ? 'none' : '1px solid #374151',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 14
  })

  return (
    <div style={modalStyle} onClick={onClose}>
      <div style={contentStyle} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={headerStyle}>
          <h2 style={{ margin: 0, color: '#fff', fontSize: 20, fontWeight: 600 }}>
            {t('auth.createAccount', 'Create Account')}
          </h2>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: '#9ca3af',
              fontSize: 24,
              cursor: 'pointer',
              padding: 0,
              lineHeight: 1
            }}
          >
            x
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 20, overflowY: 'auto' }}>
          {error && (
            <div style={{
              padding: '10px 14px',
              background: 'rgba(239, 68, 68, 0.15)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              borderRadius: 8,
              color: '#ef4444',
              marginBottom: 16,
              fontSize: 14
            }}>
              {error}
            </div>
          )}

          {success ? (
            <div style={{ textAlign: 'center', color: '#22c55e', padding: '20px 0' }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>✓</div>
              <p style={{ marginBottom: 8 }}>{t('auth.accountCreated', 'Account created successfully!')}</p>
              <p style={{ color: '#9ca3af', fontSize: 14 }}>
                {t('auth.checkEmail', 'Check your email to confirm your account')}
              </p>
              <button
                onClick={onSwitchToLogin}
                style={{ ...buttonStyle, marginTop: 16 }}
              >
                {t('auth.signIn', 'Sign In')}
              </button>
            </div>
          ) : (
            <>
              <form onSubmit={handleSubmit}>
                {/* Name fields */}
                <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ color: '#9ca3af', fontSize: 13, marginBottom: 4, display: 'block' }}>
                      {t('auth.firstName', 'First name')}
                    </label>
                    <input
                      type="text"
                      value={firstName}
                      onChange={e => setFirstName(e.target.value)}
                      style={inputStyle}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={{ color: '#9ca3af', fontSize: 13, marginBottom: 4, display: 'block' }}>
                      {t('auth.lastName', 'Last name')}
                    </label>
                    <input
                      type="text"
                      value={lastName}
                      onChange={e => setLastName(e.target.value)}
                      style={inputStyle}
                    />
                  </div>
                </div>

                {/* Country and DOB */}
                <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ color: '#9ca3af', fontSize: 13, marginBottom: 4, display: 'block' }}>
                      {t('auth.country', 'Country')}
                    </label>
                    <input
                      type="text"
                      value={country}
                      onChange={e => setCountry(e.target.value.toUpperCase())}
                      placeholder="CHE"
                      maxLength={3}
                      style={{ ...inputStyle, textTransform: 'uppercase' }}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={{ color: '#9ca3af', fontSize: 13, marginBottom: 4, display: 'block' }}>
                      {t('auth.dob', 'Date of birth')}
                    </label>
                    <input
                      type="date"
                      value={dob}
                      onChange={e => setDob(e.target.value)}
                      style={inputStyle}
                    />
                  </div>
                </div>

                {/* Role selection */}
                <div style={{ marginBottom: 16 }}>
                  <label style={{ color: '#9ca3af', fontSize: 13, marginBottom: 6, display: 'block' }}>
                    {t('auth.roles', 'I am a:')}
                  </label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      onClick={() => toggleRole('scorer')}
                      style={roleButtonStyle(roles.includes('scorer'))}
                    >
                      {t('auth.roleScorer', 'Scorer')}
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleRole('referee')}
                      style={roleButtonStyle(roles.includes('referee'))}
                    >
                      {t('auth.roleReferee', 'Referee')}
                    </button>
                  </div>
                </div>

                {/* Email */}
                <div style={{ marginBottom: 12 }}>
                  <label style={{ color: '#9ca3af', fontSize: 13, marginBottom: 4, display: 'block' }}>
                    {t('auth.email', 'Email')} *
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    style={inputStyle}
                    required
                  />
                </div>

                {/* Password */}
                <div style={{ marginBottom: 12 }}>
                  <label style={{ color: '#9ca3af', fontSize: 13, marginBottom: 4, display: 'block' }}>
                    {t('auth.password', 'Password')} *
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    style={inputStyle}
                    required
                  />
                </div>

                {/* Confirm password */}
                <div style={{ marginBottom: 16 }}>
                  <label style={{ color: '#9ca3af', fontSize: 13, marginBottom: 4, display: 'block' }}>
                    {t('auth.confirmPassword', 'Confirm password')} *
                  </label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    style={inputStyle}
                    required
                  />
                </div>

                <button type="submit" style={buttonStyle} disabled={loading}>
                  {loading ? t('auth.creatingAccount', 'Creating account...') : t('auth.createAccount', 'Create Account')}
                </button>
              </form>

              <div style={{
                marginTop: 20,
                textAlign: 'center',
                color: '#9ca3af',
                fontSize: 14
              }}>
                {t('auth.haveAccount', 'Already have an account?')}{' '}
                <button
                  onClick={onSwitchToLogin}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#22c55e',
                    cursor: 'pointer',
                    fontSize: 14,
                    textDecoration: 'underline'
                  }}
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
