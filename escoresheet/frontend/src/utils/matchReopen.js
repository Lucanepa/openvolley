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
