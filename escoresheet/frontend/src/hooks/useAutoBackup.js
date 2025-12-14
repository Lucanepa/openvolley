/**
 * useAutoBackup Hook - Automatic backup to file system or periodic downloads
 *
 * Chrome/Edge: Real-time backup to selected folder via File System Access API
 * Safari/Firefox: Periodic auto-downloads (every N minutes + on set/match end)
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

export default function useAutoBackup(activeMatchId = null) {
  // State
  const [backupDirName, setBackupDirName] = useState(null)
  const [backupDirHandle, setBackupDirHandle] = useState(null)
  const [lastBackup, setLastBackup] = useState(null)
  const [backupError, setBackupError] = useState(null)
  const [isBackingUp, setIsBackingUp] = useState(false)
  const [autoBackupEnabled, setAutoBackupEnabled] = useState(() => {
    return getBackupSettings().autoBackupEnabled
  })
  const [backupFrequency, setBackupFrequency] = useState(() => {
    return getBackupSettings().backupFrequencyMinutes
  })

  // Refs for debouncing and intervals
  const debounceTimer = useRef(null)
  const downloadIntervalRef = useRef(null)
  const lastDownloadTime = useRef(0)

  // Check if File System Access API is available
  const hasFileSystemAccess = isFileSystemAccessSupported()

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
    if (!matchId) return false

    setIsBackingUp(true)
    setBackupError(null)

    try {
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

        const result = await writeMatchBackup(matchId, backupDirHandle)
        if (result.success) {
          setLastBackup(new Date())
          return true
        } else {
          setBackupError(result.error)
          return false
        }
      } else {
        // Safari/Firefox: Download file
        await downloadMatchBackup(matchId)
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
  }, [hasFileSystemAccess, backupDirHandle])

  // Debounced backup for real-time changes (Chrome/Edge only)
  const debouncedBackup = useCallback((matchId) => {
    if (!hasFileSystemAccess || !backupDirHandle || !autoBackupEnabled) return

    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current)
    }

    debounceTimer.current = setTimeout(() => {
      performBackup(matchId)
    }, 500) // 500ms debounce
  }, [hasFileSystemAccess, backupDirHandle, autoBackupEnabled, performBackup])

  // Subscribe to Dexie changes for real-time backup (Chrome/Edge)
  useEffect(() => {
    if (!hasFileSystemAccess || !backupDirHandle || !autoBackupEnabled || !activeMatchId) {
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

    // Dexie's on('changes') hook
    db.on('changes', handleChanges)

    return () => {
      db.on('changes').unsubscribe(handleChanges)
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current)
      }
    }
  }, [hasFileSystemAccess, backupDirHandle, autoBackupEnabled, activeMatchId, debouncedBackup])

  // Periodic auto-download for Safari/Firefox
  useEffect(() => {
    if (hasFileSystemAccess && backupDirHandle) {
      // Chrome/Edge with folder selected - use real-time backup instead
      return
    }

    if (!autoBackupEnabled || !activeMatchId) {
      if (downloadIntervalRef.current) {
        clearInterval(downloadIntervalRef.current)
        downloadIntervalRef.current = null
      }
      return
    }

    // Set up periodic download interval
    const intervalMs = backupFrequency * 60 * 1000 // Convert minutes to ms

    const checkAndDownload = () => {
      const now = Date.now()
      const timeSinceLastDownload = now - lastDownloadTime.current

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
  }, [hasFileSystemAccess, backupDirHandle, autoBackupEnabled, activeMatchId, backupFrequency, performBackup])

  // Toggle auto backup
  const toggleAutoBackup = useCallback((enabled) => {
    setAutoBackupEnabled(enabled)
    saveBackupSettings({ autoBackupEnabled: enabled })
  }, [])

  // Update backup frequency
  const updateBackupFrequency = useCallback((minutes) => {
    setBackupFrequency(minutes)
    saveBackupSettings({ backupFrequencyMinutes: minutes })
  }, [])

  // Trigger immediate backup (can be called externally on set/match end)
  const triggerBackup = useCallback(() => {
    if (activeMatchId && autoBackupEnabled) {
      performBackup(activeMatchId)
    }
  }, [activeMatchId, autoBackupEnabled, performBackup])

  // Event-based backup trigger for Safari/Firefox
  // Only downloads if: no File System Access, auto-backup enabled, and not in Chrome/Edge with folder
  const triggerEventBackup = useCallback((eventType) => {
    // Only trigger for Safari/Firefox (no File System Access or no folder selected)
    if (hasFileSystemAccess && backupDirHandle) {
      // Chrome/Edge with folder - already doing real-time backup
      return
    }

    if (!activeMatchId || !autoBackupEnabled) {
      return
    }

    console.log(`📦 Event backup triggered: ${eventType}`)
    performBackup(activeMatchId)
  }, [hasFileSystemAccess, backupDirHandle, activeMatchId, autoBackupEnabled, performBackup])

  // Manual backup (always downloads, regardless of settings)
  const manualBackup = useCallback(async (matchId) => {
    const targetMatchId = matchId || activeMatchId
    if (!targetMatchId) return false

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
  }, [activeMatchId])

  return {
    // State
    hasFileSystemAccess,
    backupDirName,
    lastBackup,
    backupError,
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
    performBackup
  }
}
