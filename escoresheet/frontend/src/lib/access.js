/**
 * Account access, derived from profiles.roles. The same definitions as the
 * backend's lib/access.js (spec section 1): the server enforces every rule,
 * the UI only uses these to hide what the account cannot do.
 */

export const ADMIN_ROLES = ['admin', 'super_admin']
export const KNOWN_ROLES = ['scorer', 'referee', 'competition_manager', 'admin', 'super_admin']
// Roles an admin can grant or remove through the API (super_admin is SQL-only).
export const API_GRANTABLE_ROLES = ['scorer', 'referee', 'competition_manager', 'admin']

// OpenBeach's roles (backend lib/access.js SPORT_ROLES.beach): the same three
// with a prefix. The lists above stay indoor: OpenVolley's screens and its
// manager show and edit indoor roles only; the OpenBeach manager uses these.
export const BEACH_ROLES = ['beach:scorer', 'beach:referee', 'beach:competition_manager']
/** 'beach:scorer' -> 'scorer' (the label key); any other role unchanged. */
export const plainRole = (role) => String(role || '').replace(/^beach:/, '')

/** The flags of one sport, as the backend's apps.<sport> (admin counts for both). */
function sportFlags(roles, isAdmin, sport) {
  const own = sport === 'beach' ? BEACH_ROLES : ['scorer', 'referee', 'competition_manager']
  const prefix = sport === 'beach' ? 'beach:' : ''
  const canScore = isAdmin || roles.includes(`${prefix}scorer`)
  const canManageTeams = isAdmin || roles.includes(`${prefix}competition_manager`)
  return {
    roles: roles.filter(r => own.includes(r)),
    canScore,
    canManageTeams,
    canReadTeams: canScore || canManageTeams,
    isPending: !isAdmin && !own.some(r => roles.includes(r))
  }
}

/**
 * Normalise a roles value as the backend does: an array, a Postgres array
 * literal ('{scorer,admin}') or a comma-separated string. Values are trimmed
 * and lower-cased; unknown values are kept but grant nothing.
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeRoles(raw) {
  let list = []
  if (Array.isArray(raw)) list = raw
  else if (typeof raw === 'string') list = raw.replace(/^\{|\}$/g, '').split(',')
  const out = []
  for (const r of list) {
    if (r === null || r === undefined) continue
    const v = String(r).trim().replace(/^"|"$/g, '').toLowerCase()
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

/**
 * @param {unknown} rawRoles
 * The flags are OpenVolley's (indoor), unchanged; accessForApp() gives
 * OpenBeach's.
 * @returns {{roles: string[], isAdmin: boolean, isSuperAdmin: boolean, canScore: boolean,
 *   canManageTeams: boolean, canReadTeams: boolean, isPending: boolean}}
 */
export function accessFromRoles(rawRoles) {
  const roles = normalizeRoles(rawRoles)
  const isAdmin = roles.some(r => ADMIN_ROLES.includes(r))
  const isSuperAdmin = roles.includes('super_admin')
  const canScore = isAdmin || roles.includes('scorer')
  const canManageTeams = isAdmin || roles.includes('competition_manager')
  const canReadTeams = canScore || canManageTeams
  const isPending = !roles.some(r => KNOWN_ROLES.includes(r))
  return { roles, isAdmin, isSuperAdmin, canScore, canManageTeams, canReadTeams, isPending }
}

/**
 * The flags of `sport` in an access object, with isAdmin, isSuperAdmin and
 * known carried over: what a console of that app checks. 'indoor' returns
 * the access itself (unchanged behaviour).
 */
export function accessForApp(access, sport) {
  if (!access || sport !== 'beach') return access
  const own = sportFlags(normalizeRoles(access.roles), !!access.isAdmin, 'beach')
  return { ...own, isAdmin: !!access.isAdmin, isSuperAdmin: !!access.isSuperAdmin, known: access.known }
}

/** Access of a signed-out device: nothing, and not "pending" either. */
export const NO_ACCESS = Object.freeze({
  roles: [],
  isAdmin: false,
  isSuperAdmin: false,
  canScore: false,
  canManageTeams: false,
  canReadTeams: false,
  isPending: false,
  known: false
})

/** Did anything that changes what the account may do change? */
export function accessChanged(a, b) {
  if (!a || !b) return a !== b
  return a.isAdmin !== b.isAdmin || a.canScore !== b.canScore || a.canManageTeams !== b.canManageTeams ||
    a.canReadTeams !== b.canReadTeams || a.isPending !== b.isPending
}

export const ACCESS_CHANGED_EVENT = 'ov-access-changed'
