/**
 * access — what an account may do, from public.profiles.roles (never from the
 * request). Shared definitions, identical in frontend/src/lib/access.js
 * (docs/scorer-accounts-spec.md section 1):
 *
 *   isAdmin        roles include 'admin' or 'super_admin'
 *   isSuperAdmin   roles include 'super_admin'
 *   canScore       isAdmin or 'scorer'                (may write NON-test matches)
 *   canManageTeams isAdmin or 'competition_manager'   (saved teams: write)
 *   canReadTeams   canScore or canManageTeams         (saved teams: read)
 *   isPending      no recognised role at all          (new accounts)
 *
 * Unknown role values are kept but grant nothing.
 */

export const ADMIN_ROLES = Object.freeze(['admin', 'super_admin'])
export const KNOWN_ROLES = Object.freeze(['scorer', 'referee', 'competition_manager', 'admin', 'super_admin'])
// Roles an admin may add or remove through POST /api/admin/accounts/:id/roles
// (super_admin is SQL only).
export const API_GRANTABLE_ROLES = Object.freeze(['scorer', 'referee', 'competition_manager', 'admin'])

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

/** The access flags of a role list (raw or normalised). */
export function accessFromRoles (raw) {
  const roles = normalizeRoles(raw)
  const has = (r) => roles.includes(r)
  const isAdmin = ADMIN_ROLES.some(has)
  const canScore = isAdmin || has('scorer')
  const canManageTeams = isAdmin || has('competition_manager')
  return {
    roles,
    isAdmin,
    isSuperAdmin: has('super_admin'),
    canScore,
    canManageTeams,
    canReadTeams: canScore || canManageTeams,
    isPending: !roles.some((r) => KNOWN_ROLES.includes(r))
  }
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
