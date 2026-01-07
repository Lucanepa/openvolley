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
    // Show placeholder while loading
    if (fullWidth) {
      return (
        <div style={{
          width: '400px',
          padding: '10px 20px',
          fontSize: '20px',
          background: 'rgba(255, 255, 255, 0.05)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          borderRadius: '8px',
          height: 48,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'rgba(255, 255, 255, 0.5)',
          ...style
        }}>
          ...
        </div>
      )
    }
    return (
      <div style={{
        width: 40,
        height: 40,
        borderRadius: '50%',
        background: '#1f2937',
        ...style
      }} />
    )
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
    // Not logged in - show sign in button
    const buttonStyle = fullWidth ? {
      width: 'auto',
      padding: '10px 20px',
      fontSize: '20px',
      fontWeight: 600,
      background: 'rgb(0, 0, 0)',
      color: 'var(--text)',
      border: '1px solid rgba(255, 255, 255, 0.2)',
      borderRadius: '8px',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      ...style
    } : {
      padding: '8px 16px',
      background: '#3b82f6',
      color: '#fff',
      border: 'none',
      borderRadius: 8,
      fontWeight: 500,
      cursor: 'pointer',
      fontSize: 14,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      ...style
    }

    return (
      <>
        <button
          onClick={() => setShowLogin(true)}
          style={buttonStyle}
        >
          <svg width={fullWidth ? "20" : "16"} height={fullWidth ? "20" : "16"} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
            <polyline points="10 17 15 12 10 7" />
            <line x1="15" y1="12" x2="3" y2="12" />
          </svg>
          {t('auth.signIn', 'Sign In')}
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
    width: '400px',
    padding: '10px 20px',
    fontSize: '20px',
    fontWeight: 600,
    background: 'rgba(59, 130, 246, 0.15)',
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
    width: 40,
    height: 40,
    borderRadius: '50%',
    background: '#3b82f6',
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
          style={loggedInButtonStyle}
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
              background: '#1f2937',
              border: '1px solid #374151',
              borderRadius: 8,
              boxShadow: '0 10px 25px rgba(0,0,0,0.3)',
              zIndex: 1000,
              overflow: 'hidden'
            }}>
              {/* User info */}
              <div style={{
                padding: '12px 16px',
                borderBottom: '1px solid #374151'
              }}>
                <div style={{ color: '#fff', fontWeight: 500, fontSize: fullWidth ? 16 : 14 }}>
                  {userName}
                </div>
                <div style={{ color: '#9ca3af', fontSize: fullWidth ? 14 : 12, marginTop: 2 }}>
                  {user.email}
                </div>
                {profile?.roles && profile.roles.length > 0 && (
                  <div style={{ marginTop: 6, display: 'flex', gap: 4 }}>
                    {profile.roles.map(role => (
                      <span
                        key={role}
                        style={{
                          padding: '2px 6px',
                          background: role === 'admin' || role === 'super_admin' ? '#7c3aed' : '#22c55e',
                          color: '#fff',
                          borderRadius: 4,
                          fontSize: fullWidth ? 12 : 10,
                          textTransform: 'capitalize'
                        }}
                      >
                        {role.replace('_', ' ')}
                      </span>
                    ))}
                  </div>
                )}
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
                  color: '#e5e7eb',
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
                  color: '#e5e7eb',
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
                  borderTop: '1px solid #374151'
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
