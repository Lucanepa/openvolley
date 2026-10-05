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
 * LAN/venue server or an offline device never shows it. Also with a user in
 * the app: the stored session was then revoked or expired on the server (the
 * 401 says so), and the scorer must sign in again.
 */
export function shouldShowSyncSignIn({ syncStatus, loading, dismissed }) {
  return syncStatus === 'auth_required' && !loading && !dismissed
}

/**
 * Non-blocking notice for a scorer who is not signed in: scoring keeps working
 * and everything is saved on this device, but the cloud copy (referee,
 * livescore, backup) needs an account. After a sign-in the waiting changes are
 * sent at once (useSyncQueue resumes on the session change).
 */
export default function SyncSignInBanner({ syncStatus, compact = false }) {
  const { t } = useTranslation()
  const { user, loading } = useAuth()
  const [dismissed, setDismissed] = useState(readDismissed)
  const [showLogin, setShowLogin] = useState(false)
  const [showSignUp, setShowSignUp] = useState(false)

  const visible = shouldShowSyncSignIn({ syncStatus, loading, dismissed })
  // Signed in as far as the app knows, but the backend refused the session
  const sessionExpired = !!user
  const title = sessionExpired
    ? t('syncBanner.expiredTitle', 'Session expired: changes are saved on this device only')
    : t('syncBanner.title', 'Not signed in: this match is saved on this device only')

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
            transform: 'translateX(-50%)',
            // On the live scoreboard: one short line at the top, clear of the
            // scoring controls along the bottom
            ...(compact
              ? { top: 'calc(env(safe-area-inset-top, 0px) + 6px)', width: 'min(460px, calc(100vw - 24px))', padding: '6px 10px', gap: 8, flexWrap: 'nowrap' }
              : { bottom: 16, width: 'min(560px, calc(100vw - 32px))', padding: '12px 14px', gap: 12, flexWrap: 'wrap' }),
            background: 'var(--panel)',
            border: '1px solid rgba(245, 158, 11, 0.5)',
            borderRadius: 10,
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.35)',
            zIndex: 1500,
            display: 'flex',
            alignItems: 'center'
          }}
        >
          <div style={{ flex: compact ? '1 1 auto' : '1 1 260px', minWidth: 0 }}>
            <div style={{
              color: '#f59e0b',
              fontWeight: 600,
              fontSize: compact ? 12 : 14,
              marginBottom: compact ? 0 : 2,
              ...(compact ? { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } : {})
            }}>
              {title}
            </div>
            {!compact && (
              <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.4 }}>
                {sessionExpired
                  ? t('syncBanner.expiredBody', 'Scoring keeps working. Sign in again to save it to the cloud; waiting changes are sent right after.')
                  : t('syncBanner.body', 'Scoring keeps working. Sign in to save it to the cloud (referee, livescore, backup); waiting changes are sent right after.')}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: compact ? 6 : 8, flexShrink: 0 }}>
            <button
              onClick={dismiss}
              style={{
                padding: compact ? '4px 8px' : '6px 12px',
                background: 'transparent',
                color: 'var(--muted)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                fontSize: compact ? 12 : 13,
                cursor: 'pointer'
              }}
            >
              {t('syncBanner.later', 'Later')}
            </button>
            <button
              onClick={() => setShowLogin(true)}
              style={{
                padding: compact ? '4px 8px' : '6px 12px',
                background: '#3b82f6',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                fontSize: compact ? 12 : 13,
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              {sessionExpired ? t('syncBanner.signInAgain', 'Sign in again') : t('auth.signIn', 'Sign In')}
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
