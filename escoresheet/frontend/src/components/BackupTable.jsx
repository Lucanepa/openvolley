import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { loadCloudBackup } from '../utils/logger'
import { formatBackupDateTime } from '../utils/dateFormatter'

/**
 * Format event type for display
 */
function formatEventType(type, t) {
  const typeMap = {
    'point': t('backupTable.eventTypes.point', 'Point'),
    'timeout': t('backupTable.eventTypes.timeout', 'Timeout'),
    'substitution': t('backupTable.eventTypes.substitution', 'Substitution'),
    'libero_entry': t('backupTable.eventTypes.liberoEntry', 'Libero Entry'),
    'libero_exit': t('backupTable.eventTypes.liberoExit', 'Libero Exit'),
    'libero_exchange': t('backupTable.eventTypes.liberoExchange', 'Libero Exchange'),
    'libero_unable': t('backupTable.eventTypes.liberoUnable', 'Libero Unable'),
    'libero_redesignation': t('backupTable.eventTypes.liberoRedesignation', 'Libero Redesignation'),
    'set_start': t('backupTable.eventTypes.setStart', 'Set Start'),
    'set_end': t('backupTable.eventTypes.setEnd', 'Set End'),
    'coin_toss': t('backupTable.eventTypes.coinToss', 'Coin Toss'),
    'rotation': t('backupTable.eventTypes.rotation', 'Rotation'),
    'sanction': t('backupTable.eventTypes.sanction', 'Sanction'),
    'challenge': t('backupTable.eventTypes.challenge', 'Challenge'),
    'decision_change': t('backupTable.eventTypes.decisionChange', 'Decision Change')
  }
  return typeMap[type] || type.charAt(0).toUpperCase() + type.slice(1).replace('_', ' ')
}

/**
 * Extract the last significant action from backup events
 * Filters out sub-events (decimal seq), rally_start, and replay events
 * Returns the most recent main event type
 */
function extractLastAction(events, t) {
  if (!events || events.length === 0) return null

  // Filter and sort events
  const lastEvent = events
    .filter(event => {
      // Filter out sub-events (rotation events with decimal seq like 1.1, 1.2)
      if (event.seq && event.seq % 1 !== 0) return false

      // Filter out rally_start and replay (not significant for display)
      if (['rally_start', 'replay'].includes(event.type)) return false

      return true
    })
    .sort((a, b) => (b.seq || 0) - (a.seq || 0))[0]

  return lastEvent ? formatEventType(lastEvent.type, t) : null
}

/**
 * BackupTable - Reusable component for displaying cloud backups
 */
export default function BackupTable({
  backups = [],
  onBackupSelect,
  loading = false,
  showRestoreButton = false,
  mode = 'button', // 'button' = entire row is clickable, 'row' = row clickable with separate button
  loadingBackupPath = null,
  restoreButtonText = 'Restore'
}) {
  const { t } = useTranslation()
  const [lastActions, setLastActions] = useState({})
  const [loadingActions, setLoadingActions] = useState({})

  // Fetch last actions for cloud backups (PocketBase entries don't need fetching)
  useEffect(() => {
    if (backups.length === 0) return

    const cloudBackups = backups.filter(b => b.source !== 'pocketbase' && b.path)
    if (cloudBackups.length === 0) return

    const fetchLastActions = async () => {
      const actions = {}
      const loadingStates = {}

      // Mark cloud backups as loading
      cloudBackups.forEach(backup => {
        loadingStates[backup.path] = true
      })
      setLoadingActions(loadingStates)

      // Fetch all in parallel
      await Promise.all(
        cloudBackups.map(async (backup) => {
          try {
            const backupData = await loadCloudBackup(backup.path)
            if (backupData && backupData.events) {
              actions[backup.path] = extractLastAction(backupData.events, t)
            } else {
              actions[backup.path] = t('backupTable.noActions', 'No actions')
            }
          } catch (err) {
            console.error(`Failed to load backup ${backup.path}:`, err)
            actions[backup.path] = t('backupTable.error', 'Error')
          }
        })
      )

      setLastActions(actions)
      setLoadingActions({})
    }

    fetchLastActions()
  }, [backups, t])

  if (backups.length === 0) {
    return null
  }

  const hasMixedSources = backups.some(b => b.source === 'pocketbase') && backups.some(b => b.source !== 'pocketbase')
  const hasAnyPb = backups.some(b => b.source === 'pocketbase')
  const sourceColWidth = (hasMixedSources || hasAnyPb) ? '32px ' : ''
  const gridColumns = showRestoreButton
    ? `${sourceColWidth}60px 35px 70px 90px 1fr 70px`
    : `${sourceColWidth}60px 35px 70px 90px 1fr`

  return (
    <>
      {/* Table Header */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: gridColumns,
        gap: '2px',
        padding: '8px 10px',
        fontSize: '11px',
        fontWeight: 600,
        color: 'rgba(255,255,255,0.5)',
        borderBottom: '2px solid rgba(255,255,255,0.2)',
        marginBottom: '2px',
        alignItems: 'center'
      }}>
        {(hasMixedSources || hasAnyPb) && <span style={{ textAlign: 'center' }}></span>}
        <span style={{ textAlign: 'center' }}>{t('backupTable.gameN', 'Game N')}</span>
        <span style={{ textAlign: 'center' }}>{t('backupTable.set', 'Set')}</span>
        <span style={{ textAlign: 'center' }}>{t('backupTable.score', 'Score')}</span>
        <span >{t('backupTable.lastAction', 'Last Action')}</span>
        <span style={{ textAlign: 'right' }}>{t('backupTable.createdAt', 'Created At')}</span>
        {showRestoreButton && <span></span>}
      </div>

      {/* Table Rows - sorted by created_at descending (newest first) */}
      {[...backups].sort((a, b) => {
        // Sort by date/time descending (newest first)
        // Backups have date (YYYYMMDD), time (HHmmss), and ms fields
        const getTimestamp = (backup) => {
          if (backup.date && backup.time) {
            // Parse date YYYYMMDD and time HHmmss
            const dateStr = backup.date
            const timeStr = backup.time.padStart(6, '0')
            const ms = backup.ms || 0
            return new Date(
              parseInt(dateStr.slice(0, 4)),
              parseInt(dateStr.slice(4, 6)) - 1,
              parseInt(dateStr.slice(6, 8)),
              parseInt(timeStr.slice(0, 2)),
              parseInt(timeStr.slice(2, 4)),
              parseInt(timeStr.slice(4, 6)),
              ms
            ).getTime()
          }
          if (backup.created_at || backup.updated_at) {
            return new Date(backup.created_at || backup.updated_at).getTime()
          }
          return 0
        }
        return getTimestamp(b) - getTimestamp(a)
      }).map((backup, index) => {
        const formattedTime = backup.date && backup.time
          ? formatBackupDateTime(backup.date, backup.time, backup.ms)
          : (backup.created_at || backup.updated_at ? new Date(backup.created_at || backup.updated_at).toLocaleString() : 'Unknown')

        const isPb = backup.source === 'pocketbase'
        const lastAction = isPb
          ? (backup.status || '—')
          : (loadingActions[backup.path]
            ? t('common.loading', 'Loading...')
            : (lastActions[backup.path] || t('common.unknown', 'Unknown')))

        const isDisabled = loading || loadingBackupPath === backup.path

        const rowStyle = {
          display: 'grid',
          gridTemplateColumns: gridColumns,
          gap: '2px',
          alignItems: 'center',
          padding: '8px 10px',
          background: index % 2 === 0 ? 'rgba(255,255,255,0.05)' : 'transparent',
          cursor: isDisabled ? 'not-allowed' : 'pointer',
          textAlign: 'left'
        }

        if (mode === 'button') {
          // App.jsx mode - entire row is a button
          return (
            <button
              key={backup.match_id || backup.name}
              onClick={() => !isDisabled && onBackupSelect(backup)}
              disabled={isDisabled}
              style={{
                ...rowStyle,
                width: '100%',
                color: 'var(--text)',
                border: 'none',
                borderBottom: index < backups.length - 1 ? '1px solid rgba(255,255,255,0.1)' : 'none',
                fontSize: '12px'
              }}
            >
              {(hasMixedSources || hasAnyPb) && (
                <span style={{ textAlign: 'center' }}>
                  <span style={{
                    display: 'inline-block',
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: isPb ? '#22c55e' : '#8b5cf6',
                    title: isPb ? 'PocketBase' : 'Cloud'
                  }} />
                </span>
              )}
              <span style={{ fontWeight: 600, textAlign: 'center' }}>{backup.gameN || 'N/A'}</span>
              <span style={{ textAlign: 'center' }}>{backup.setIndex || 'N/A'}</span>
              <span style={{ fontWeight: 600, color: '#22c55e', textAlign: 'center' }}>
                {backup.leftScore !== undefined && backup.rightScore !== undefined
                  ? `${backup.leftScore}:${backup.rightScore}`
                  : 'N/A'}
              </span>
              <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: '11px' }}>
                {lastAction}
              </span>
              <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.6)', textAlign: 'right' }}>
                {formattedTime}
              </span>
              {showRestoreButton && <div></div>}
            </button>
          )
        } else {
          // ScoreboardOptionsModal mode - row clickable with separate restore button
          return (
            <div
              key={backup.match_id || backup.name}
              onClick={() => !isDisabled && onBackupSelect(backup)}
              style={{
                ...rowStyle,
                width: '100%',
                borderRadius: '4px',
                transition: 'background 0.2s'
              }}
              onMouseEnter={(e) => !isDisabled && (e.currentTarget.style.background = 'rgba(59, 130, 246, 0.2)')}
              onMouseLeave={(e) => e.currentTarget.style.background = index % 2 === 0 ? 'rgba(255,255,255,0.05)' : 'transparent'}
            >
              {(hasMixedSources || hasAnyPb) && (
                <span style={{ textAlign: 'center' }}>
                  <span style={{
                    display: 'inline-block',
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: isPb ? '#22c55e' : '#8b5cf6',
                    title: isPb ? 'PocketBase' : 'Cloud'
                  }} />
                </span>
              )}
              <span style={{ fontWeight: 600, fontSize: '12px', textAlign: 'center' }}>{backup.gameN || 'N/A'}</span>
              <span style={{ fontSize: '12px', textAlign: 'center' }}>{backup.setIndex || 'N/A'}</span>
              <span style={{ fontWeight: 600, fontSize: '12px', color: '#22c55e', textAlign: 'center' }}>
                {backup.leftScore !== undefined && backup.rightScore !== undefined
                  ? `${backup.leftScore}:${backup.rightScore}`
                  : 'N/A'}
              </span>
              <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.7)' }}>
                {lastAction}
              </span>
              <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.6)', textAlign: 'right' }}>
                {formattedTime}
              </span>
              {showRestoreButton && (
                <div style={{
                  padding: '4px 8px',
                  fontSize: '11px',
                  fontWeight: 600,
                  background: 'rgba(34, 197, 94, 0.2)',
                  color: '#22c55e',
                  borderRadius: '4px',
                  textAlign: 'center'
                }}>
                  {restoreButtonText}
                </div>
              )}
            </div>
          )
        }
      })}
    </>
  )
}

// PropTypes removed to avoid dependency issues
// Expected props:
// - backups: array (required)
// - onBackupSelect: function (required)
// - loading: boolean
// - showRestoreButton: boolean
// - mode: 'button' | 'row'
// - loadingBackupPath: string
// - restoreButtonText: string
