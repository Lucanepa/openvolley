/**
 * Native auto-backup: file naming and rotation (pure, no I/O).
 *
 * Layout under the app's backup folder:
 *   <matchDir>/<yyyymmdd>T<hhmmss>.<mmm>Z-<seq>.json   one file per scoring event
 *   <matchDir>/latest.json                            always the newest state
 *
 * Event file names sort chronologically as plain strings (UTC, fixed width).
 */

export const LATEST_FILE = 'latest.json'
export const DEFAULT_MAX_PER_MATCH = 500
export const DEFAULT_MAX_AGE_DAYS = 30

const EVENT_FILE_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})Z-(\d+)\.json$/
const SAFE_SEGMENT_RE = /[^A-Za-z0-9_-]+/g

const pad = (n, w = 2) => String(n).padStart(w, '0')

/** Folder- and file-name safe text (letters, digits, _ and -). */
export function sanitizeSegment(value, maxLength = 40) {
  return String(value ?? '')
    .replace(SAFE_SEGMENT_RE, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
}

/**
 * Folder of one match: game<N>-<seed> (gameN for the owner, the seed so two
 * matches with the same number never share a folder). Test matches get a
 * test- prefix. Falls back to the local id.
 */
export function matchFolderName(match, localId) {
  const gameN = sanitizeSegment(match?.gameN ?? match?.game_n ?? match?.gameNumber ?? '', 12)
  const seed = sanitizeSegment(match?.seed_key || match?.seedKey || match?.externalId || match?.external_id || '', 12)
  const prefix = match?.test ? 'test-' : ''
  let name
  if (gameN && seed) name = `game${gameN}-${seed}`
  else if (gameN) name = `game${gameN}`
  else if (seed) name = `match-${seed}`
  else name = `match-${sanitizeSegment(localId ?? 'unknown', 12) || 'unknown'}`
  return prefix + name
}

/** Event backup file name for a moment (UTC) and the match's latest event seq. */
export function eventFileName(date, seq) {
  const d = date instanceof Date ? date : new Date(date)
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}Z`
  const n = Math.max(0, Math.floor(Number(seq) || 0))
  return `${stamp}-${pad(n, 5)}.json`
}

/** { time: ms since epoch, seq } of an event backup file name, or null. */
export function parseEventFileName(name) {
  const m = EVENT_FILE_RE.exec(String(name))
  if (!m) return null
  const [, y, mo, d, h, mi, s, ms, seq] = m
  return { time: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, +ms), seq: parseInt(seq, 10) }
}

export const isEventFile = (name) => EVENT_FILE_RE.test(String(name))

/** Highest integer event seq in a match backup (the "event number" in the file name). */
export function latestEventSeq(data) {
  let max = 0
  for (const e of data?.events || []) {
    const s = Math.floor(Number(e?.seq) || 0)
    if (s > max) max = s
  }
  return max
}

/**
 * Event files of ONE match folder to delete: those older than maxAgeDays, then
 * the oldest beyond maxPerMatch. latest.json and unknown files are never
 * touched, so every match keeps its final state.
 * @param {string[]} names file names in the folder
 * @returns {string[]} names to delete (oldest first)
 */
export function planMatchRotation(names, { now = Date.now(), maxPerMatch = DEFAULT_MAX_PER_MATCH, maxAgeDays = DEFAULT_MAX_AGE_DAYS } = {}) {
  const cutoff = (now instanceof Date ? now.getTime() : now) - maxAgeDays * 24 * 60 * 60 * 1000
  const events = names.filter(isEventFile).sort()
  const doomed = []
  const kept = []
  for (const name of events) {
    if (parseEventFileName(name).time < cutoff) doomed.push(name)
    else kept.push(name)
  }
  const excess = kept.length - Math.max(0, maxPerMatch)
  if (excess > 0) doomed.push(...kept.slice(0, excess))
  return doomed
}

/**
 * Rotation over every match folder.
 * @param {{dir: string, files: {name: string}[]}[]} dirs
 * @returns {{dir: string, names: string[]}[]} only folders with something to delete
 */
export function planRotation(dirs, options = {}) {
  const plan = []
  for (const d of dirs || []) {
    const names = planMatchRotation((d.files || []).map(f => (typeof f === 'string' ? f : f.name)), options)
    if (names.length) plan.push({ dir: d.dir, names })
  }
  return plan
}
