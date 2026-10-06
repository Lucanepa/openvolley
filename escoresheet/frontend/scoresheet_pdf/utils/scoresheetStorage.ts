/**
 * Approved scoresheets in cloud storage: where they live and who may read them.
 *
 * The scorer app uploads a match's scoresheet files to
 *   scoresheets/{YYYY-MM-DD}/game{n}_{key}.json        (during the match)
 *   scoresheets/{YYYY-MM-DD}/game{n}_{key}_final.json  (approved)
 *   scoresheets/{YYYY-MM-DD}/game{n}_{key}.pdf
 * (scoresheetUploader: the UTC date of scheduledAt, n = scoresheetGameId(match),
 * key = 'k' + 128 random bits kept on the scorer's device). The backend lets
 * ONLY the account that created a file read, replace or list it
 * (backend/lib/storage.js uploaderReadBuckets, backend/README "Who can read a
 * scoresheet"): no session -> 401, another account -> 403
 * OV_STORAGE_FORBIDDEN, a missing file -> OV_STORAGE_NOT_FOUND. The random
 * part means nobody can claim the path of a real scoresheet before the scorer
 * uploads it, so the viewer finds the file by listing the date folder (which
 * shows the caller only its own files), never by building the name.
 *
 * Never log the key: console output is uploaded with the interaction logs.
 */

export const SCORESHEET_KEY_RE = /^k[0-9a-f]{32}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const NAME_RE = /^game(.+?)(?:_(k[0-9a-f]{32}))?(_final)?\.(json|pdf)$/

/** A fresh random part for a match's scoresheet file names: 'k' + 32 hex (128 bits). */
export function newScoresheetKey(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return 'k' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

const cleanGame = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = String(v).trim().replace(/[^A-Za-z0-9-]/g, '-').slice(0, 64)
  return /[A-Za-z0-9]/.test(s) ? s : null
}

type MatchLike = {
  gameNumber?: number | string | null
  game_n?: number | string | null
  externalId?: string | null
  external_id?: string | null
} | null | undefined

/**
 * The game part of a match's scoresheet names: its game number, else its
 * external id (a friendly without a number), path-safe. null when the match has
 * neither: such a match is not uploaded (no shared 'unknown' name).
 */
export function scoresheetGameId(match: MatchLike): string | null {
  if (!match) return null
  for (const v of [match.gameNumber, match.game_n, match.externalId, match.external_id]) {
    if (v === null || v === undefined || v === '') continue
    return cleanGame(v)
  }
  return null
}

export function scoresheetObjectPath(date: string, game: string, key: string, { final = false, ext = 'json' }: { final?: boolean, ext?: 'json' | 'pdf' } = {}): string {
  if (!SCORESHEET_KEY_RE.test(key)) throw new Error('invalid scoresheet key')
  return `${date}/game${game}_${key}${final ? '_final' : ''}.${ext}`
}

/** game{n}[_{key}][_final].{json|pdf} -> its parts; null for any other name. */
export function parseScoresheetName(name: string): { game: string, key: string | null, final: boolean, ext: 'json' | 'pdf' } | null {
  const m = NAME_RE.exec(name || '')
  if (!m) return null
  return { game: m[1], key: m[2] || null, final: Boolean(m[3]), ext: m[4] as 'json' | 'pdf' }
}

/** The path with its random part masked, for logs and messages. */
export function redactScoresheetPath(p: string): string {
  return String(p).replace(/_k[0-9a-f]{32}/g, '_k…')
}

/** Key-less name of older versions (still found by findOwnScoresheet when its owner was granted). */
export const finalScoresheetPath = (date: string, game: string | number) => `${date}/game${game}_final.json`

type StorageBucket = {
  list: (dir: string, options?: object) => Promise<{ data: any[] | null, error: any }>
}

/**
 * Locate the caller's own scoresheet of a game on a date: the newest approved
 * (_final) JSON, or with { final: false } also the in-match JSON. Returns
 * { path } or { error } (a storage error, or OV_STORAGE_NOT_FOUND).
 */
export async function findOwnScoresheet(storage: StorageBucket, date: string, game: string | number, { final = true }: { final?: boolean } = {}): Promise<{ path: string | null, error: any }> {
  const g = cleanGame(game)
  const notFound = { path: null, error: { message: 'Object not found', code: 'OV_STORAGE_NOT_FOUND' } }
  if (!g || !DATE_RE.test(String(date))) return notFound
  const { data, error } = await storage.list(date, { limit: 100, search: `game${g}`, sortBy: { column: 'updated_at', order: 'desc' } })
  if (error) return { path: null, error }
  const hits = (data || [])
    .filter((f) => f && f.id)
    .map((f) => ({ f, p: parseScoresheetName(f.name) }))
    .filter(({ p }) => p && p.ext === 'json' && p.game === g && (p.final || !final))
  if (!hits.length) return notFound
  // Approved first; then newest (the list is sorted by updated_at desc)
  const best = hits.find(({ p }) => p!.final) || hits[0]
  return { path: `${date}/${best.f.name}`, error: null }
}

/**
 * Viewer URL (scorer app origin, where the session lives) of a match's approved
 * scoresheet, from a cloud matches row; null when it cannot be located (no
 * scheduled date, no game number or external id) or the match is not final yet.
 */
export function finalScoresheetUrl(match: { status?: string | null, scheduled_at?: string | null, game_n?: number | string | null, external_id?: string | null } | null | undefined): string | null {
  if (!match || match.status !== 'final') return null
  const game = scoresheetGameId(match)
  if (!game) return null
  const when = match.scheduled_at ? new Date(match.scheduled_at) : null
  if (!when || Number.isNaN(when.getTime())) return null
  const date = when.toISOString().slice(0, 10)
  return `/scoresheet/?date=${encodeURIComponent(date)}&game=${encodeURIComponent(game)}`
}

export type ScoresheetLoadError = { kind: 'signin' | 'forbidden' | 'notfound' | 'offline' | 'error', title: string, message: string }

/** What to tell the viewer when the storage download of a scoresheet failed. */
export function describeScoresheetLoadError(error: { status?: number, code?: string, message?: string, network?: boolean } | null | undefined, storagePath: string): ScoresheetLoadError {
  const status = error?.status
  const code = error?.code
  if (status === 401 || code === 'missing_token' || code === 'invalid_token') {
    return {
      kind: 'signin',
      title: 'Sign-in Required',
      message: 'Approved scoresheets can only be opened by the scorer account that uploaded them. Sign in to the scorer app with that account and open the match from My Matches.'
    }
  }
  if (status === 403 || code === 'OV_STORAGE_FORBIDDEN') {
    return {
      kind: 'forbidden',
      title: 'Not Your Scoresheet',
      message: 'This scoresheet can only be opened by the scorer account that uploaded it.'
    }
  }
  if (status === 404 || code === 'OV_STORAGE_NOT_FOUND') {
    return {
      kind: 'notfound',
      title: 'Scoresheet Not Found',
      message: `No scoresheet uploaded by this account was found: ${redactScoresheetPath(storagePath)}. Only the scorer account that approved the match can open it.`
    }
  }
  if (error?.network || status === 0) {
    return { kind: 'offline', title: 'Server Not Reachable', message: 'The scoresheet could not be loaded: the server is not reachable. Check the connection and try again.' }
  }
  return { kind: 'error', title: 'Scoresheet Not Available', message: error?.message || 'Failed to load scoresheet' }
}
