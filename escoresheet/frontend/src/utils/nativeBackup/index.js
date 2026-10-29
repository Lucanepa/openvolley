/**
 * Native auto-backup for the OpenVolley apps (desktop Tauri, Android Capacitor).
 * One engine per app session, shared by useAutoBackup (App) and the scoreboard
 * Options modal.
 */

import { useEffect, useSyncExternalStore } from 'react'
import { detectBackupPlatform, isNativeBackupPlatform, createPlatformStore } from './platform'
import { createNativeBackupEngine } from './engine'
import { isContinuedElsewhere } from '../matchReopen'

export { detectBackupPlatform, isNativeBackupPlatform } from './platform'
export { subscribeMatchWrites } from './matchWriteHook'

let enginePromise = null
let engine = null
const EMPTY_STATUS = { folder: null, lastBackup: null, lastFile: null, error: null, count: 0 }

/** The app's backup engine, or null in a browser. */
export function getNativeBackupEngine() {
  if (!isNativeBackupPlatform(detectBackupPlatform())) return Promise.resolve(null)
  if (!enginePromise) {
    enginePromise = (async () => {
      const [store, { exportMatchData }] = await Promise.all([
        createPlatformStore(),
        import('../backupManager')
      ])
      // No new file of a copy another device went on with: its state is older
      // than the match's (2026-10-29, match 406970)
      engine = createNativeBackupEngine({ store, exportMatch: exportMatchData, skipMatch: isContinuedElsewhere })
      engine.subscribe(emit)
      emit()
      return engine
    })().catch((e) => {
      console.error('[NativeBackup] cannot start:', e)
      enginePromise = null
      return null
    })
  }
  return enginePromise
}

// useSyncExternalStore plumbing (works before the engine has loaded)
const listeners = new Set()
function emit() {
  for (const l of listeners) l()
}
function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const getSnapshot = () => (engine ? engine.getStatus() : EMPTY_STATUS)

/** Live backup status { folder, lastBackup, lastFile, error, count } for the UI. */
export function useNativeBackupStatus() {
  const status = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  useEffect(() => {
    getNativeBackupEngine().then(e => e?.loadFolder())
  }, [])
  return status
}

/** Opens the backup folder in the file manager (desktop). */
export async function openNativeBackupFolder() {
  const e = await getNativeBackupEngine()
  if (!e?.store?.canOpenFolder) return false
  return e.store.openFolder()
}

/**
 * Native file picker opened on the backup folder (desktop). Resolves to the
 * parsed backup, null when cancelled, or undefined when the platform has no
 * native picker (use the browser file input instead).
 */
export async function pickNativeBackupFile() {
  const e = await getNativeBackupEngine()
  if (!e?.store?.canPickFile) return undefined
  return e.store.pickFile()
}
