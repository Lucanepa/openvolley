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
 *   guardedWrite()  an /api/db write and its check in ONE transaction:
 *            the scorer rows of the matches the request names are locked
 *            first (FOR SHARE), a device other than the stored one is
 *            refused (409 OV_SCORER_MOVED with the scorer's platform and the
 *            time of its take-over, never its id), the write runs, and the
 *            matches whose rows it wrote are adopted (none scored yet: the
 *            first device that writes a match scores it) and checked once
 *            more. A take-over locks the same row FOR UPDATE, so a write of
 *            the device a match leaves is either committed before the
 *            take-over (and in what the new device reads) or refused.
 *   lockedHolder()  the same check inside another write's transaction (the
 *            event history).
 *   movedSince()  inside a backup restore's transaction: a restore made
 *            before another device took the match over is refused the same
 *            way.
 *   check()  the same question without a lock, for the relay (its room sync
 *            writes nothing to the database).
 *   claim()  POST /api/match/scorer: "continue on this device" (a restore by
 *            game PIN, a backup restore) and "Take back scoring here". The
 *            device becomes the scorer whoever it was; server.js then tells
 *            the previous one over the relay (scorer-moved).
 *   claimProved()  the same take-over, authorised by the game PIN the caller
 *            has just proved (POST /api/match/restore-by-pin with claim):
 *            no session needed, so a signed-out device that continues a
 *            match scores it at once, and before the match is read for it.
 *
 * Lock order, everywhere: the scorer row first, then the match. A take-over
 * locks its scorer row before it reads the match; a write locks the scorer
 * rows of the matches it names before its statement takes the match's row
 * locks. In the other order a match update of the old device and a take-over
 * would wait for each other.
 *
 * Which matches a write touches is decided by the rows it wrote (their
 * match_id), never by what the request names: a filter that matches nothing,
 * an update without columns or a child id that names another match adopts
 * nothing. A caller that may not write a match is never told who scores it:
 * the write goes on to pgQuery's own refusal.
 *
 * A write that names no device (an app from before the handover) is neither
 * checked nor recorded. Test matches and closed matches are never checked:
 * a test match is shared freely, a closed one refuses every write anyway
 * (db/007, 409 OV_MATCH_CLOSED says more than "moved").
 *
 * A failing check fails the write (5xx, the app keeps the job and sends it
 * again): a write let through unchecked is the one the new device never
 * gets. The device a scorer explicitly takes back always wins.
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

/**
 * The matches a /api/db write names: external_ids and uuids of matches rows
 * (data and eq/in filters on external_id / id), and the match_id of a set,
 * event or live state row (data and filters). Never a match parsed from a
 * child's external_id: pgQuery decides which match a child row belongs to,
 * and the check follows the rows written (guardedWrite). Best effort: what
 * it cannot name is checked after the write.
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
      }
    }
  }
  return { externalIds: [...ext], ids: [...ids] }
}

/** The matches whose rows a write wrote: matches.id, a child's match_id (pgQuery `changes`). */
export function writtenMatchIds (table, changes) {
  const ids = new Set()
  for (const c of Array.isArray(changes) ? changes : []) {
    const v = table === 'matches' ? c?.row?.id : c?.row?.match_id
    if (typeof v === 'string' && UUID_RE.test(v)) ids.add(v.toLowerCase())
  }
  return [...ids]
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

// A write refused after its statement ran: withTransaction rolls it back
class Rollback extends Error {
  constructor (out) {
    super('rolled back')
    this.out = out
  }
}

// The scorer rows of the matches `where` selects, in match order (the order
// FOR SHARE locks them in); `more`: extra columns.
const SCORER_ROWS_SQL = (where, more = '') =>
  `SELECT s.match_id::text AS match_id, m.external_id, s.device_id, s.platform, s.claimed_at${more}
     FROM public.match_scorer_devices s
     JOIN public.matches m ON m.id = s.match_id
    WHERE ${where}
    ORDER BY s.match_id`

/**
 * @param {{ pool: {query: Function}, db?: { withTransaction: Function, assertMatchWritable: Function,
 *   toErrorResult?: Function }, audit?: Function }} deps  audit: accounts.audit(clientOrPool, entry)
 */
export function createScorerDevices ({ pool, db = null, audit = null } = {}) {
  /**
   * Who scores the matches `refs` names, without a lock: the relay's room
   * sync, which writes nothing to the database. A write checks inside its
   * own transaction (guardedWrite, lockedHolder).
   * @returns {Promise<{ moved: object|null, unclaimed: boolean, mine: boolean }>}
   *   moved: the scorer row (another device); unclaimed: none of the open,
   *   non-test matches has a scorer yet; mine: the device is the stored
   *   scorer of every one of them (at least one).
   */
  async function check ({ device, refs }) {
    if (!device || !hasRefs(refs)) return { moved: null, unclaimed: false, mine: false }
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
      if (isMissingTable(err)) return { moved: null, unclaimed: false, mine: false }
      throw err
    }
    const moved = rows.find((r) => r.device_id && r.device_id !== device.id) || null
    const unclaimed = rows.length === 0 || rows.some((r) => !r.device_id)
    const mine = rows.length > 0 && rows.every((r) => r.device_id === device.id)
    return { moved, unclaimed, mine }
  }

  /** May matchOwner write the match `externalId`? (pgQuery's rule; the caller's transaction) */
  async function mayWrite (client, externalId, matchOwner) {
    if (!matchOwner || !db?.assertMatchWritable) return true
    try {
      await db.assertMatchWritable(client, externalId, matchOwner)
      return true
    } catch (err) {
      if (err && (err.status === 403 || err.status === 404)) return false
      throw err
    }
  }

  /**
   * Inside the caller's transaction: lock the scorer rows of the open,
   * non-test matches `refs` names (FOR SHARE: a take-over waits for this
   * transaction to end, and this one for a take-over in flight) and return
   * the first one another device holds, of a match matchOwner may write (a
   * caller that may not is never told who scores a match: pgQuery refuses
   * its write). `ageMs` (a backup restore made that long ago): only a scorer
   * that took the match over after it (movedSince). null: nothing in the way.
   * Throws on a database error (the caller's write fails with it).
   */
  async function lockedHolder (client, { device, refs, matchOwner = null, ageMs = null }) {
    if (!device || !hasRefs(refs)) return null
    const age = ageMs == null ? null : Math.min(Math.max(Math.floor(Number(ageMs)) || 0, 0), MAX_RESTORE_AGE_MS)
    const { rows } = await client.query(
      `${SCORER_ROWS_SQL('(m.id = ANY($1::uuid[]) OR m.external_id = ANY($2::text[])) AND m.closed_at IS NULL AND m.test IS NOT TRUE',
        ", ($3::bigint IS NULL OR s.claimed_at > now() - ($3::bigint * interval '1 millisecond')) AS in_time")} FOR SHARE OF s`,
      [refs.ids || [], refs.externalIds || [], age])
    for (const r of rows) {
      if (r.device_id === device.id || !r.in_time) continue
      if (await mayWrite(client, r.external_id, matchOwner)) return r
    }
    return null
  }

  /**
   * An /api/db write of `device` and its scorer check in ONE transaction.
   * `write(client)`: the pgQuery runQuery of the request in that
   * transaction. Before it: lockedHolder for the matches the request names
   * (also the state before the write: a write that closes a match is checked
   * while it is still open). After a 200: the open, non-test matches whose
   * rows it wrote and that have no scorer get this device (not for a
   * delete), and the scorer rows of every match it wrote are locked and
   * compared once more (a take-over that the first check could not see: a
   * match the request did not name, a scorer row inserted meanwhile).
   * A refused or failed write is rolled back.
   * @returns {Promise<{ moved: object|null, result: object|null }>} moved:
   *   the scorer row that keeps the match (answer 409 scorerMovedBody), else
   *   result: the write's runQuery answer (a database error as its 5xx)
   */
  async function guardedWrite ({ device, refs, table, action, matchOwner = null, userId = null, write }) {
    try {
      return await db.withTransaction(async (client) => {
        const named = await lockedHolder(client, { device, refs, matchOwner })
        if (named) return { moved: named, result: null }
        const result = await write(client)
        if (result.status !== 200) throw new Rollback({ moved: null, result })
        const ids = writtenMatchIds(table, result.changes)
        if (ids.length) {
          if (action !== 'delete') {
            await client.query(
              `INSERT INTO public.match_scorer_devices (match_id, device_id, platform, claimed_by)
               SELECT m.id, $2, $3, $4::uuid
                 FROM public.matches m
                WHERE m.id = ANY($1::uuid[]) AND m.closed_at IS NULL AND m.test IS NOT TRUE
                ORDER BY m.id
               ON CONFLICT (match_id) DO NOTHING`,
              [ids, device.id, device.platform, UUID_RE.test(String(userId)) ? userId : null])
          }
          const { rows } = await client.query(`${SCORER_ROWS_SQL('s.match_id = ANY($1::uuid[]) AND m.test IS NOT TRUE')} FOR SHARE OF s`, [ids])
          const moved = rows.find((r) => r.device_id !== device.id)
          if (moved) throw new Rollback({ moved, result: null })
        }
        return { moved: null, result }
      })
    } catch (err) {
      if (err instanceof Rollback) return err.out
      if (!db.toErrorResult) throw err
      return { moved: null, result: db.toErrorResult(err, { action, table }) }
    }
  }

  /**
   * The scorer row of `matchId` locked FOR UPDATE (a take-over), before the
   * match is: the lock order of the header. Nothing to lock yet: null.
   */
  async function lockForTakeOver (client, matchId) {
    const { rows: [held] } = await client.query(
      'SELECT device_id, platform, claimed_at FROM public.match_scorer_devices WHERE match_id = $1 FOR UPDATE', [matchId])
    return held || null
  }

  /**
   * `device` scores `match` ({ id, external_id }, locked by the caller's
   * transaction) from now on. The previous scorer's row is replaced and the
   * change audited; a device that already scores it changes nothing.
   * @returns {Promise<{ data: object, matchId: string }>} data: the answer of
   *   claim() (mine, moved, scorer, previous); matchId for server.js
   */
  async function takeOver (client, match, device, userId, via = null) {
    const claimedBy = UUID_RE.test(String(userId)) ? userId : null
    let held = await lockForTakeOver(client, match.id)
    if (!held) {
      // None yet. A write that is adopting the match right now holds its new
      // row uncommitted: this insert waits for it and then does nothing, and
      // the row it committed is taken over below like any other.
      const { rows: [row] } = await client.query(
        `INSERT INTO public.match_scorer_devices (match_id, device_id, platform, claimed_by, claimed_at)
         VALUES ($1, $2, $3, $4::uuid, now())
         ON CONFLICT (match_id) DO NOTHING
         RETURNING device_id, platform, claimed_at`,
        [match.id, device.id, device.platform, claimedBy])
      if (row) return { data: { external_id: match.external_id, mine: true, moved: false, scorer: publicScorer(row), previous: null }, matchId: match.id }
      held = await lockForTakeOver(client, match.id)
    }
    if (held && held.device_id === device.id) {
      return { data: { external_id: match.external_id, mine: true, moved: false, scorer: publicScorer(held), previous: null }, matchId: match.id }
    }
    const { rows: [row] } = await client.query(
      `INSERT INTO public.match_scorer_devices (match_id, device_id, platform, claimed_by, claimed_at)
       VALUES ($1, $2, $3, $4::uuid, now())
       ON CONFLICT (match_id) DO UPDATE
         SET device_id = EXCLUDED.device_id, platform = EXCLUDED.platform,
             claimed_by = EXCLUDED.claimed_by, claimed_at = EXCLUDED.claimed_at
       RETURNING device_id, platform, claimed_at`,
      [match.id, device.id, device.platform, claimedBy])
    if (audit && held) {
      await audit(client, {
        actorId: userId,
        action: 'match.scorer_device',
        matchId: match.id,
        details: { external_id: match.external_id, platform: device.platform, previous_platform: held.platform || null, ...(via ? { via } : {}) }
      })
    }
    return {
      data: { external_id: match.external_id, mine: true, moved: !!held, scorer: publicScorer(row), previous: held ? publicScorer(held) : null },
      matchId: match.id
    }
  }

  /**
   * The take-over of a caller who has just proved the match's game PIN
   * (restore-by-pin with claim; `matchId`: the row it found). The game PIN is
   * the match's own secret, the proof the relay asked of a scorer before
   * db/019: no session and no editor role are needed. 2026-10-26: a device
   * that continued a match signed out never got its queued claim through
   * (POST /api/match/scorer needs a session), so the relay refused its syncs
   * as coming from the device the match had left, and the referee and
   * benches froze. Made before the match is read for the caller, so a write
   * of the previous device is either in what it reads or refused (409
   * OV_SCORER_MOVED) - never sent in between and overwritten: the write holds
   * the scorer row FOR SHARE until it commits, this take-over waits for it.
   * A test match is never checked, a closed one has nothing left to score:
   * neither is claimed (null). Never throws for a database without db/019.
   * @returns {Promise<{ data: object, matchId: string }|null>}
   */
  async function claimProved ({ matchId, device, userId = null }) {
    if (!device || !UUID_RE.test(String(matchId)) || !db?.withTransaction) return null
    try {
      return await db.withTransaction(async (client) => {
        await lockForTakeOver(client, matchId)
        const { rows: [match] } = await client.query(
          `SELECT id::text AS id, external_id, closed_at IS NOT NULL AS closed, test IS TRUE AS test
             FROM public.matches WHERE id = $1 FOR SHARE`, [matchId])
        if (!match || match.closed || match.test) return null
        return takeOver(client, match, device, userId, 'game-pin')
      })
    } catch (err) {
      if (isMissingTable(err)) return null
      throw err
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
        // the scorer row before the match (assertMatchWritable locks it): the lock order of the header
        if (wantClaim) {
          await client.query(
            `SELECT 1 FROM public.match_scorer_devices s JOIN public.matches m ON m.id = s.match_id
              WHERE m.external_id = $1 FOR UPDATE OF s`, [externalId])
        }
        const match = await db.assertMatchWritable(client, externalId, matchOwner)
        if (!wantClaim) {
          const { rows: [held] } = await client.query(
            'SELECT device_id, platform, claimed_at FROM public.match_scorer_devices WHERE match_id = $1', [match.id])
          return ok({ external_id: match.external_id, mine: held ? held.device_id === device.id : null, closed: match.closed, scorer: publicScorer(held) })
        }
        if (match.closed) return fail(409, 'OV_MATCH_CLOSED', 'This match is closed')
        const r = await takeOver(client, match, device, userId)
        // matchId: for server.js (the realtime hub's ordering), not in the answer
        return { ...ok(r.data), matchId: r.matchId }
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
   * Inside a backup restore's transaction (POST /api/match/restore by
   * `device`, which then takes the match over for it): the restore was made
   * `ageMs` ago (the app's own clock, so no clock skew), and another device
   * that took the match over AFTER that keeps it. A restore queued on a
   * device the scorer left (offline, sent late) must not replace the other
   * device's score; a restore made after the other device took over is this
   * device taking it back on purpose. Open, non-test matches only; the scorer
   * row stays locked until the restore commits (lockedHolder).
   * @returns {Promise<object|null>} the scorer row that keeps the match
   */
  async function movedSince (client, { device, externalId, ageMs, matchOwner = null }) {
    if (!device || typeof externalId !== 'string' || !externalId || externalId.length > 200) return null
    // no age (made now): nothing to refuse, the scorer row is locked all the same
    const age = Number(ageMs)
    return lockedHolder(client, { device, refs: { externalIds: [externalId], ids: [] }, matchOwner, ageMs: Number.isFinite(age) && age > 0 ? age : 0 })
  }

  return { check, guardedWrite, lockedHolder, claim, claimProved, movedSince }
}

function ok (data) {
  return { status: 200, body: { data, error: null } }
}

function fail (status, code, message) {
  return { status, body: { data: null, error: { message, code } } }
}
