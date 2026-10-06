/**
 * Offline cache of the saved teams (spec 6.6). One online load of
 * GET /api/saved-teams fills two Dexie tables, so MatchSetup's "Load saved
 * team" and the schedule suggestions work without a connection afterwards.
 *
 * The rows hold personal data (DOB, licence number): they are only for the
 * account that loaded them (meta.userId) and are cleared on sign-out and
 * account switch (AuthContext).
 *
 * Indoor only (docs/beach-saved-teams-spec.md 3.3): beach teams are
 * OpenBeach's. storeSavedTeamsBundle drops every beach competition and team,
 * whatever the caller fetched, so MatchSetup and its modals never see one.
 */

import { db } from './db'
import { savedTeamsApi } from '../lib/accountApi'
import { accessFromRoles } from '../lib/access'
import { bundleForSport, normalizeName, sportOf } from '../domain/savedTeams'

export const SAVED_TEAMS_MAX_AGE_MS = 10 * 60 * 1000
export const SAVED_TEAMS_CHANGED_EVENT = 'ov-saved-teams-changed'
const META_KEY = 'bundle'

function readJson(key) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/** The signed-in account id on this device (from the stored session), or null. */
export function currentUserId() {
  const session = readJson('api_auth_token')
  return session?.user?.id ?? null
}

function currentAccess() {
  return accessFromRoles(readJson('cachedProfile')?.roles ?? [])
}

function isOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

function notify() {
  try { window.dispatchEvent(new Event(SAVED_TEAMS_CHANGED_EVENT)) } catch { /* no window */ }
}

/** API bundle → the cache's competition objects (every one, also those without teams yet). */
export function bundleCompetitions(bundle) {
  return (bundle?.competitions || []).filter(c => c && c.id).map(c => ({
    id: c.id,
    name: c.name || '',
    season: c.season || '',
    gender: c.gender ?? null,
    category: c.category ?? null,
    vmLeagues: Array.isArray(c.vm_leagues) ? c.vm_leagues : [],
    archived: !!c.archived,
    sport: sportOf(c)
  }))
}

/** API bundle → cache rows (camelCase, with the competition embedded). */
export function bundleToRows(bundle) {
  const competitions = new Map(bundleCompetitions(bundle).map(c => [c.id, c]))
  return (bundle?.teams || []).map(t => ({
    id: t.id,
    competitionId: t.competition_id,
    competition: competitions.get(t.competition_id) || null,
    name: t.name || '',
    shortName: t.short_name || '',
    club: t.club || '',
    color: t.color || '',
    svrzTeamName: t.svrz_team_name || '',
    nameKey: normalizeName(t.name),
    svrzKey: normalizeName(t.svrz_team_name),
    players: Array.isArray(t.players) ? t.players : [],
    staff: Array.isArray(t.staff) ? t.staff : [],
    updatedAt: t.updated_at || null
  }))
}

/**
 * The cached competitions (for pickers): the bundle's list kept in the meta
 * row, so a competition without teams can still take its first team; plus
 * any competition embedded in a team row (a cache written before the list
 * was kept).
 */
export function competitionsOf(rows, meta = null) {
  const map = new Map()
  for (const c of Array.isArray(meta?.competitions) ? meta.competitions : []) if (c?.id && !map.has(c.id)) map.set(c.id, c)
  for (const row of rows || []) if (row.competition && !map.has(row.competition.id)) map.set(row.competition.id, row.competition)
  return [...map.values()]
}

export async function getSavedTeamsMeta() {
  try {
    return (await db.saved_teams_meta.get(META_KEY)) || null
  } catch {
    return null
  }
}

/**
 * Every cached saved team of the signed-in account; [] when the cache belongs
 * to another account (or there is none).
 */
export async function getSavedTeams({ userId = currentUserId() } = {}) {
  try {
    const meta = await db.saved_teams_meta.get(META_KEY)
    if (!meta || !userId || meta.userId !== userId) return []
    return (await db.saved_teams.toArray()).filter(row => sportOf(row.competition) !== 'beach')
  } catch {
    return []
  }
}

export async function clearSavedTeams() {
  try {
    await db.transaction('rw', db.saved_teams, db.saved_teams_meta, async () => {
      await db.saved_teams.clear()
      await db.saved_teams_meta.clear()
    })
    notify()
  } catch (e) {
    console.warn('[savedTeams] clear failed:', e?.message)
  }
}

/** Replace the cache with a bundle (also used after a write that returned data). */
export async function storeSavedTeamsBundle(bundle, userId) {
  bundle = bundleForSport(bundle, 'indoor') // the single guarantee: no beach team in this cache
  const rows = bundleToRows(bundle)
  await db.transaction('rw', db.saved_teams, db.saved_teams_meta, async () => {
    await db.saved_teams.clear()
    if (rows.length) await db.saved_teams.bulkPut(rows)
    await db.saved_teams_meta.put({
      key: META_KEY,
      version: String(bundle?.version ?? '0'),
      fetchedAt: bundle?.fetched_at || new Date().toISOString(),
      userId,
      competitions: bundleCompetitions(bundle)
    })
  })
  notify()
  return rows
}

/**
 * Load the saved teams from the server into the cache.
 * @param {{force?: boolean, access?: object, userId?: string|null, online?: boolean}} [opts]
 * @returns {Promise<{status: 'refreshed'|'fresh'|'skipped'|'offline'|'forbidden'|'error', teams: object[]}>}
 */
export async function refreshSavedTeams({ force = false, access, userId, online } = {}) {
  const uid = userId === undefined ? currentUserId() : userId
  const acc = access || currentAccess()
  if (!uid || !acc.canReadTeams) return { status: 'skipped', teams: await getSavedTeams({ userId: uid }) }
  if (!(online ?? isOnline())) return { status: 'offline', teams: await getSavedTeams({ userId: uid }) }

  if (!force) {
    const meta = await getSavedTeamsMeta()
    const age = meta?.fetchedAt ? Date.now() - Date.parse(meta.fetchedAt) : Infinity
    if (meta && meta.userId === uid && age >= 0 && age < SAVED_TEAMS_MAX_AGE_MS) {
      return { status: 'fresh', teams: await getSavedTeams({ userId: uid }) }
    }
  }

  const { data, error, status } = await savedTeamsApi.fetchBundle({ sport: 'indoor' })
  if (error) {
    if (status === 403 || status === 401) {
      await clearSavedTeams()
      return { status: 'forbidden', teams: [] }
    }
    return { status: error.network || status === 0 ? 'offline' : 'error', teams: await getSavedTeams({ userId: uid }) }
  }
  try {
    const teams = await storeSavedTeamsBundle(data, uid)
    return { status: 'refreshed', teams }
  } catch (e) {
    console.warn('[savedTeams] cache write failed:', e?.message)
    return { status: 'error', teams: await getSavedTeams({ userId: uid }) }
  }
}
