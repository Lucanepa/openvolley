/**
 * One accurate, non-blocking toast for a save that also goes to the cloud
 * (Create match, match info, home/away roster confirm).
 *
 * The setup screen used to raise a blocking "Syncing..." modal, then poll the
 * whole sync queue for 10 s and leave a terminal "saved locally (sync
 * pending)" modal on screen even after the job was sent (e.g. after a
 * sign-in), and each roster confirm needed an OK. Now:
 *   - the jobs of THIS save are watched (not every queued job); a save that
 *     queued none (test match) shows nothing;
 *   - offline or signed out, the outcome is known at once: an info toast
 *     "saved locally (sync pending)" (the Not signed in banner / offline pill
 *     explain why);
 *   - otherwise the first of: all sent -> success toast, refused/errored ->
 *     error toast, still waiting after timeoutMs -> info toast;
 *   - toasts dismiss themselves, so no stale message stays up; the card sync
 *     pills keep the live state.
 */
import { toast } from '../ui/uiStore.js'
import { db } from '../db/db'
import { hasStoredSessionToken } from '../hooks/useSyncQueue'

const DONE = new Set(['sent', 'superseded', 'dropped'])

/**
 * Outcome of a set of sync_queue rows.
 * @param {Array<{status?: string}|undefined>} jobs  undefined = pruned (it was sent)
 * @returns {'synced'|'failed'|'pending'}
 */
export function syncJobsOutcome(jobs) {
  if (jobs.some((j) => j && (j.status === 'error' || j.status === 'failed'))) return 'failed'
  if (jobs.every((j) => !j || DONE.has(j.status))) return 'synced'
  return 'pending'
}

const kitLang = (lang) => (String(lang || '').toLowerCase().startsWith('de') ? 'DE' : 'EN')

/**
 * Watch the given sync jobs and show one toast with the outcome.
 * @param {Array<number|null|undefined>} jobIds  ids from db.sync_queue.add (falsy ids are ignored)
 * @param {object} opts
 * @param {{synced: string, failed: string, pending: string}} opts.messages
 * @param {(id: number) => Promise<object|undefined>} opts.getJob
 * @param {() => boolean} opts.canSync  online and signed in
 * @param {string} [opts.lang]  i18n language (for the toast's dismiss label)
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.pollMs]
 * @param {typeof toast} [opts.notify]
 * @returns {() => void} stop watching (no toast after that)
 */
export function toastSyncOutcome(jobIds, { messages, getJob, canSync, lang, timeoutMs = 10000, pollMs = 500, notify = toast }) {
  const ids = (jobIds || []).filter(Boolean)
  const toastOpts = { lang: kitLang(lang) }
  let stopped = false
  let timer = null
  const stop = () => {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
  }

  // Nothing went to the queue (test match, no cloud id): nothing to report
  if (ids.length === 0) {
    stop()
    return stop
  }
  // Offline or signed out: it waits on this device, say so at once
  if (!canSync()) {
    notify.info(messages.pending, toastOpts)
    stop()
    return stop
  }

  const started = Date.now()
  const check = async () => {
    if (stopped) return
    let outcome = 'pending'
    try {
      outcome = syncJobsOutcome(await Promise.all(ids.map((id) => getJob(id))))
    } catch {
      outcome = 'pending'
    }
    if (stopped) return
    if (outcome === 'synced') {
      notify.success(messages.synced, toastOpts)
    } else if (outcome === 'failed') {
      notify.error(messages.failed, toastOpts)
    } else if (Date.now() - started >= timeoutMs || !canSync()) {
      notify.info(messages.pending, toastOpts)
    } else {
      timer = setTimeout(check, pollMs)
      return
    }
    stop()
  }
  timer = setTimeout(check, pollMs)
  return stop
}

/**
 * toastSyncOutcome for jobs in the local sync queue: online and signed in
 * decide whether the cloud can take them now.
 * @param {Array<number|null|undefined>} jobIds
 * @param {{synced: string, failed: string, pending: string}} messages
 * @param {string} [lang]
 */
export function toastQueuedSync(jobIds, messages, lang) {
  return toastSyncOutcome(jobIds, {
    messages,
    lang,
    getJob: (id) => db.sync_queue.get(id),
    canSync: () => (typeof navigator === 'undefined' || navigator.onLine !== false) && hasStoredSessionToken()
  })
}
