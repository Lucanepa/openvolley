import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useAlert } from '../../contexts/AlertContext'
import Modal from '../Modal'
import SupportFeedbackModal from '../SupportFeedbackModal'
import { copyToClipboard, generateQRCodeUrl } from '../../utils/networkInfo'

const currentVersion = __APP_VERSION__

function InfoDot({ title }) {
  const [showTooltip, setShowTooltip] = useState(false)

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <div
        onClick={(e) => {
          e.stopPropagation()
          setShowTooltip(!showTooltip)
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '16px',
          height: '16px',
          borderRadius: '50%',
          background: showTooltip ? 'rgba(59, 130, 246, 0.5)' : 'rgba(255, 255, 255, 0.2)',
          color: 'rgba(255, 255, 255, 0.7)',
          fontSize: '11px',
          fontWeight: 600,
          cursor: 'pointer'
        }}
      >
        i
      </div>
      {showTooltip && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            marginTop: '8px',
            padding: '8px 12px',
            background: '#1f2937',
            border: '1px solid rgba(255,255,255,0.2)',
            borderRadius: '6px',
            fontSize: '12px',
            color: 'rgba(255,255,255,0.9)',
            whiteSpace: 'normal',
            width: 'max-content',
            maxWidth: '250px',
            zIndex: 10,
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)'
          }}
        >
          {title}
        </div>
      )}
    </div>
  )
}

function ToggleSwitch({ value, onToggle }) {
  return (
    <button
      onClick={onToggle}
      style={{
        width: '52px',
        height: '28px',
        minHeight: '28px',
        maxHeight: '28px',
        padding: 0,
        boxSizing: 'border-box',
        borderRadius: '14px',
        border: 'none',
        cursor: 'pointer',
        background: value ? '#22c55e' : 'rgba(255, 255, 255, 0.2)',
        position: 'relative',
        transition: 'background 0.2s',
        flexShrink: 0,
        marginLeft: '16px'
      }}
    >
      <div style={{
        width: '20px',
        height: '20px',
        borderRadius: '10px',
        background: '#fff',
        position: 'absolute',
        top: '4px',
        left: value ? '28px' : '4px',
        transition: 'left 0.2s'
      }} />
    </button>
  )
}

function Row({ children, style }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 16px',
        background: 'rgba(255, 255, 255, 0.05)',
        borderRadius: '8px',
        flexShrink: 0,
        height: 'auto',
        ...style
      }}
    >
      {children}
    </div>
  )
}

function Section({ title, children, borderBottom = true }) {
  return (
    <div style={{ marginBottom: '24px', paddingBottom: borderBottom ? '24px' : 0, borderBottom: borderBottom ? '1px solid rgba(255,255,255,0.1)' : 'none' }}>
      {title ? (
        <h3 style={{ marginTop: 0, marginBottom: '16px', fontSize: '18px', fontWeight: 600 }}>{title}</h3>
      ) : null}
      {children}
    </div>
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
  const inputStyle = {
    width: '36px',
    padding: '4px',
    fontSize: '14px',
    fontFamily: 'monospace',
    fontWeight: 600,
    textAlign: 'center',
    background: 'rgba(255,255,255,0.1)',
    border: '1px solid rgba(255,255,255,0.2)',
    borderRadius: '6px',
    color: 'var(--text)'
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginLeft: '16px' }}>
      <input type="number" min={0} max={10} value={minutes} onChange={handleMinutes} style={inputStyle} aria-label={`${label} minutes`} />
      <span style={{ fontFamily: 'monospace', fontWeight: 600, fontSize: '14px' }}>'</span>
      <input type="number" min={0} max={59} value={seconds.toString().padStart(2, '0')} onChange={handleSeconds} style={inputStyle} aria-label={`${label} seconds`} />
      <span style={{ fontFamily: 'monospace', fontWeight: 600, fontSize: '14px' }}>''</span>
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
  dashboardServer = null // Optional dashboard server props from useDashboardServer
}) {
  const { t } = useTranslation()
  const { showAlert } = useAlert()
  const [clearCacheModal, setClearCacheModal] = useState(null) // { type: 'cache' | 'all' }
  const [copyFeedback, setCopyFeedback] = useState(null)
  const [supportFeedbackOpen, setSupportFeedbackOpen] = useState(false)
  const [updateCheck, setUpdateCheck] = useState({ checking: false, result: null }) // result: 'available' | 'latest' | 'error'
  const [newVersion, setNewVersion] = useState(null)
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

  // Clear cache functions
  const clearServiceWorkerCaches = async () => {
    if ('caches' in window) {
      const cacheNames = await caches.keys()
      await Promise.all(cacheNames.map(cacheName => caches.delete(cacheName)))
    }
  }

  const unregisterServiceWorkers = async () => {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations()
      await Promise.all(registrations.map(registration => registration.unregister()))
    }
  }

  const checkForUpdates = async () => {
    setUpdateCheck({ checking: true, result: null })
    setNewVersion(null)
    try {
      // Fetch latest version from server (bypass cache)
      const res = await fetch(`/version.json?t=${Date.now()}`)
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
      await clearServiceWorkerCaches()
      await unregisterServiceWorkers()

      if (includeLocalStorage) {
        localStorage.clear()
      }

      // Force reload bypassing browser HTTP cache
      window.location.href = window.location.pathname + '?cache_bust=' + Date.now()
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
      {/* Sticky Header */}
      <div style={{
        position: 'sticky',
        top: 0,
        background: '#1f2937',
        borderBottom: '1px solid rgba(255,255,255,0.1)',
        padding: '12px 24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        zIndex: 10
      }}>
        <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>{t('options.title')}</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button
            onClick={() => setSupportFeedbackOpen(true)}
            style={{
              padding: '6px 12px',
              fontSize: '12px',
              fontWeight: 600,
              background: 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              whiteSpace: 'nowrap'
            }}
          >
            {t('supportFeedback.button')}
          </button>
          <button
            onClick={onClose}
            style={{
              width: '32px',
              height: '32px',
              borderRadius: '6px',
              border: 'none',
              background: 'rgba(255,255,255,0.1)',
              color: 'var(--text)',
              fontSize: '18px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
            title={t('options.close')}
          >
            ×
          </button>
        </div>
      </div>

      {/* Support & Feedback Modal */}
      <SupportFeedbackModal
        open={supportFeedbackOpen}
        onClose={() => setSupportFeedbackOpen(false)}
        currentPage="options"
      />
      <div style={{ padding: '24px', maxHeight: 'calc(80vh - 60px)', overflowY: 'auto' }}>
        <Section title={null}>
          <Row style={{ marginBottom: '12px', alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                <div style={{ fontWeight: 600, fontSize: '15px' }}>{t('options.checkAccidentalRallyStart')}</div>
                <InfoDot title={t('options.checkAccidentalRallyStartInfo', { duration: accidentalRallyStartDuration })} />
              </div>
              {checkAccidentalRallyStart && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
                  <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)' }}>{t('options.duration')}:</span>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={accidentalRallyStartDuration}
                    onChange={(e) => {
                      const val = Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 3))
                      setAccidentalRallyStartDuration(val)
                      localStorage.setItem('accidentalRallyStartDuration', String(val))
                    }}
                    style={{
                      width: '50px',
                      padding: '4px 8px',
                      fontSize: '12px',
                      background: 'rgba(255,255,255,0.1)',
                      border: '1px solid rgba(255,255,255,0.2)',
                      borderRadius: '4px',
                      color: 'var(--text)',
                      textAlign: 'center'
                    }}
                  />
                  <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)' }}>{t('options.seconds')}</span>
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
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                <div style={{ fontWeight: 600, fontSize: '15px' }}>{t('options.checkAccidentalPointAward')}</div>
                <InfoDot title={t('options.checkAccidentalPointAwardInfo', { duration: accidentalPointAwardDuration })} />
              </div>
              {checkAccidentalPointAward && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
                  <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)' }}>{t('options.duration')}:</span>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={accidentalPointAwardDuration}
                    onChange={(e) => {
                      const val = Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 3))
                      setAccidentalPointAwardDuration(val)
                      localStorage.setItem('accidentalPointAwardDuration', String(val))
                    }}
                    style={{
                      width: '50px',
                      padding: '4px 8px',
                      fontSize: '12px',
                      background: 'rgba(255,255,255,0.1)',
                      border: '1px solid rgba(255,255,255,0.2)',
                      borderRadius: '4px',
                      color: 'var(--text)',
                      textAlign: 'center'
                    }}
                  />
                  <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)' }}>{t('options.seconds')}</span>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ fontWeight: 600, fontSize: '15px' }}>{t('options.manageCaptainOnCourt')}</div>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ fontWeight: 600, fontSize: '15px' }}>{t('options.liberoExitConfirmation')}</div>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ fontWeight: 600, fontSize: '15px' }}>{t('options.liberoEntrySuggestion')}</div>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ fontWeight: 600, fontSize: '15px' }}>{t('options.setIntervalDuration')}</div>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ fontWeight: 600, fontSize: '15px' }}>{t('options.keyboardShortcuts')}</div>
              <InfoDot title={t('options.keyboardShortcutsInfo')} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {keybindingsEnabled && (
                <button
                  onClick={() => setKeybindingsModalOpen(true)}
                  style={{
                    padding: '6px 12px',
                    fontSize: '12px',
                    fontWeight: 600,
                    background: 'rgba(59, 130, 246, 0.2)',
                    color: '#3b82f6',
                    border: '1px solid rgba(59, 130, 246, 0.4)',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    transition: 'all 0.2s'
                  }}
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
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                <div style={{ fontWeight: 600, fontSize: '15px' }}>{t('options.enableLfpTracking')}</div>
                <InfoDot title={t('options.lfpTrackingInfo')} />
              </div>
              {lfpTrackingEnabled && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
                  <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)' }}>{t('options.minimumLfpsOnCourt')}</span>
                  <select
                    value={lfpMinimumOnCourt}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10)
                      setLfpMinimumOnCourt(val)
                      localStorage.setItem('lfpMinimumOnCourt', String(val))
                    }}
                    style={{
                      padding: '4px 4px',
                      fontSize: '12px',
                      background: 'rgba(255,255,255,0.1)',
                      border: '1px solid rgba(255,255,255,0.2)',
                      borderRadius: '4px',
                      color: 'var(--text)',
                      textAlign: 'center',
                      width: '44px'
                    }}
                  >
                    {[1, 2, 3, 4, 5, 6].map(n => (
                      <option key={n} value={n} style={{ background: '#1e293b', color: '#fff' }}>{n}</option>
                    ))}
                  </select>
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
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
                <div style={{ fontWeight: 600, fontSize: '15px' }}>{t('options.screenMode')}</div>
                <InfoDot title={t('options.screenModeInfo')} />
              </div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {['auto', 'desktop', 'tablet'].map(mode => (
                  <button
                    key={mode}
                    onClick={() => {
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
                    style={{
                      padding: '8px 16px',
                      fontSize: '13px',
                      fontWeight: 600,
                      background: displayMode === mode ? '#3b82f6' : 'rgba(255, 255, 255, 0.1)',
                      color: displayMode === mode ? '#fff' : 'var(--text)',
                      border: displayMode === mode ? '1px solid #3b82f6' : '1px solid rgba(255, 255, 255, 0.2)',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      textTransform: 'capitalize',
                      transition: 'all 0.2s',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px'
                    }}
                  >
                    <span>{mode === 'auto' ? t('options.autoWithMode', { mode: detectedDisplayMode }) : mode}</span>
                    {modeDescriptions[mode] ? (
                      <span
                        title={modeDescriptions[mode]}
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          width: '14px',
                          height: '14px',
                          borderRadius: '50%',
                          background: displayMode === mode ? 'rgba(255, 255, 255, 0.3)' : 'rgba(255, 255, 255, 0.2)',
                          color: displayMode === mode ? '#fff' : 'rgba(255, 255, 255, 0.7)',
                          fontSize: '10px',
                          fontWeight: 600,
                          cursor: 'help'
                        }}
                      >
                        i
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>

              {displayMode !== 'desktop' && displayMode !== 'auto' && (
                <div style={{ marginTop: '12px' }}>
                  <button
                    onClick={exitDisplayMode}
                    style={{
                      padding: '6px 12px',
                      fontSize: '12px',
                      fontWeight: 600,
                      background: 'rgba(239, 68, 68, 0.2)',
                      color: '#ef4444',
                      border: '1px solid rgba(239, 68, 68, 0.4)',
                      borderRadius: '4px',
                      cursor: 'pointer'
                    }}
                  >
                    {t('options.exitMode', { mode: displayMode })}
                  </button>
                </div>
              )}
            </div>
          </Row>

          <Row>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ fontWeight: 600, fontSize: '15px' }}>{t('options.screenAlwaysOn')}</div>
              <InfoDot title={t('options.screenAlwaysOnInfo')} />
            </div>
            <ToggleSwitch value={wakeLockActive} onToggle={toggleWakeLock} />
          </Row>
        </Section>

        {dashboardServer && (
          <Section title={t('options.dashboardServer')}>
            <Row style={{ marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <div style={{ fontWeight: 600, fontSize: '15px' }}>{t('options.enableDashboards')}</div>
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
                <div style={{
                  background: 'rgba(255,255,255,0.05)',
                  borderRadius: '8px',
                  padding: '16px',
                  marginBottom: '12px'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                    <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.7)' }}>{t('options.serverStatus')}</span>
                    <span style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      fontSize: '13px',
                      color: dashboardServer.serverRunning ? '#22c55e' : '#ef4444'
                    }}>
                      <span style={{
                        width: '8px',
                        height: '8px',
                        borderRadius: '50%',
                        background: dashboardServer.serverRunning ? '#22c55e' : '#ef4444'
                      }} />
                      {dashboardServer.serverRunning ? t('options.running') : t('options.notRunning')}
                    </span>
                  </div>

                  {dashboardServer.serverRunning && dashboardServer.connectionUrl && (
                    <>
                      <div style={{ marginBottom: '12px' }}>
                        <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)', marginBottom: '4px' }}>
                          {t('options.connectDashboardsTo')}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <code style={{
                            flex: 1,
                            padding: '10px 12px',
                            background: 'rgba(0,0,0,0.3)',
                            borderRadius: '6px',
                            fontSize: '14px',
                            fontFamily: 'monospace',
                            color: '#22c55e',
                            wordBreak: 'break-all'
                          }}>
                            {dashboardServer.connectionUrl}
                          </code>
                          <button
                            onClick={() => handleCopy(dashboardServer.connectionUrl, 'URL')}
                            style={{
                              padding: '10px 14px',
                              fontSize: '12px',
                              fontWeight: 600,
                              background: copyFeedback === 'URL' ? '#22c55e' : 'rgba(255,255,255,0.1)',
                              border: 'none',
                              borderRadius: '6px',
                              color: '#fff',
                              cursor: 'pointer',
                              whiteSpace: 'nowrap'
                            }}
                          >
                            {copyFeedback === 'URL' ? t('options.copied') : t('options.copy')}
                          </button>
                        </div>
                      </div>

                      {dashboardServer.refereePin && (
                        <div style={{ marginBottom: '12px' }}>
                          <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)', marginBottom: '4px' }}>
                            {t('options.refereePin')}:
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <code style={{
                              padding: '10px 16px',
                              background: 'rgba(59, 130, 246, 0.2)',
                              borderRadius: '6px',
                              fontSize: '20px',
                              fontFamily: 'monospace',
                              fontWeight: 700,
                              color: '#3b82f6',
                              letterSpacing: '2px'
                            }}>
                              {dashboardServer.refereePin}
                            </code>
                            <button
                              onClick={() => handleCopy(dashboardServer.refereePin, 'PIN')}
                              style={{
                                padding: '10px 14px',
                                fontSize: '12px',
                                fontWeight: 600,
                                background: copyFeedback === 'PIN' ? '#22c55e' : 'rgba(255,255,255,0.1)',
                                border: 'none',
                                borderRadius: '6px',
                                color: '#fff',
                                cursor: 'pointer',
                                whiteSpace: 'nowrap'
                              }}
                            >
                              {copyFeedback === 'PIN' ? t('options.copied') : t('options.copy')}
                            </button>
                          </div>
                        </div>
                      )}

                      {/* QR Code */}
                      <div style={{ textAlign: 'center', marginTop: '16px' }}>
                        <img
                          src={generateQRCodeUrl(`${dashboardServer.connectionUrl}/referee`, 120)}
                          alt="Referee Dashboard QR"
                          style={{ background: '#fff', padding: 6, borderRadius: 6 }}
                        />
                        <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', marginTop: '6px' }}>
                          {t('options.scanToOpen')}
                        </div>
                      </div>
                    </>
                  )}

                  {!dashboardServer.serverRunning && (
                    <div style={{
                      padding: '12px',
                      background: 'rgba(239, 68, 68, 0.1)',
                      border: '1px solid rgba(239, 68, 68, 0.3)',
                      borderRadius: '6px',
                      fontSize: '12px',
                      color: 'rgba(255,255,255,0.8)'
                    }}>
                      <strong style={{ color: '#ef4444' }}>{t('options.serverNotDetected')}</strong>
                      <br />
                      {t('options.startBackendServer')} <code style={{ background: 'rgba(0,0,0,0.3)', padding: '2px 6px', borderRadius: '3px' }}>npm run start:backend</code>
                    </div>
                  )}
                </div>

                {/* Connected Dashboards */}
                <div style={{
                  background: 'rgba(255,255,255,0.05)',
                  borderRadius: '8px',
                  padding: '16px'
                }}>
                  <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.7)', marginBottom: '12px' }}>
                    {t('options.connectedDashboards')}
                  </div>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '12px',
                    padding: '16px',
                    background: 'rgba(0,0,0,0.2)',
                    borderRadius: '8px'
                  }}>
                    <span style={{
                      fontSize: '36px',
                      fontWeight: 700,
                      color: dashboardServer.dashboardCount > 0 ? '#22c55e' : 'rgba(255,255,255,0.3)'
                    }}>
                      {dashboardServer.dashboardCount || 0}
                    </span>
                    <div style={{ textAlign: 'left' }}>
                      <div style={{ fontSize: '14px', color: 'rgba(255,255,255,0.8)' }}>
                        {dashboardServer.dashboardCount === 1
                          ? t('options.dashboardConnected', { count: dashboardServer.dashboardCount || 0 })
                          : t('options.dashboardsConnected', { count: dashboardServer.dashboardCount || 0 })}
                      </div>
                      {dashboardServer.dashboardCount > 0 && (
                        <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', marginTop: '2px' }}>
                          {t('options.refereeBenchCount', { refereeCount: dashboardServer.refereeCount || 0, benchCount: dashboardServer.benchCount || 0 })}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Individual clients list */}
                  {dashboardServer.connectedDashboards?.length > 0 && (
                    <div style={{ marginTop: '12px' }}>
                      {dashboardServer.connectedDashboards.map((client, idx) => (
                        <div
                          key={client.id || idx}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '8px 12px',
                            background: 'rgba(255,255,255,0.03)',
                            borderRadius: '6px',
                            marginBottom: idx < dashboardServer.connectedDashboards.length - 1 ? '6px' : 0
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{
                              width: '8px',
                              height: '8px',
                              borderRadius: '50%',
                              background: '#22c55e'
                            }} />
                            <span style={{ fontSize: '13px', fontWeight: 600, textTransform: 'capitalize' }}>
                              {client.role}
                              {client.team && ` (${client.team})`}
                            </span>
                          </div>
                          <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', fontFamily: 'monospace' }}>
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '24px' }}>
            <button
              onClick={() => {
                onClose?.()
                onOpenConnectionSetup?.()
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '12px 16px',
                fontSize: '16px',
                fontWeight: 600,
                background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.2) 0%, rgba(139, 92, 246, 0.2) 100%)',
                color: 'var(--text)',
                border: '1px solid rgba(59, 130, 246, 0.4)',
                borderRadius: '8px',
                cursor: 'pointer',
                width: '100%',
                transition: 'all 0.2s'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'linear-gradient(135deg, rgba(59, 130, 246, 0.3) 0%, rgba(139, 92, 246, 0.3) 100%)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'linear-gradient(135deg, rgba(59, 130, 246, 0.2) 0%, rgba(139, 92, 246, 0.2) 100%)'
              }}
            >
              <span style={{ fontSize: '20px' }}>📡</span>
              <span>{t('options.setupConnections')}</span>
            </button>
          </div>
        )}

        {activeDisplayMode === 'desktop' && (
          <Section title={t('options.downloadDesktopApp')} borderBottom={false}>
            <a
              href="https://github.com/Lucanepa/openvolley/releases"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '12px 16px',
                fontSize: '16px',
                fontWeight: 600,
                background: 'rgba(255, 255, 255, 0.1)',
                color: 'var(--text)',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                borderRadius: '8px',
                textDecoration: 'none',
                transition: 'all 0.2s',
                justifyContent: 'center'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.15)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
              }}
            >
              <span>{t('options.viewReleasesDownloads')}</span>
              <span style={{ fontSize: '14px', opacity: 0.7 }}>↗</span>
            </a>
          </Section>
        )}

      

        {backup && (
          <Section title={t('options.backup')}>
            <Row style={{ flexDirection: 'column', alignItems: 'stretch', gap: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <div style={{ fontWeight: 600, fontSize: '15px' }}>{t('options.autoBackup')}</div>
                  <InfoDot title={backup.hasFileSystemAccess
                    ? t('options.autoBackupFolderInfo')
                    : t('options.autoBackupDownloadInfo')
                  } />
                </div>
                <ToggleSwitch
                  value={backup.autoBackupEnabled}
                  onToggle={() => backup.toggleAutoBackup(!backup.autoBackupEnabled)}
                />
              </div>

              {backup.hasFileSystemAccess ? (
                // Chrome/Edge: Folder selection
                <div style={{ marginTop: '8px' }}>
                  <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', marginBottom: '8px' }}>
                    {t('options.backupLocation')}: {backup.backupDirName || t('common.notSet')}
                  </div>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <button
                      onClick={backup.selectBackupDir}
                      style={{
                        padding: '6px 12px',
                        fontSize: '12px',
                        fontWeight: 600,
                        background: 'rgba(59, 130, 246, 0.2)',
                        color: '#3b82f6',
                        border: '1px solid rgba(59, 130, 246, 0.4)',
                        borderRadius: '4px',
                        cursor: 'pointer'
                      }}
                    >
                      {backup.backupDirName ? t('options.changeFolder') : t('options.selectBackupFolder')}
                    </button>
                    {backup.backupDirName && (
                      <button
                        onClick={backup.clearBackupDir}
                        style={{
                          padding: '6px 12px',
                          fontSize: '12px',
                          fontWeight: 600,
                          background: 'rgba(239, 68, 68, 0.2)',
                          color: '#ef4444',
                          border: '1px solid rgba(239, 68, 68, 0.4)',
                          borderRadius: '4px',
                          cursor: 'pointer'
                        }}
                      >
                        {t('options.clear')}
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                // Safari/Firefox: Show browser limitation notice + event-based backup
                <div style={{ marginTop: '8px' }}>
                  <div style={{
                    padding: '10px 12px',
                    background: 'rgba(251, 191, 36, 0.15)',
                    border: '1px solid rgba(251, 191, 36, 0.3)',
                    borderRadius: '6px',
                    marginBottom: '12px'
                  }}>
                    <div style={{ fontSize: '12px', fontWeight: 600, color: '#fbbf24', marginBottom: '4px' }}>
                      {t('options.limitedBrowserSupport')}
                    </div>
                    <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.7)', lineHeight: '1.4' }}>
                      {t('options.limitedBrowserSupportDesc')}
                    </div>
                  </div>
                  <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', marginBottom: '8px' }}>
                    {t('options.eventBasedAutoDownload')}:
                  </div>
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, 1fr)',
                    gap: '6px',
                    fontSize: '11px',
                    color: 'rgba(255,255,255,0.7)'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ color: '#22c55e' }}>✓</span> {t('options.setStart')}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ color: '#22c55e' }}>✓</span> {t('options.setEnd')}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ color: '#22c55e' }}>✓</span> {t('options.matchEnd')}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ color: '#22c55e' }}>✓</span> {t('options.timeoutCalled')}
                    </div>
                  </div>
                  <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)', marginTop: '8px' }}>
                    {t('options.eventBasedNote')}
                  </div>
                </div>
              )}

              {backup.lastBackup && (
                <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', marginTop: '4px' }}>
                  {t('options.lastBackup')}: {backup.lastBackup.toLocaleTimeString()}
                </div>
              )}

              {backup.backupError && (
                <div style={{
                  marginTop: '8px',
                  padding: '8px',
                  background: 'rgba(239,68,68,0.2)',
                  borderRadius: '6px',
                  fontSize: '12px',
                  color: '#ef4444'
                }}>
                  {backup.backupError}
                </div>
              )}

              <div style={{ marginTop: '8px' }}>
                <button
                  onClick={() => backup.manualBackup()}
                  disabled={backup.isBackingUp}
                  style={{
                    padding: '8px 16px',
                    fontSize: '13px',
                    fontWeight: 600,
                    background: backup.isBackingUp ? 'rgba(255, 255, 255, 0.1)' : 'rgba(34, 197, 94, 0.2)',
                    color: backup.isBackingUp ? 'rgba(255,255,255,0.5)' : '#22c55e',
                    border: backup.isBackingUp ? '1px solid rgba(255, 255, 255, 0.2)' : '1px solid rgba(34, 197, 94, 0.4)',
                    borderRadius: '6px',
                    cursor: backup.isBackingUp ? 'not-allowed' : 'pointer'
                  }}
                >
                  {backup.isBackingUp ? t('options.backingUp') : t('options.downloadBackupNow')}
                </button>
              </div>
            </Row>
          </Section>
        )}

        <Section title={t('options.appVersion')}>
          <Row style={{ flexDirection: 'column', alignItems: 'stretch', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: '15px' }}>{t('options.currentVersion')}</div>
                <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.6)', marginTop: '4px' }}>
                  v{currentVersion}
                </div>
              </div>
              <button
                onClick={checkForUpdates}
                disabled={updateCheck.checking}
                style={{
                  padding: '8px 16px',
                  fontSize: '13px',
                  fontWeight: 600,
                  background: updateCheck.checking ? 'rgba(255, 255, 255, 0.1)' : 'rgba(59, 130, 246, 0.2)',
                  color: updateCheck.checking ? 'rgba(255,255,255,0.5)' : '#3b82f6',
                  border: updateCheck.checking ? '1px solid rgba(255, 255, 255, 0.2)' : '1px solid rgba(59, 130, 246, 0.4)',
                  borderRadius: '6px',
                  cursor: updateCheck.checking ? 'not-allowed' : 'pointer'
                }}
              >
                {updateCheck.checking ? t('options.checking') : t('options.checkForUpdates')}
              </button>
            </div>

            {updateCheck.result === 'available' && (
              <div style={{
                padding: '12px',
                background: 'rgba(34, 197, 94, 0.15)',
                border: '1px solid rgba(34, 197, 94, 0.3)',
                borderRadius: '6px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '12px'
              }}>
                <div>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: '#22c55e' }}>
                    {t('options.updateAvailable')}
                  </div>
                  <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)', marginTop: '2px' }}>
                    {currentVersion} → {newVersion}
                  </div>
                </div>
                <button
                  onClick={() => window.location.reload()}
                  style={{
                    padding: '6px 12px',
                    fontSize: '12px',
                    fontWeight: 600,
                    background: '#22c55e',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                >
                  {t('options.refreshToUpdate')}
                </button>
              </div>
            )}

            {updateCheck.result === 'latest' && (
              <div style={{
                padding: '10px 12px',
                background: 'rgba(59, 130, 246, 0.1)',
                border: '1px solid rgba(59, 130, 246, 0.2)',
                borderRadius: '6px',
                fontSize: '13px',
                color: 'rgba(255,255,255,0.8)'
              }}>
                {t('options.latestVersion')}
              </div>
            )}

            {updateCheck.result === 'error' && (
              <div style={{
                padding: '10px 12px',
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.2)',
                borderRadius: '6px',
                fontSize: '13px',
                color: '#ef4444'
              }}>
                {t('options.couldNotCheckUpdates')}
              </div>
            )}
          </Row>
        </Section>

        <Section title={t('options.cacheManagement')} borderBottom={false}>
          <Row style={{ flexDirection: 'column', alignItems: 'stretch', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ fontWeight: 600, fontSize: '15px' }}>{t('options.clearApplicationCache')}</div>
              <InfoDot title={t('options.clearApplicationCacheInfo')} />
            </div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button
                onClick={() => setClearCacheModal({ type: 'cache' })}
                style={{
                  padding: '8px 16px',
                  fontSize: '13px',
                  fontWeight: 600,
                  background: 'rgba(239, 68, 68, 0.2)',
                  color: '#ef4444',
                  border: '1px solid rgba(239, 68, 68, 0.4)',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  transition: 'all 0.2s'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(239, 68, 68, 0.3)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(239, 68, 68, 0.2)'
                }}
              >
                {t('options.clearCache')}
              </button>
              <button
                onClick={() => setClearCacheModal({ type: 'all' })}
                style={{
                  padding: '8px 16px',
                  fontSize: '13px',
                  fontWeight: 600,
                  background: 'rgba(239, 68, 68, 0.4)',
                  color: '#fff',
                  border: '1px solid rgba(239, 68, 68, 0.6)',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  transition: 'all 0.2s'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(239, 68, 68, 0.5)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(239, 68, 68, 0.4)'
                }}
              >
                {t('options.clearAll')}
              </button>
            </div>
          </Row>
        </Section>

        {/* Clear Cache Confirmation Modal */}
        {clearCacheModal && (
          <div
            onClick={() => setClearCacheModal(null)}
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'rgba(0, 0, 0, 0.7)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 10000
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                background: '#1f2937',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                borderRadius: '12px',
                padding: '24px',
                maxWidth: '400px',
                width: '90%'
              }}
            >
              <h3 style={{ margin: '0 0 16px 0', fontSize: '18px', fontWeight: 600, color: '#fff' }}>
                {t('options.confirmClearCache')}
              </h3>
              <p style={{ margin: '0 0 16px 0', color: 'rgba(255, 255, 255, 0.8)', lineHeight: 1.5 }}>
                {clearCacheModal.type === 'all'
                  ? t('options.clearAllWarning')
                  : t('options.clearCacheWarning')
                }
              </p>
              {clearCacheModal.type === 'all' && (
                <p style={{ margin: '0 0 16px 0', color: '#ef4444', fontSize: '13px' }}>
                  {t('options.resetPreferencesWarning')}
                </p>
              )}
              <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
                <button
                  onClick={() => setClearCacheModal(null)}
                  style={{
                    padding: '10px 20px',
                    fontSize: '14px',
                    fontWeight: 600,
                    background: 'rgba(255, 255, 255, 0.1)',
                    color: 'var(--text)',
                    border: '1px solid rgba(255, 255, 255, 0.2)',
                    borderRadius: '8px',
                    cursor: 'pointer'
                  }}
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={() => executeClearCache(clearCacheModal.type === 'all')}
                  style={{
                    padding: '10px 20px',
                    fontSize: '14px',
                    fontWeight: 600,
                    background: '#ef4444',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '8px',
                    cursor: 'pointer'
                  }}
                >
                  {clearCacheModal.type === 'all' ? t('options.clearAll') : t('options.clearCache')}
                </button>
              </div>
            </div>
          </div>
        )}

        <div style={{
          marginTop: '24px',
          paddingTop: '24px',
          borderTop: '1px solid rgba(255, 255, 255, 0.1)',
          textAlign: 'center',
          fontSize: '12px',
          color: 'var(--muted)'
        }}>
          {t('common.support', 'Support:')} luca.canepa@gmail.com
        </div>
      </div>

      {/* Keybindings Modal */}
      {keybindingsModalOpen && (
        <div
          onClick={() => {
            setKeybindingsModalOpen(false)
            setEditingKey(null)
          }}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.8)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2000
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#1f2937',
              borderRadius: '12px',
              padding: '24px',
              minWidth: '360px',
              maxWidth: '90vw',
              maxHeight: '80vh',
              overflowY: 'auto',
              boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>{t('options.keybindings')}</h3>
              <button
                onClick={() => {
                  setKeybindingsModalOpen(false)
                  setEditingKey(null)
                }}
                style={{
                  width: '28px',
                  height: '28px',
                  borderRadius: '6px',
                  border: 'none',
                  background: 'rgba(255, 255, 255, 0.1)',
                  color: 'var(--text)',
                  fontSize: '16px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              >
                ×
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {keyBindingKeys.map((key) => (
                <div
                  key={key}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '10px 12px',
                    background: 'rgba(255, 255, 255, 0.05)',
                    borderRadius: '8px'
                  }}
                >
                  <span style={{ fontSize: '14px', color: 'rgba(255, 255, 255, 0.9)' }}>{t(`options.keybindingLabels.${key}`)}</span>
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
                    style={{
                      padding: '6px 14px',
                      fontSize: '13px',
                      fontWeight: 600,
                      fontFamily: 'monospace',
                      background: editingKey === key ? 'rgba(59, 130, 246, 0.3)' : 'rgba(255, 255, 255, 0.1)',
                      color: editingKey === key ? '#60a5fa' : '#fff',
                      border: editingKey === key ? '1px solid #3b82f6' : '1px solid rgba(255, 255, 255, 0.2)',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      minWidth: '80px',
                      transition: 'all 0.2s'
                    }}
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

            <div style={{ display: 'flex', gap: '12px', marginTop: '20px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => {
                  setKeyBindings(defaultKeyBindings)
                  localStorage.setItem('keyBindings', JSON.stringify(defaultKeyBindings))
                }}
                style={{
                  padding: '8px 16px',
                  fontSize: '13px',
                  fontWeight: 600,
                  background: 'rgba(255, 255, 255, 0.1)',
                  color: 'var(--text)',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: '6px',
                  cursor: 'pointer'
                }}
              >
                {t('options.resetDefaults')}
              </button>
              <button
                onClick={() => {
                  setKeybindingsModalOpen(false)
                  setEditingKey(null)
                }}
                style={{
                  padding: '8px 16px',
                  fontSize: '13px',
                  fontWeight: 600,
                  background: '#3b82f6',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer'
                }}
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
