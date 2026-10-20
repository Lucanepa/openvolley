/**
 * The active scoring device of a match (db/019): the scoring-device handover.
 *
 * A match is scored on ONE device at a time. The apps name their installation
 * (frontend utils/deviceId.js, a random uuid) in the body of their writes:
 * `device: { id, platform }` next to table/action/params on /api/db and on
 * /api/match/restore and /api/match/event-revisions (the device sending
 * them: a revision's own device_id is the one that made it). A body field, not a header: an older backend
 * ignores it, while a new header would fail its CORS preflight and cut every
 * new app off from an old backend.
 *
 *   check()  before a write: another device scores one of the written
 *            matches -> the server answers 409 OV_SCORER_MOVED with the
 *            scorer's platform and the time of its take-over (never its id).
 *   adopt()  after a write that found no scorer: the writing device becomes
 *            it (the first device that writes a match scores it).
 *   movedSince()  before a backup restore: a restore made before another
 *            device took the match over is refused the same way.
 *   claim()  POST /api/match/scorer: "continue on this device" (a restore by
 *            game PIN, a backup restore) and "Take back scoring here". The
 *            device becomes the scorer whoever it was; server.js then tells
 *            the previous one over the relay (scorer-moved).
 *
 * A write that names no device (an app from before the handover) is neither
 * checked nor recorded. Test matches and closed matches are never checked:
 * a test match is shared freely, a closed one refuses every write anyway
 * (db/007, 409 OV_MATCH_CLOSED says more than "moved").
 *
 * Never in the way of a match day: a missing table (a database without 019)
 * or a failing query lets the write through (server.js logs it); the device a
 * scorer explicitly takes back always wins.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PLATFORM_RE = /^[a-z0-9-]{1,24}$/
const MAX_REFS = 50
// The oldest restore movedSince() still dates (an app offline for weeks)
const MAX_RESTORE_AGE_MS = 30 * 24 * 60 * 60 * 1000

// The tables whose writes score a match. user_matches ("My Matches") and the
// storage uploads are not scoring.
export const SCORER_TABLES = Object.freeze(['matches', 'sets', 'events', 'match_live_state'])

/**
 * The device a request names: `{ id, platform }` or a bare id string; null
 * when there is none or it is malformed (then the write is not checked).
 * @returns {{ id: string, platform: string|null }|null}
 */
export function deviceOf (raw) {
  const id = typeof raw === 'string' ? raw : (raw && typeof raw === 'object' ? raw.id : null)
  if (typeof id !== 'string' || !UUID_RE.test(id)) return null
  const p = raw && typeof raw === 'object' && typeof raw.platform === 'string' ? raw.platform.toLowerCase() : null
  return { id: id.toLowerCase(), platform: p && PLATFORM_RE.test(p) ? p : null }
}

// The match key of a set/event external_id (`${seedKey}:s:${id}` /
// `${seedKey}:e:${id}`, frontend utils/syncIds); null for a bare id.
function seedOfChildExt (ext) {
  if (typeof ext !== 'string') return null
  const i = Math.max(ext.lastIndexOf(':s:'), ext.lastIndexOf(':e:'))
  return i > 0 ? ext.slice(0, i) : null
}

/**
 * The matches a /api/db write touches, as far as the request names them:
 * external_ids (matches rows; the seed key of a namespaced set/event id) and
 * match uuids (matches.id, a child's match_id). Best effort: what it cannot
 * name is not checked (pgQuery's ownership rules still apply).
 * @returns {{ externalIds: string[], ids: string[] }}
 */
export function matchRefsOfWrite (table, action, params) {
  const ext = new Set()
  const ids = new Set()
  const addExt = (v) => { if (typeof v === 'string' && v && v.length <= 200) ext.add(v) }
  const addId = (v) => { if (typeof v === 'string' && UUID_RE.test(v)) ids.add(v.toLowerCase()) }
  const isParent = table === 'matches'
  const rows = params?.data == null ? [] : (Array.isArray(params.data) ? params.data : [params.data])
  for (const r of rows.slice(0, MAX_REFS)) {
    if (!r || typeof r !== 'object') continue
    if (isParent) {
      addExt(r.external_id)
      addId(r.id)
    } else {
      addId(r.match_id)
      if (table !== 'match_live_state') addExt(seedOfChildExt(r.external_id))
    }
  }
  if (action === 'update' || action === 'delete') {
    for (const f of Array.isArray(params?.filters) ? params.filters : []) {
      if (!f || typeof f !== 'object' || (f.type !== 'eq' && f.type !== 'in')) continue
      const values = f.type === 'in' ? (Array.isArray(f.value) ? f.value.slice(0, MAX_REFS) : []) : [f.value]
      for (const v of values) {
        if (isParent && f.column === 'external_id') addExt(v)
        else if (isParent && f.column === 'id') addId(v)
        else if (!isParent && f.column === 'match_id') addId(v)
        else if (!isParent && f.column === 'external_id') addExt(seedOfChildExt(v))
      }
    }
  }
  return { externalIds: [...ext], ids: [...ids] }
}

const hasRefs = (refs) => !!refs && ((refs.externalIds?.length || 0) + (refs.ids?.length || 0)) > 0

// A database without db/019: no scorer is recorded, nothing is refused
const isMissingTable = (err) => err?.code === '42P01'

/** The scorer as the other device may see it: platform and take-over time only. */
export function publicScorer (row) {
  if (!row) return null
  return {
    platform: row.platform || null,
    at: row.claimed_at instanceof Date ? row.claimed_at.toISOString() : (row.claimed_at || null)
  }
}

/** The 409 body of a write by a device that no longer scores the match. */
export function scorerMovedBody (holder) {
  return {
    data: null,
    error: {
      message: 'This match is now scored on another device.',
      code: 'OV_SCORER_MOVED',
      scorer: publicScorer(holder),
      match_external_id: holder?.external_id || null
    }
  }
}

/**
 * @param {{ pool: {query: Function}, db?: { withTransaction: Function, assertMatchWritable: Function },
 *   audit?: Function }} deps  audit: accounts.audit(clientOrPool, entry)
 */
export function createScorerDevices ({ pool, db = null, audit = null } = {}) {
  /**
   * Before a write by `device`: who scores the matches it names.
   * @returns {Promise<{ moved: object|null, unclaimed: boolean }>} moved: the
   *   scorer row (another device); unclaimed: none of the open, non-test
   *   matches has a scorer yet (adopt() after the write).
   */
  async function check ({ device, refs }) {
    if (!device || !hasRefs(refs)) return { moved: null, unclaimed: false }
    let rows
    try {
      ;({ rows } = await pool.query(
        `SELECT m.external_id, s.device_id, s.platform, s.claimed_at
           FROM public.matches m
           LEFT JOIN public.match_scorer_devices s ON s.match_id = m.id
          WHERE (m.id = ANY($1::uuid[]) OR m.external_id = ANY($2::text[]))
            AND m.closed_at IS NULL AND m.test IS NOT TRUE`,
        [refs.ids || [], refs.externalIds || []]))
    } catch (err) {
      if (isMissingTable(err)) return { moved: null, unclaimed: false }
      throw err
    }
    const moved = rows.find((r) => r.device_id && r.device_id !== device.id) || null
    // No stored match yet (an insert): adopt it after the write as well
    const unclaimed = rows.length === 0 || rows.some((r) => !r.device_id)
    return { moved, unclaimed }
  }

  /**
   * After a successful write that found no scorer: the writing device scores
   * the open, non-test matches it named that have none (a concurrent claim
   * wins: ON CONFLICT DO NOTHING). Never throws.
   */
  async function adopt ({ device, refs, userId = null }) {
    if (!device || !hasRefs(refs)) return 0
    try {
      const r = await pool.query(
        `INSERT INTO public.match_scorer_devices (match_id, device_id, platform, claimed_by)
         SELECT m.id, $3, $4, $5::uuid
           FROM public.matches m
          WHERE (m.id = ANY($1::uuid[]) OR m.external_id = ANY($2::text[]))
            AND m.closed_at IS NULL AND m.test IS NOT TRUE
         ON CONFLICT (match_id) DO NOTHING`,
        [refs.ids || [], refs.externalIds || [], device.id, device.platform, UUID_RE.test(String(userId)) ? userId : null])
      return r.rowCount || 0
    } catch (err) {
      if (!isMissingTable(err)) console.warn('[scorer] adopt failed:', err?.message)
      return 0
    }
  }

  /**
   * POST /api/match/scorer { external_id, device: { id, platform }, claim }.
   * claim true: `device` becomes the match's scorer (the creator, an editor or
   * an admin of the match only: pgQuery assertMatchWritable). claim false:
   * whether `device` is the scorer.
   * 200 { external_id, mine, scorer, previous?, moved? }; moved: another
   * device scored it until now (server.js tells it). 409 OV_MATCH_CLOSED for
   * a closed match (nothing left to score), 400 without a device.
   */
  async function claim ({ body, matchOwner, userId }) {
    const externalId = typeof body?.external_id === 'string' ? body.external_id : ''
    if (!externalId || externalId.length > 200) return fail(400, 'OV_INVALID_REQUEST', 'external_id is required')
    const device = deviceOf(body?.device)
    if (!device) return fail(400, 'OV_INVALID_REQUEST', 'device.id must be a uuid')
    const wantClaim = body?.claim !== false
    if (!db?.withTransaction || !db?.assertMatchWritable) return fail(503, 'OV_DB_UNAVAILABLE', 'Service unavailable')
    try {
      return await db.withTransaction(async (client) => {
        const match = await db.assertMatchWritable(client, externalId, matchOwner)
        const { rows: [held] } = await client.query(
          'SELECT device_id, platform, claimed_at FROM public.match_scorer_devices WHERE match_id = $1 FOR UPDATE', [match.id])
        const mine = !!held && held.device_id === device.id
        if (!wantClaim) {
          return ok({ external_id: match.external_id, mine: held ? mine : null, closed: match.closed, scorer: publicScorer(held) })
        }
        if (match.closed) return fail(409, 'OV_MATCH_CLOSED', 'This match is closed')
        if (mine) return ok({ external_id: match.external_id, mine: true, moved: false, scorer: publicScorer(held), previous: null })
        const { rows: [row] } = await client.query(
          `INSERT INTO public.match_scorer_devices (match_id, device_id, platform, claimed_by, claimed_at)
           VALUES ($1, $2, $3, $4::uuid, now())
           ON CONFLICT (match_id) DO UPDATE
             SET device_id = EXCLUDED.device_id, platform = EXCLUDED.platform,
                 claimed_by = EXCLUDED.claimed_by, claimed_at = EXCLUDED.claimed_at
           RETURNING device_id, platform, claimed_at`,
          [match.id, device.id, device.platform, UUID_RE.test(String(userId)) ? userId : null])
        if (audit && held) {
          await audit(client, {
            actorId: userId,
            action: 'match.scorer_device',
            matchId: match.id,
            details: { external_id: match.external_id, platform: device.platform, previous_platform: held.platform || null }
          })
        }
        return ok({
          external_id: match.external_id,
          mine: true,
          moved: !!held,
          scorer: publicScorer(row),
          previous: held ? publicScorer(held) : null
        })
      })
    } catch (err) {
      if (isMissingTable(err)) return fail(503, 'OV_SCORER_UNAVAILABLE', 'Scoring-device handover is not available on this server (db/019 missing)')
      if (err && typeof err.status === 'number' && typeof err.code === 'string') {
        return fail(err.status, err.code, err.message || 'Request refused')
      }
      throw err
    }
  }

  /**
   * Before a backup restore by `device` (POST /api/match/restore, which
   * then takes the match over for it): the restore was made `ageMs` ago (the
   * app's own clock, so no clock skew), and another device that took the
   * match over AFTER that keeps it. A restore queued on a device the scorer
   * left (offline, sent late) must not replace the other device's score; a
   * restore made after the other device took over is this device taking it
   * back on purpose. Open, non-test matches only.
   * @returns {Promise<object|null>} the scorer row that keeps the match
   */
  async function movedSince ({ device, externalId, ageMs }) {
    if (!device || typeof externalId !== 'string' || !externalId || externalId.length > 200) return null
    const age = Number(ageMs)
    if (!Number.isFinite(age) || age <= 0) return null
    try {
      const { rows } = await pool.query(
        `SELECT m.external_id, s.device_id, s.platform, s.claimed_at
           FROM public.matches m
           JOIN public.match_scorer_devices s ON s.match_id = m.id
          WHERE m.external_id = $1 AND m.closed_at IS NULL AND m.test IS NOT TRUE
            AND s.device_id <> $2
            AND s.claimed_at > now() - ($3::bigint * interval '1 millisecond')`,
        [externalId, device.id, Math.min(Math.floor(age), MAX_RESTORE_AGE_MS)])
      return rows[0] || null
    } catch (err) {
      if (isMissingTable(err)) return null
      throw err
    }
  }

  return { check, adopt, claim, movedSince }
}

function ok (data) {
  return { status: 200, body: { data, error: null } }
}

function fail (status, code, message) {
  return { status, body: { data: null, error: { message, code } } }
}
