import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../contexts/AuthContext'

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
    width: 'min(90vw, 400px)',
    background: '#111827',
    border: '2px solid #3b82f6',
    borderRadius: 12,
    padding: 0,
    overflow: 'hidden'
  }

  const headerStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 20px',
    background: 'rgba(59, 130, 246, 0.1)',
    borderBottom: '1px solid rgba(59, 130, 246, 0.3)'
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
    background: '#3b82f6',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    fontWeight: 600,
    fontSize: 16,
    cursor: 'pointer'
  }

  return (
    <div style={modalStyle} onClick={onClose}>
      <div style={contentStyle} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={headerStyle}>
          <h2 style={{ margin: 0, color: '#fff', fontSize: 20, fontWeight: 600 }}>
            {showForgotPassword
              ? t('auth.resetPassword', 'Reset Password')
              : t('auth.signIn', 'Sign In')}
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
        <div style={{ padding: 20 }}>
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

          {resetSent ? (
            <div style={{ textAlign: 'center', color: '#22c55e', padding: '20px 0' }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>✓</div>
              <p>{t('auth.resetEmailSent', 'Check your email for a password reset link')}</p>
              <button
                onClick={() => {
                  setShowForgotPassword(false)
                  setResetSent(false)
                }}
                style={{ ...buttonStyle, marginTop: 16 }}
              >
                {t('auth.backToSignIn', 'Back to Sign In')}
              </button>
            </div>
          ) : showForgotPassword ? (
            <form onSubmit={handleForgotPassword}>
              <p style={{ color: '#9ca3af', marginBottom: 16, fontSize: 14 }}>
                {t('auth.resetInstructions', 'Enter your email and we\'ll send you a reset link')}
              </p>
              <div style={{ marginBottom: 16 }}>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder={t('auth.email', 'Email')}
                  style={inputStyle}
                  required
                />
              </div>
              <button type="submit" style={buttonStyle} disabled={loading}>
                {loading ? t('auth.sending', 'Sending...') : t('auth.sendResetLink', 'Send Reset Link')}
              </button>
              <button
                type="button"
                onClick={() => setShowForgotPassword(false)}
                style={{
                  width: '100%',
                  padding: '12px 16px',
                  background: 'transparent',
                  color: '#9ca3af',
                  border: 'none',
                  cursor: 'pointer',
                  marginTop: 8
                }}
              >
                {t('auth.backToSignIn', 'Back to Sign In')}
              </button>
            </form>
          ) : (
            <>
              <form onSubmit={handleSubmit}>
                <div style={{ marginBottom: 12 }}>
                  <input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder={t('auth.email', 'Email')}
                    style={inputStyle}
                    required
                  />
                </div>
                <div style={{ marginBottom: 16 }}>
                  <input
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder={t('auth.password', 'Password')}
                    style={inputStyle}
                    required
                  />
                </div>
                <button type="submit" style={buttonStyle} disabled={loading}>
                  {loading ? t('auth.signingIn', 'Signing in...') : t('auth.signIn', 'Sign In')}
                </button>
              </form>

              <button
                onClick={() => setShowForgotPassword(true)}
                style={{
                  width: '100%',
                  padding: '8px',
                  background: 'transparent',
                  color: '#3b82f6',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 14,
                  marginTop: 8
                }}
              >
                {t('auth.forgotPassword', 'Forgot password?')}
              </button>

              <div style={{
                marginTop: 20,
                textAlign: 'center',
                color: '#9ca3af',
                fontSize: 14
              }}>
                {t('auth.noAccount', "Don't have an account?")}{' '}
                <button
                  onClick={onSwitchToSignUp}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#3b82f6',
                    cursor: 'pointer',
                    fontSize: 14,
                    textDecoration: 'underline'
                  }}
                >
                  {t('auth.signUp', 'Sign Up')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
