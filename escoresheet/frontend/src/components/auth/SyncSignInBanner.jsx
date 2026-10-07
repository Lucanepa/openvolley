import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../contexts/AuthContext'
import LoginModal from './LoginModal'
import { cn } from '../../ui'

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
      {visible && !showLogin && (
        <div
          role="status"
          aria-live="polite"
          // Kit amber banner (decide / stale), floating, no-print. Opened on the
          // scoreboard too, so the action is dark, never a brand-red fill (R4).
          className={cn(
            'ov-kit no-print fixed flex items-center rounded-xl border border-amber-200 bg-amber-50 shadow-lg',
            compact ? 'flex-nowrap gap-2 px-2.5 py-1.5' : 'flex-wrap gap-3 px-3.5 py-3'
          )}
          style={{
            left: '50%',
            transform: 'translateX(-50%)',
            // On the live scoreboard: one short line at the top, clear of the
            // scoring controls along the bottom
            ...(compact
              ? { top: 'calc(env(safe-area-inset-top, 0px) + 6px)', width: 'min(460px, calc(100vw - 24px))' }
              : { bottom: 16, width: 'min(560px, calc(100vw - 32px))' }),
            zIndex: 1500
          }}
        >
          <div className={cn('min-w-0', compact ? 'flex-auto' : 'flex-[1_1_260px]')}>
            <div className={cn('font-semibold text-amber-800', compact ? 'truncate text-xs' : 'mb-0.5 text-sm')}>
              {title}
            </div>
            {!compact && (
              <div className="text-xs leading-snug text-stone-600">
                {sessionExpired
                  ? t('syncBanner.expiredBody', 'Scoring keeps working. Sign in again to save it to the cloud; waiting changes are sent right after.')
                  : t('syncBanner.body', 'Scoring keeps working. Sign in to save it to the cloud (referee, livescore, backup); waiting changes are sent right after.')}
              </div>
            )}
          </div>
          <div className={cn('flex shrink-0', compact ? 'gap-1.5' : 'gap-2')}>
            <button
              type="button"
              onClick={dismiss}
              className={cn('inline-flex items-center rounded-lg border border-amber-200 bg-white font-medium text-amber-800 transition-colors hover:bg-amber-100', compact ? 'h-8 px-2.5 text-xs' : 'h-9 px-3 text-xs', 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 focus-visible:ring-offset-1')}
            >
              {t('syncBanner.later', 'Later')}
            </button>
            <button
              type="button"
              onClick={() => setShowLogin(true)}
              className={cn('inline-flex items-center rounded-lg bg-slate-900 font-semibold text-white transition-colors hover:bg-slate-800', compact ? 'h-8 px-2.5 text-xs' : 'h-9 px-3 text-xs', 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 focus-visible:ring-offset-1')}
            >
              {sessionExpired ? t('syncBanner.signInAgain', 'Sign in again') : t('auth.signIn', 'Sign in')}
            </button>
          </div>
        </div>
      )}

      {/* Sign-in only: "Don't have an account?" opens manager.openvolley.app */}
      <LoginModal
        open={showLogin}
        onClose={() => setShowLogin(false)}
      />
    </>
  )
}
