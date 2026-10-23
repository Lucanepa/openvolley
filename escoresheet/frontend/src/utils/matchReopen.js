/**
 * "Reopen match" after approval (spec 6.8). Closing is locked on the server:
 * once a non-test match reached approved/final there, only an admin can
 * reopen it (POST /api/admin/matches/:id/reopen, audit-logged). This replaces
 * the old client-side reopen password.
 *
 * planReopen decides; MatchEnd carries the decision out:
 * - 'local'          test match or never-synced match (no seed_key): reopen
 *                    locally as before.
 * - 'localUnsynced'  the local queue PROVES no closing update reached the
 *                    server: it holds an unsent (queued / errored / refused)
 *                    closing job of this match and no sent one. Those jobs are
 *                    superseded and the match reopens locally without queuing
 *                    'ended'. The only offline path. No closing job at all is
 *                    no proof (sent jobs are pruned after 7 days, the match
 *                    may have been closed on another device or restored from
 *                    the cloud): then the server is asked.
 * - 'needsConnection' the server may have it closed and there is no connection.
 * - 'serverOpen'     the server has it open (an admin reopened it): reopen
 *                    locally without queuing.
 * - 'adminReopen'    closed on the server and this account is an admin.
 * - 'adminOnly'      closed on the server: only an admin can reopen it.
 * - 'checkFailed'    the server could not be asked.
 */

import { jobMatchKey } from './syncIds'

export const CLOSING_STATUSES = ['approved', 'final']

/** A sync job that marks its match approved/final on the server. */
export function isClosingSyncJob(job) {
  if (job?.resource !== 'match') return false
  const status = job.action === 'restore' ? job.payload?.match?.status : job.payload?.status
  return CLOSING_STATUSES.includes(status)
}

/**
 * Is the local match known to be closed on the server? It carries the
 * server's closed_at, the server refused a write of it as closed (cloudBlock
 * OV_MATCH_CLOSED), it was closed on the
 * device that took it over (OV_SCORER_MOVED, closed), or its local status is
 * approved / final: this device only writes those from the server (a closed
 * match restored or imported, useSyncQueue closesLocalCopy; an approval here
 * keeps the status 'ended' and sets approved). Never a test match.
 */
export function isKnownClosedOnServer(match) {
  if (!match || match.test === true) return false
  if (match.closed_at) return true
  const block = match.cloudBlock
  if (block?.code === 'OV_MATCH_CLOSED') return true
  if (block?.code === 'OV_SCORER_MOVED' && block.closed === true) return true
  return CLOSING_STATUSES.includes(match.status)
}

/**
 * A copy this device was still scoring (not ended / approved / final here)
 * whose match the server has closed: it can no longer be scored or synced,
 * so it is never resumed on its own; the user loads the official version or
 * removes it (ClosedOnServerModal). A phone kept such a copy of match 406970
 * 'live' and reopened it on its scoring screen at every start (2026-10-23).
 * Reads only local evidence, so it holds offline too. Never a test match;
 * never a match another device took over (ScorerMovedModal). Match End keeps
 * the closed view of a copy that ended or was approved here.
 */
export function isStaleClosedCopy(match) {
  if (!match || match.test === true) return false
  if (match.cloudBlock?.code === 'OV_SCORER_MOVED') return false
  if (['ended', 'approved', 'final'].includes(match.status)) return false
  return !!match.closed_at || match.cloudBlock?.code === 'OV_MATCH_CLOSED'
}

/**
 * @param {object} args
 * @param {object} args.match the local match row
 * @param {object[]} args.queue every sync_queue row (or at least this match's)
 * @param {boolean} args.online
 * @param {{isAdmin?: boolean}} [args.access]
 * @param {(seedKey: string) => Promise<{data: object|null, error: object|null}>} args.readServerMatch
 * @returns {Promise<{kind: string, row?: object, supersedeIds?: number[]}>}
 */
export async function planReopen({ match, queue, online, access, readServerMatch }) {
  if (!match || match.test || !match.seed_key) return { kind: 'local' }

  const closingJobs = (queue || []).filter(j => isClosingSyncJob(j) && jobMatchKey(j) === match.seed_key)
  const reached = closingJobs.some(j => j.status === 'sent' || j.status === 'sending')
  const unsent = closingJobs.filter(j => j.status === 'queued' || j.status === 'error' || j.status === 'failed')
  if (!reached && unsent.length > 0) {
    return { kind: 'localUnsynced', supersedeIds: unsent.map(j => j.id) }
  }

  if (!online) return { kind: 'needsConnection' }

  let result
  try {
    result = await readServerMatch(match.seed_key)
  } catch {
    return { kind: 'checkFailed' }
  }
  if (!result || result.error) return { kind: 'checkFailed' }
  const row = result.data
  // Not in the cloud (or not visible to this account): nothing is closed there
  if (!row) return { kind: 'serverOpen' }
  const closed = row.closed_at
    ? true
    : (!('closed_at' in row) && CLOSING_STATUSES.includes(row.status))
  if (!closed) return { kind: 'serverOpen', row }
  if (access?.isAdmin) return { kind: 'adminReopen', row }
  return { kind: 'adminOnly', row }
}
