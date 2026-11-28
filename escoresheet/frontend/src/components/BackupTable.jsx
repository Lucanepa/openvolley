import { useState, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { fetchCloudBackup } from '../utils/backupManager'
import { isEncryptedBackup } from '../utils/backupCrypto/envelope'
import { formatBackupDateTime, formatZurichDateTime } from '../utils/dateFormatter'
import { displaySetNumber, resolveBestOf } from '../utils/matchFormat'
import { cn } from '../ui'

// "Last action" needs the whole backup file (a match, up to about 1 MB): read
// for the newest rows only, one after another, and for older ones on a tap.
// It read every listed file at once, up to 100 over a hall hotspot, before
// the scorer could pick the one to restore.
export const LAST_ACTION_NEWEST = 3
export const LAST_ACTION_MORE = 5

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
    'libero_recovered': t('backupTable.eventTypes.liberoRecovered', 'Libero able to play again'),
    'libero_redesignation': t('backupTable.eventTypes.liberoRedesignation', 'Libero redesignation'),
    'set_start': t('backupTable.eventTypes.setStart', 'Set start'),
    'set_end': t('backupTable.eventTypes.setEnd', 'Set end'),
    'coin_toss': t('backupTable.eventTypes.coinToss', 'Coin toss'),
    'rotation': t('backupTable.eventTypes.rotation', 'Rotation'),
    'sanction': t('backupTable.eventTypes.sanction', 'Sanction'),
    'challenge': t('backupTable.eventTypes.challenge', 'Challenge'),
    'decision_change': t('backupTable.eventTypes.decisionChange', 'Decision change'),
    'lineup': t('backupTable.eventTypes.lineup', 'Line-up'),
    'forfait': t('backupTable.eventTypes.forfait', 'Forfeit'),
    'court_captain_designation': t('backupTable.eventTypes.gameCaptain', 'Game captain'),
    'remark': t('backupTable.eventTypes.remark', 'Remark'),
    'match_stopped': t('backupTable.eventTypes.matchStopped', 'Match stopped'),
    'set5_coin_toss': t('backupTable.eventTypes.decidingSetCoinToss', 'Coin toss (deciding set)')
  }
  return typeMap[type] || type.charAt(0).toUpperCase() + type.slice(1).replace('_', ' ')
}

// The cloud match row's status (its "Last action"): the raw 'live' / 'ended'
// stayed English in every language (28.11.2026)
const STATUS_LABELS = {
  scheduled: 'Not started',
  setup: 'Set-up',
  live: 'In progress',
  ended: 'Ended',
  approved: 'Approved',
  final: 'Closed'
}
function formatStatus(status, t) {
  if (!status) return '—'
  return STATUS_LABELS[status] ? t(`backupTable.status.${status}`, STATUS_LABELS[status]) : status
}

/**
 * Extract the last significant action from backup events
 * Filters out sub-events (decimal seq), rally_start, and replay events
 * Returns the most recent main event's type (translated when shown)
 */
function extractLastAction(events) {
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

  return lastEvent ? lastEvent.type : null
}

// Newest first: the UTC stamp in the file name (yyyymmdd, hhmmss, ms), else
// the storage's created_at
function backupTime(backup) {
  if (backup.date && backup.time) {
    const d = backup.date
    const t = backup.time.padStart(6, '0')
    return Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6), +(backup.ms || 0))
  }
  const at = backup.created_at || backup.updated_at
  const ms = at ? new Date(at).getTime() : NaN
  return Number.isFinite(ms) ? ms : 0
}

/**
 * BackupTable - Reusable component for displaying cloud backups.
 * unlockPins: the PINs an encrypted cloud copy is opened with for its last
 * action (the game PIN typed to list them, the open match's PINs).
 */
// home:away points of the latest set; lists from before 14.11.2026 called
// them leftScore / rightScore (the same numbers, from the file name)
function backupScore(backup) {
  const home = backup.homeScore ?? backup.leftScore
  const away = backup.awayScore ?? backup.rightScore
  return home !== undefined && away !== undefined ? `${home}:${away}` : 'N/A'
}

export default function BackupTable({
  backups = [],
  onBackupSelect,
  loading = false,
  showRestoreButton = false,
  mode = 'button', // 'button' = entire row is clickable, 'row' = row clickable with separate button
  loadingBackupPath = null,
  restoreButtonText = 'Restore',
  unlockPins = [],
  loadBackup = null // (path) -> the backup (tests); default: fetchCloudBackup with unlockPins
}) {
  const { t } = useTranslation()
  const [lastActions, setLastActions] = useState({})
  const [loadingActions, setLoadingActions] = useState({})
  const [shown, setShown] = useState(LAST_ACTION_NEWEST)

  const sorted = useMemo(() => [...backups].sort((a, b) => backupTime(b) - backupTime(a)), [backups])
  // The cloud copies (the cloud match itself has no file), newest first
  const files = useMemo(() => sorted.filter(b => b.path), [sorted])

  const pinsKey = (unlockPins || []).filter(Boolean).join('\n')
  const read = useRef(null)
  read.current = loadBackup || ((path) => fetchCloudBackup(path, { pins: pinsKey ? pinsKey.split('\n') : [] }))
  // Paths asked for in this list (a new list or new PINs start again)
  const asked = useRef(new Set())
  useEffect(() => {
    asked.current = new Set()
    setLastActions({})
    setLoadingActions({})
    setShown(LAST_ACTION_NEWEST)
  }, [files, pinsKey])

  // What a read file says: its last action's type and the match's best of
  // (the set column). Kept untranslated and translated when shown: text
  // made when the file was read stayed in the language of that moment, e.g.
  // English when the list was read before a new language's texts had loaded
  // ("Point", "Set end" in de/fr/it, 28.11.2026)
  const lastActionOf = useRef(null)
  lastActionOf.current = (data) => {
    if (!data) return { kind: 'error' }
    if (isEncryptedBackup(data)) return { kind: 'locked' }
    const bestOf = data.match ? resolveBestOf(data.match) : undefined
    const type = extractLastAction(data.events)
    return type ? { kind: 'event', type, bestOf } : { kind: 'none', bestOf }
  }
  const actionText = (entry) => {
    if (!entry) return '—'
    if (entry.kind === 'error') return t('backupTable.error', 'Error')
    if (entry.kind === 'locked') return t('backupTable.locked', 'Encrypted')
    if (entry.kind === 'none') return t('backupTable.noActions', 'No actions')
    return formatEventType(entry.type, t)
  }

  // The last action of the first `shown` files, one file at a time; again
  // when the PINs change (a game PIN corrected under the list): the reset
  // above cleared the rows, and `shown` may already be the newest 3
  useEffect(() => {
    let alive = true
    const queue = files.slice(0, shown).map(b => b.path).filter(path => !asked.current.has(path))
    if (!queue.length) return undefined
    for (const path of queue) asked.current.add(path)
    setLoadingActions(prev => ({ ...prev, ...Object.fromEntries(queue.map(path => [path, true])) }))
    const done = new Set()
    ;(async () => {
      for (const path of queue) {
        if (!alive) return
        let action
        try {
          action = lastActionOf.current(await read.current(path))
        } catch (err) {
          console.error(`Failed to load backup ${path}:`, err)
          action = lastActionOf.current(null)
        }
        if (!alive) return
        done.add(path)
        setLastActions(prev => ({ ...prev, [path]: action }))
        setLoadingActions(prev => {
          const next = { ...prev }
          delete next[path]
          return next
        })
      }
    })()
    return () => {
      alive = false
      // not read yet: asked again by the next run
      for (const path of queue) if (!done.has(path)) asked.current.delete(path)
    }
  }, [files, shown, pinsKey])

  if (backups.length === 0) {
    return null
  }

  // Game N · Set · Score · Last action · Created at [restore],
  // sized by the table's own width (@container), not the screen's. Under 28rem
  // (a phone's dialog) the Game N column goes, it is the number just searched
  // for, and the date may wrap: the fixed columns alone were wider than the
  // dialog and pushed "Created at" off the right edge (2026-10-13). Whole class
  // names, so Tailwind finds them.
  const gridCols = showRestoreButton
    ? 'grid-cols-[32px_56px_minmax(0,1fr)_auto_auto] @md:grid-cols-[60px_35px_70px_90px_1fr_70px]'
    : 'grid-cols-[32px_56px_minmax(0,1fr)_auto] @md:grid-cols-[60px_35px_70px_90px_1fr]'
  const gameCell = 'hidden text-center @md:block'

  return (
    <div className="ov-kit @container divide-y divide-stone-100">
      {/* Table Header (kit sticky table head) */}
      <div
        className={cn('sticky top-0 z-10 grid items-center gap-x-1 border-b border-stone-200 bg-stone-50 px-2.5 py-2 text-[11px] font-bold uppercase tracking-wide text-stone-500', gridCols)}
      >
        <span className={gameCell}>{t('backupTable.gameN', 'Game N')}</span>
        <span className="text-center">{t('backupTable.set', 'Set')}</span>
        <span className="text-center">{t('backupTable.score', 'Score')}</span>
        <span >{t('backupTable.lastAction', 'Last action')}</span>
        <span className="text-right">{t('backupTable.createdAt', 'Created at')}</span>
        {showRestoreButton && <span></span>}
      </div>

      {/* Table Rows - newest first */}
      {sorted.map((backup, index) => {
        // Zürich time, the gym's clock, whatever zone the device is in
        const formattedTime = backup.date && backup.time
          ? formatBackupDateTime(backup.date, backup.time, backup.ms)
          : (formatZurichDateTime(backup.created_at || backup.updated_at) || 'Unknown')

        // The cloud match itself shows its status; an older file not read yet, a dash
        const lastAction = backup.source === 'database'
          ? formatStatus(backup.status, t)
          : (loadingActions[backup.path]
            ? t('common.loading', 'Loading...')
            : actionText(lastActions[backup.path]))
        // A best-of-3 decider is stored (and named in the file) as set 5 but
        // is the third set, as the scoring screen says. Best of: the row's
        // (the list's match), else the read file's
        const setNumber = backup.setIndex
          ? displaySetNumber(backup.setIndex, backup.bestOf ?? lastActions[backup.path]?.bestOf)
          : 'N/A'

        const isDisabled = loading || loadingBackupPath === backup.path

        const rowCls = cn(
          'grid w-full min-h-11 items-center gap-x-1 px-2.5 py-2 text-left text-xs text-stone-800 tabular-nums transition-colors',
          gridCols,
          isDisabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-stone-50'
        )

        if (mode === 'button') {
          // App.jsx mode - entire row is a button
          return (
            <button
              key={backup.name}
              onClick={() => !isDisabled && onBackupSelect(backup)}
              disabled={isDisabled}
              type="button"
              className={cn(rowCls, 'rounded-none bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-400/60')}
            >
              <span className={cn(gameCell, 'font-semibold')}>{backup.gameN || 'N/A'}</span>
              <span className="text-center">{setNumber}</span>
              <span className="text-center font-semibold text-stone-900">
                {backupScore(backup)}
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
              key={backup.name}
              onClick={() => !isDisabled && onBackupSelect(backup)}
              className={rowCls}
            >
              <span className={cn(gameCell, 'font-semibold')}>{backup.gameN || 'N/A'}</span>
              <span className="text-center">{setNumber}</span>
              <span className="text-center font-semibold text-stone-900">
                {backupScore(backup)}
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

      {files.length > shown && (
        <div className="px-2.5 py-2">
          <button
            type="button"
            onClick={() => setShown(n => n + LAST_ACTION_MORE)}
            className="text-[11px] font-medium text-stone-600 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60"
          >
            {t('backupTable.showMoreLastActions', { count: Math.min(LAST_ACTION_MORE, files.length - shown) })}
          </button>
        </div>
      )}
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
// Each backup may carry bestOf (3 or 5, its match's): the set column shows a
// best-of-3 decider as set 3
