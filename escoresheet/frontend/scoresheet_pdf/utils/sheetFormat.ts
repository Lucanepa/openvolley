/**
 * Formats of the printed scoresheet and its PDF (docs/scoresheet/field-spec.md
 * 12.3 and 13): dates, names, the game number, short team names and the PDF
 * file name. Pure functions, no React: unit-tested in
 * utils/__tests__/sheetFormat.test.ts.
 */
import { officialsToArray } from '../../src/domain/officials.js'
import { scoresheetGameId } from './scoresheetStorage'

const pad2 = (n: number) => String(n).padStart(2, '0')

/** A real calendar date (rejects 31.02.2001, month 13 ...). */
function validDate(y: number, m: number, d: number): boolean {
  if (!(y >= 1000 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/** The 01.01.1900 "unknown" placeholder (src/utils/remoteRoster.js isKnownDob). */
const isPlaceholderDob = (y: number, m: number, d: number) => y === 1900 && m === 1 && d === 1

/**
 * A date of birth as printed on the sheet: `DD.MM.YYYY`.
 * Accepts ISO `YYYY-MM-DD` (with or without a time), `D.M.YYYY`, `DD.MM.YYYY`,
 * `DD/MM/YYYY` and `DD-MM-YYYY`. Empty for nothing and for the 01.01.1900
 * placeholder; anything else that cannot be read is printed as it is (never
 * "Invalid Date").
 */
export function formatDob(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  const s = String(raw).trim()
  if (!s) return ''
  let y: number, m: number, d: number
  let match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/)
  if (match) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]
  } else if ((match = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/))) {
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])]
  } else {
    return s
  }
  if (!validDate(y, m, d)) return s
  if (isPlaceholderDob(y, m, d)) return ''
  return `${pad2(d)}.${pad2(m)}.${y}`
}

const toDate = (value: unknown): Date | null => {
  if (value === null || value === undefined || value === '') return null
  const dt = value instanceof Date ? value : new Date(value as string)
  return Number.isNaN(dt.getTime()) ? null : dt
}

/** A match date as printed in the header: the LOCAL calendar day, `DD.MM.YYYY`. */
export function formatSheetDate(value: unknown): string {
  const dt = toDate(value)
  if (!dt) return ''
  return `${pad2(dt.getDate())}.${pad2(dt.getMonth() + 1)}.${dt.getFullYear()}`
}

/** `YYYYMMDD` of the LOCAL calendar day (file names). */
export function localDateStamp(value: unknown): string {
  const dt = toDate(value)
  if (!dt) return ''
  return `${dt.getFullYear()}${pad2(dt.getMonth() + 1)}${pad2(dt.getDate())}`
}

/**
 * Minutes as the result table prints a match time: `H h MM min` (field-spec 9).
 * Empty for nothing / not positive.
 */
export function formatHoursMinutes(totalMinutes: number | null | undefined): string {
  if (totalMinutes === null || totalMinutes === undefined || !Number.isFinite(totalMinutes) || totalMinutes <= 0) return ''
  const h = Math.floor(totalMinutes / 60)
  const m = Math.floor(totalMinutes % 60)
  return `${h} h ${pad2(m)} min`
}

/** A local clock time as the result table prints it: `HH h MM min`. */
export function formatClockHoursMinutes(value: unknown): string {
  const dt = toDate(value)
  if (!dt) return ''
  return `${pad2(dt.getHours())} h ${pad2(dt.getMinutes())} min`
}

/**
 * The match number printed in the header and used in the file name: one rule
 * for the header, the file name and the storage path (scoresheetGameId:
 * gameNumber, game_n, externalId, external_id).
 */
export function gameNumberOf(match: any): string {
  return scoresheetGameId(match) || ''
}

/** Placeholder team names that must never name a file or a roster (field-spec 13.4). */
export function isPlaceholderTeamName(name: unknown): boolean {
  if (name === null || name === undefined) return true
  const s = String(name).trim()
  if (!s) return true
  return /^(home|away|team\s*[ab]|heim|gast)$/i.test(s)
}

/**
 * The short name printed in the set boxes, the rosters and the result table:
 * the stored short name, else the team's full name (also when the short name
 * is a placeholder such as HOME / AWAY and a real name is known).
 */
export function displayShortName(shortName: unknown, fullName: unknown): string {
  const short = shortName === null || shortName === undefined ? '' : String(shortName).trim()
  const full = fullName === null || fullName === undefined ? '' : String(fullName).trim()
  if (short && !isPlaceholderTeamName(short)) return short
  if (full && !isPlaceholderTeamName(full)) return full
  return short || full
}

const TRANSLITERATION: Record<string, string> = {
  ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss',
  é: 'e', è: 'e', ê: 'e', ë: 'e', É: 'E', È: 'E', Ê: 'E', Ë: 'E',
  à: 'a', â: 'a', á: 'a', À: 'A', Â: 'A', Á: 'A',
  ç: 'c', Ç: 'C', î: 'i', ï: 'i', í: 'i', ì: 'i', ô: 'o', ó: 'o', ò: 'o',
  û: 'u', ú: 'u', ù: 'u', ñ: 'n', Ñ: 'N'
}

/**
 * One part of a file name: transliterated (ä -> ae ...), every other
 * character outside [A-Za-z0-9-] replaced by '-', repeated '-' collapsed and
 * trimmed, at most `max` characters. No dots, slashes or spaces survive, so the
 * name means the same on every platform and download handler.
 */
export function sanitizeFilenamePart(value: unknown, max = 30): string {
  const s = value === null || value === undefined ? '' : String(value)
  // Ä/Ö/Ü in an upper-case word become AE/OE/UE ("SCHÖNENWERD" -> "SCHOENENWERD")
  const ascii = s
    .replace(/[^\u0000-\u007f]/g, (ch: string, i: number) => {
      const t = TRANSLITERATION[ch] ?? ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      const near = `${s[i - 1] || ''}${s[i + 1] || ''}`
      return t.length > 1 && /^[A-Z]/.test(t) && /[A-Z]/.test(near) && !/[a-z]/.test(near) ? t.toUpperCase() : t
    })
  return ascii
    .replace(/[^A-Za-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, max)
    .replace(/-$/, '')
}

const MAX_FILENAME = 120

/**
 * The PDF's file name: `<YYYYMMDD>_<gameNo>_<Home>_vs_<Away>.pdf`
 * (field-spec 13.4), e.g. `20261007_382208_KSCW-H1_vs_Spada-H1.pdf`.
 *  - the real team names: the short name, unless it is empty or a placeholder
 *    (HOME / AWAY / Team A ...), then the full name;
 *  - the LOCAL match date (scheduled, else the first set's start, else `now`);
 *  - the game number left out (with its `_`) when unknown, never "match".
 */
export function buildScoresheetFilename(
  data: { match?: any; homeTeam?: any; awayTeam?: any; sets?: any[] },
  now: Date = new Date()
): string {
  const match = data.match || {}
  const firstSetStart = (data.sets || []).find((s: any) => s?.index === 1)?.startTime
  const date = localDateStamp(match.scheduledAt) || localDateStamp(firstSetStart) || localDateStamp(now)
  const game = sanitizeFilenamePart(gameNumberOf(match), 20)
  const home = sanitizeFilenamePart(displayShortName(match.homeShortName, data.homeTeam?.name ?? match.homeTeamName), 30) || 'Home'
  const away = sanitizeFilenamePart(displayShortName(match.awayShortName, data.awayTeam?.name ?? match.awayTeamName), 30) || 'Away'
  const stem = [date, game, `${home}_vs_${away}`].filter(Boolean).join('_')
  return `${stem.slice(0, MAX_FILENAME - 4)}.pdf`
}

/** The PDF's document title (metadata, field-spec 13.1). */
export function buildScoresheetTitle(data: { match?: any; homeTeam?: any; awayTeam?: any; sets?: any[] }): string {
  const match = data.match || {}
  const home = data.homeTeam?.name || match.homeTeamName || displayShortName(match.homeShortName, '') || 'Home'
  const away = data.awayTeam?.name || match.awayTeamName || displayShortName(match.awayShortName, '') || 'Away'
  const firstSetStart = (data.sets || []).find((s: any) => s?.index === 1)?.startTime
  const date = formatSheetDate(match.scheduledAt) || formatSheetDate(firstSetStart)
  const game = gameNumberOf(match)
  return `OpenVolley eScoresheet: ${home} vs ${away}${date ? `, ${date}` : ''}${game ? `, game ${game}` : ''}`
}

/** `Lastname, F.` (field-spec 12.3); the first name alone when there is no last name. */
export function formatPersonName(lastName: unknown, firstName: unknown): string {
  const last = lastName === null || lastName === undefined ? '' : String(lastName).trim()
  const first = firstName === null || firstName === undefined ? '' : String(firstName).trim()
  if (!last) return first
  if (!first) return last
  // initials of a compound first name: "Jean-Baptiste" -> "J.-B.", "Anna Lena" -> "A. L."
  const initials = first
    .split(/\s+/)
    .map(part => part.split('-').map(p => (p ? `${p[0].toUpperCase()}.` : '')).filter(Boolean).join('-'))
    .filter(Boolean)
    .join(' ')
  return `${last}, ${initials}`
}

export interface SheetOfficial {
  role: string
  firstName: string
  lastName: string
  country: string
  dob: string
  name: string
}

/**
 * The match officials as one array, whatever the stored shape: the array
 * MatchSetup writes, the older role-keyed object (domain/officials.js), and
 * snake_case names (first_name / last_name, the cloud payload). Never throws.
 */
export function normalizeOfficials(raw: unknown): SheetOfficial[] {
  let list: any[]
  try {
    list = officialsToArray(raw as any) as any[]
  } catch {
    list = []
  }
  return list
    .filter(o => o && typeof o === 'object')
    .map(o => ({
      role: typeof o.role === 'string' ? o.role : '',
      firstName: String(o.firstName ?? o.first_name ?? '').trim(),
      lastName: String(o.lastName ?? o.last_name ?? '').trim(),
      country: String(o.country ?? '').trim(),
      dob: o.dob ?? o.date_of_birth ?? '',
      name: String(o.name ?? '').trim()
    }))
}

const ROLE_ALIASES: Record<string, string[]> = {
  '1st referee': ['1st referee', 'ref1', '1st_referee', 'referee1', 'first referee'],
  '2nd referee': ['2nd referee', 'ref2', '2nd_referee', 'referee2', 'second referee'],
  'scorer': ['scorer'],
  'assistant scorer': ['assistant scorer', 'asstscorer', 'assistant_scorer', 'asst scorer']
}

/** The official of a role ('1st referee', '2nd referee', 'scorer', 'assistant scorer', 'line judge 1'...). */
export function findOfficial(officials: SheetOfficial[], role: string): SheetOfficial | undefined {
  const wanted = role.toLowerCase()
  const aliases = ROLE_ALIASES[wanted] || [wanted]
  return officials.find(o => aliases.includes(o.role.toLowerCase()))
}

/** An array, whatever was stored (null, an object, undefined). */
export const asArray = <T = any>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])
