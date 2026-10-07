import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useAlert } from '../../contexts/AlertContext'
import Modal from '../Modal'
import SupportFeedbackModal from '../SupportFeedbackModal'
import NativeServerSection from './NativeServerSection'
import DesktopUpdateSection from './DesktopUpdateSection'
import { useDesktopUpdate } from '../../hooks/useDesktopUpdate'
import { copyToClipboard } from '../../utils/networkInfo'
import { QRCodeSVG } from 'qrcode.react'
import { SatelliteDishIcon } from '../icons'
import { clearCachesAndReload, applyServiceWorkerUpdate } from '../../hooks/useServiceWorker'
import { Info, LifeBuoy, X } from 'lucide-react'
import { Button, cn, IconButton, Select, SegmentedControl, Switch } from '../../ui'
import { isAndroidApp } from '../../utils/androidUpdate'
import AndroidVersionRows from './AndroidVersionRows'
import { backdropDismiss } from '../../ui/backdropDismiss.js'
import LegalLinks from '../../legal/LegalLinks'

// Kit field recipes for the small inline number/select controls (h-9, svrz md).
const SMALL_FIELD = 'h-9 rounded-lg border border-stone-300 bg-white px-2 text-center text-sm tabular-nums text-stone-800 focus:outline-none focus:ring-2 focus:ring-red-500'
// Kit secondary button, h-11 (courtside touch size).
const BTN_OUTLINE = 'inline-flex h-11 items-center justify-center gap-1.5 rounded-lg border border-stone-300 bg-white px-4 text-sm font-medium text-stone-700 hover:bg-stone-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ' + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 focus-visible:ring-offset-1'
const BTN_DANGER_OUTLINE = 'inline-flex h-11 items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-white px-4 text-sm font-medium text-red-700 hover:bg-red-50 transition-colors ' + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 focus-visible:ring-offset-1'

const currentVersion = __APP_VERSION__

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
  // Kit Switch, lg (h-7 w-12) for tablets; the row around it is the 48px hit row.
  return <Switch size="lg" checked={!!value} onCheckedChange={() => onToggle()} className="ml-4" />
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

// Apps (desktop / Android): a backup file at every scoring event, no browser API.
function NativeBackupRow({ backup, onRestoreFromFile, t }) {
  const [saving, setSaving] = useState(false)
  const enabled = backup.autoBackupEnabled
  return (
    <Row style={{ flexDirection: 'column', alignItems: 'stretch', gap: '12px' }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <div className="text-sm font-semibold text-stone-900">{t('options.autoBackup')}</div>
          <InfoDot title={t('options.nativeBackupInfo')} />
        </div>
        <ToggleSwitch value={enabled} onToggle={() => backup.toggleAutoBackup(!enabled)} />
      </div>

      {enabled ? (
        <div>
          <div className="text-xs text-stone-600">{t('options.nativeBackupOn')}</div>
          <div
            className="mt-1.5 break-all rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 font-mono text-[11px] leading-snug text-stone-700"
            data-testid="native-backup-folder"
          >
            {backup.backupFolder || t('options.nativeBackupPreparing')}
          </div>
          {backup.platform === 'capacitor' && (
            <div className="mt-1.5 text-[11px] leading-snug text-stone-500">{t('options.nativeBackupCopyHint')}</div>
          )}
          <div className="mt-1.5 text-[11px] leading-snug text-stone-500" data-testid="native-backup-privacy">
            {t(backup.platform === 'capacitor' ? 'options.nativeBackupPrivacyAndroid' : 'options.nativeBackupPrivacy')}
          </div>
        </div>
      ) : (
        <div className="text-xs text-stone-500">{t('options.nativeBackupOff')}</div>
      )}

      {backup.lastBackup && (
        <div className="text-[11px] tabular-nums text-stone-500">
          {t('options.lastBackup')}: {backup.lastBackup.toLocaleTimeString()}
        </div>
      )}

      {backup.backupError && (
        <div role="status" className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">
          {t('options.nativeBackupFailed')} {backup.backupError}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {backup.canOpenBackupFolder && (
          <button
            type="button"
            onClick={() => backup.openBackupFolder()}
            className={BTN_OUTLINE}
          >
            {t('options.openBackupFolder')}
          </button>
        )}
        {onRestoreFromFile && (
          <button type="button" onClick={onRestoreFromFile} className={BTN_OUTLINE}>
            {t('options.restoreFromBackupFile')}
          </button>
        )}
        {backup.activeMatchId != null && (
          <button
            type="button"
            disabled={saving}
            aria-busy={saving || undefined}
            onClick={async () => {
              setSaving(true)
              try { await backup.manualBackup() } finally { setSaving(false) }
            }}
            className={BTN_OUTLINE}
          >
            {saving ? t('options.backingUp') : t('options.saveBackupNow')}
          </button>
        )}
      </div>
    </Row>
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

// Default key bindings
const defaultKeyBindings = {
  pointLeft: 'a',
  pointRight: 'l',
  timeoutLeft: 'q',
  timeoutRight: 'p',
  exchangeLiberoLeft: 'w',
  exchangeLiberoRight: 'o',
  undo: 'z',
  confirm: 'Enter',
  cancel: 'Escape',
  startRally: 'Enter'
}

// Key binding keys (used for lookup)
const keyBindingKeys = [
  'pointLeft',
  'pointRight',
  'timeoutLeft',
  'timeoutRight',
  'exchangeLiberoLeft',
  'exchangeLiberoRight',
  'undo',
  'confirm',
  'cancel',
  'startRally'
]

export default function HomeOptionsModal({
  open,
  onClose,
  onOpenConnectionSetup,
  matchOptions,
  displayOptions,
  wakeLock,
  backup = null, // Optional backup props from useAutoBackup
  onRestoreFromFile = null, // Options > Backup > Restore from a backup file
  dashboardServer = null // Optional dashboard server props from useDashboardServer
}) {
  const { t } = useTranslation()
  const { showAlert } = useAlert()
  const androidApp = isAndroidApp()
  const [clearCacheModal, setClearCacheModal] = useState(null) // { type: 'cache' | 'all' }
  const [copyFeedback, setCopyFeedback] = useState(null)
  const [supportFeedbackOpen, setSupportFeedbackOpen] = useState(false)
  const [updateCheck, setUpdateCheck] = useState({ checking: false, result: null }) // result: 'available' | 'latest' | 'error'
  const [newVersion, setNewVersion] = useState(null)
  // The desktop app updates itself (updater.rs): its own status, not the web
  // build's version.json, which in the app is always the bundled one.
  const desktopUpdate = useDesktopUpdate()
  const [keybindingsModalOpen, setKeybindingsModalOpen] = useState(false)
  const [editingKey, setEditingKey] = useState(null)
  const [keyBindings, setKeyBindings] = useState(() => {
    const saved = localStorage.getItem('keyBindings')
    if (saved) {
      try {
        return { ...defaultKeyBindings, ...JSON.parse(saved) }
      } catch {
        return defaultKeyBindings
      }
    }
    return defaultKeyBindings
  })

  // Handle copy with feedback
  const handleCopy = useCallback(async (text, label) => {
    const result = await copyToClipboard(text)
    if (result.success) {
      setCopyFeedback(label)
      setTimeout(() => setCopyFeedback(null), 2000)
    }
  }, [])

  const checkForUpdates = async () => {
    setUpdateCheck({ checking: true, result: null })
    setNewVersion(null)
    try {
      // Fetch latest version from server (bypass cache)
      const res = await fetch(`${import.meta.env.BASE_URL}version.json?t=${Date.now()}`, { cache: 'no-store' })
      const data = await res.json()
      const latestVersion = data.version

      if (latestVersion && latestVersion !== currentVersion) {
        setNewVersion(latestVersion)
        setUpdateCheck({ checking: false, result: 'available' })
        // Trigger service worker update check
        if ('serviceWorker' in navigator) {
          const reg = await navigator.serviceWorker.getRegistration()
          if (reg) reg.update()
        }
      } else {
        setUpdateCheck({ checking: false, result: 'latest' })
      }
    } catch {
      setUpdateCheck({ checking: false, result: 'error' })
    }
  }

  const executeClearCache = async (includeLocalStorage) => {
    try {
      // Refuse when the server is unreachable: with the precache and service
      // worker gone, the reload could not load the app at all.
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
    activeDisplayMode,
    enterDisplayMode,
    exitDisplayMode
  } = displayOptions

  const { wakeLockActive, toggleWakeLock } = wakeLock

  const modeDescriptions = {
    desktop: t('options.desktopDesc'),
    tablet: t('options.tabletDesc')
  }

  return (
    <Modal
      open={true}
      title=""
      onClose={onClose}
      width={750}
      hideCloseButton={true}
    >
      <div className="ov-kit">
      {/* Sticky Header */}
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-stone-200/70 bg-white px-2 pb-3 sm:px-4">
        <h2 className="text-lg font-bold text-stone-900">{t('options.title')}</h2>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="md" icon={LifeBuoy} onClick={() => setSupportFeedbackOpen(true)} className="h-11 whitespace-nowrap">
            {t('supportFeedback.button')}
          </Button>
          <IconButton variant="close" icon={X} label={t('options.close')} onClick={onClose} />
        </div>
      </div>

      {/* Support & Feedback Modal */}
      <SupportFeedbackModal
        open={supportFeedbackOpen}
        onClose={() => setSupportFeedbackOpen(false)}
        currentPage="options"
      />
      <div className="max-h-[calc(80vh-60px)] overflow-y-auto px-2 pt-4 pb-2 text-stone-800 sm:px-4">
        <Section title={null}>
          <Row style={{ marginBottom: '12px', alignItems: 'flex-start' }}>
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

          <Row style={{ marginBottom: '12px', alignItems: 'flex-start' }}>
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

          <Row style={{ marginBottom: '12px' }}>
            <div className="flex items-center gap-1.5">
              <div className="text-sm font-semibold text-stone-900">{t('options.keyboardShortcuts')}</div>
              <InfoDot title={t('options.keyboardShortcutsInfo')} />
            </div>
            <div className="flex items-center gap-2">
              {keybindingsEnabled && (
                <button
                  type="button"
                  onClick={() => setKeybindingsModalOpen(true)}
                  className={BTN_OUTLINE}
                >
                  {t('options.keybindings')}
                </button>
              )}
              <ToggleSwitch
                value={keybindingsEnabled}
                onToggle={() => {
                  const newValue = !keybindingsEnabled
                  setKeybindingsEnabled(newValue)
                  localStorage.setItem('keybindingsEnabled', String(newValue))
                }}
              />
            </div>
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
                    className="w-16 tabular-nums focus:ring-red-500"
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

        {/* Android app only: cloud or venue LAN relay, other bundled views */}
        <NativeServerSection />

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
                options={['auto', 'desktop', 'tablet'].map(mode => ({
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
                    className={BTN_DANGER_OUTLINE}
                  >
                    {t('options.exitMode', { mode: displayMode })}
                  </button>
                </div>
              )}
            </div>
          </Row>

          <Row>
            <div className="flex items-center gap-1.5">
              <div className="text-sm font-semibold text-stone-900">{t('options.screenAlwaysOn')}</div>
              <InfoDot title={t('options.screenAlwaysOnInfo')} />
            </div>
            <ToggleSwitch value={wakeLockActive} onToggle={toggleWakeLock} />
          </Row>
        </Section>

        {dashboardServer && (
          <Section title={t('options.dashboardServer')}>
            <Row style={{ marginBottom: '12px' }}>
              <div className="flex items-center gap-1.5">
                <div className="text-sm font-semibold text-stone-900">{t('options.enableDashboards')}</div>
                <InfoDot title={t('options.enableDashboardsInfo')} />
              </div>
              <ToggleSwitch
                value={dashboardServer.enabled}
                onToggle={dashboardServer.onToggle}
              />
            </Row>

            {dashboardServer.enabled && (
              <>
                {/* Server Status */}
                <div className="py-3">
                  <div className="mb-3 flex items-center justify-between">
                    <span className="text-xs text-stone-500">{t('options.serverStatus')}</span>
                    <span className={cn(
                      'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium',
                      dashboardServer.serverRunning ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
                    )}>
                      <span className={cn('h-2 w-2 rounded-full', dashboardServer.serverRunning ? 'bg-emerald-500' : 'bg-red-500')} />
                      {dashboardServer.serverRunning ? t('options.running') : t('options.notRunning')}
                    </span>
                  </div>

                  {dashboardServer.serverRunning && dashboardServer.connectionUrl && (
                    <>
                      <div className="mb-3">
                        <div className="mb-1 text-xs text-stone-500">
                          {t('options.connectDashboardsTo')}
                        </div>
                        <div className="flex items-center gap-2">
                          <code className="min-w-0 flex-1 break-all rounded-lg border border-stone-200 bg-stone-50 px-3 py-2.5 font-mono text-sm text-stone-700">
                            {dashboardServer.connectionUrl}
                          </code>
                          <button
                            type="button"
                            onClick={() => handleCopy(dashboardServer.connectionUrl, 'URL')}
                            className={cn(BTN_OUTLINE, 'whitespace-nowrap', copyFeedback === 'URL' && 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-50')}
                          >
                            {copyFeedback === 'URL' ? t('options.copied') : t('options.copy')}
                          </button>
                        </div>
                      </div>

                      {dashboardServer.refereePin && (
                        <div className="mb-3">
                          <div className="mb-1 text-xs text-stone-500">
                            {t('options.refereePin')}:
                          </div>
                          <div className="flex items-center gap-2">
                            <code className="rounded-lg border border-stone-200 bg-stone-50 px-4 py-2 font-mono text-xl font-bold tracking-[0.3em] text-stone-900">
                              {dashboardServer.refereePin}
                            </code>
                            <button
                              type="button"
                              onClick={() => handleCopy(dashboardServer.refereePin, 'PIN')}
                              className={cn(BTN_OUTLINE, 'whitespace-nowrap', copyFeedback === 'PIN' && 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-50')}
                            >
                              {copyFeedback === 'PIN' ? t('options.copied') : t('options.copy')}
                            </button>
                          </div>
                        </div>
                      )}

                      {/* QR Code */}
                      <div className="mt-4 text-center">
                        <div className="inline-block rounded-lg border border-stone-200 bg-white p-1.5">
                          <QRCodeSVG value={`${dashboardServer.connectionUrl}/referee`} size={120} level="L" />
                        </div>
                        <div className="mt-1.5 text-[11px] text-stone-500">
                          {t('options.scanToOpen')}
                        </div>
                      </div>
                    </>
                  )}

                  {!dashboardServer.serverRunning && (
                    <div className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-stone-700">
                      <strong className="font-semibold text-red-700">{t('options.serverNotDetected')}</strong>
                      <br />
                      {t('options.startBackendServer')} <code className="rounded border border-stone-200 bg-white px-1.5 py-0.5 font-mono">npm run start:backend</code>
                    </div>
                  )}
                </div>

                {/* Connected Dashboards */}
                <div className="py-3">
                  <div className="mb-3 text-xs text-stone-500">
                    {t('options.connectedDashboards')}
                  </div>
                  <div className="flex items-center justify-center gap-3 rounded-xl border border-stone-200/70 bg-stone-50/60 p-4">
                    <span className={cn('text-3xl font-bold tabular-nums', dashboardServer.dashboardCount > 0 ? 'text-emerald-600' : 'text-stone-400')}>
                      {dashboardServer.dashboardCount || 0}
                    </span>
                    <div className="text-left">
                      <div className="text-sm text-stone-800">
                        {dashboardServer.dashboardCount === 1
                          ? t('options.dashboardConnected', { count: dashboardServer.dashboardCount || 0 })
                          : t('options.dashboardsConnected', { count: dashboardServer.dashboardCount || 0 })}
                      </div>
                      {dashboardServer.dashboardCount > 0 && (
                        <div className="mt-0.5 text-[11px] text-stone-500">
                          {t('options.refereeBenchCount', { refereeCount: dashboardServer.refereeCount || 0, benchCount: dashboardServer.benchCount || 0 })}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Individual clients list */}
                  {dashboardServer.connectedDashboards?.length > 0 && (
                    <div className="mt-3 divide-y divide-stone-100 rounded-lg border border-stone-200">
                      {dashboardServer.connectedDashboards.map((client, idx) => (
                        <div
                          key={client.id || idx}
                          className="flex items-center justify-between px-3 py-2"
                        >
                          <div className="flex items-center gap-2">
                            <span className="h-2 w-2 rounded-full bg-green-500" title="Connected" />
                            <span className="text-sm font-semibold capitalize text-stone-900">
                              {client.role}
                              {client.team && ` (${client.team})`}
                            </span>
                          </div>
                          <span className="font-mono text-[11px] text-stone-500">
                            {client.ip}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </Section>
        )}

        {onOpenConnectionSetup && (
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
        )}


      

        {backup?.nativeMode && (
          <Section title={t('options.backup')}>
            <NativeBackupRow backup={backup} onRestoreFromFile={onRestoreFromFile} t={t} />
          </Section>
        )}

        {backup && !backup.nativeMode && (
          <Section title={t('options.backup')}>
            <Row style={{ flexDirection: 'column', alignItems: 'stretch', gap: '12px' }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <div className="text-sm font-semibold text-stone-900">{t('options.autoBackup')}</div>
                  <InfoDot title={backup.hasFileSystemAccess
                    ? t('options.autoBackupFolderInfo')
                    : t('options.autoBackupDownloadInfo')
                  } />
                </div>
                <ToggleSwitch
                  value={backup.autoBackupEnabled}
                  onToggle={() => {
                    const newValue = !backup.autoBackupEnabled
                    backup.toggleAutoBackup(newValue)
                    if (newValue && backup.hasFileSystemAccess && !backup.backupDirName) {
                      backup.selectBackupDir()
                    }
                  }}
                />
              </div>

              {backup.hasFileSystemAccess ? (
                // Chrome/Edge: Folder selection
                <div>
                  <div className="mb-2 text-xs text-stone-500">
                    {t('options.backupLocation')}: {backup.backupDirName || t('common.notSet')}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={backup.selectBackupDir}
                      className={BTN_OUTLINE}
                    >
                      {backup.backupDirName ? t('options.changeFolder') : t('options.selectBackupFolder')}
                    </button>
                    {backup.backupDirName && (
                      <button
                        type="button"
                        onClick={backup.clearBackupDir}
                        className={BTN_DANGER_OUTLINE}
                      >
                        {t('options.clear')}
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                // Safari/Firefox: Show browser limitation notice + event-based backup
                <div>
                  <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                    <div className="mb-1 text-xs font-semibold text-amber-800">
                      {t('options.limitedBrowserSupport')}
                    </div>
                    <div className="text-[11px] leading-snug text-stone-600">
                      {t('options.limitedBrowserSupportDesc')}
                    </div>
                  </div>
                  <div className="mb-2 text-xs text-stone-500">
                    {t('options.eventBasedAutoDownload')}:
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 text-[11px] text-stone-600">
                    <div className="flex items-center gap-1.5">
                      <span className="text-emerald-600">✓</span> {t('options.setStart')}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-emerald-600">✓</span> {t('options.setEnd')}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-emerald-600">✓</span> {t('options.matchEnd')}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-emerald-600">✓</span> {t('options.timeoutCalled')}
                    </div>
                  </div>
                  <div className="mt-2 text-[11px] text-stone-400">
                    {t('options.eventBasedNote')}
                  </div>
                </div>
              )}

              {backup.lastBackup && (
                <div className="text-[11px] tabular-nums text-stone-500">
                  {t('options.lastBackup')}: {backup.lastBackup.toLocaleTimeString()}
                </div>
              )}

              {backup.backupError && (
                <div role="alert" className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {backup.backupError}
                </div>
              )}

              <div>
                <button
                  type="button"
                  onClick={() => backup.manualBackup()}
                  disabled={backup.isBackingUp}
                  aria-busy={backup.isBackingUp || undefined}
                  className={BTN_OUTLINE}
                >
                  {backup.isBackingUp ? t('options.backingUp') : t('options.downloadBackupNow')}
                </button>
              </div>
            </Row>
          </Section>
        )}

        <Section title={t('options.appVersion')}>
          {/* Android: the APK bundles version.json (always "latest"); it asks
              the F-Droid index instead (AndroidVersionRows). The desktop app:
              its own update status (DesktopUpdateSection). Elsewhere the web
              build's version check. */}
          {androidApp ? <AndroidVersionRows /> : desktopUpdate.active ? <DesktopUpdateSection update={desktopUpdate} /> : (
          <Row style={{ flexDirection: 'column', alignItems: 'stretch', gap: '12px' }}>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-stone-900">{t('options.currentVersion')}</div>
                <div className="mt-0.5 text-xs tabular-nums text-stone-500">
                  v{currentVersion}
                </div>
              </div>
              <button
                type="button"
                onClick={checkForUpdates}
                disabled={updateCheck.checking}
                aria-busy={updateCheck.checking || undefined}
                className={BTN_OUTLINE}
              >
                {updateCheck.checking ? t('options.checking') : t('options.checkForUpdates')}
              </button>
            </div>

            {updateCheck.result === 'available' && (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2">
                <div>
                  <div className="text-sm font-semibold text-green-800">
                    {t('options.updateAvailable')}
                  </div>
                  <div className="mt-0.5 text-xs tabular-nums text-stone-600">
                    {currentVersion} → {newVersion}
                  </div>
                </div>
                <button
                  // A plain reload keeps the old active service worker (skipWaiting
                  // is off) and serves the old precached app: activate the new one.
                  onClick={() => applyServiceWorkerUpdate({ checkForUpdate: true })}
                  type="button"
                  className="inline-flex h-11 items-center justify-center rounded-lg bg-emerald-700 px-4 text-sm font-medium text-white transition-colors hover:bg-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 focus-visible:ring-offset-1"
                >
                  {t('options.refreshToUpdate')}
                </button>
              </div>
            )}

            {updateCheck.result === 'latest' && (
              <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">
                {t('options.latestVersion')}
              </div>
            )}

            {updateCheck.result === 'error' && (
              <div role="alert" className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">
                {t('options.couldNotCheckUpdates')}
              </div>
            )}
          </Row>
          )}
          {/* Licence + credits. The icons are the same packs as wiedisync:
              Lucide (ISC) for the UI glyphs and the whistle, Phosphor (MIT) for
              the volleyball (see components/icons and ui/AppSpinner.jsx). Both
              licences ask for their notice to travel with the code; naming them
              here keeps the credit visible in every build (web, desktop,
              Android). The Game Icons (CC BY 3.0) ball and whistle are gone, so
              their credit went with them. */}
          <Row>
            <p className="text-xs leading-relaxed text-stone-500" data-testid="credits">
              OpenVolley · {t('options.freeSoftware', 'Free software')} (GPL-3.0-or-later) ·{' '}
              <a href="https://github.com/Lucanepa/openvolley" target="_blank" rel="noopener noreferrer" className="underline decoration-stone-300 hover:text-stone-700">
                {t('options.sourceCode', 'Source code')}
              </a>
              {' · '}{t('options.icons', 'Icons')}{' '}
              <a href="https://lucide.dev/license" target="_blank" rel="noopener noreferrer" className="underline decoration-stone-300 hover:text-stone-700">Lucide</a> (ISC)
              {', '}<a href="https://github.com/phosphor-icons/react/blob/master/LICENSE" target="_blank" rel="noopener noreferrer" className="underline decoration-stone-300 hover:text-stone-700">Phosphor</a> (MIT)
              {' · '}{t('options.fonts', 'Fonts')} Inter, IBM Plex Mono, JetBrains Mono, Orbitron, Roboto Mono, Space Mono (SIL OFL 1.1)
            </p>
          </Row>
          {/* Privacy policy, terms, legal notice and the full open-source
              notice on openvolley.app, in the app's language. */}
          <Row>
            <LegalLinks />
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
                className="inline-flex h-11 items-center justify-center rounded-lg border border-red-100 bg-red-50 px-4 text-sm font-medium text-red-600 shadow-sm transition-colors hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 focus-visible:ring-offset-1"
              >
                {t('options.clearAll')}
              </button>
            </div>
          </Row>
        </Section>

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
              <h3 className="text-lg font-bold text-stone-900">
                {t('options.confirmClearCache')}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-stone-600">
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
                  className="inline-flex h-11 items-center justify-center rounded-lg border border-stone-300 bg-white px-4 text-sm text-stone-700 transition-colors hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 focus-visible:ring-offset-1"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => executeClearCache(clearCacheModal.type === 'all')}
                  className="inline-flex h-11 items-center justify-center rounded-lg bg-red-600 px-4 text-sm font-medium text-white transition-colors hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 focus-visible:ring-offset-1"
                >
                  {clearCacheModal.type === 'all' ? t('options.clearAll') : t('options.clearCache')}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="border-t border-stone-100 pt-4 text-center text-xs text-stone-500">
          {t('common.support', 'Support:')} support@openvolley.app
        </div>
      </div>
      </div>

      {/* Keybindings Modal */}
      {keybindingsModalOpen && (
        <div
          {...backdropDismiss(() => {
            setKeybindingsModalOpen(false)
            setEditingKey(null)
          })}
          className="ov-kit fixed inset-0 flex items-center justify-center bg-stone-900/50 p-4 backdrop-blur-sm"
          style={{ zIndex: 2000 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl sm:p-6"
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-lg font-bold text-stone-900">{t('options.keybindings')}</h3>
              <IconButton
                variant="close"
                icon={X}
                label={t('common.close', 'Close')}
                onClick={() => {
                  setKeybindingsModalOpen(false)
                  setEditingKey(null)
                }}
              />
            </div>

            <div className="divide-y divide-stone-100">
              {keyBindingKeys.map((key) => (
                <div
                  key={key}
                  className="flex min-h-12 items-center justify-between gap-3 py-2"
                >
                  <span className="text-sm text-stone-800">{t(`options.keybindingLabels.${key}`)}</span>
                  <button
                    onClick={() => {
                      if (editingKey === key) {
                        setEditingKey(null)
                      } else {
                        setEditingKey(key)
                        const handleKeyCapture = (e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          if (e.key === 'Escape') {
                            setEditingKey(null)
                          } else {
                            const newBindings = { ...keyBindings, [key]: e.key }
                            setKeyBindings(newBindings)
                            localStorage.setItem('keyBindings', JSON.stringify(newBindings))
                            setEditingKey(null)
                          }
                          window.removeEventListener('keydown', handleKeyCapture, true)
                        }
                        window.addEventListener('keydown', handleKeyCapture, true)
                      }
                    }}
                    type="button"
                    aria-pressed={editingKey === key}
                    className={cn(
                      'inline-flex h-9 min-w-20 items-center justify-center rounded-lg border px-3 font-mono text-sm font-semibold transition-colors',
                      editingKey === key ? 'border-slate-900 bg-slate-900 text-white' : 'border-stone-300 bg-white text-stone-800 hover:bg-stone-50',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 focus-visible:ring-offset-1'
                    )}
                  >
                    {editingKey === key ? t('options.pressKey') : (
                      keyBindings[key] === ' ' ? 'Space' :
                        keyBindings[key] === 'Enter' ? 'Enter' :
                          keyBindings[key] === 'Escape' ? 'Esc' :
                            keyBindings[key] === 'Backspace' ? 'Backspace' :
                              keyBindings[key] === 'ArrowUp' ? '↑' :
                                keyBindings[key] === 'ArrowDown' ? '↓' :
                                  keyBindings[key] === 'ArrowLeft' ? '←' :
                                    keyBindings[key] === 'ArrowRight' ? '→' :
                                      keyBindings[key].toUpperCase()
                    )}
                  </button>
                </div>
              ))}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setKeyBindings(defaultKeyBindings)
                  localStorage.setItem('keyBindings', JSON.stringify(defaultKeyBindings))
                }}
                className="mr-auto inline-flex h-11 items-center justify-center rounded-lg border border-stone-300 bg-white px-4 text-sm text-stone-700 transition-colors hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 focus-visible:ring-offset-1"
              >
                {t('options.resetDefaults')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setKeybindingsModalOpen(false)
                  setEditingKey(null)
                }}
                className="inline-flex h-11 items-center justify-center rounded-lg bg-slate-900 px-4 text-sm font-medium text-white transition-colors hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 focus-visible:ring-offset-1"
              >
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}
