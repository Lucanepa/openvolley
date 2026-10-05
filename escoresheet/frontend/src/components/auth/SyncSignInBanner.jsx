import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../contexts/AuthContext'
import LoginModal from './LoginModal'
import SignUpModal from './SignUpModal'

const DISMISS_KEY = 'ov_sync_signin_banner_dismissed'

function readDismissed() {
  try { return sessionStorage.getItem(DISMISS_KEY) === '1' } catch { return false }
}

/**
 * Should the "sign in to sync" banner show? Only when the cloud backend asked
 * for a session (sync status 'auth_required' comes from a 401 on a write), so a
 * LAN/venue server or an offline device never shows it.
 */
export function shouldShowSyncSignIn({ syncStatus, user, loading, dismissed }) {
  return syncStatus === 'auth_required' && !user && !loading && !dismissed
}

/**
 * Non-blocking notice for a scorer who is not signed in: scoring keeps working
 * and everything is saved on this device, but the cloud copy (referee,
 * livescore, backup) needs an account. After a sign-in the waiting changes are
 * sent at once (useSyncQueue resumes on the session change).
 */
export default function SyncSignInBanner({ syncStatus }) {
  const { t } = useTranslation()
  const { user, loading } = useAuth()
  const [dismissed, setDismissed] = useState(readDismissed)
  const [showLogin, setShowLogin] = useState(false)
  const [showSignUp, setShowSignUp] = useState(false)

  const visible = shouldShowSyncSignIn({ syncStatus, user, loading, dismissed })

  const dismiss = () => {
    setDismissed(true)
    try { sessionStorage.setItem(DISMISS_KEY, '1') } catch { /* private mode */ }
  }

  return (
    <>
      {visible && !showLogin && !showSignUp && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed',
            left: '50%',
            bottom: 16,
            transform: 'translateX(-50%)',
            width: 'min(560px, calc(100vw - 32px))',
            background: 'var(--panel)',
            border: '1px solid rgba(245, 158, 11, 0.5)',
            borderRadius: 10,
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.35)',
            padding: '12px 14px',
            zIndex: 1500,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap'
          }}
        >
          <div style={{ flex: '1 1 260px', minWidth: 0 }}>
            <div style={{ color: '#f59e0b', fontWeight: 600, fontSize: 14, marginBottom: 2 }}>
              {t('syncBanner.title', 'Not signed in: this match is saved on this device only')}
            </div>
            <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.4 }}>
              {t('syncBanner.body', 'Scoring keeps working. Sign in to save it to the cloud (referee, livescore, backup); waiting changes are sent right after.')}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button
              onClick={dismiss}
              style={{
                padding: '6px 12px',
                background: 'transparent',
                color: 'var(--muted)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                fontSize: 13,
                cursor: 'pointer'
              }}
            >
              {t('syncBanner.later', 'Later')}
            </button>
            <button
              onClick={() => setShowLogin(true)}
              style={{
                padding: '6px 12px',
                background: '#3b82f6',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              {t('auth.signIn', 'Sign In')}
            </button>
          </div>
        </div>
      )}

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
