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
// Every file is the whole match (a 5-set match ends near 1 MB), so a count cap
// alone lets one match reach hundreds of MB. A byte budget keeps the newest
// files of the match being scored; a folder nobody wrote to for a while (a
// finished match) is thinned to its newest few files.
export const DEFAULT_MAX_BYTES_PER_MATCH = 64 * 1024 * 1024
export const DEFAULT_IDLE_KEEP = 10
export const DEFAULT_IDLE_AFTER_HOURS = 12
// Longest seed kept in a folder name (backup.rs accepts 100-char segments)
const SEED_MAX = 64

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
 * Folder of one match: game<N>-<seed> (gameN for the owner, the WHOLE seed so
 * two matches with the same number never share a folder: seeds are
 * match_<ms>_<random>, and a cut seed keeps only the start of the timestamp).
 * Without a seed the local id keeps matches apart. Test matches get a test-
 * prefix.
 */
export function matchFolderName(match, localId) {
  const gameN = sanitizeSegment(match?.gameN ?? match?.game_n ?? match?.gameNumber ?? '', 12)
  const seed = sanitizeSegment(match?.seed_key || match?.seedKey || match?.externalId || match?.external_id || '', SEED_MAX)
  const local = sanitizeSegment(localId ?? '', 12)
  const prefix = match?.test ? 'test-' : ''
  let name
  if (gameN && seed) name = `game${gameN}-${seed}`
  else if (seed) name = `match-${seed}`
  else if (gameN) name = local ? `game${gameN}-local${local}` : `game${gameN}`
  else name = `match-${local || 'unknown'}`
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

const fileName = (f) => (typeof f === 'string' ? f : f?.name)
const fileSize = (f) => (typeof f === 'string' ? 0 : Math.max(0, Number(f?.size) || 0))

/**
 * Event files of ONE match folder to delete (oldest first):
 *  - older than maxAgeDays,
 *  - beyond the newest maxPerMatch,
 *  - beyond maxBytesPerMatch (sizes, when the store knows them),
 *  - a folder idle for idleAfterHours (a finished match) keeps its newest idleKeep.
 * The newest event file is ALWAYS kept, whatever its age: it may be the only
 * copy of the final state (latest.json can belong to an earlier install on
 * Android 11+ and be stale). latest.json and unknown files are never touched.
 * @param {(string|{name: string, size?: number})[]} files the folder's files
 * @returns {string[]} names to delete
 */
export function planMatchRotation(files, {
  now = Date.now(),
  maxPerMatch = DEFAULT_MAX_PER_MATCH,
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
  maxBytesPerMatch = DEFAULT_MAX_BYTES_PER_MATCH,
  idleKeep = DEFAULT_IDLE_KEEP,
  idleAfterHours = DEFAULT_IDLE_AFTER_HOURS
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now
  const cutoff = nowMs - maxAgeDays * 24 * 60 * 60 * 1000
  const events = (files || [])
    .map(f => ({ name: fileName(f), size: fileSize(f) }))
    .filter(f => isEventFile(f.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  if (events.length <= 1) return []

  // newest first; the newest one is never deleted
  const newestFirst = events.slice().reverse()
  const newestTime = parseEventFileName(newestFirst[0].name).time
  const idle = idleAfterHours > 0 && nowMs - newestTime > idleAfterHours * 60 * 60 * 1000
  const keepCount = Math.max(1, idle ? Math.min(maxPerMatch, idleKeep) : maxPerMatch)

  const doomed = new Set()
  let bytes = 0
  let kept = 0
  let full = false // budget reached: everything older goes
  newestFirst.forEach((f, i) => {
    if (i === 0) {
      bytes += f.size
      kept++
      return
    }
    const old = parseEventFileName(f.name).time < cutoff
    const overCount = kept >= keepCount
    if (maxBytesPerMatch > 0 && bytes + f.size > maxBytesPerMatch) full = true
    if (old || overCount || full) {
      doomed.add(f.name)
    } else {
      bytes += f.size
      kept++
    }
  })
  return events.map(f => f.name).filter(n => doomed.has(n))
}

/**
 * Rotation over every match folder.
 * @param {{dir: string, files: (string|{name: string, size?: number})[]}[]} dirs
 * @returns {{dir: string, names: string[]}[]} only folders with something to delete
 */
export function planRotation(dirs, options = {}) {
  const plan = []
  for (const d of dirs || []) {
    const names = planMatchRotation(d.files || [], options)
    if (names.length) plan.push({ dir: d.dir, names })
  }
  return plan
}
