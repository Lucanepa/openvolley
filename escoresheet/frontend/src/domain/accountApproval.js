/**
 * Approval with an account (docs/account-approval-spec.md, section 4.2).
 * Pure helpers: no React, no Dexie, no network. localStorage is touched only
 * by deviceId() and the email memory, always inside try/catch.
 *
 * The 1st referee, the 2nd referee and the scorer may approve the result with
 * their account (email + personal approval PIN) instead of drawing a
 * signature. Each of these slots is complete with EITHER a drawn signature OR
 * a valid account approval. The assistant scorer and the captains sign by
 * hand only.
 *
 * An approval is bound to the result it approved (`result_key`). When the
 * finished sets change, the approval is stale: it no longer completes the slot
 * and never prints on the PDF.
 */
import { OFFICIAL_ROLES } from './officials.js'

/** MatchEnd role -> server slot. */
export const ROLE_TO_SLOT = Object.freeze({ ref1: 'referee1', ref2: 'referee2', scorer: 'scorer' })
/** Server slot -> MatchEnd role. */
export const SLOT_TO_ROLE = Object.freeze({ referee1: 'ref1', referee2: 'ref2', scorer: 'scorer' })
/** MatchEnd roles that may approve with an account, in signing order. */
export const APPROVAL_ROLES = Object.freeze(['scorer', 'ref2', 'ref1'])
/** Server slots in display order. */
export const APPROVAL_SLOTS = Object.freeze(['referee1', 'referee2', 'scorer'])

/** A personal approval PIN: 4 to 6 digits (the server checks the same). */
export const PIN_RE = /^\d{4,6}$/

/**
 * A PIN that is too easy to guess: one repeated digit (0000, 111111) or a
 * strictly ascending or descending run (1234, 0123, 123456, 4321, 987654).
 * Mirrors the server's isWeakPin; the format is checked separately.
 */
export function isWeakPin(pin) {
  if (typeof pin !== 'string' || !PIN_RE.test(pin)) return false
  const d = [...pin].map(Number)
  const steps = d.slice(1).map((v, i) => v - d[i])
  return steps.every(s => s === 0) || steps.every(s => s === 1) || steps.every(s => s === -1)
}

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** The finished sets as [index, homePoints, awayPoints], ordered by index. */
export function resultTriples(sets) {
  return (Array.isArray(sets) ? sets : [])
    .filter(s => s && s.finished === true)
    .map(s => [num(s.index), num(s.homePoints), num(s.awayPoints)])
    .sort((a, b) => a[0] - b[0])
}

/**
 * The canonical result string the server binds an approval to (spec 1.4):
 * "ov-result-v1|1:25:20,2:23:25,..." over the finished sets, by index.
 * A missing points value counts as 0.
 */
export function resultKey(sets) {
  return `ov-result-v1|${resultTriples(sets).map(t => t.join(':')).join(',')}`
}

/** The account approval of a MatchEnd role, or null (also for roles without one). */
export function approvalFor(match, role) {
  const slot = ROLE_TO_SLOT[role]
  if (!slot) return null
  return match?.accountApprovals?.[slot] ?? null
}

/** An approval completes its slot only while it matches the current result. */
export function isApprovalValid(approval, sets) {
  if (!approval || approval.revoked_at) return false
  return typeof approval.result_key === 'string' && approval.result_key === resultKey(sets)
}

/**
 * The drawn-signature field of a MatchEnd role on the match row. Team A is
 * the coin-toss team A (home unless coinTossTeamA says 'away'), as in MatchEnd.
 */
export function signatureFieldOf(match, role) {
  const homeIsA = (match?.coinTossTeamA || 'home') === 'home'
  switch (role) {
    case 'captain-a': return homeIsA ? 'homePostGameCaptainSignature' : 'awayPostGameCaptainSignature'
    case 'captain-b': return homeIsA ? 'awayPostGameCaptainSignature' : 'homePostGameCaptainSignature'
    case 'asst-scorer': return 'asstScorerSignature'
    case 'scorer': return 'scorerSignature'
    case 'ref2': return 'ref2Signature'
    case 'ref1': return 'ref1Signature'
    default: return null
  }
}

/**
 * A signing slot is complete with a drawn signature, or (scorer and
 * referees only) with an account approval that matches the current result.
 */
export function slotComplete(match, role, sets) {
  const field = signatureFieldOf(match, role)
  if (field && match?.[field]) return true
  if (!ROLE_TO_SLOT[role]) return false
  return isApprovalValid(approvalFor(match, role), sets)
}

const pad = (n) => String(n).padStart(2, '0')

/** "dd.mm.yyyy hh:mm" (24 h) on the given clock; '' for an invalid value. */
export function formatApprovalTime(value, { timeZone = 'Europe/Zurich' } = {}) {
  const date = value instanceof Date ? value : new Date(value)
  if (!value || Number.isNaN(date.getTime())) return ''
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).formatToParts(date)
    const at = (type) => Number(parts.find(p => p.type === type)?.value ?? NaN)
    const hour = at('hour') === 24 ? 0 : at('hour')
    return `${pad(at('day'))}.${pad(at('month'))}.${at('year')} ${pad(hour)}:${pad(at('minute'))}`
  } catch {
    return ''
  }
}

/** "<name> · dd.mm.yyyy hh:mm · ID <short_id>" (the second line of the done state). */
export function approvalLine(approval, opts) {
  if (!approval) return ''
  return [approval.name, formatApprovalTime(approval.approved_at, opts), approval.short_id ? `ID ${approval.short_id}` : '']
    .filter(Boolean)
    .join(' · ')
}

/**
 * The text printed on the PDF in place of a drawn signature. English, as the
 * sheet is: "Approved electronically · <name> · dd.mm.yyyy hh:mm · ID <short_id>".
 */
export function formatApprovalStamp(approval, opts = {}) {
  if (!approval) return ''
  return `Approved electronically · ${approvalLine(approval, opts)}`
}

/** Server records (GET /api/approvals) keyed by slot; unknown slots are dropped. */
export function approvalsBySlot(records) {
  const out = {}
  for (const r of Array.isArray(records) ? records : []) {
    if (r && APPROVAL_SLOTS.includes(r.slot) && !r.revoked_at) out[r.slot] = r
  }
  return out
}

/** The match.officials entry of a MatchEnd role (scorer, ref2, ref1), or null. */
export function officialFor(match, role) {
  const key = role === 'scorer' ? 'scorer' : role === 'ref1' ? 'ref1' : role === 'ref2' ? 'ref2' : null
  if (!key || !Array.isArray(match?.officials)) return null
  const aliases = OFFICIAL_ROLES[key].aliases
  return match.officials.find(o => aliases.includes(String(o?.role || '').toLowerCase()) || aliases.includes(o?.role)) || null
}

/** "Last First", as the PDF's name column shows it. */
export function officialName(official) {
  if (!official) return ''
  return `${official.lastName || ''} ${official.firstName || ''}`.trim().replace(/\s+/g, ' ')
}

const nameTokens = (name) => String(name || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .split(/[\s,]+/)
  .filter(Boolean)
  .sort()
  .join(' ')

/**
 * True when both names are given and differ, ignoring case, accents and word
 * order ("Müller Anna" = "anna muller").
 */
export function namesDiffer(accountName, enteredName) {
  const a = nameTokens(accountName)
  const b = nameTokens(enteredName)
  return !!a && !!b && a !== b
}

// ── Per-device memory (localStorage; never in match.officials) ──

const DEVICE_KEY = 'ov.deviceId'
const EMAILS_KEY = 'ov.approvalEmails'
export const APPROVAL_EMAILS_MAX = 50

function randomUuid() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch { /* fall through */ }
  const b = new Uint8Array(16)
  try { crypto.getRandomValues(b) } catch { for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256) }
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A random id for this device (localStorage 'ov.deviceId'); null without storage. */
export function deviceId(storage = globalThis.localStorage) {
  try {
    const existing = storage.getItem(DEVICE_KEY)
    if (existing && UUID_RE.test(existing)) return existing
    const id = randomUuid()
    storage.setItem(DEVICE_KEY, id)
    return storage.getItem(DEVICE_KEY) === id ? id : null
  } catch {
    return null
  }
}

const memoryKey = (officialNameText) => String(officialNameText || '').trim().replace(/\s+/g, ' ').toLowerCase()

function readEmails(storage) {
  const raw = storage.getItem(EMAILS_KEY)
  const list = raw ? JSON.parse(raw) : []
  return Array.isArray(list) ? list.filter(e => e && typeof e.k === 'string' && typeof e.e === 'string') : []
}

/**
 * Remember which email an official approved with on this device, keyed by
 * the lower-cased "last first" name. At most 50 entries, least recently used
 * dropped first. A convenience only: failures are ignored.
 */
export function rememberApprovalEmail(officialNameText, email, storage = globalThis.localStorage) {
  const k = memoryKey(officialNameText)
  const e = String(email || '').trim().toLowerCase()
  if (!k || !e) return
  try {
    const list = readEmails(storage).filter(x => x.k !== k)
    list.push({ k, e })
    storage.setItem(EMAILS_KEY, JSON.stringify(list.slice(-APPROVAL_EMAILS_MAX)))
  } catch { /* storage full or blocked */ }
}

/** The email remembered for an official's name on this device, or ''. */
export function recallApprovalEmail(officialNameText, storage = globalThis.localStorage) {
  const k = memoryKey(officialNameText)
  if (!k) return ''
  try {
    return readEmails(storage).find(x => x.k === k)?.e || ''
  } catch {
    return ''
  }
}

// ── Sync queue ──

/** Statuses of a sync job that has not reached the server yet. */
export const PENDING_SYNC_STATUSES = Object.freeze(['queued', 'sending', 'error'])

/**
 * Does a sync_queue job write this match (its row, a set or an event)?
 * Set and event ids are namespaced "<seed_key>:s:<id>" / ":e:"; a few older
 * set updates carry the bare local id, which counts for any match.
 */
export function syncJobTouchesMatch(job, seedKey) {
  if (!job || !seedKey) return false
  const p = job.payload || {}
  if (job.resource === 'match') return p.id === seedKey || p.external_id === seedKey || p.match?.external_id === seedKey
  if (job.resource === 'set' || job.resource === 'event') {
    if (p.match_id === seedKey) return true
    const ext = String(p.external_id ?? p.id ?? '')
    return ext.startsWith(`${seedKey}:`) || /^\d+$/.test(ext)
  }
  return false
}

/** The jobs of this match that the server has not received yet. */
export function pendingSyncJobsFor(jobs, seedKey) {
  return (Array.isArray(jobs) ? jobs : []).filter(j => PENDING_SYNC_STATUSES.includes(j?.status) && syncJobTouchesMatch(j, seedKey))
}

/**
 * What the approval summary in the approve sync job carries: per role
 * { short_id, name, approved_at } or null. No user ids, no emails.
 */
export function approvalSummary(match, sets) {
  const out = {}
  for (const role of ['ref1', 'ref2', 'scorer']) {
    const a = approvalFor(match, role)
    out[role] = isApprovalValid(a, sets) ? { short_id: a.short_id, name: a.name, approved_at: a.approved_at } : null
  }
  return out
}
