/**
 * useAutoBackup Hook - Automatic backup to file system or periodic downloads
 *
 * Apps (desktop Tauri, Android Capacitor): a native backup file at every
 *   scoring event, written by utils/nativeBackup (on by default, no browser API).
 * Chrome/Edge: Real-time backup to selected folder via File System Access API
 * Safari/Firefox: Periodic auto-downloads (every N minutes + on set/match end)
 *
 * Only on the scoretable page (utils/appEntry): a referee, bench or livescore
 * page never backs anything up. A browser download needs something new to
 * save: opening or loading a match never downloads a file; only a scoring
 * write since the last backup (periodic) or the end of a set / the match does.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { db } from '../db/db'
import {
  isFileSystemAccessSupported,
  getStoredDirectoryHandle,
  verifyDirectoryPermission,
  selectBackupDirectory,
  clearStoredDirectoryHandle,
  writeMatchBackup,
  downloadMatchBackup,
  getBackupSettings,
  saveBackupSettings
} from '../utils/backupManager'
import {
  detectBackupPlatform,
  isNativeBackupPlatform,
  getNativeBackupEngine,
  subscribeMatchWrites,
  useNativeBackupStatus,
  openNativeBackupFolder
} from '../utils/nativeBackup'
import { setActiveMatch } from '../utils/activity/activeMatch'
import { isScorerEntry } from '../utils/appEntry'

/** The Scoreboard events that download a backup in a browser without a folder */
export const BROWSER_DOWNLOAD_EVENTS = new Set(['set_end', 'match_end'])

export default function useAutoBackup(activeMatchId = null) {
  // Apps write native backups; browsers keep the folder / download behaviour
  const [platform] = useState(() => detectBackupPlatform())
  // Backups are the scoretable's job only (never a tablet's referee / bench page)
  const [scorerPage] = useState(() => isScorerEntry())
  const nativeMode = isNativeBackupPlatform(platform)
  const nativeStatus = useNativeBackupStatus()

  // State
  const [backupDirName, setBackupDirName] = useState(null)
  const [backupDirHandle, setBackupDirHandle] = useState(null)
  const [lastBackup, setLastBackup] = useState(null)
  const [backupError, setBackupError] = useState(null)
  const [isBackingUp, setIsBackingUp] = useState(false)
  const [autoBackupEnabled, setAutoBackupEnabled] = useState(() => {
    return getBackupSettings({ native: nativeMode }).autoBackupEnabled
  })
  const [backupFrequency, setBackupFrequency] = useState(() => {
    return getBackupSettings().backupFrequencyMinutes
  })

  // Refs for debouncing and intervals
  const debounceTimer = useRef(null)
  const downloadIntervalRef = useRef(null)
  const lastDownloadTime = useRef(0)
  // A scoring write of the open match since its last browser backup
  const matchChanged = useRef(false)

  // Settings stay as stored; nothing runs on a page that is not the scoretable
  const autoOn = scorerPage && autoBackupEnabled

  // Check if File System Access API is available (never used in the apps:
  // WebView2 exposes it, but the native backup replaces it there)
  const hasFileSystemAccess = !nativeMode && isFileSystemAccessSupported()

  // The open match tags the interaction and activity logs (utils/activity)
  useEffect(() => {
    let cancelled = false
    if (activeMatchId == null) {
      setActiveMatch(null)
      return undefined
    }
    Promise.resolve()
      .then(() => db.matches?.get?.(activeMatchId))
      .then((m) => { if (!cancelled) setActiveMatch(m || null) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [activeMatchId])

  // Apps: back up the open match after every committed write of it (events,
  // sets, match row). Runs in the background; never blocks scoring.
  useEffect(() => {
    if (!nativeMode || !autoOn || activeMatchId == null) return
    let cancelled = false
    let unsubscribe = () => {}
    getNativeBackupEngine().then((engine) => {
      if (!engine || cancelled) return
      unsubscribe = subscribeMatchWrites(db, activeMatchId, () => engine.notify(activeMatchId))
      engine.notify(activeMatchId) // state when the match is opened
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [nativeMode, autoOn, activeMatchId])

  // Browsers: remember whether the open match changed since its last backup.
  // Opening (or reloading) a match is no change: the periodic download and the
  // folder backup wait for a real write.
  useEffect(() => {
    matchChanged.current = false
    lastDownloadTime.current = Date.now()
    if (nativeMode || !autoOn || activeMatchId == null) return
    return subscribeMatchWrites(db, activeMatchId, () => { matchChanged.current = true })
  }, [nativeMode, autoOn, activeMatchId])

  // Load stored directory handle on mount
  useEffect(() => {
    async function loadStoredHandle() {
      if (!hasFileSystemAccess) return

      try {
        const handle = await getStoredDirectoryHandle()
        if (handle) {
          const hasPermission = await verifyDirectoryPermission(handle)
          if (hasPermission) {
            setBackupDirHandle(handle)
            setBackupDirName(handle.name)
          } else {
            // Permission denied, clear stored handle
            await clearStoredDirectoryHandle()
          }
        }
      } catch (error) {
        console.error('Error loading stored backup directory:', error)
      }
    }

    loadStoredHandle()
  }, [hasFileSystemAccess])

  // Handle selecting backup directory
  const handleSelectBackupDir = useCallback(async () => {
    try {
      setBackupError(null)
      const handle = await selectBackupDirectory()
      setBackupDirHandle(handle)
      setBackupDirName(handle.name)
      return true
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error('Error selecting backup directory:', error)
        setBackupError(error.message)
      }
      return false
    }
  }, [])

  // Handle clearing backup directory
  const handleClearBackupDir = useCallback(async () => {
    try {
      await clearStoredDirectoryHandle()
      setBackupDirHandle(null)
      setBackupDirName(null)
      setBackupError(null)
    } catch (error) {
      console.error('Error clearing backup directory:', error)
    }
  }, [])

  // Perform backup for a specific match
  const performBackup = useCallback(async (matchId) => {
    if (!matchId || !scorerPage) return false

    setIsBackingUp(true)
    setBackupError(null)

    try {
      if (nativeMode) {
        const engine = await getNativeBackupEngine()
        const result = await engine?.backupNow(matchId)
        if (!result || result.error) {
          setBackupError(result?.error || 'Backup is not available')
          return false
        }
        setLastBackup(result.lastBackup || new Date())
        return true
      }
      // Browsers: the file holds the match as read now, so clear the change
      // flag before reading it; a write during the backup sets it again
      // (cleared after the await, that write would wait for the next one)
      const ofActive = matchId === activeMatchId
      let hadChange = false
      const markSaved = () => {
        hadChange = matchChanged.current
        if (ofActive) matchChanged.current = false
      }
      const markUnsaved = () => { if (ofActive && hadChange) matchChanged.current = true }
      if (hasFileSystemAccess && backupDirHandle) {
        // Chrome/Edge: Write to file system
        const hasPermission = await verifyDirectoryPermission(backupDirHandle)
        if (!hasPermission) {
          setBackupError('Permission denied. Please re-select the backup folder.')
          setBackupDirHandle(null)
          setBackupDirName(null)
          await clearStoredDirectoryHandle()
          return false
        }

        markSaved()
        const result = await writeMatchBackup(matchId, backupDirHandle)
        if (result.success) {
          setLastBackup(new Date())
          return true
        } else {
          markUnsaved()
          setBackupError(result.error)
          return false
        }
      } else {
        // Safari/Firefox: Download file
        markSaved()
        try {
          await downloadMatchBackup(matchId)
        } catch (error) {
          markUnsaved()
          throw error
        }
        setLastBackup(new Date())
        lastDownloadTime.current = Date.now()
        return true
      }
    } catch (error) {
      console.error('Backup error:', error)
      setBackupError(error.message)
      return false
    } finally {
      setIsBackingUp(false)
    }
  }, [scorerPage, nativeMode, hasFileSystemAccess, backupDirHandle, activeMatchId])

  // Debounced backup for real-time changes (Chrome/Edge only)
  const debouncedBackup = useCallback((matchId) => {
    if (!hasFileSystemAccess || !backupDirHandle || !autoOn) return

    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current)
    }

    debounceTimer.current = setTimeout(() => {
      performBackup(matchId)
    }, 500) // 500ms debounce
  }, [hasFileSystemAccess, backupDirHandle, autoOn, performBackup])

  // Subscribe to Dexie changes for real-time backup (Chrome/Edge)
  useEffect(() => {
    if (!hasFileSystemAccess || !backupDirHandle || !autoOn || !activeMatchId) {
      return
    }

    // Subscribe to changes on relevant tables
    const handleChanges = (changes) => {
      // Check if any change is related to our active match
      const relevantChange = changes.some(change => {
        if (change.table === 'matches' && change.key === activeMatchId) return true
        if (change.table === 'sets' && change.obj?.matchId === activeMatchId) return true
        if (change.table === 'events' && change.obj?.matchId === activeMatchId) return true
        return false
      })

      if (relevantChange) {
        debouncedBackup(activeMatchId)
      }
    }

    // Dexie's 'changes' event only exists with the dexie-observable addon, which
    // is NOT installed. Feature-detect so this never throws, and fall back to a
    // periodic backup so continuous folder backup still works on Chrome/Edge.
    let usedChangeEvents = false
    try {
      const ev = db.on && db.on('changes')
      if (ev && typeof ev.subscribe === 'function') {
        ev.subscribe(handleChanges)
        usedChangeEvents = true
      }
    } catch {
      usedChangeEvents = false
    }

    let intervalId = null
    if (!usedChangeEvents) {
      // only after a write of the match: an opened match is not saved again
      intervalId = setInterval(() => {
        if (matchChanged.current) debouncedBackup(activeMatchId)
      }, 15000)
    }

    return () => {
      try {
        if (usedChangeEvents) db.on('changes').unsubscribe(handleChanges)
      } catch { /* addon not present */ }
      if (intervalId) clearInterval(intervalId)
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current)
      }
    }
  }, [hasFileSystemAccess, backupDirHandle, autoOn, activeMatchId, debouncedBackup])

  // Periodic auto-download for Safari/Firefox
  useEffect(() => {
    if (nativeMode || (hasFileSystemAccess && backupDirHandle)) {
      // Chrome/Edge with folder selected - use real-time backup instead
      return
    }

    if (!autoOn || !activeMatchId) {
      if (downloadIntervalRef.current) {
        clearInterval(downloadIntervalRef.current)
        downloadIntervalRef.current = null
      }
      return
    }

    // Set up periodic download interval
    const intervalMs = backupFrequency * 60 * 1000 // Convert minutes to ms

    // Every N minutes after the match was opened or last saved, and only when
    // it changed since: never a download just for opening a match
    const checkAndDownload = () => {
      if (!matchChanged.current) return
      const timeSinceLastDownload = Date.now() - lastDownloadTime.current
      if (timeSinceLastDownload >= intervalMs) {
        performBackup(activeMatchId)
      }
    }

    // Check every minute
    downloadIntervalRef.current = setInterval(checkAndDownload, 60 * 1000)

    return () => {
      if (downloadIntervalRef.current) {
        clearInterval(downloadIntervalRef.current)
        downloadIntervalRef.current = null
      }
    }
  }, [nativeMode, hasFileSystemAccess, backupDirHandle, autoOn, activeMatchId, backupFrequency, performBackup])

  // Toggle auto backup
  const toggleAutoBackup = useCallback((enabled) => {
    setAutoBackupEnabled(enabled)
    saveBackupSettings({ autoBackupEnabled: enabled }, { native: nativeMode })
  }, [nativeMode])

  // Update backup frequency
  const updateBackupFrequency = useCallback((minutes) => {
    setBackupFrequency(minutes)
    saveBackupSettings({ backupFrequencyMinutes: minutes })
  }, [])

  // Trigger immediate backup (can be called externally on set/match end)
  const triggerBackup = useCallback(() => {
    if (activeMatchId && autoOn) {
      performBackup(activeMatchId)
    }
  }, [activeMatchId, autoOn, performBackup])

  // Event-based backup trigger for Safari/Firefox
  // Only downloads if: no File System Access, auto-backup enabled, not in
  // Chrome/Edge with folder, and the event ends a set or the match
  const triggerEventBackup = useCallback((eventType) => {
    // Apps: the write hook already backs up every event; this only nudges it
    if (nativeMode) {
      if (activeMatchId != null && autoOn) {
        getNativeBackupEngine().then(engine => engine?.notify(activeMatchId))
      }
      return
    }
    // Only trigger for Safari/Firefox (no File System Access or no folder selected)
    if (hasFileSystemAccess && backupDirHandle) {
      // Chrome/Edge with folder - already doing real-time backup
      return
    }

    if (!activeMatchId || !autoOn) {
      return
    }

    // The start of a set (a 0:0 file) or a timeout is no reason to download:
    // the periodic download covers the play, the set / match end closes it
    if (!BROWSER_DOWNLOAD_EVENTS.has(eventType)) return

    console.log(`📦 Event backup triggered: ${eventType}`)
    performBackup(activeMatchId)
  }, [nativeMode, hasFileSystemAccess, backupDirHandle, activeMatchId, autoOn, performBackup])

  // Manual backup (always downloads, regardless of settings; apps write a
  // native backup file instead)
  const manualBackup = useCallback(async (matchId) => {
    const targetMatchId = matchId || activeMatchId
    if (!targetMatchId || !scorerPage) return false
    if (nativeMode) return performBackup(targetMatchId)

    setIsBackingUp(true)
    setBackupError(null)

    try {
      await downloadMatchBackup(targetMatchId)
      setLastBackup(new Date())
      return true
    } catch (error) {
      console.error('Manual backup error:', error)
      setBackupError(error.message)
      return false
    } finally {
      setIsBackingUp(false)
    }
  }, [scorerPage, nativeMode, activeMatchId, performBackup])

  const openBackupFolder = useCallback(async () => {
    try {
      return await openNativeBackupFolder()
    } catch (error) {
      console.error('Cannot open the backup folder:', error)
      setBackupError(error?.message || String(error))
      return false
    }
  }, [])

  return {
    // State
    platform,
    nativeMode,
    activeMatchId,
    backupFolder: nativeStatus.folder,
    hasFileSystemAccess,
    backupDirName,
    // Apps: the engine's status (every event), browsers: this hook's
    lastBackup: nativeMode ? (nativeStatus.lastBackup || lastBackup) : lastBackup,
    backupError: nativeMode ? (nativeStatus.error || backupError) : backupError,
    isBackingUp,
    autoBackupEnabled,
    backupFrequency,

    // Actions
    selectBackupDir: handleSelectBackupDir,
    clearBackupDir: handleClearBackupDir,
    toggleAutoBackup,
    updateBackupFrequency,
    triggerBackup,
    triggerEventBackup, // For Safari/Firefox event-based backup
    manualBackup,
    performBackup,
    openBackupFolder,
    canOpenBackupFolder: platform === 'tauri'
  }
}
