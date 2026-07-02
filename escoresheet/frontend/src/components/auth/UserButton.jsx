import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../contexts/AuthContext'
import LoginModal from './LoginModal'
import SignUpModal from './SignUpModal'
import ProfileModal from './ProfileModal'
import MatchHistory from './MatchHistory'

export default function UserButton({ style = {}, fullWidth = false }) {
  const { t } = useTranslation()
  const { user, profile, loading, signOut } = useAuth()

  const [showLogin, setShowLogin] = useState(false)
  const [showSignUp, setShowSignUp] = useState(false)
  const [showProfile, setShowProfile] = useState(false)
  const [showMatchHistory, setShowMatchHistory] = useState(false)
  const [showDropdown, setShowDropdown] = useState(false)

  if (loading) {
    return null
  }

  const getInitials = () => {
    if (profile?.first_name || profile?.last_name) {
      const first = (profile.first_name || '')[0] || ''
      const last = (profile.last_name || '')[0] || ''
      return (first + last).toUpperCase() || '?'
    }
    if (user?.email) {
      return user.email[0].toUpperCase()
    }
    return '?'
  }

  const handleSignOut = async () => {
    await signOut()
    setShowDropdown(false)
  }

  if (!user) {
    // Not logged in - show pill-shaped login button with gradient
    const buttonStyle = {
      background: 'linear-gradient(180deg, #4da6ff 0%, #2196f3 50%, #1976d2 100%)',
      color: '#fff',
      border: 'none',padding: '4px 10px',
      fontSize: 'clamp(10px, 1.2vw, 12px)',
      borderRadius: 50,
      fontWeight: 600,
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      boxShadow: '0 3px 8px rgba(33, 150, 243, 0.35), inset 0 1px 0 rgba(255,255,255,0.3)',
      textTransform: 'uppercase',
      letterSpacing: '0.5px',
      ...style
    }

    const circleStyle = {
      width: 19,
      height: 19,
      borderRadius: '50%',
      background: '#fff',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
    }

    return (
      <>
        <button
          onClick={() => setShowLogin(true)}
          style={buttonStyle}
        >
          {t('auth.login', 'Login')}
          <span style={circleStyle}>
            <svg
              width={fullWidth ? "12" : "9"}
              height={fullWidth ? "12" : "9"}
              viewBox="0 0 24 24"
              fill="none"
              stroke="#2196f3"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </span>
        </button>

        <LoginModal
          open={showLogin}
          onClose={() => setShowLogin(false)}
          onSwitchToSignUp={() => {
            setShowLogin(false)
            setShowSignUp(true)
          }}
        />

        <SignUpModal
          open={showSignUp}
          onClose={() => setShowSignUp(false)}
          onSwitchToLogin={() => {
            setShowSignUp(false)
            setShowLogin(true)
          }}
        />
      </>
    )
  }

  // Logged in - show avatar with dropdown
  const userName = profile?.first_name || profile?.last_name
    ? `${profile.first_name || ''} ${profile.last_name || ''}`.trim()
    : user?.email?.split('@')[0] || t('auth.user', 'User')

  const loggedInButtonStyle = fullWidth ? {
    width: 'auto',
    padding: '10px 20px',
    fontSize: '20px',
    fontWeight: 600,
    background:  'linear-gradient(180deg, #4da6ff 0%, #2196f3 50%, #1976d2 100%)',
    color: '#3b82f6',
    border: '1px solid rgba(59, 130, 246, 0.3)',
    borderRadius: '8px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    minHeight: 48
  } : {
    width: 'auto',
    height: 27,
    borderRadius: 50,
    background:  'linear-gradient(180deg, #4da6ff 0%, #2196f3 50%, #1976d2 100%)',
    color: '#fff',
    border: 'none',
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 600,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  }

  return (
    <>
      <div style={{ position: 'relative', ...style }}>
        <button
          onClick={() => setShowDropdown(!showDropdown)}
          aria-label={userName}
          style={{ ...loggedInButtonStyle,  }}
        >
          {fullWidth ? (
            <>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              {userName}
              <span style={{ marginLeft: 'auto', opacity: 0.7 }}>▼</span>
            </>
          ) : (
            getInitials()
          )}
        </button>

        {showDropdown && (
          <>
            {/* Backdrop */}
            <div
              style={{
                position: 'fixed',
                inset: 0,
                zIndex: 999
              }}
              onClick={() => setShowDropdown(false)}
            />

            {/* Dropdown menu */}
            <div style={{
              position: 'absolute',
              top: '100%',
              ...(fullWidth ? { left: '50%', transform: 'translateX(-50%)' } : { right: 0 }),
              marginTop: 8,
              width: fullWidth ? 300 : 200,
              background: 'var(--panel)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              boxShadow: '0 10px 25px rgba(0,0,0,0.3)',
              zIndex: 1000,
              overflow: 'hidden'
            }}>
              {/* User info */}
              <div style={{
                padding: '12px 16px',
                borderBottom: '1px solid var(--border)'
              }}>
                <div style={{ color: 'var(--text)', fontWeight: 500, fontSize: fullWidth ? 16 : 14 }}>
                  {userName}
                </div>
                <div style={{ color: 'var(--muted)', fontSize: fullWidth ? 14 : 12, marginTop: 2 }}>
                  {user.email}
                </div>
                <div style={{ marginTop: 6, display: 'flex', gap: 4 }}>
                  <span
                    style={{
                      padding: '2px 6px',
                      background: '#22c55e',
                      color: '#fff',
                      borderRadius: 4,
                      fontSize: fullWidth ? 12 : 10
                    }}
                  >
                    {t('auth.roleScorer', 'Scorer')}
                  </span>
                </div>
              </div>

              {/* Menu items */}
              <button
                onClick={() => {
                  setShowDropdown(false)
                  setShowProfile(true)
                }}
                style={{
                  width: '100%',
                  padding: fullWidth ? '12px 16px' : '10px 16px',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text)',
                  textAlign: 'left',
                  cursor: 'pointer',
                  fontSize: fullWidth ? 16 : 14,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10
                }}
              >
                <svg width={fullWidth ? "18" : "16"} height={fullWidth ? "18" : "16"} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
                {t('auth.profile', 'Profile')}
              </button>

              <button
                onClick={() => {
                  setShowDropdown(false)
                  setShowMatchHistory(true)
                }}
                style={{
                  width: '100%',
                  padding: fullWidth ? '12px 16px' : '10px 16px',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text)',
                  textAlign: 'left',
                  cursor: 'pointer',
                  fontSize: fullWidth ? 16 : 14,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10
                }}
              >
                <svg width={fullWidth ? "18" : "16"} height={fullWidth ? "18" : "16"} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                  <line x1="16" y1="2" x2="16" y2="6" />
                  <line x1="8" y1="2" x2="8" y2="6" />
                  <line x1="3" y1="10" x2="21" y2="10" />
                </svg>
                {t('home.myMatches', 'My Matches')}
              </button>

              <button
                onClick={handleSignOut}
                style={{
                  width: '100%',
                  padding: fullWidth ? '12px 16px' : '10px 16px',
                  background: 'transparent',
                  border: 'none',
                  color: '#ef4444',
                  textAlign: 'left',
                  cursor: 'pointer',
                  fontSize: fullWidth ? 16 : 14,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  borderTop: '1px solid var(--border)'
                }}
              >
                <svg width={fullWidth ? "18" : "16"} height={fullWidth ? "18" : "16"} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
                {t('auth.signOut', 'Sign Out')}
              </button>
            </div>
          </>
        )}
      </div>

      <ProfileModal
        open={showProfile}
        onClose={() => setShowProfile(false)}
      />

      <MatchHistory
        open={showMatchHistory}
        onClose={() => setShowMatchHistory(false)}
      />
    </>
  )
}
