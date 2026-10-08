import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAlert } from '../../contexts/AlertContext'
import Modal from '../Modal'
import { db } from '../../db/db'
import { restoreMatchInPlace, listCloudBackups, fetchCloudBackup, selectBackupFile, getBackupSettings } from '../../utils/backupManager'
import {
  detectBackupPlatform,
  isNativeBackupPlatform,
  useNativeBackupStatus,
  openNativeBackupFolder,
  pickNativeBackupFile
} from '../../utils/nativeBackup'
import BackupTable from '../BackupTable'
import { SatelliteDishIcon } from '../icons'
import { clearCachesAndReload } from '../../hooks/useServiceWorker'
import { ChevronDown, Info, X } from 'lucide-react'
import { cn, IconButton, Select, SegmentedControl, Switch } from '../../ui'
import { allowLeaving } from '../../utils/leaveGuard'
import { backdropDismiss } from '../../ui/backdropDismiss.js'
import ActivityLogModal from '../ActivityLogModal'
import { canOpenLogFolder, openLogFolder } from '../../utils/activity'
import { diagnosticLogQuery } from '../../utils/activity/logQuery'
import { reloadWithReason } from '../../diagnostics/reload'
import DiagnosticsSection from '../../diagnostics/DiagnosticsSection'

// Opened over the scoreboard: no brand-red fills here (RESTYLE-SPEC R4).
// Selection and "on" are slate-900, the non-destructive confirm emerald.
const SMALL_FIELD = 'h-9 rounded-lg border border-stone-300 bg-white px-2 text-center text-sm tabular-nums text-stone-800 focus:outline-none focus:ring-2 focus:ring-slate-400'
const BTN_OUTLINE = 'inline-flex h-11 items-center justify-center gap-1.5 rounded-lg border border-stone-300 bg-white px-4 text-sm font-medium text-stone-700 hover:bg-stone-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 focus-visible:ring-offset-1'
const BTN_DANGER_OUTLINE = 'inline-flex h-11 items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-white px-4 text-sm font-medium text-red-700 hover:bg-red-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 focus-visible:ring-offset-1'
const BTN_DARK = 'inline-flex h-11 items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-800 transition-colors disabled:bg-stone-200 disabled:text-stone-400 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 focus-visible:ring-offset-1'
const BTN_POSITIVE = 'inline-flex h-11 items-center justify-center gap-1.5 rounded-lg bg-emerald-700 px-4 text-sm font-medium text-white hover:bg-emerald-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 focus-visible:ring-offset-1'

function InfoDot({ title }) {
  const [showTooltip, setShowTooltip] = useState(false)

  return (
    <div className="relative inline-flex">
      <button
        type="button"
        aria-expanded={showTooltip}
        onClick={(e) => {
          e.stopPropagation()
          setShowTooltip(!showTooltip)
        }}
        className={cn(
          'inline-flex h-5 w-5 items-center justify-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-sky-500/50',
          showTooltip ? 'bg-sky-50 text-sky-700' : 'text-stone-400 hover:bg-sky-50 hover:text-sky-700'
        )}
      >
        <Info size={14} aria-hidden="true" />
      </button>
      {showTooltip && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute left-1/2 top-full z-10 mt-2 w-max max-w-[250px] -translate-x-1/2 whitespace-normal rounded-lg border border-stone-300 bg-white px-3 py-2 text-xs font-normal leading-relaxed text-stone-700 shadow-xl"
        >
          {title}
        </div>
      )}
    </div>
  )
}

function ToggleSwitch({ value, onToggle }) {
  // Kit Switch, lg; on = slate-900 here, not brand red (R4: over the scoreboard).
  return <Switch size="lg" checked={!!value} onCheckedChange={() => onToggle()} className={cn('ml-4', value && 'bg-slate-900')} />
}

function Row({ children, style }) {
  // svrz settings row: flat, min 48px, the Section list draws the hairlines.
  // Spacing between rows comes from the dividers, so a passed marginBottom is dropped.
  const { marginBottom, ...rest } = style || {}
  return (
    <div className="flex min-h-12 shrink-0 items-center justify-between py-3" style={rest}>
      {children}
    </div>
  )
}

function Section({ title, children }) {
  // svrz section head (name on a dark 1.5px rule) over a flat divided list.
  return (
    <section className="mb-6">
      {title ? (
        <div className="flex items-center justify-between gap-2 border-b-[1.5px] border-stone-800 pb-1.5">
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-stone-800">{title}</h3>
        </div>
      ) : null}
      <div className="divide-y divide-stone-100">
        {children}
      </div>
    </section>
  )
}

function DurationInput({ value, onChange, label }) {
  const minutes = Math.floor(value / 60)
  const seconds = value % 60
  const handleMinutes = (e) => {
    const m = Math.max(0, Math.min(10, parseInt(e.target.value, 10) || 0))
    const newVal = Math.max(60, Math.min(600, m * 60 + seconds))
    onChange(newVal)
  }
  const handleSeconds = (e) => {
    const s = Math.max(0, Math.min(59, parseInt(e.target.value, 10) || 0))
    const newVal = Math.max(60, Math.min(600, minutes * 60 + s))
    onChange(newVal)
  }
  const inputCls = cn(SMALL_FIELD, 'w-14 font-semibold')
  return (
    <div className="ml-4 flex items-center gap-1">
      <input type="number" min={0} max={10} value={minutes} onChange={handleMinutes} className={inputCls} aria-label={`${label} minutes`} />
      <span className="text-sm font-semibold text-stone-500">'</span>
      <input type="number" min={0} max={59} value={seconds.toString().padStart(2, '0')} onChange={handleSeconds} className={inputCls} aria-label={`${label} seconds`} />
      <span className="text-sm font-semibold text-stone-500">''</span>
    </div>
  )
}

export default function ScoreboardOptionsModal({
  open,
  onClose,

  onOpenKeybindings,
  onOpenConnectionSetup,
  server,
  matchOptions,
  displayOptions,
  matchId,
  onRestoreBackup
}) {
  const { t } = useTranslation()
  const { showAlert } = useAlert()
  const [clearCacheModal, setClearCacheModal] = useState(null) // { type: 'cache' | 'all' }
  const [fontSelectorOpen, setFontSelectorOpen] = useState(false)
  const [showCloudBackups, setShowCloudBackups] = useState(false)
  const [cloudBackups, setCloudBackups] = useState([])
  const [backupsLoading, setBackupsLoading] = useState(false)
  const [restoreConfirm, setRestoreConfirm] = useState(null) // backup to confirm restore
  const [backupPlatform] = useState(() => detectBackupPlatform())
  const nativeBackup = isNativeBackupPlatform(backupPlatform)
  const nativeBackupStatus = useNativeBackupStatus()
  // Logs: the activity log (synced) and the diagnostic log (clicks, local only)
  const [showActivityLog, setShowActivityLog] = useState(false)
  const [logFolder, setLogFolder] = useState(false)
  useEffect(() => {
    if (!open) return undefined
    let alive = true
    canOpenLogFolder().then((ok) => { if (alive) setLogFolder(ok) }).catch(() => {})
    return () => { alive = false }
  }, [open])
  const exportDiagnosticLog = async () => {
    try {
      const match = matchId != null ? await db.matches.get(matchId) : null
      const { downloadLogs } = await import('../../utils/comprehensiveLogger')
      await downloadLogs(diagnosticLogQuery(matchId, match), 'ndjson')
    } catch (err) {
      console.error('[Options] diagnostic log export failed:', err)
      showAlert(t('options.diagnosticLogFailed'), 'error')
    }
  }
  const openLogs = async () => {
    if (!(await openLogFolder().catch(() => false))) showAlert(t('options.logFolderOpenFailed'), 'error')
  }

  // Load cloud backups
  const loadBackups = async () => {
    if (!matchId) {
      showAlert(t('options.alerts.noMatchId'), 'warning')
      return
    }
    setBackupsLoading(true)
    try {
      // Backups are filed under the match's game number (logger.js upload path),
      // so list that folder, not game 1's. backupManager.listCloudBackups throws
      // on error, so a failed listing reaches the alert below.
      const match = await db.matches.get(matchId)
      const gameN = match?.gameN || match?.game_n || match?.gameNumber || 1
      const backups = await listCloudBackups(null, gameN)
      setCloudBackups(backups)
      setShowCloudBackups(true)
    } catch (err) {
      console.error('Failed to load backups:', err)
      showAlert(t('options.alerts.failedToLoadBackups'), 'error')
    } finally {
      setBackupsLoading(false)
    }
  }

  // Restore from a cloud backup
  const handleRestore = async (backup) => {
    try {
      // a local file was read already (handleRestoreFromFile); cloud: download it
      const backupData = backup.fileData || await fetchCloudBackup(backup.path)
      await restoreBackupData(backupData)
    } catch (err) {
      console.error('Failed to restore backup:', err)
      showAlert(t('options.alerts.failedToRestoreBackup', { error: err.message }), 'error')
    }
  }

  // Apps: restore the open match from a backup file on this device (after the
  // same confirmation as a cloud backup)
  const handleRestoreFromFile = async () => {
    try {
      const native = await pickNativeBackupFile()
      const backupData = native === undefined ? await selectBackupFile() : native
      if (!backupData) return // cancelled
      const lastSet = [...(backupData.sets || [])].sort((a, b) => (b.index || 0) - (a.index || 0))[0]
      setRestoreConfirm({
        fileData: backupData,
        name: t('options.restoreFromBackupFile'),
        ...(lastSet ? { setIndex: lastSet.index || 1, homePoints: lastSet.homePoints ?? 0, awayPoints: lastSet.awayPoints ?? 0 } : {}),
        timestamp: backupData.lastUpdated ? new Date(backupData.lastUpdated).toLocaleString() : undefined
      })
    } catch (err) {
      console.error('Failed to restore backup file:', err)
      showAlert(t('options.alerts.failedToRestoreBackup', { error: err.message }), 'error')
    }
  }

  const restoreBackupData = async (backupData) => {
    if (!backupData) {
      showAlert(t('options.alerts.failedToLoadBackupData'), 'error')
      return
    }
    // The game-number folder is shared by every match with that number:
    // never restore another match's backup onto the open one.
    const current = await db.matches.get(matchId)
    const currentKey = current?.seed_key || current?.externalId
    const backupKey = backupData.match?.seed_key || backupData.match?.seedKey || backupData.match?.external_id
    if (currentKey && backupKey && currentKey !== backupKey) {
      showAlert(t('options.alerts.failedToRestoreBackup', { error: 'This backup belongs to a different match' }), 'error')
      return
    }
    // Use the callback or in-place restore
    if (onRestoreBackup) {
      await onRestoreBackup(backupData)
    } else {
      await restoreMatchInPlace(matchId, backupData)
    }
    setShowCloudBackups(false)
    setRestoreConfirm(null)
    onClose?.()
    allowLeaving()
    reloadWithReason('backup-restored')
  }

  const executeClearCache = async (includeLocalStorage) => {
    try {
      // Reachable mid-match: refuse when the server is unreachable, since with
      // the precache and service worker gone the reload could not load the app.
      if (!(await clearCachesAndReload({ includeLocalStorage }))) {
        showAlert(t('options.alerts.clearCacheNeedsServer', 'Cannot clear the cache while the server is unreachable: the app could not be reloaded afterwards.'), 'error')
      }
    } catch (error) {
      console.error('Error clearing cache:', error)
      showAlert(t('options.alerts.failedToClearCache', { error: error.message }), 'error')
    }
  }

  if (!open) return null

  const {
    isAvailable: serverManagementAvailable,
    serverRunning,
    serverStatus,
    serverLoading,
    onStartServer,
    onStopServer
  } = server || {}

  const {
    checkAccidentalRallyStart,
    setCheckAccidentalRallyStart,
    accidentalRallyStartDuration,
    setAccidentalRallyStartDuration,
    checkAccidentalPointAward,
    setCheckAccidentalPointAward,
    accidentalPointAwardDuration,
    setAccidentalPointAwardDuration,
    manageCaptainOnCourt,
    setManageCaptainOnCourt,
    liberoExitConfirmation,
    setLiberoExitConfirmation,
    liberoEntrySuggestion,
    setLiberoEntrySuggestion,
    setIntervalDuration,
    setSetIntervalDuration,
    scoreFont,
    setScoreFont,
    keybindingsEnabled,
    setKeybindingsEnabled,
    lfpTrackingEnabled,
    setLfpTrackingEnabled,
    lfpMinimumOnCourt,
    setLfpMinimumOnCourt
  } = matchOptions

  const {
    displayMode,
    setDisplayMode,
    detectedDisplayMode,
    enterDisplayMode,
    exitDisplayMode
  } = displayOptions

  const modeDescriptions = {
    desktop: t('options.desktopDesc'),
    tablet: t('options.tabletDesc'),
    phone: t('options.phoneDesc')
  }

  return (
    <Modal
      title=""
      open={true}
      onClose={onClose}
      width={900}
      hideCloseButton={true}
    >
      <div className="ov-kit">
      {/* Sticky Header */}
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-stone-200/70 bg-white px-2 pb-3 sm:px-4">
        <h2 className="text-lg font-bold text-stone-900">{t('options.title')}</h2>
        <IconButton variant="close" icon={X} label={t('options.close')} onClick={onClose} />
      </div>
      <div className="max-h-[calc(80vh-60px)] overflow-y-auto px-2 pt-4 pb-2 text-stone-800 sm:px-4">
        {serverManagementAvailable && (
          <Section title={t('options.liveServer')} paddingBottom="24px">
            {serverRunning && serverStatus ? (
              <div>
                <div className="my-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2">
                  <div className="mb-1 flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-green-500" />
                    <span className="text-sm font-semibold text-green-800">{t('options.serverRunning')}</span>
                  </div>
                  <div className="ml-4 text-xs text-stone-600">
                    <div>{t('options.hostname')}: <span className="font-mono">{serverStatus.hostname || 'escoresheet.local'}</span></div>
                    <div>{t('options.ipAddress')}: <span className="font-mono">{serverStatus.localIP}</span></div>
                    <div>{t('options.protocol')}: <span className="uppercase">{serverStatus.protocol || 'https'}</span></div>
                  </div>
                </div>

                <div className="mb-3 rounded-xl border border-stone-200/70 bg-stone-50/60 p-3 text-xs">
                  <div className="mb-2 font-semibold text-stone-700">{t('options.connectionUrls')}:</div>
                  <div className="flex flex-col gap-1 font-mono text-[11px] text-stone-700">
                    <div className="break-all">
                      <span className="text-stone-500">{t('options.main')}: </span>
                      {serverStatus.urls?.mainIP || `${serverStatus.protocol}://${serverStatus.localIP}:${serverStatus.port}/`}
                    </div>
                    <div className="break-all">
                      <span className="text-stone-500">{t('header.referee')}: </span>
                      {serverStatus.urls?.refereeIP || `${serverStatus.protocol}://${serverStatus.localIP}:${serverStatus.port}/referee`}
                    </div>
                    <div className="break-all">
                      <span className="text-stone-500">{t('header.bench')}: </span>
                      {serverStatus.urls?.benchIP || `${serverStatus.protocol}://${serverStatus.localIP}:${serverStatus.port}/bench`}
                    </div>
                    <div className="break-all">
                      <span className="text-stone-500">{t('options.websocket')}: </span>
                      {serverStatus.urls?.websocketIP || `${serverStatus.wsProtocol}://${serverStatus.localIP}:${serverStatus.wsPort}`}
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={onStopServer}
                  disabled={serverLoading}
                  aria-busy={serverLoading || undefined}
                  className={cn(BTN_DARK, 'w-full')}
                >
                  {serverLoading ? t('options.stopping') : t('options.stopServer')}
                </button>
              </div>
            ) : (
              <div>
                <div className="my-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-red-500" />
                    <span className="text-sm font-semibold text-red-700">{t('options.serverNotRunning')}</span>
                  </div>
                </div>
                <p className="mb-3 text-sm text-stone-600">
                  {t('options.startServerToConnect')}
                </p>
                <button
                  type="button"
                  onClick={onStartServer}
                  disabled={serverLoading}
                  aria-busy={serverLoading || undefined}
                  className={cn(BTN_POSITIVE, 'w-full')}
                >
                  {serverLoading ? t('options.starting') : t('options.startServer')}
                </button>
              </div>
            )}
          </Section>
        )}

        <Section title={t('options.matchOptions')}>
          <Row style={{ marginBottom: '12px' }}>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <div className="text-sm font-semibold text-stone-900">{t('options.checkAccidentalRallyStart')}</div>
                <InfoDot title={t('options.checkAccidentalRallyStartInfo', { duration: accidentalRallyStartDuration })} />
              </div>
              {checkAccidentalRallyStart && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-xs text-stone-500">{t('options.duration')}:</span>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={accidentalRallyStartDuration}
                    aria-label={t('options.duration')}
                    onChange={(e) => {
                      const val = Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 3))
                      setAccidentalRallyStartDuration(val)
                      localStorage.setItem('accidentalRallyStartDuration', String(val))
                    }}
                    className={cn(SMALL_FIELD, 'w-16')}
                  />
                  <span className="text-xs text-stone-500">{t('options.seconds')}</span>
                </div>
              )}
            </div>
            <ToggleSwitch
              value={checkAccidentalRallyStart}
              onToggle={() => {
                const newValue = !checkAccidentalRallyStart
                setCheckAccidentalRallyStart(newValue)
                localStorage.setItem('checkAccidentalRallyStart', String(newValue))
              }}
            />
          </Row>

          <Row style={{ marginBottom: '12px' }}>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <div className="text-sm font-semibold text-stone-900">{t('options.checkAccidentalPointAward')}</div>
                <InfoDot title={t('options.checkAccidentalPointAwardInfo', { duration: accidentalPointAwardDuration })} />
              </div>
              {checkAccidentalPointAward && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-xs text-stone-500">{t('options.duration')}:</span>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={accidentalPointAwardDuration}
                    aria-label={t('options.duration')}
                    onChange={(e) => {
                      const val = Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 3))
                      setAccidentalPointAwardDuration(val)
                      localStorage.setItem('accidentalPointAwardDuration', String(val))
                    }}
                    className={cn(SMALL_FIELD, 'w-16')}
                  />
                  <span className="text-xs text-stone-500">{t('options.seconds')}</span>
                </div>
              )}
            </div>
            <ToggleSwitch
              value={checkAccidentalPointAward}
              onToggle={() => {
                const newValue = !checkAccidentalPointAward
                setCheckAccidentalPointAward(newValue)
                localStorage.setItem('checkAccidentalPointAward', String(newValue))
              }}
            />
          </Row>
          <Row style={{ marginBottom: '12px' }}>
            <div className="flex items-center gap-1.5">
              <div className="text-sm font-semibold text-stone-900">{t('options.showNamesOnCourt')}</div>
              <InfoDot title={t('options.showNamesOnCourtInfo')} />
            </div>
            <ToggleSwitch
              value={displayOptions?.showNamesOnCourt}
              onToggle={() => displayOptions?.setShowNamesOnCourt?.(!displayOptions?.showNamesOnCourt)}
            />
          </Row>
          <Row style={{ marginBottom: '12px' }}>
            <div className="flex items-center gap-1.5">
              <div className="text-sm font-semibold text-stone-900">{t('options.manageCaptainOnCourt')}</div>
              <InfoDot title={t('options.manageCaptainOnCourtInfo')} />
            </div>
            <ToggleSwitch
              value={manageCaptainOnCourt}
              onToggle={() => {
                const newValue = !manageCaptainOnCourt
                setManageCaptainOnCourt(newValue)
                localStorage.setItem('manageCaptainOnCourt', String(newValue))
              }}
            />
          </Row>

          <Row style={{ marginBottom: '12px' }}>
            <div className="flex items-center gap-1.5">
              <div className="text-sm font-semibold text-stone-900">{t('options.liberoExitConfirmation')}</div>
              <InfoDot title={t('options.liberoExitConfirmationInfo')} />
            </div>
            <ToggleSwitch
              value={liberoExitConfirmation}
              onToggle={() => {
                const newValue = !liberoExitConfirmation
                setLiberoExitConfirmation(newValue)
                localStorage.setItem('liberoExitConfirmation', String(newValue))
              }}
            />
          </Row>

          <Row style={{ marginBottom: '12px' }}>
            <div className="flex items-center gap-1.5">
              <div className="text-sm font-semibold text-stone-900">{t('options.liberoEntrySuggestion')}</div>
              <InfoDot title={t('options.liberoEntrySuggestionInfo')} />
            </div>
            <ToggleSwitch
              value={liberoEntrySuggestion}
              onToggle={() => {
                const newValue = !liberoEntrySuggestion
                setLiberoEntrySuggestion(newValue)
                localStorage.setItem('liberoEntrySuggestion', String(newValue))
              }}
            />
          </Row>

          <Row style={{ marginBottom: '12px' }}>
            <div className="flex items-center gap-1.5">
              <div className="text-sm font-semibold text-stone-900">{t('options.setIntervalDuration')}</div>
              <InfoDot title={t('options.setIntervalDurationInfo')} />
            </div>
            <DurationInput
              value={setIntervalDuration}
              label={t('options.setIntervalDurationLabel', 'set interval duration')}
              onChange={(newVal) => {
                setSetIntervalDuration(newVal)
                localStorage.setItem('setIntervalDuration', String(newVal))
              }}
            />
          </Row>

          <Row style={{ marginBottom: '12px', flexDirection: 'column', alignItems: 'stretch', gap: '0' }}>
            {(() => {
              const fontOptions = [
                { value: 'default', label: t('options.fontDefault'), fontFamily: 'inherit', preview: '12:25' },
                { value: 'orbitron', label: 'Orbitron', fontFamily: "'Orbitron', monospace", preview: '12:25' },
                { value: 'roboto-mono', label: 'Roboto Mono', fontFamily: "'Roboto Mono', monospace", preview: '12:25' },
                { value: 'jetbrains-mono', label: 'JetBrains Mono', fontFamily: "'JetBrains Mono', monospace", preview: '12:25' },
                { value: 'space-mono', label: 'Space Mono', fontFamily: "'Space Mono', monospace", preview: '12:25' },
                { value: 'ibm-plex-mono', label: 'IBM Plex Mono', fontFamily: "'IBM Plex Mono', monospace", preview: '12:25' }
              ]
              const currentFont = fontOptions.find(f => f.value === scoreFont) || fontOptions[0]
              return (
                <>
                  {/* Label + InfoDot sit beside the picker button, not inside it (no button in a button). */}
                  <div className="flex w-full min-h-11 items-center justify-between gap-3">
                    <div className="flex items-center gap-1.5">
                      <div id="score-font-label" className="text-sm font-semibold text-stone-900">{t('options.scoreFont')}</div>
                      <InfoDot title={t('options.scoreFontInfo')} />
                    </div>
                    <button
                      type="button"
                      aria-expanded={fontSelectorOpen}
                      aria-labelledby="score-font-label"
                      onClick={() => setFontSelectorOpen(!fontSelectorOpen)}
                      className="flex min-h-11 items-center gap-3 rounded-lg px-2 transition-colors hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                    >
                      <span style={{
                        fontFamily: currentFont.fontFamily,
                        fontSize: '18px',
                        fontWeight: 700,
                        color: 'var(--accent)',
                        letterSpacing: '1px'
                      }}>
                        {currentFont.preview}
                      </span>
                      <ChevronDown size={16} aria-hidden="true" className={cn('text-stone-400 transition-transform', fontSelectorOpen && 'rotate-180')} />
                    </button>
                  </div>
                  {fontSelectorOpen && (
                    <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                      {fontOptions.map(option => (
                        <button
                          key={option.value}
                          onClick={() => {
                            setScoreFont(option.value)
                            localStorage.setItem('scoreFont', option.value)
                            setFontSelectorOpen(false)
                          }}
                          type="button"
                          aria-pressed={scoreFont === option.value}
                          className={cn(
                            'flex min-h-12 items-center justify-between rounded-lg border px-3.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400',
                            scoreFont === option.value ? 'border-slate-900 bg-white ring-1 ring-slate-900' : 'border-stone-200 bg-white hover:bg-stone-50'
                          )}
                        >
                          <span className="text-[13px] text-stone-700">{option.label}</span>
                          <span style={{
                            fontFamily: option.fontFamily,
                            fontSize: '20px',
                            fontWeight: 700,
                            color: scoreFont === option.value ? '#0f172a' : 'var(--accent)',
                            letterSpacing: '1px'
                          }}>
                            {option.preview}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )
            })()}
          </Row>

          <Row style={{ marginBottom: '12px' }}>
            <div className="min-w-0 flex-1">
              <div className={cn('flex items-center gap-1.5', keybindingsEnabled && onOpenKeybindings && 'mb-2')}>
                <div className="text-sm font-semibold text-stone-900">{t('options.keyboardShortcuts')}</div>
                <InfoDot title={t('options.keyboardShortcutsInfo')} />
              </div>
              {keybindingsEnabled && onOpenKeybindings ? (
                <button
                  type="button"
                  onClick={onOpenKeybindings}
                  className={BTN_OUTLINE}
                >
                  {t('options.configureKeys')}
                </button>
              ) : null}
            </div>
            <ToggleSwitch
              value={keybindingsEnabled}
              onToggle={() => {
                const newValue = !keybindingsEnabled
                setKeybindingsEnabled(newValue)
                localStorage.setItem('keybindingsEnabled', String(newValue))
              }}
            />
          </Row>

          <Row style={{ marginBottom: '12px' }}>
            <div className="flex items-center gap-1.5">
              <div className="text-sm font-semibold text-stone-900">{t('options.autoDownloadAtSetEnd')}</div>
              <InfoDot title={t('options.autoDownloadAtSetEndInfo')} />
            </div>
            <ToggleSwitch
              value={displayOptions?.autoDownloadAtSetEnd ?? true}
              onToggle={() => displayOptions?.setAutoDownloadAtSetEnd?.(!displayOptions?.autoDownloadAtSetEnd)}
            />
          </Row>

          <Row style={{ alignItems: 'flex-start' }}>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <div className="text-sm font-semibold text-stone-900">{t('options.enableLfpTracking')}</div>
                <InfoDot title={t('options.lfpTrackingInfo')} />
              </div>
              {lfpTrackingEnabled && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-xs text-stone-500">{t('options.minimumLfpsOnCourt')}</span>
                  <Select
                    value={lfpMinimumOnCourt}
                    aria-label={t('options.minimumLfpsOnCourt')}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10)
                      setLfpMinimumOnCourt(val)
                      localStorage.setItem('lfpMinimumOnCourt', String(val))
                    }}
                    className="w-16 tabular-nums focus:ring-slate-400"
                  >
                    {[1, 2, 3, 4, 5, 6].map(n => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </Select>
                </div>
              )}
            </div>
            <ToggleSwitch
              value={lfpTrackingEnabled}
              onToggle={() => {
                const newValue = !lfpTrackingEnabled
                setLfpTrackingEnabled(newValue)
                localStorage.setItem('lfpTrackingEnabled', String(newValue))
              }}
            />
          </Row>
        </Section>

        <Section title={t('options.displayMode')}>
          <Row style={{ marginBottom: '12px', alignItems: 'flex-start' }}>
            <div className="min-w-0 flex-1">
              <div className="mb-2 flex items-center gap-1.5">
                <div className="text-sm font-semibold text-stone-900">{t('options.screenMode')}</div>
                <InfoDot title={t('options.screenModeInfo')} />
              </div>
              {/* joined (aria-pressed buttons): commits on click/Enter/Space only, so
                  arrowing across segments cannot trigger fullscreen as a radiogroup would. */}
              <SegmentedControl
                ariaLabel={t('options.screenMode')}
                variant="joined"
                size="lg"
                value={displayMode}
                className="max-w-md [&>button]:capitalize"
                options={['auto', 'desktop', 'tablet', 'phone'].map(mode => ({
                  value: mode,
                  label: mode === 'auto' ? t('options.autoWithMode', { mode: detectedDisplayMode }) : mode,
                  title: modeDescriptions[mode]
                }))}
                onChange={(mode) => {
                  if (mode === 'tablet') {
                    enterDisplayMode(mode)
                    return
                  }
                  if (mode === 'desktop') {
                    exitDisplayMode()
                    return
                  }
                  setDisplayMode(mode)
                  localStorage.setItem('displayMode', mode)
                }}
              />

              {displayMode !== 'desktop' && displayMode !== 'auto' && (
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={exitDisplayMode}
                    className={BTN_OUTLINE}
                  >
                    {t('options.exitMode', { mode: displayMode })}
                  </button>
                </div>
              )}
            </div>
          </Row>
        </Section>

        <div className="mb-6 flex flex-col gap-3">
          <button
            type="button"
            onClick={() => {
              onClose?.()
              onOpenConnectionSetup?.()
            }}
            className={cn('flex w-full min-h-12 items-center gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm font-semibold text-stone-800 shadow-sm transition-colors hover:bg-stone-50', 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 focus-visible:ring-offset-1')}
          >
            <SatelliteDishIcon size={20} />
            <span>{t('options.setupConnections')}</span>
          </button>

        </div>

        {nativeBackup && (
          <Section title={t('options.backup')}>
            <Row style={{ flexDirection: 'column', alignItems: 'stretch', gap: '12px' }}>
              <div className="flex items-center gap-1.5">
                <div className="text-sm font-semibold text-stone-900">{t('options.autoBackup')}</div>
                <InfoDot title={t('options.nativeBackupInfo')} />
              </div>
              {getBackupSettings({ native: true }).autoBackupEnabled ? (
                <div>
                  <div className="text-xs text-stone-600">{t('options.nativeBackupOn')}</div>
                  <div
                    className="mt-1.5 break-all rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 font-mono text-[11px] leading-snug text-stone-700"
                    data-testid="native-backup-folder"
                  >
                    {nativeBackupStatus.folder || t('options.nativeBackupPreparing')}
                  </div>
                  {backupPlatform === 'capacitor' && (
                    <div className="mt-1.5 text-[11px] leading-snug text-stone-500">{t('options.nativeBackupCopyHint')}</div>
                  )}
                  <div className="mt-1.5 text-[11px] leading-snug text-stone-500">
                    {t(backupPlatform === 'capacitor' ? 'options.nativeBackupPrivacyAndroid' : 'options.nativeBackupPrivacy')}
                  </div>
                </div>
              ) : (
                <div className="text-xs text-stone-500">{t('options.nativeBackupOff')}</div>
              )}
              {nativeBackupStatus.lastBackup && (
                <div className="text-[11px] tabular-nums text-stone-500">
                  {t('options.lastBackup')}: {nativeBackupStatus.lastBackup.toLocaleTimeString()}
                </div>
              )}
              {nativeBackupStatus.error && (
                <div role="status" className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {t('options.nativeBackupFailed')} {nativeBackupStatus.error}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {backupPlatform === 'tauri' && (
                  <button
                    type="button"
                    onClick={() => openNativeBackupFolder().catch(err => showAlert(err?.message || String(err), 'error'))}
                    className={BTN_OUTLINE}
                  >
                    {t('options.openBackupFolder')}
                  </button>
                )}
                <button type="button" onClick={handleRestoreFromFile} disabled={!matchId} className={BTN_OUTLINE}>
                  {t('options.restoreFromBackupFile')}
                </button>
              </div>
            </Row>
          </Section>
        )}

        <Section title={t('options.logs')}>
          <Row style={{ flexDirection: 'column', alignItems: 'stretch', gap: '12px' }}>
            <div className="flex items-center gap-1.5">
              <div className="text-sm font-semibold text-stone-900">{t('options.activityLog')}</div>
              <InfoDot title={t('options.activityLogInfo')} />
            </div>
            <button type="button" onClick={() => setShowActivityLog(true)} className={cn(BTN_OUTLINE, 'w-full')} data-testid="options-activity-log">
              {t('options.openActivityLog')}
            </button>
          </Row>
          <Row style={{ flexDirection: 'column', alignItems: 'stretch', gap: '12px' }}>
            <div className="flex items-center gap-1.5">
              <div className="text-sm font-semibold text-stone-900">{t('options.diagnosticLog')}</div>
              <InfoDot title={t('options.diagnosticLogInfo')} />
            </div>
            <button type="button" onClick={exportDiagnosticLog} className={cn(BTN_OUTLINE, 'w-full')} data-testid="options-diagnostic-log">
              {t('options.exportDiagnosticLog')}
            </button>
            {logFolder && (
              <button type="button" onClick={openLogs} className={cn(BTN_OUTLINE, 'w-full')} data-testid="options-log-folder">
                {t('options.openLogFolder')}
              </button>
            )}
          </Row>
          <DiagnosticsSection showAlert={showAlert} testIdPrefix="options" />
        </Section>

        <Section title={t('options.cloudBackup')}>
          <Row style={{ flexDirection: 'column', alignItems: 'stretch', gap: '12px' }}>
            <div className="flex items-center gap-1.5">
              <div className="text-sm font-semibold text-stone-900">{t('options.restoreFromCloud')}</div>
              <InfoDot title={t('options.restoreFromCloudInfo')} />
            </div>
            <button
              type="button"
              onClick={loadBackups}
              disabled={backupsLoading || !matchId}
              aria-busy={backupsLoading || undefined}
              className={cn(BTN_OUTLINE, 'w-full')}
            >
              {backupsLoading ? t('options.loading') : t('options.browseCloudBackups')}
            </button>
            {!matchId && (
              <p className="text-xs text-stone-500">
                {t('options.startMatchToAccessBackups')}
              </p>
            )}
          </Row>
        </Section>

        <Section title={t('options.cacheManagement')} borderBottom={false}>
          <Row style={{ flexDirection: 'column', alignItems: 'stretch', gap: '12px' }}>
            <div className="flex items-center gap-1.5">
              <div className="text-sm font-semibold text-stone-900">{t('options.clearApplicationCache')}</div>
              <InfoDot title={t('options.clearApplicationCacheInfo')} />
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setClearCacheModal({ type: 'cache' })}
                className={BTN_DANGER_OUTLINE}
              >
                {t('options.clearCache')}
              </button>
              <button
                type="button"
                onClick={() => setClearCacheModal({ type: 'all' })}
                className={BTN_DANGER_OUTLINE}
              >
                {t('options.clearAll')}
              </button>
            </div>
          </Row>
        </Section>

        {/* Cloud Backups Modal */}
        {showCloudBackups && (
          <div
            {...backdropDismiss(() => setShowCloudBackups(false))}
            className="fixed inset-0 flex items-center justify-center bg-stone-900/50 p-4 backdrop-blur-sm"
            style={{ zIndex: 10000 }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              className="flex max-h-[70vh] w-full max-w-lg flex-col rounded-2xl bg-white p-5 shadow-2xl sm:p-6"
            >
              <h3 className="mb-2 text-lg font-bold text-stone-900">
                {t('options.cloudBackups')}
              </h3>

              {cloudBackups.length === 0 ? (
                <p className="py-6 text-center text-sm font-medium text-stone-500">
                  {t('options.noCloudBackupsFound')}
                </p>
              ) : (
                <div className="mb-4 flex-1 overflow-y-auto rounded-lg border border-stone-200">
                  <BackupTable
                    backups={cloudBackups}
                    onBackupSelect={(backup) => setRestoreConfirm(backup)}
                    showRestoreButton={true}
                    mode="row"
                    restoreButtonText={t('options.restore')}
                  />
                </div>
              )}

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setShowCloudBackups(false)}
                  className={BTN_OUTLINE}
                >
                  {t('options.close')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Restore Confirmation Modal */}
        {restoreConfirm && (
          <div
            {...backdropDismiss(() => setRestoreConfirm(null))}
            className="fixed inset-0 flex items-center justify-center bg-stone-900/60 p-4 backdrop-blur-sm"
            style={{ zIndex: 10001 }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              role="alertdialog"
              aria-modal="true"
              className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl"
            >
              <h3 className="mb-2 text-lg font-bold text-stone-900">
                {t('options.confirmRestore')}
              </h3>
              <p className="mb-3 text-sm leading-relaxed text-stone-600">
                {t('options.restoreMatchToThisState')}
              </p>
              <div className="mb-3 rounded-xl border border-stone-200/70 bg-stone-50/60 p-3">
                <div className="text-base font-semibold tabular-nums text-stone-900">
                  {restoreConfirm.homePoints !== undefined ? (
                    t('options.backupSetScore', { setIndex: restoreConfirm.setIndex, homePoints: restoreConfirm.homePoints, awayPoints: restoreConfirm.awayPoints })
                  ) : (
                    restoreConfirm.name
                  )}
                </div>
                <div className="mt-1 text-xs tabular-nums text-stone-500">
                  {restoreConfirm.timestamp || restoreConfirm.created_at}
                </div>
              </div>
              <p className="text-xs font-medium text-red-700">
                {t('options.warningStateReplaced')}
              </p>
              <div className="mt-6 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setRestoreConfirm(null)}
                  className={BTN_OUTLINE}
                >
                  {t('options.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => handleRestore(restoreConfirm)}
                  className={BTN_POSITIVE}
                >
                  {t('options.restore')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Clear Cache Confirmation Modal */}
        {clearCacheModal && (
          <div
            {...backdropDismiss(() => setClearCacheModal(null))}
            className="fixed inset-0 flex items-center justify-center bg-stone-900/60 p-4 backdrop-blur-sm"
            style={{ zIndex: 10000 }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              role="alertdialog"
              aria-modal="true"
              className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl"
            >
              <h3 className="mb-2 text-lg font-bold text-stone-900">
                {t('options.confirmClearCache')}
              </h3>
              <p className="text-sm leading-relaxed text-stone-600">
                {clearCacheModal.type === 'all'
                  ? t('options.clearAllWarning')
                  : t('options.clearCacheWarning')
                }
              </p>
              {clearCacheModal.type === 'all' && (
                <p className="mt-2 text-xs font-medium text-red-700">
                  {t('options.resetPreferencesWarning')}
                </p>
              )}
              <div className="mt-6 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setClearCacheModal(null)}
                  className={BTN_OUTLINE}
                >
                  {t('options.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => executeClearCache(clearCacheModal.type === 'all')}
                  className={BTN_DARK}
                >
                  {clearCacheModal.type === 'all' ? t('options.clearAll') : t('options.clearCache')}
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
      </div>
      <ActivityLogModal open={showActivityLog} onClose={() => setShowActivityLog(false)} matchId={matchId ?? null} />
    </Modal >
  )
}
