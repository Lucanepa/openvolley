/**
 * The device's self-check on open: run by App at start-up and again when the
 * app comes back after a long time in the background (LONG_HIDDEN_MS).
 *
 * 2026-10-27 (the owner: "whenever it opens it should do a self check etc to
 * avoid duplications"): the owner's desktop app opened straight on the
 * scoring screen of official match 406970, "Online · Connected", as if it
 * were live. That copy had only reached the coin toss on the PC on 20.10; the
 * match was continued and closed on a phone the same day. A device only hears
 * that the server closed a match when a write of its copy is refused
 * (OV_MATCH_CLOSED), and that another device scores it through
 * checkScorerMoved or a refused relay sync. The copy wrote nothing after
 * 20.10, so it looked live for a week. A stale copy reopened like that is how
 * duplicate scoring and duplicate records start.
 *
 * Part 1, local (always, offline too):
 * - Two or more copies of one official match (the same seed_key; older
 *   versions and restores could leave several): the copy furthest on is kept
 *   (most events, then the latest activity). Another copy is removed only
 *   when it holds nothing the kept one lacks: no unsent write of the match
 *   (the jobs carry the match key, not the copy), no event, set score,
 *   signature, approval, remarks, roster, officials or event history beyond
 *   the kept copy's, never the match on the screen. Otherwise it is flagged:
 *   the home screen lists it as a copy with its Remove.
 * - At start-up at most one live match is resumed, the one with the most
 *   recent activity, and none whose last activity is older than
 *   STALE_LIVE_MS: Home offers it with Continue. A scorer whose app restarts
 *   mid-match (minutes or an hour later) is back on the scoring screen at
 *   once, offline too.
 * Part 2, the server (online and signed in only, never blocking for long):
 * - Every open official copy is looked up in ONE read of `matches`. A copy
 *   the server has closed is marked as the sync queue marks a write refused
 *   as closed (useSyncQueue noteMatchClosedOnServer): the closed-copy notice
 *   and dialog take over, and it is never resumed.
 * - The copy about to be resumed (or the open one, back from the background)
 *   is asked about its scoring device (checkScorerMoved): a match another
 *   device scores now shows ScorerMovedModal at once.
 * - The start-up waits for these answers SERVER_CHECK_TIMEOUT_MS at most; a
 *   later answer is still applied (the closed-copy dialog then replaces the
 *   scoring screen). A timeout, an error, no session or no connection leave
 *   the decision to Part 1.
 * Test matches are never asked about on the server.
 */
import { jobMatchKey } from './syncIds'
import { matchGameNumber } from './deviceMatches'
import { isKnownClosedOnServer, isStaleClosedCopy, serverRowClosed } from './matchReopen'
import { wipeMatchEvents } from '../db/eventHistory'
import { apiFrom } from '../lib/apiClient'

// A match plus its breaks never comes near it; a copy left live overnight or
// for days does
export const STALE_LIVE_MS = 12 * 60 * 60 * 1000
// The longest a start-up (or Continue) waits for the server's answers
export const SERVER_CHECK_TIMEOUT_MS = 3000
// Back in the foreground after this long: the check runs again
export const LONG_HIDDEN_MS = 60 * 60 * 1000

// Jobs not sent yet (or in flight): a copy is never removed while one exists
const UNSENT = ['queued', 'sending', 'error', 'failed']
// How far a copy got; a copy that got further holds something
const STATUS_RANK = { live: 1, ended: 2, approved: 3, final: 4 }

/** The match key of a local row (seed_key; older rows used seedKey / externalId). */
export const localMatchKey = (m) => m?.seed_key || m?.seedKey || m?.externalId || m?.external_id || null

/** An official copy the server may have closed: not a test, has its seed_key, not final, not known closed. */
export const isOpenOfficialCopy = (m) => !!m && m.test !== true && !!m.seed_key && m.status !== 'final' && !isKnownClosedOnServer(m)

const timeOf = (v) => {
  const t = typeof v === 'number' ? v : (typeof v === 'string' ? Date.parse(v) : NaN)
  return Number.isFinite(t) ? t : null
}

/**
 * When the match was last worked on (ms): its newest event, else its update
 * or creation time. null when nothing says.
 */
export function lastActivityAt(match, newestEvent) {
  return timeOf(newestEvent?.ts) ?? timeOf(match?.updatedAt) ?? timeOf(match?.createdAt) ?? null
}

// The last event added to a match (the highest id), one row read
const newestEventOf = (database, matchId) => database.events.where('matchId').equals(matchId).last()

const reportItem = (m, extra = {}) => ({ id: m.id, key: localMatchKey(m), gameN: matchGameNumber(m), ...extra })

/** Ids of the open local matches that are one of two or more copies of an official match. */
export function duplicateCopyIds(matches) {
  const byKey = new Map()
  for (const m of matches || []) {
    const key = localMatchKey(m)
    if (!key || m.test === true || m.status === 'final') continue
    byKey.set(key, [...(byKey.get(key) || []), m.id])
  }
  return [...byKey.values()].filter(ids => ids.length > 1).flat()
}

/** Is there another local copy of this official match? (Delete then removes this copy alone.) */
export async function hasOtherLocalCopy(database, match) {
  const key = localMatchKey(match)
  if (!key || match?.test === true) return false
  return (await database.matches.filter(m => m.id !== match.id && m.test !== true && localMatchKey(m) === key).count()) > 0
}

// ---------------------------------------------------------------------------
// Part 1: copies of one official match
// ---------------------------------------------------------------------------

const hasValue = (v) => v != null && v !== '' && v !== false &&
  !(Array.isArray(v) && v.length === 0) && !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)
// Signatures (team, post-game, officials) and the approval, by their fields
const SIGNED = /signature|approv/i
// Lists entered in Match Setup that live on the match row
const LISTS = ['officials', 'bench_home', 'bench_away']

async function contentOf(database, m) {
  const events = await database.events.where('matchId').equals(m.id).toArray()
  const sets = await database.sets.where('matchId').equals(m.id).toArray()
  const history = database.event_history ? await database.event_history.where('matchId').equals(m.id).count() : 0
  const teamIds = [m.homeTeamId, m.awayTeamId].filter(id => id != null)
  const players = teamIds.length ? await database.players.where('teamId').anyOf(teamIds).count() : 0
  const newest = events.reduce((best, e) => (best == null || (timeOf(e.ts) ?? -Infinity) >= (timeOf(best.ts) ?? -Infinity) ? e : best), null)
  return { match: m, events, sets, history, players, activity: lastActivityAt(m, newest) }
}

// An event as two copies of one match both have it (a restore keeps seq and type)
const eventIdentity = (e) => (e.seq != null ? `${e.setIndex ?? ''}|${e.seq}|${e.type}` : `${e.setIndex ?? ''}|${e.ts}|${e.type}`)

/** Does `kept` hold everything `other` holds? */
function covers(kept, other) {
  if (other.history > 0) return false
  const keptEvents = new Set(kept.events.map(eventIdentity))
  if (!other.events.every(e => keptEvents.has(eventIdentity(e)))) return false
  for (const s of other.sets) {
    if (!(s.homePoints > 0 || s.awayPoints > 0 || s.finished || s.startTime)) continue
    const k = kept.sets.find(ks => ks.index === s.index)
    if (!k || (k.homePoints ?? 0) < (s.homePoints ?? 0) || (k.awayPoints ?? 0) < (s.awayPoints ?? 0) || (s.finished && !k.finished)) return false
  }
  const a = other.match
  const b = kept.match
  for (const [field, value] of Object.entries(a)) {
    if (SIGNED.test(field) && hasValue(value) && !hasValue(b[field])) return false
  }
  if (LISTS.some(field => hasValue(a[field]) && !hasValue(b[field]))) return false
  if (hasValue(a.remarks) && a.remarks !== b.remarks) return false
  if ((STATUS_RANK[a.status] ?? 0) > (STATUS_RANK[b.status] ?? 0)) return false
  return other.players <= kept.players
}

// The copy furthest on first: most events, then the latest activity
const furthestFirst = (x, y) =>
  (y.events.length - x.events.length) || ((y.activity ?? -Infinity) - (x.activity ?? -Infinity)) || (y.match.id - x.match.id)

// The copy's rows: its sets and events (with their history), the match, and
// its own team and player rows. A team row another local match still uses
// stays (restores before 92a288da shared one row between matches). Its sync
// jobs are left: they carry the match key, which the kept copy shares.
async function removeCopy(database, m) {
  const tables = [database.matches, database.sets, database.events, database.event_history, database.players, database.teams].filter(Boolean)
  await database.transaction('rw', tables, async () => {
    await wipeMatchEvents(database, m.id, { dropHistory: true })
    await database.sets.where('matchId').equals(m.id).delete()
    await database.matches.delete(m.id)
    for (const teamId of new Set([m.homeTeamId, m.awayTeamId])) {
      if (teamId == null) continue
      if (await database.matches.filter(o => o.homeTeamId === teamId || o.awayTeamId === teamId).count()) continue
      await database.players.where('teamId').equals(teamId).delete()
      await database.teams.delete(teamId)
    }
  })
}

/**
 * Part 1: the copies of one official match. Test matches and final copies are
 * left alone.
 * @param {object} database the app's Dexie database
 * @param {{ openMatchId?: number|null }} [options] the match on the screen: never removed
 * @returns {Promise<{ removed: object[], flagged: object[] }>} { id, key, gameN, keptId } each
 */
export async function settleDuplicateCopies(database, { openMatchId = null } = {}) {
  const removed = []
  const flagged = []
  const groups = new Map()
  for (const m of await database.matches.toArray()) {
    const key = localMatchKey(m)
    if (!key || m.test === true || m.status === 'final') continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(m)
  }
  for (const [key, copies] of groups) {
    if (copies.length < 2) continue
    const contents = []
    for (const m of copies) contents.push(await contentOf(database, m))
    contents.sort(furthestFirst)
    const [kept, ...others] = contents
    const unsent = (await database.sync_queue.where('status').anyOf(UNSENT).toArray()).some(j => jobMatchKey(j) === key)
    for (const other of others) {
      const item = reportItem(other.match, { keptId: kept.match.id })
      if (!unsent && other.match.id !== openMatchId && covers(kept, other)) {
        await removeCopy(database, other.match)
        removed.push(item)
        console.info(`[SelfCheck] Removed a copy of match ${key} (game ${item.gameN ?? '?'}, local ${other.match.id}): local ${kept.match.id} holds everything it had`)
      } else {
        flagged.push(item)
        console.info(`[SelfCheck] Two copies of match ${key} (game ${item.gameN ?? '?'}): local ${other.match.id} kept next to ${kept.match.id}, it holds something of its own${unsent ? ' or the match has unsent writes' : ''}`)
      }
    }
  }
  return { removed, flagged }
}

/**
 * The live match a start-up resumes: the one with the most recent activity,
 * never a copy the server has closed. `stale`: last active more than
 * `staleMs` ago (or nothing says when), not resumed.
 * @returns {Promise<{ id: number, match: object, lastActivityAt: number|null, stale: boolean }|null>}
 */
export async function pickResumeMatch(database, { now = Date.now(), staleMs = STALE_LIVE_MS } = {}) {
  const live = (await database.matches.where('status').equals('live').toArray()).filter(m => !isStaleClosedCopy(m))
  if (!live.length) return null
  const rated = []
  for (const m of live) rated.push({ match: m, at: lastActivityAt(m, await newestEventOf(database, m.id)) })
  rated.sort((x, y) => ((y.at ?? -Infinity) - (x.at ?? -Infinity)) || (y.match.id - x.match.id))
  const { match, at } = rated[0]
  return { id: match.id, match, lastActivityAt: at, stale: at == null || now - at > staleMs }
}

// ---------------------------------------------------------------------------
// Part 2: the server
// ---------------------------------------------------------------------------

/**
 * The server's rows of these matches, in one request: { data: rows, error }.
 * The columns MatchEnd's reopen check reads, and the key to match them by.
 */
export function readServerMatchRows(keys) {
  return apiFrom('matches').select('id, external_id, status, closed_at').in('external_id', keys)
}

/**
 * Ask the server about the open official copies on this device.
 * @param {object} database
 * @param {{ readRows: (keys: string[]) => Promise<{data: object[]|null, error: object|null}>,
 *   noteClosed: (localId: number) => Promise<boolean>, scorerMoved: (seedKey: string) => Promise<boolean> }} server
 * @param {{ onlyIds?: number[]|null, scorerCheckId?: number|null }} [options]
 *   onlyIds: these copies only (Continue); scorerCheckId: the copy whose
 *   scoring device is asked too, once the server has it open
 * @returns {Promise<{ closed: object[], moved: boolean, error: object|null }>}
 */
export async function checkCopiesOnServer(database, server, { onlyIds = null, scorerCheckId = null } = {}) {
  const result = { closed: [], moved: false, error: null }
  const copies = (await database.matches.toArray()).filter(m => isOpenOfficialCopy(m) && (!onlyIds || onlyIds.includes(m.id)))
  const keys = [...new Set(copies.map(m => m.seed_key))]
  if (!keys.length) return result
  let rows
  try {
    const { data, error } = await server.readRows(keys)
    if (error) {
      result.error = error
      console.info('[SelfCheck] The server could not be asked about the matches on this device:', error.message || error.status)
      return result
    }
    rows = Array.isArray(data) ? data : (data ? [data] : [])
  } catch (err) {
    result.error = err
    console.info('[SelfCheck] The server could not be asked about the matches on this device:', err?.message)
    return result
  }
  const byKey = new Map(rows.filter(r => r?.external_id).map(r => [r.external_id, r]))
  const closedKeys = new Set()
  for (const m of copies) {
    if (!serverRowClosed(byKey.get(m.seed_key))) continue
    closedKeys.add(m.seed_key)
    if (await server.noteClosed(m.id)) {
      result.closed.push(reportItem(m))
      console.info(`[SelfCheck] Match ${m.seed_key} (game ${matchGameNumber(m) ?? '?'}, local ${m.id}) is closed on the server: this copy is marked closed`)
    }
  }
  // (a match the server does not have is scored nowhere else)
  const target = scorerCheckId == null ? null : copies.find(m => m.id === scorerCheckId)
  if (target && byKey.has(target.seed_key) && !closedKeys.has(target.seed_key)) {
    result.moved = (await server.scorerMoved(target.seed_key)) === true
  }
  return result
}

/** Did `promise` settle within `ms`? { done, value | error }; it runs on either way. */
export function withinTimeout(promise, ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ done: false }), ms)
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve({ done: true, value }) },
      (error) => { clearTimeout(timer); resolve({ done: true, error }) }
    )
  })
}

// One check at a time: a start-up and a return from the background never
// remove the same copy twice
let running = Promise.resolve()

/**
 * The self-check (see the top of this file).
 * @param {object} args
 * @param {object} args.database the app's Dexie database
 * @param {object|null} [args.server] the server side (checkCopiesOnServer), only online and signed in
 * @param {boolean} [args.resume] start-up: pick the live match to resume
 * @param {number|null} [args.openMatchId] the match on the screen (back from the background)
 * @returns {Promise<{ removed: object[], flagged: object[], closed: object[], resumeId: number|null,
 *   stale: object|null, late: Promise<{ closed: object[] }>|null }>} late: the server's
 *   answer when it came after the timeout (applied all the same)
 */
export function runDeviceSelfCheck(args) {
  const run = running.then(() => selfCheck(args))
  running = run.catch(() => {})
  return run
}

async function selfCheck({ database, server = null, now = Date.now(), resume = false, openMatchId = null,
  timeoutMs = SERVER_CHECK_TIMEOUT_MS, staleMs = STALE_LIVE_MS }) {
  const report = { removed: [], flagged: [], closed: [], resumeId: null, stale: null, late: null }
  try {
    Object.assign(report, await settleDuplicateCopies(database, { openMatchId }))
  } catch (err) {
    console.warn('[SelfCheck] Could not check the copies on this device:', err?.message)
  }

  let pick = null
  if (resume) {
    try {
      pick = await pickResumeMatch(database, { now, staleMs })
    } catch (err) {
      console.warn('[SelfCheck] Could not read the live matches:', err?.message)
    }
    if (pick?.stale) {
      report.stale = reportItem(pick.match, { lastActivityAt: pick.lastActivityAt })
      console.info(`[SelfCheck] Live match ${localMatchKey(pick.match) ?? pick.id} not reopened: last activity ${pick.lastActivityAt ? new Date(pick.lastActivityAt).toISOString() : 'unknown'}`)
    }
  }
  const candidate = pick && !pick.stale ? pick.match : null

  if (server) {
    const scorerCheckId = resume ? (candidate?.id ?? null) : openMatchId
    const work = checkCopiesOnServer(database, server, { scorerCheckId }).catch((err) => {
      console.warn('[SelfCheck] The server check failed:', err?.message)
      return { closed: [], moved: false, error: err }
    })
    const answer = await withinTimeout(work, timeoutMs)
    if (answer.done) report.closed = answer.value.closed
    else {
      console.info(`[SelfCheck] No answer from the server within ${timeoutMs} ms: decided on this device`)
      report.late = work
    }
  }

  // Resumed only if still live and not closed (the server may have said so)
  if (candidate) {
    const fresh = await database.matches.get(candidate.id).catch(() => null)
    if (fresh?.status === 'live' && !isStaleClosedCopy(fresh)) report.resumeId = fresh.id
  }
  return report
}

/**
 * Calls `callback` when the page becomes visible again after being hidden for
 * at least `minHiddenMs` (the app sent to the background, the desktop window
 * hidden to the tray). @returns {() => void} unsubscribe
 */
export function onBackAfterHidden(callback, { minHiddenMs = LONG_HIDDEN_MS, doc = typeof document === 'undefined' ? null : document, now = () => Date.now() } = {}) {
  if (!doc?.addEventListener) return () => {}
  let hiddenAt = doc.visibilityState === 'hidden' ? now() : null
  const onChange = () => {
    if (doc.visibilityState === 'hidden') {
      if (hiddenAt == null) hiddenAt = now()
      return
    }
    if (doc.visibilityState !== 'visible' || hiddenAt == null) return
    const away = now() - hiddenAt
    hiddenAt = null
    if (away >= minHiddenMs) callback(away)
  }
  doc.addEventListener('visibilitychange', onChange)
  return () => doc.removeEventListener('visibilitychange', onChange)
}
