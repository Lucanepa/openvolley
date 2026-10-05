import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../contexts/AuthContext'
import LoginModal from './LoginModal'
import SignUpModal from './SignUpModal'
import ProfileModal from './ProfileModal'
import MatchHistory from './MatchHistory'
import { CalendarDays, ChevronDown, ChevronRight, LogOut, User } from 'lucide-react'
import { cn, FOCUS_RING } from '../../ui'

// Kit recipes. Header-small button (svrz AdminConsole header) and the
// anchored dropdown / sheet menu row (RESTYLE-SPEC 3.4).
const HEADER_BTN = 'inline-flex items-center justify-center gap-1.5 h-8 px-2.5 rounded-lg border border-stone-200 bg-white text-xs font-medium text-stone-600 hover:bg-stone-100 transition-colors'
const MENU_ROW = 'w-full min-h-11 inline-flex items-center gap-3 px-3 py-2.5 rounded-lg text-left font-medium transition-colors'

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
    // Not logged in: header-small outline button
    return (
      <>
        <button
          type="button"
          onClick={() => setShowLogin(true)}
          className={cn(HEADER_BTN, fullWidth && 'h-12 px-5 text-base rounded-xl', FOCUS_RING)}
          style={style}
        >
          {t('auth.login', 'Login')}
          <ChevronRight size={fullWidth ? 16 : 13} aria-hidden="true" className="text-stone-400" />
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

  const iconPx = fullWidth ? 18 : 16

  return (
    <>
      <div className="ov-kit relative" style={style}>
        <button
          type="button"
          onClick={() => setShowDropdown(!showDropdown)}
          aria-label={userName}
          aria-expanded={showDropdown}
          className={cn(
            fullWidth
              ? 'inline-flex min-h-12 items-center justify-center gap-2.5 rounded-xl border border-stone-300 bg-white px-5 text-base font-semibold text-stone-800 hover:bg-stone-50 transition-colors'
              : 'inline-flex h-8 min-w-8 items-center justify-center rounded-full bg-slate-900 px-2 text-xs font-semibold text-white hover:bg-slate-800 transition-colors',
            FOCUS_RING
          )}
        >
          {fullWidth ? (
            <>
              <User size={20} aria-hidden="true" className="text-stone-500" />
              {userName}
              <ChevronDown size={16} aria-hidden="true" className="ml-auto text-stone-400" />
            </>
          ) : (
            getInitials()
          )}
        </button>

        {showDropdown && (
          <>
            {/* Backdrop */}
            <div
              className="fixed inset-0"
              style={{ zIndex: 999 }}
              onClick={() => setShowDropdown(false)}
            />

            {/* Dropdown menu */}
            <div
              className={cn(
                'absolute top-full mt-2 overflow-hidden rounded-xl border border-stone-200 bg-white p-1.5 shadow-card-lg',
                fullWidth ? 'left-1/2 w-[300px] -translate-x-1/2' : 'right-0 w-[220px]'
              )}
              style={{ zIndex: 1000 }}
            >
              {/* User info */}
              <div className="border-b border-stone-100 px-3 pt-2 pb-3">
                <div className={cn('font-semibold text-stone-900', fullWidth ? 'text-base' : 'text-sm')}>
                  {userName}
                </div>
                <div className={cn('mt-0.5 truncate text-stone-500', fullWidth ? 'text-sm' : 'text-xs')}>
                  {user.email}
                </div>
                <div className="mt-1.5 flex gap-1">
                  <span className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-emerald-200 bg-emerald-50 px-1.5 py-[3px] text-[11px] font-semibold leading-none text-emerald-700">
                    {t('auth.roleScorer', 'Scorer')}
                  </span>
                </div>
              </div>

              {/* Menu items */}
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setShowDropdown(false)
                    setShowProfile(true)
                  }}
                  className={cn(MENU_ROW, fullWidth ? 'text-base' : 'text-sm', 'text-stone-700 hover:bg-stone-100', FOCUS_RING)}
                >
                  <User size={iconPx} aria-hidden="true" className="text-stone-400" />
                  {t('auth.profile', 'Profile')}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setShowDropdown(false)
                    setShowMatchHistory(true)
                  }}
                  className={cn(MENU_ROW, fullWidth ? 'text-base' : 'text-sm', 'text-stone-700 hover:bg-stone-100', FOCUS_RING)}
                >
                  <CalendarDays size={iconPx} aria-hidden="true" className="text-stone-400" />
                  {t('home.myMatches', 'My Matches')}
                </button>

                <button
                  type="button"
                  onClick={handleSignOut}
                  className={cn(MENU_ROW, fullWidth ? 'text-base' : 'text-sm', 'mt-1 text-red-600 hover:bg-red-50', FOCUS_RING)}
                >
                  <LogOut size={iconPx} aria-hidden="true" />
                  {t('auth.signOut', 'Sign Out')}
                </button>
              </div>
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
