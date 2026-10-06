import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../contexts/AuthContext'
import LoginModal from './LoginModal'
import SignUpModal from './SignUpModal'
import ProfileModal from './ProfileModal'
import MatchHistory from './MatchHistory'
import RedeemInviteModal from './RedeemInviteModal'
import RoleChips from './RoleChips'
import { openManage } from '../../utils/manageNav'
import { CalendarDays, ChevronDown, ChevronRight, KeyRound, LogOut, ShieldCheck, User, Users } from 'lucide-react'
import { cn, FOCUS_RING } from '../../ui'

// Kit recipes. Header-small button (svrz AdminConsole header) and the
// anchored dropdown / sheet menu row (RESTYLE-SPEC 3.4).
const HEADER_BTN = 'inline-flex items-center justify-center gap-1.5 h-8 px-2.5 rounded-lg border border-stone-200 bg-white text-xs font-medium text-stone-600 hover:bg-stone-100 transition-colors'
const MENU_ROW = 'w-full min-h-11 inline-flex items-center gap-3 px-3 py-2.5 rounded-lg text-left font-medium transition-colors'

// Modals go to <body>: they stay up when the menu that holds this button
// closes (or is hidden), and no menu panel can clip them.
const toBody = (node) => (typeof document !== 'undefined' ? createPortal(node, document.body) : node)

/**
 * @param {object} props
 * @param {boolean} [props.inline] render the account rows in place (inside a
 *   menu panel) instead of an anchored dropdown, which the panel's scroll box
 *   clipped ('Sign out' cut off)
 * @param {() => void} [props.onAction] called when a row opens a dialog or
 *   signs out, so the surrounding menu can close
 */
export default function UserButton({ style = {}, fullWidth = false, inline = false, onAction }) {
  const { t } = useTranslation()
  const { user, profile, access, loading, signOut } = useAuth()

  const [showLogin, setShowLogin] = useState(false)
  const [showSignUp, setShowSignUp] = useState(false)
  const [showProfile, setShowProfile] = useState(false)
  const [showMatchHistory, setShowMatchHistory] = useState(false)
  const [showRedeem, setShowRedeem] = useState(false)
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
    onAction?.()
    await signOut()
    setShowDropdown(false)
  }

  if (!user) {
    // Not logged in: header-small outline button
    return (
      <>
        <button
          type="button"
          onClick={() => {
            setShowLogin(true)
            onAction?.()
          }}
          className={cn(
            inline ? cn(MENU_ROW, 'justify-between border-0 bg-transparent text-sm text-stone-700 hover:bg-stone-100') : HEADER_BTN,
            fullWidth && 'h-12 px-5 text-base rounded-xl',
            FOCUS_RING
          )}
          style={style}
        >
          {inline ? (
            // Same icon column as the other header menu rows
            <span className="flex flex-1 items-center gap-3">
              <span className="flex w-5 shrink-0 items-center justify-center text-stone-400"><User size={15} aria-hidden="true" /></span>
              {t('auth.login', 'Login')}
            </span>
          ) : t('auth.login', 'Login')}
          <ChevronRight size={fullWidth ? 16 : 13} aria-hidden="true" className="text-stone-400" />
        </button>

        {toBody(<>
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
        </>)}
      </>
    )
  }

  // Logged in - show avatar with dropdown
  const userName = profile?.first_name || profile?.last_name
    ? `${profile.first_name || ''} ${profile.last_name || ''}`.trim()
    : user?.email?.split('@')[0] || t('auth.user', 'User')

  const iconPx = fullWidth ? 18 : 16

  const accountModals = toBody(<>
    <ProfileModal
      open={showProfile}
      onClose={() => setShowProfile(false)}
    />

    <MatchHistory
      open={showMatchHistory}
      onClose={() => setShowMatchHistory(false)}
    />

    <RedeemInviteModal
      open={showRedeem}
      onClose={() => setShowRedeem(false)}
    />
  </>)

  // Access rows: admin console, saved teams (competition managers) and the
  // invite code for a pending account. Hiding them is cosmetic: the server
  // refuses every action without the role.
  const accessRows = (rowClass, close) => (<>
    {access?.isAdmin && (
      <button type="button" onClick={() => { close(); openManage('accounts') }} className={rowClass}>
        <ShieldCheck size={iconPx} aria-hidden="true" className="text-stone-400" />
        {t('manage.menuAdmin')}
      </button>
    )}
    {access?.canManageTeams && (
      <button type="button" onClick={() => { close(); openManage('teams') }} className={rowClass}>
        <Users size={iconPx} aria-hidden="true" className="text-stone-400" />
        {t('manage.menuSavedTeams')}
      </button>
    )}
    {access?.known && access?.isPending && (
      <button type="button" onClick={() => { close(); setShowRedeem(true) }} className={rowClass}>
        <KeyRound size={iconPx} aria-hidden="true" className="text-amber-600" />
        {t('manage.menuInviteCode')}
      </button>
    )}
  </>)

  if (inline) {
    // Account rows in the flow of the surrounding menu (no nested popover)
    return (
      <div className="ov-kit" style={style}>
        <div className="flex items-center gap-3 px-3 pt-2 pb-2">
          <span aria-hidden="true" className="inline-flex h-8 min-w-8 shrink-0 items-center justify-center rounded-full bg-slate-900 px-2 text-xs font-semibold text-white">
            {getInitials()}
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-stone-900">{userName}</div>
            <div className="truncate text-xs text-stone-500" title={user.email}>{user.email}</div>
            {access?.known && <RoleChips roles={access.roles} pending={access.isPending} className="mt-1" />}
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            setShowProfile(true)
            onAction?.()
          }}
          className={cn(MENU_ROW, 'border-0 bg-transparent text-sm text-stone-700 hover:bg-stone-100', FOCUS_RING)}
        >
          <User size={iconPx} aria-hidden="true" className="text-stone-400" />
          {t('auth.profile', 'Profile')}
        </button>
        <button
          type="button"
          onClick={() => {
            setShowMatchHistory(true)
            onAction?.()
          }}
          className={cn(MENU_ROW, 'border-0 bg-transparent text-sm text-stone-700 hover:bg-stone-100', FOCUS_RING)}
        >
          <CalendarDays size={iconPx} aria-hidden="true" className="text-stone-400" />
          {t('home.myMatches', 'My matches')}
        </button>
        {accessRows(cn(MENU_ROW, 'border-0 bg-transparent text-sm text-stone-700 hover:bg-stone-100', FOCUS_RING), () => onAction?.())}
        <button
          type="button"
          onClick={handleSignOut}
          className={cn(MENU_ROW, 'border-0 bg-transparent text-sm text-red-600 hover:bg-red-50', FOCUS_RING)}
        >
          <LogOut size={iconPx} aria-hidden="true" />
          {t('auth.signOut', 'Sign out')}
        </button>
        {accountModals}
      </div>
    )
  }

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
                {access?.known && <RoleChips roles={access.roles} pending={access.isPending} className="mt-1.5" />}
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
                  {t('home.myMatches', 'My matches')}
                </button>

                {accessRows(cn(MENU_ROW, fullWidth ? 'text-base' : 'text-sm', 'text-stone-700 hover:bg-stone-100', FOCUS_RING), () => setShowDropdown(false))}

                <button
                  type="button"
                  onClick={handleSignOut}
                  className={cn(MENU_ROW, fullWidth ? 'text-base' : 'text-sm', 'mt-1 text-red-600 hover:bg-red-50', FOCUS_RING)}
                >
                  <LogOut size={iconPx} aria-hidden="true" />
                  {t('auth.signOut', 'Sign out')}
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {accountModals}
    </>
  )
}
