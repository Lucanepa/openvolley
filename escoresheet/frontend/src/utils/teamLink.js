/**
 * A team link opened on the manager site (db/023, docs/team-managers-spec.md
 * section 2): manager.openvolley.app/#team=<code>; a club manager link
 * (db/029) the same way, as #club=<code>. The code is taken out of
 * the URL at once and kept on this device for a week, through sign-up and
 * the email confirmation. It is redeemed only after the signed-in account
 * said yes to "Manage <team> with <account>?" (ManagerApp TeamLinkQuestion,
 * fe-auth-client-7), and it goes when a session ends here or another
 * account signs in (AuthContext clearLocalAccountData).
 */
import { linkKindFromHash, teamCodeFromHash } from './managerSite'

export const PENDING_TEAM_LINK_KEY = 'ov:pendingTeamLink'
export const PENDING_TEAM_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** The kept code, or null (an old one is dropped). */
export function readPendingTeamLink(now = Date.now()) {
  try {
    const v = JSON.parse(localStorage.getItem(PENDING_TEAM_LINK_KEY) || 'null')
    if (!v || typeof v.code !== 'string') return null
    if (!(now - Number(v.at) < PENDING_TEAM_LINK_TTL_MS)) {
      localStorage.removeItem(PENDING_TEAM_LINK_KEY)
      return null
    }
    return v.code
  } catch {
    return null
  }
}

export function keepPendingTeamLink(code, now = Date.now(), kind = 'team') {
  try { localStorage.setItem(PENDING_TEAM_LINK_KEY, JSON.stringify({ code, at: now, ...(kind === 'club' ? { kind } : {}) })) } catch { /* private mode: the code field still works */ }
}

/** The kind of the kept link: 'club' (a club manager link, db/029) or 'team'. */
export function readPendingLinkKind() {
  try {
    return JSON.parse(localStorage.getItem(PENDING_TEAM_LINK_KEY) || 'null')?.kind === 'club' ? 'club' : 'team'
  } catch {
    return 'team'
  }
}

export function clearPendingTeamLink() {
  try { localStorage.removeItem(PENDING_TEAM_LINK_KEY) } catch { /* nothing kept */ }
}

/**
 * A '#team=<code>' in the URL: kept, and the hash removed (no history entry).
 * Returns the code, or null when the URL has none.
 */
export function takeTeamLinkFromLocation(win = typeof window !== 'undefined' ? window : undefined) {
  if (!win) return null
  const code = teamCodeFromHash(win.location?.hash)
  if (!code) return null
  keepPendingTeamLink(code, Date.now(), linkKindFromHash(win.location?.hash))
  try {
    const { pathname, search } = win.location
    win.history.replaceState(win.history.state, '', `${pathname}${search}`)
  } catch { /* no history: the hash stays, harmless */ }
  return code
}

/** Errors after which the kept code is useless (the others are tried again). */
export const FINAL_TEAM_LINK_ERRORS = new Set(['OV_INVITE_INVALID', 'OV_INVITE_EXPIRED', 'OV_INVITE_USED_UP', 'OV_INVITE_REMOVED'])

/**
 * Errors of the question's preview that another account may not get: the
 * question stays, with "Use another account" (a club manager link mailed to
 * another address, db/036).
 */
export const OTHER_ACCOUNT_TEAM_LINK_ERRORS = new Set(['OV_INVITE_OTHER_ACCOUNT'])
