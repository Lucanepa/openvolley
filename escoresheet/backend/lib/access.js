/**
 * access — what an account may do, from public.profiles.roles (never from the
 * request). The top-level flags are identical in frontend/src/lib/access.js
 * (docs/scorer-accounts-spec.md section 1):
 *
 *   isAdmin        roles include 'admin' or 'super_admin'
 *   isSuperAdmin   roles include 'super_admin'
 *   canScore       isAdmin or 'scorer'                (may write NON-test indoor matches)
 *   canManageTeams isAdmin or 'competition_manager'   (indoor saved teams: write)
 *   canReadTeams   canScore or canManageTeams         (indoor saved teams: read)
 *   isPending      no indoor role and not an admin    (new accounts)
 *
 * Sports (OpenVolley = 'indoor', OpenBeach = 'beach'; db/012 and
 * ~/ov-ops/openbeach-separation-tournaments-PLAN.md 1.3): one login, roles per
 * sport. The beach roles carry a prefix ('beach:scorer', 'beach:referee',
 * 'beach:competition_manager'); the global admin counts for both sports.
 * `apps.indoor` / `apps.beach` (and forSport(sport)) hold the flags of one
 * sport. The top-level flags keep meaning indoor, so OpenVolley 2.1/2.2
 * clients behave as before (a beach-only account is pending for them).
 *
 * The sport is always the sport of the ROW being written (a match, a saved
 * team's competition, an invite code), never what the calling app says it is.
 * Unknown role values are kept but grant nothing.
 */

export const SPORTS = Object.freeze(['indoor', 'beach'])
export const ADMIN_ROLES = Object.freeze(['admin', 'super_admin'])
// The roles of each sport, by their plain name
export const SPORT_ROLES = Object.freeze({
  indoor: Object.freeze({ scorer: 'scorer', referee: 'referee', competition_manager: 'competition_manager' }),
  beach: Object.freeze({ scorer: 'beach:scorer', referee: 'beach:referee', competition_manager: 'beach:competition_manager' })
})
export const INDOOR_ROLES = Object.freeze(Object.values(SPORT_ROLES.indoor))
export const BEACH_ROLES = Object.freeze(Object.values(SPORT_ROLES.beach))
export const KNOWN_ROLES = Object.freeze([...INDOOR_ROLES, ...ADMIN_ROLES, ...BEACH_ROLES])
// Roles an admin may add or remove through POST /api/admin/accounts/:id/roles
// (super_admin is SQL only).
export const API_GRANTABLE_ROLES = Object.freeze([...INDOOR_ROLES, 'admin', ...BEACH_ROLES])

/** 'beach' or 'indoor' (anything else, NULL included, counts as indoor, like db/007's index). */
export function sportOf (value) {
  return value === 'beach' ? 'beach' : 'indoor'
}

/** The sport a role belongs to: 'indoor', 'beach', or null (admin roles and unknown values). */
export function sportOfRole (role) {
  if (BEACH_ROLES.includes(role)) return 'beach'
  if (INDOOR_ROLES.includes(role)) return 'indoor'
  return null
}

/** The role name of plain `role` ('scorer', ...) in `sport`, or null. */
export function roleFor (sport, role) {
  return SPORT_ROLES[sport]?.[role] ?? null
}

/**
 * profiles.roles as a list of normalised strings. Accepts a text[] (pg array),
 * a JSON array string, a Postgres array literal ('{a,b}') or nothing.
 */
export function normalizeRoles (raw) {
  let roles = raw
  if (typeof roles === 'string') {
    try { roles = JSON.parse(roles) } catch { roles = roles.replace(/^\{|\}$/g, '').split(',') }
  }
  if (!Array.isArray(roles)) return []
  const out = []
  for (const r of roles) {
    if (r == null) continue
    const v = String(r).trim().replace(/^"|"$/g, '').trim().toLowerCase()
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

/** The flags of one sport: { roles, canScore, canManageTeams, canReadTeams, isPending }. */
function sportFlags (roles, isAdmin, sport) {
  const own = Object.values(SPORT_ROLES[sport])
  const canScore = isAdmin || roles.includes(SPORT_ROLES[sport].scorer)
  const canManageTeams = isAdmin || roles.includes(SPORT_ROLES[sport].competition_manager)
  return {
    roles: roles.filter((r) => own.includes(r)),
    canScore,
    canManageTeams,
    canReadTeams: canScore || canManageTeams,
    isPending: !isAdmin && !own.some((r) => roles.includes(r))
  }
}

/** The access flags of a role list (raw or normalised). */
export function accessFromRoles (raw) {
  const roles = normalizeRoles(raw)
  const has = (r) => roles.includes(r)
  const isAdmin = ADMIN_ROLES.some(has)
  const apps = { indoor: sportFlags(roles, isAdmin, 'indoor'), beach: sportFlags(roles, isAdmin, 'beach') }
  const access = {
    roles,
    isAdmin,
    isSuperAdmin: has('super_admin'),
    canScore: apps.indoor.canScore,
    canManageTeams: apps.indoor.canManageTeams,
    canReadTeams: apps.indoor.canReadTeams,
    isPending: apps.indoor.isPending,
    apps
  }
  // Not enumerable: comparisons and the JSON of the flags stay plain data
  Object.defineProperty(access, 'forSport', { value: (sport) => apps[sportOf(sport)], enumerable: false })
  return access
}

/** The flags of `sport` in an access object (also a hand-made one without `apps`: indoor flags only, beach for admins). */
export function accessForSport (access, sport) {
  const s = sportOf(sport)
  const own = access?.apps?.[s]
  if (own) return own
  const admin = !!access?.isAdmin
  return s === 'indoor'
    ? { roles: [], canScore: !!access?.canScore, canManageTeams: !!access?.canManageTeams, canReadTeams: !!access?.canReadTeams, isPending: !!access?.isPending }
    : { roles: [], canScore: admin, canManageTeams: admin, canReadTeams: admin, isPending: !admin }
}

/** The sports in which `access` has `flag` (canScore, canManageTeams, canReadTeams). */
export function sportsWith (access, flag) {
  return SPORTS.filter((s) => accessForSport(access, s)[flag] === true)
}

/**
 * Per-process cache of each account's access (one backend process today).
 * get() THROWS on a database error: callers answer 503, never "not a scorer".
 * A missing profile row is a pending account.
 */
export function createAccessResolver ({ pool, ttlMs = 30000, maxEntries = 5000, now = () => Date.now() } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new Error('createAccessResolver: pool is required')
  const cache = new Map() // userId -> { at, access }
  return {
    async get (userId) {
      const id = String(userId || '')
      const hit = cache.get(id)
      if (hit && now() - hit.at < ttlMs) return hit.access
      const { rows } = await pool.query('SELECT roles FROM public.profiles WHERE user_id = $1 LIMIT 1', [id])
      const access = accessFromRoles(rows[0]?.roles)
      if (cache.size >= maxEntries) cache.clear()
      cache.set(id, { at: now(), access })
      return access
    },
    invalidate (userId) { cache.delete(String(userId || '')) },
    clear () { cache.clear() },
    get size () { return cache.size }
  }
}
