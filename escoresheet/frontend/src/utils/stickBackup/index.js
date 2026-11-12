/**
 * USB stick copies of the match backups (desktop app, phase 1).
 *
 * "Copy to stick now" (Options, backup section) saves the open match with
 * the backup engine (nativeBackup backupNow) and copies that file, as the
 * engine wrote it (encrypted with the match's game PIN and referee PIN, a
 * test match plain), to every stick plugged in:
 *
 *   <stick>/OpenVolley/<matchDir>/<devtag>-latest.json
 *   <stick>/OpenVolley/<matchDir>/<devtag>-manual-<yyyymmddThhmmss>Z.json
 *
 * devtag: the first 8 hex of SHA-256 of this installation's id
 * (utils/deviceId), so several computers can share one stick without
 * overwriting each other's files. Every copy is read back from the stick and
 * checked (stick.rs). Never blocks scoring: nothing here runs unless the
 * scorer asks.
 *
 * The stick list is polled (every 4 s) only while the Options backup section
 * is open, and not while the page is hidden. Later phases add the automatic
 * copy of every backup, the set-end reminder, the match-end check and
 * restoring from a stick.
 */

import { useEffect, useSyncExternalStore } from 'react'
import { createStickPlatform, stickErrorCode } from './platform'
import { getNativeBackupEngine } from '../nativeBackup'
import { deviceId } from '../deviceId'

export { STICK_ERRORS, stickErrorCode } from './platform'

export const STICK_POLL_MS = 4000
/** Below this a stick is shown as full (a copy needs the file + 8 MiB). */
export const STICK_FULL_BYTES = 16 * 1024 * 1024

const pad = (n) => String(n).padStart(2, '0')

/** 2026-11-12T10:15:00.123Z -> "20261112T101500Z" (UTC). */
export function compactStamp(date) {
  const d = date instanceof Date ? date : new Date(date)
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
}

// FNV-1a, 32 bit: only when there is no WebCrypto (not on http://localhost)
function fnv8(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** This computer's tag in the stick file names: 8 hex of SHA-256(deviceId). */
export async function deviceTagOf(id) {
  const text = String(id || 'no-device-id')
  try {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    return [...new Uint8Array(digest).slice(0, 4)].map(b => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return fnv8(text)
  }
}

let tagPromise = null
const defaultDeviceTag = () => {
  if (!tagPromise) tagPromise = deviceTagOf(deviceId())
  return tagPromise
}

const EMPTY = { supported: false, sticks: [], lastCopy: null, writing: false, error: null }

/**
 * @param {object} o
 * @param {ReturnType<typeof createStickPlatform>} o.platform the stick commands (null: not the desktop app)
 * @param {() => Promise<object|null>} o.getEngine the nativeBackup engine
 */
export function createStickBackup({
  platform,
  getEngine,
  deviceTag = defaultDeviceTag,
  now = () => new Date(),
  pollMs = STICK_POLL_MS,
  doc = typeof document !== 'undefined' ? document : undefined,
  log = console
}) {
  let state = { ...EMPTY, supported: !!platform }
  const listeners = new Set()
  const set = (patch) => {
    state = { ...state, ...patch }
    for (const l of listeners) {
      try { l(state) } catch { /* a listener never breaks the store */ }
    }
  }

  let listing = null
  async function refresh() {
    if (!platform) return []
    if (!listing) {
      listing = platform.list()
        .then((sticks) => {
          set({ sticks: Array.isArray(sticks) ? sticks : [], error: null })
          return state.sticks
        })
        .catch((e) => {
          log.warn?.('[StickBackup] cannot list the sticks:', e?.message || e)
          set({ sticks: [], error: e?.message || String(e) })
          return []
        })
        .finally(() => { listing = null })
    }
    return listing
  }

  // Polling while someone looks (refcounted), paused while the page is hidden
  let pollers = 0
  let timer = null
  const hidden = () => !!doc?.hidden
  function tick() {
    timer = null
    if (!pollers || hidden()) return
    refresh().finally(() => {
      if (pollers && !timer && !hidden()) timer = setTimeout(tick, pollMs)
    })
  }
  const onVisibility = () => {
    if (pollers && !hidden() && !timer) tick()
  }
  function startPolling() {
    if (!platform) return () => {}
    pollers += 1
    if (pollers === 1) {
      doc?.addEventListener?.('visibilitychange', onVisibility)
      tick()
    }
    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      pollers -= 1
      if (pollers > 0) return
      doc?.removeEventListener?.('visibilitychange', onVisibility)
      if (timer) clearTimeout(timer)
      timer = null
    }
  }

  /**
   * Saves the match and copies its backup file to every stick present.
   * Resolves to { status, results, error? }: status 'ok' | 'partial' |
   * 'failed' | 'noStick' | 'backupFailed' | 'unsupported'; results one per
   * stick ({ id, label, ok, error?, message? }). Never throws.
   */
  let copying = null
  function copyMatch(matchId) {
    if (!platform) return Promise.resolve({ status: 'unsupported', results: [] })
    if (copying) return copying
    copying = (async () => {
      set({ writing: true })
      try {
        const engine = await getEngine()
        if (!engine) return { status: 'backupFailed', results: [], error: 'no backup engine' }
        const before = engine.lastWrittenOf?.(matchId) || null
        const status = await engine.backupNow(matchId)
        const file = engine.lastWrittenOf?.(matchId) || null
        if (!file || file === before) {
          return { status: 'backupFailed', results: [], error: status?.error || 'no backup file was written' }
        }
        const tag = await deviceTag()
        const copy = (stickIds, destFile) =>
          platform.mirror({ stickIds, matchDir: file.dir, sourceFile: file.name, destFile, verify: true })
        // -latest.json first: what a restore picks; then this copy's own file
        const first = await copy(null, `${tag}-latest.json`)
        if (!first.length) return { status: 'noStick', results: [] }
        const okIds = first.filter(r => r.ok).map(r => r.id)
        const second = okIds.length ? await copy(okIds, `${tag}-manual-${compactStamp(now())}.json`) : []
        const results = first.map((r) => {
          const m = r.ok && second.find(x => x.id === r.id)
          return m && !m.ok ? { ...m, label: m.label || r.label } : r
        })
        const okCount = results.filter(r => r.ok).length
        if (okCount) set({ lastCopy: { at: now(), matchId, dir: file.dir, results } })
        return { status: okCount === results.length ? 'ok' : okCount ? 'partial' : 'failed', results }
      } catch (e) {
        log.error?.('[StickBackup] copy failed:', e)
        return { status: 'failed', results: [], error: e?.message || String(e), code: stickErrorCode(e) }
      } finally {
        set({ writing: false })
        copying = null
        refresh() // free space, the new folder
      }
    })()
    return copying
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh,
    startPolling,
    copyMatch
  }
}

// The app's one instance (created on first use)
let instance = null
export function getStickBackup() {
  if (!instance) instance = createStickBackup({ platform: createStickPlatform(), getEngine: getNativeBackupEngine })
  return instance
}

const subscribe = (l) => getStickBackup().subscribe(l)
const getSnapshot = () => getStickBackup().getState()

/** Live { supported, sticks, lastCopy, writing, error }; poll: list the sticks every 4 s while mounted. */
export function useStickBackup({ poll = false } = {}) {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  useEffect(() => (poll ? getStickBackup().startPolling() : undefined), [poll])
  return snapshot
}

/** "Copy to stick now": see createStickBackup copyMatch. */
export function copyMatchToSticks(matchId) {
  return getStickBackup().copyMatch(matchId)
}
