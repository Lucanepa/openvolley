import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { loadCloudBackup } from '../utils/logger'
import { formatBackupDateTime } from '../utils/dateFormatter'
import { cn } from '../ui'

/**
 * Format event type for display
 */
function formatEventType(type, t) {
  const typeMap = {
    'point': t('backupTable.eventTypes.point', 'Point'),
    'timeout': t('backupTable.eventTypes.timeout', 'Timeout'),
    'substitution': t('backupTable.eventTypes.substitution', 'Substitution'),
    'libero_entry': t('backupTable.eventTypes.liberoEntry', 'Libero entry'),
    'libero_exit': t('backupTable.eventTypes.liberoExit', 'Libero exit'),
    'libero_exchange': t('backupTable.eventTypes.liberoExchange', 'Libero exchange'),
    'libero_unable': t('backupTable.eventTypes.liberoUnable', 'Libero unable'),
    'libero_redesignation': t('backupTable.eventTypes.liberoRedesignation', 'Libero redesignation'),
    'set_start': t('backupTable.eventTypes.setStart', 'Set start'),
    'set_end': t('backupTable.eventTypes.setEnd', 'Set end'),
    'coin_toss': t('backupTable.eventTypes.coinToss', 'Coin toss'),
    'rotation': t('backupTable.eventTypes.rotation', 'Rotation'),
    'sanction': t('backupTable.eventTypes.sanction', 'Sanction'),
    'challenge': t('backupTable.eventTypes.challenge', 'Challenge'),
    'decision_change': t('backupTable.eventTypes.decisionChange', 'Decision change')
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
    <div className="ov-kit divide-y divide-stone-100">
      {/* Table Header (kit sticky table head) */}
      <div
        className="sticky top-0 z-10 grid items-center gap-0.5 border-b border-stone-200 bg-stone-50 px-2.5 py-2 text-[11px] font-bold uppercase tracking-wide text-stone-500"
        style={{ gridTemplateColumns: gridColumns }}
      >
        {(hasMixedSources || hasAnyPb) && <span className="text-center"></span>}
        <span className="text-center">{t('backupTable.gameN', 'Game N')}</span>
        <span className="text-center">{t('backupTable.set', 'Set')}</span>
        <span className="text-center">{t('backupTable.score', 'Score')}</span>
        <span >{t('backupTable.lastAction', 'Last action')}</span>
        <span className="text-right">{t('backupTable.createdAt', 'Created at')}</span>
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
        // PocketBase snapshots and the cloud match itself show their status
        const lastAction = isPb || backup.source === 'database'
          ? (backup.status || '—')
          : (loadingActions[backup.path]
            ? t('common.loading', 'Loading...')
            : (lastActions[backup.path] || t('common.unknown', 'Unknown')))

        const isDisabled = loading || loadingBackupPath === backup.path

        const rowStyle = { gridTemplateColumns: gridColumns }
        const rowCls = cn(
          'grid w-full min-h-11 items-center gap-0.5 px-2.5 py-2 text-left text-xs text-stone-800 tabular-nums transition-colors',
          isDisabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-stone-50'
        )
        const sourceDot = (
          <span className="text-center">
            <span
              className={cn('inline-block h-2 w-2 rounded-full', isPb ? 'bg-green-500' : 'bg-violet-500')}
              title={isPb ? 'PocketBase' : 'Cloud'}
            />
          </span>
        )

        if (mode === 'button') {
          // App.jsx mode - entire row is a button
          return (
            <button
              key={backup.match_id || backup.name}
              onClick={() => !isDisabled && onBackupSelect(backup)}
              disabled={isDisabled}
              type="button"
              className={cn(rowCls, 'rounded-none bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-400/60')}
              style={rowStyle}
            >
              {(hasMixedSources || hasAnyPb) && sourceDot}
              <span className="text-center font-semibold">{backup.gameN || 'N/A'}</span>
              <span className="text-center">{backup.setIndex || 'N/A'}</span>
              <span className="text-center font-semibold text-stone-900">
                {backup.leftScore !== undefined && backup.rightScore !== undefined
                  ? `${backup.leftScore}:${backup.rightScore}`
                  : 'N/A'}
              </span>
              <span className="text-[11px] text-stone-500">
                {lastAction}
              </span>
              <span className="text-right text-[11px] text-stone-500">
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
              className={rowCls}
              style={rowStyle}
            >
              {(hasMixedSources || hasAnyPb) && sourceDot}
              <span className="text-center font-semibold">{backup.gameN || 'N/A'}</span>
              <span className="text-center">{backup.setIndex || 'N/A'}</span>
              <span className="text-center font-semibold text-stone-900">
                {backup.leftScore !== undefined && backup.rightScore !== undefined
                  ? `${backup.leftScore}:${backup.rightScore}`
                  : 'N/A'}
              </span>
              <span className="text-[11px] text-stone-500">
                {lastAction}
              </span>
              <span className="text-right text-[11px] text-stone-500">
                {formattedTime}
              </span>
              {showRestoreButton && (
                <div className="rounded-lg border border-stone-300 bg-white px-2 py-1 text-center text-[11px] font-medium text-stone-700">
                  {restoreButtonText}
                </div>
              )}
            </div>
          )
        }
      })}
    </div>
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
