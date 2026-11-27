/**
 * A photo reading in the activity log (kind `photo.read`, docs/activity-log-spec.md):
 * owner 27.11, the times of real tablets reach the server. One entry when a reading
 * ends (RosterPhotoImport: the roster read, or the error; a cancelled one is not
 * logged): `ms` from the tap on "Read the list", `outcome` ('ok' or the error code
 * shown), on success `rows` (players read), `toCheck` (fields shown amber or red) and
 * `struck` (rows left out as struck), the device's `cores` and `memory`, `workers`
 * (recognition workers used) and `turned` (the page turned by the reading itself);
 * where the time went (owner 27.11: "check why it took 42 secs"): `msEngine` (waiting
 * for the recognition to start, and for the handwriting reader), `msPage` (the page
 * read), `msHand` (the handwriting read again), `msRest` (everything else: the photo
 * made flat, the SV numbers and struck rows read again, ...), `marksBy` (which reader
 * read the handwriting: 'onnx', the handwriting reader, or 'tesseract') and `lang`
 * (the list's language the scorer picked: 'de', 'fr', 'it' or 'other').
 *
 * COUNTS AND TIMINGS ONLY: never a name, a licence number, a date, a shirt number,
 * the photo or any text read from it. The sanitizers (domain/activitySummary, the
 * server's lib/activitySanitize) keep these keys only, typed. The app version and
 * platform are on every entry. Never throws.
 */
import { emitActivity } from '../activity/bus'
import { PHOTO_READ_LANGS, PHOTO_READ_MARKS_BY, PHOTO_READ_OUTCOMES } from '../../domain/activitySummary'
import { fieldIssues } from '../../domain/importedRoster'

export const PHOTO_READ_KIND = 'photo.read'

/** Fields marked amber or red in the roster after the photo (photoMarks: to check + to fix). */
function fieldsToCheck (roster) {
  const issues = fieldIssues(roster)
  return [...issues.players, ...Object.values(issues.officials)]
    .reduce((n, m) => n + Object.values(m).filter((x) => x.level === 'invalid' || x.level === 'low').length, 0)
}

const positive = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)
const msOf = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0)

/**
 * The entry's data.
 * @param {{ ms: number, outcome: string, roster?: object, stats?: { workers?: number, turned?: boolean, msEngine?: number, msPage?: number, msHand?: number, marksBy?: string }, lang?: string, nav?: Navigator }} reading
 *   roster: the one read (outcome 'ok'), as it goes into the roster; stats: what readRosterPhoto noted;
 *   lang: the list's language picked (ocrFiles.js LIST_LANGUAGES)
 */
export function photoReadData ({ ms, outcome, roster = null, stats = {}, lang = null, nav = typeof navigator !== 'undefined' ? navigator : undefined } = {}) {
  const ok = outcome === 'ok'
  const total = Math.max(0, Math.round(Number(ms) || 0))
  const msEngine = msOf(stats?.msEngine)
  const msPage = msOf(stats?.msPage)
  const msHand = msOf(stats?.msHand)
  return {
    ms: total,
    outcome: PHOTO_READ_OUTCOMES.includes(outcome) ? outcome : 'other',
    ...(ok
      ? { rows: roster?.players?.length || 0, toCheck: fieldsToCheck(roster), struck: roster?.struck?.length || 0 }
      : {}),
    cores: positive(nav?.hardwareConcurrency),
    memory: positive(nav?.deviceMemory),
    workers: Number.isInteger(stats?.workers) ? stats.workers : 0,
    turned: stats?.turned === true,
    msEngine,
    msPage,
    msHand,
    msRest: Math.max(0, total - msEngine - msPage - msHand),
    marksBy: PHOTO_READ_MARKS_BY.includes(stats?.marksBy) ? stats.marksBy : 'tesseract',
    lang: PHOTO_READ_LANGS.includes(lang) ? lang : 'other'
  }
}

/** Log one reading (a failure as a warning: the scorer can try again). */
export function logPhotoRead (reading) {
  try {
    const data = photoReadData(reading)
    emitActivity(PHOTO_READ_KIND, data, { level: data.outcome === 'ok' ? 'info' : 'warn' })
  } catch {
    // logging never breaks the photo import
  }
}
