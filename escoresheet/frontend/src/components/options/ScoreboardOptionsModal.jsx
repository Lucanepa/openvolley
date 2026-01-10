import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAlert } from '../../contexts/AlertContext'
import Modal from '../Modal'
import { listCloudBackups, loadCloudBackup } from '../../utils/logger'
import { restoreMatchInPlace } from '../../utils/backupManager'
import BackupTable from '../BackupTable'

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
        padding: '12px 16px',
        background: 'rgba(255, 255, 255, 0.05)',
        borderRadius: '8px',
        ...style
      }}
    >
      {children}
    </div>
  )
}

function Section({ title, children, borderBottom = true, paddingBottom = '24px' }) {
  return (
    <div style={{ marginBottom: '24px', paddingBottom: borderBottom ? paddingBottom : 0, borderBottom: borderBottom ? '1px solid rgba(255,255,255,0.1)' : 'none' }}>
      {title ? (
        <h3 style={{ marginTop: 0, marginBottom: '16px', fontSize: '18px', fontWeight: 600 }}>{title}</h3>
      ) : null}
      {children}
    </div>
  )
}

function Stepper({ value, onDecrement, onIncrement, label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: '16px' }}>
      <button
        onClick={onDecrement}
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
        aria-label={`Decrease ${label}`}
      >
        -
      </button>
      <span style={{ minWidth: '80px', textAlign: 'center', fontFamily: 'monospace', fontSize: '14px', fontWeight: 600 }}>
        {Math.floor(value / 60)}' {(value % 60).toString().padStart(2, '0')}''
      </span>
      <button
        onClick={onIncrement}
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
        aria-label={`Increase ${label}`}
      >
        +
      </button>
    </div>
  )
}

export default function ScoreboardOptionsModal({
  open,
  onClose,
  onOpenGuide,
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

  // Load cloud backups
  const loadBackups = async () => {
    if (!matchId) {
      showAlert(t('options.alerts.noMatchId'), 'warning')
      return
    }
    setBackupsLoading(true)
    try {
      const backups = await listCloudBackups(matchId)
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
      const backupData = await loadCloudBackup(backup.path)
      if (!backupData) {
        showAlert(t('options.alerts.failedToLoadBackupData'), 'error')
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
      window.location.reload()
    } catch (err) {
      console.error('Failed to restore backup:', err)
      showAlert(t('options.alerts.failedToRestoreBackup', { error: err.message }), 'error')
    }
  }

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

  const executeClearCache = async (includeLocalStorage) => {
    try {
      await clearServiceWorkerCaches()
      await unregisterServiceWorkers()

      if (includeLocalStorage) {
        localStorage.clear()
      }

      // Reload to apply changes
      window.location.reload()
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
    setKeybindingsEnabled
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
    smartphone: t('options.smartphoneDesc')
  }

  return (
    <Modal
      title=""
      open={true}
      onClose={onClose}
      width={600}
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
      <div style={{ padding: '24px', maxHeight: 'calc(80vh - 60px)', overflowY: 'auto' }}>
        {serverManagementAvailable && (
          <Section title={t('options.liveServer')} paddingBottom="24px">
            {serverRunning && serverStatus ? (
              <div>
                <div style={{
                  background: 'rgba(16, 185, 129, 0.1)',
                  border: '1px solid rgba(16, 185, 129, 0.3)',
                  borderRadius: '8px',
                  padding: '12px',
                  marginBottom: '12px'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                    <span style={{ color: '#10b981', fontWeight: 600 }}>●</span>
                    <span style={{ fontWeight: 600 }}>{t('options.serverRunning')}</span>
                  </div>
                  <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.7)', marginLeft: '24px' }}>
                    <div>{t('options.hostname')}: <span style={{ fontFamily: 'monospace' }}>{serverStatus.hostname || 'escoresheet.local'}</span></div>
                    <div>{t('options.ipAddress')}: <span style={{ fontFamily: 'monospace' }}>{serverStatus.localIP}</span></div>
                    <div>{t('options.protocol')}: <span style={{ textTransform: 'uppercase' }}>{serverStatus.protocol || 'https'}</span></div>
                  </div>
                </div>

                <div style={{
                  background: 'rgba(15, 23, 42, 0.5)',
                  padding: '12px',
                  borderRadius: '8px',
                  marginBottom: '12px',
                  fontSize: '12px'
                }}>
                  <div style={{ fontWeight: 600, marginBottom: '8px' }}>{t('options.connectionUrls')}:</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontFamily: 'monospace', fontSize: '11px' }}>
                    <div style={{ wordBreak: 'break-all' }}>
                      <span style={{ color: 'rgba(255,255,255,0.6)' }}>{t('options.main')}: </span>
                      {serverStatus.urls?.mainIP || `${serverStatus.protocol}://${serverStatus.localIP}:${serverStatus.port}/`}
                    </div>
                    <div style={{ wordBreak: 'break-all' }}>
                      <span style={{ color: 'rgba(255,255,255,0.6)' }}>{t('header.referee')}: </span>
                      {serverStatus.urls?.refereeIP || `${serverStatus.protocol}://${serverStatus.localIP}:${serverStatus.port}/referee`}
                    </div>
                    <div style={{ wordBreak: 'break-all' }}>
                      <span style={{ color: 'rgba(255,255,255,0.6)' }}>{t('header.bench')}: </span>
                      {serverStatus.urls?.benchIP || `${serverStatus.protocol}://${serverStatus.localIP}:${serverStatus.port}/bench`}
                    </div>
                    <div style={{ wordBreak: 'break-all' }}>
                      <span style={{ color: 'rgba(255,255,255,0.6)' }}>{t('options.websocket')}: </span>
                      {serverStatus.urls?.websocketIP || `${serverStatus.wsProtocol}://${serverStatus.localIP}:${serverStatus.wsPort}`}
                    </div>
                  </div>
                </div>

                <button
                  onClick={onStopServer}
                  disabled={serverLoading}
                  style={{
                    padding: '10px 20px',
                    fontSize: '14px',
                    fontWeight: 600,
                    background: '#ef4444',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '8px',
                    cursor: serverLoading ? 'not-allowed' : 'pointer',
                    opacity: serverLoading ? 0.6 : 1,
                    width: '100%'
                  }}
                >
                  {serverLoading ? t('options.stopping') : t('options.stopServer')}
                </button>
              </div>
            ) : (
              <div>
                <div style={{
                  background: 'rgba(239, 68, 68, 0.1)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  borderRadius: '8px',
                  padding: '12px',
                  marginBottom: '12px'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ color: '#ef4444', fontWeight: 600 }}>●</span>
                    <span style={{ fontWeight: 600 }}>{t('options.serverNotRunning')}</span>
                  </div>
                </div>
                <p style={{ fontSize: '14px', color: 'rgba(255,255,255,0.7)', marginBottom: '12px' }}>
                  {t('options.startServerToConnect')}
                </p>
                <button
                  onClick={onStartServer}
                  disabled={serverLoading}
                  style={{
                    padding: '10px 20px',
                    fontSize: '14px',
                    fontWeight: 600,
                    background: '#22c55e',
                    color: '#000',
                    border: 'none',
                    borderRadius: '8px',
                    cursor: serverLoading ? 'not-allowed' : 'pointer',
                    opacity: serverLoading ? 0.6 : 1,
                    width: '100%'
                  }}
                >
                  {serverLoading ? t('options.starting') : t('options.startServer')}
                </button>
              </div>
            )}
          </Section>
        )}

        <Section title={t('options.matchOptions')}>
          <Row style={{ marginBottom: '12px' }}>
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

          <Row style={{ marginBottom: '12px' }}>
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
              <div style={{ fontWeight: 600, fontSize: '15px' }}>{t('options.showNamesOnCourt')}</div>
              <InfoDot title={t('options.showNamesOnCourtInfo')} />
            </div>
            <ToggleSwitch
              value={displayOptions?.showNamesOnCourt ?? true}
              onToggle={() => displayOptions?.setShowNamesOnCourt?.(!displayOptions?.showNamesOnCourt)}
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
            <Stepper
              value={setIntervalDuration}
              label="set interval duration"
              onDecrement={() => {
                const newVal = Math.max(60, setIntervalDuration - 15)
                setSetIntervalDuration(newVal)
                localStorage.setItem('setIntervalDuration', String(newVal))
              }}
              onIncrement={() => {
                const newVal = Math.min(600, setIntervalDuration + 15)
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
                  <button
                    onClick={() => setFontSelectorOpen(!fontSelectorOpen)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '12px 14px',
                      fontSize: '14px',
                      fontWeight: 500,
                      background: 'transparent',
                      color: 'var(--text)',
                      border: 'none',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      textAlign: 'left',
                      width: '100%'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <div style={{ fontWeight: 600, fontSize: '15px' }}>{t('options.scoreFont')}</div>
                      <InfoDot title={t('options.scoreFontInfo')} />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <span style={{
                        fontFamily: currentFont.fontFamily,
                        fontSize: '18px',
                        fontWeight: 700,
                        color: 'var(--accent)',
                        letterSpacing: '1px'
                      }}>
                        {currentFont.preview}
                      </span>
                      <span style={{
                        fontSize: '12px',
                        color: 'rgba(255,255,255,0.5)',
                        transition: 'transform 0.2s',
                        transform: fontSelectorOpen ? 'rotate(180deg)' : 'rotate(0deg)'
                      }}>
                        ▼
                      </span>
                    </div>
                  </button>
                  {fontSelectorOpen && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px', paddingLeft: '8px', paddingRight: '8px' }}>
                      {fontOptions.map(option => (
                        <button
                          key={option.value}
                          onClick={() => {
                            setScoreFont(option.value)
                            localStorage.setItem('scoreFont', option.value)
                            setFontSelectorOpen(false)
                          }}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '10px 14px',
                            fontSize: '14px',
                            fontWeight: 500,
                            background: scoreFont === option.value ? 'rgba(59, 130, 246, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                            color: 'var(--text)',
                            border: scoreFont === option.value ? '2px solid #3b82f6' : '1px solid rgba(255, 255, 255, 0.15)',
                            borderRadius: '8px',
                            cursor: 'pointer',
                            transition: 'all 0.2s',
                            textAlign: 'left'
                          }}
                        >
                          <span style={{ fontSize: '13px' }}>{option.label}</span>
                          <span style={{
                            fontFamily: option.fontFamily,
                            fontSize: '20px',
                            fontWeight: 700,
                            color: scoreFont === option.value ? '#3b82f6' : 'var(--accent)',
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
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: keybindingsEnabled && onOpenKeybindings ? '8px' : 0 }}>
                <div style={{ fontWeight: 600, fontSize: '15px' }}>{t('options.keyboardShortcuts')}</div>
                <InfoDot title={t('options.keyboardShortcutsInfo')} />
              </div>
              {keybindingsEnabled && onOpenKeybindings ? (
                <button
                  onClick={onOpenKeybindings}
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ fontWeight: 600, fontSize: '15px' }}>{t('options.autoDownloadAtSetEnd')}</div>
              <InfoDot title={t('options.autoDownloadAtSetEndInfo')} />
            </div>
            <ToggleSwitch
              value={displayOptions?.autoDownloadAtSetEnd ?? true}
              onToggle={() => displayOptions?.setAutoDownloadAtSetEnd?.(!displayOptions?.autoDownloadAtSetEnd)}
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
                {['auto', 'desktop', 'tablet', 'smartphone'].map(mode => (
                  <button
                    key={mode}
                    onClick={() => {
                      if (mode === 'tablet' || mode === 'smartphone') {
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
        </Section>

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
          <button
            onClick={() => {
              onClose?.()
              onOpenGuide?.()
            }}
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
              cursor: 'pointer',
              width: '100%',
              transition: 'all 0.2s'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.15)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
            }}
          >
            <span style={{ fontSize: '20px' }}>?</span>
            <span>{t('options.showGuide')}</span>
          </button>
        </div>

        <Section title={t('options.cloudBackup')}>
          <Row style={{ flexDirection: 'column', alignItems: 'stretch', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ fontWeight: 600, fontSize: '15px' }}>{t('options.restoreFromCloud')}</div>
              <InfoDot title={t('options.restoreFromCloudInfo')} />
            </div>
            <button
              onClick={loadBackups}
              disabled={backupsLoading || !matchId}
              style={{
                padding: '10px 20px',
                fontSize: '14px',
                fontWeight: 600,
                background: 'linear-gradient(135deg, rgba(34, 197, 94, 0.2) 0%, rgba(16, 185, 129, 0.2) 100%)',
                color: '#22c55e',
                border: '1px solid rgba(34, 197, 94, 0.4)',
                borderRadius: '8px',
                cursor: backupsLoading || !matchId ? 'not-allowed' : 'pointer',
                opacity: backupsLoading || !matchId ? 0.6 : 1,
                width: '100%',
                transition: 'all 0.2s'
              }}
            >
              {backupsLoading ? t('options.loading') : t('options.browseCloudBackups')}
            </button>
            {!matchId && (
              <p style={{ margin: 0, fontSize: '12px', color: 'rgba(255,255,255,0.5)' }}>
                {t('options.startMatchToAccessBackups')}
              </p>
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

        {/* Cloud Backups Modal */}
        {showCloudBackups && (
          <div
            onClick={() => setShowCloudBackups(false)}
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
                maxWidth: '500px',
                width: '90%',
                maxHeight: '70vh',
                display: 'flex',
                flexDirection: 'column'
              }}
            >
              <h3 style={{ margin: '0 0 16px 0', fontSize: '18px', fontWeight: 600, color: '#fff' }}>
                {t('options.cloudBackups')}
              </h3>

              {cloudBackups.length === 0 ? (
                <p style={{ color: 'rgba(255,255,255,0.7)', textAlign: 'center', padding: '24px 0' }}>
                  {t('options.noCloudBackupsFound')}
                </p>
              ) : (
                <div style={{ flex: 1, overflowY: 'auto', marginBottom: '16px' }}>
                  <BackupTable
                    backups={cloudBackups}
                    onBackupSelect={(backup) => setRestoreConfirm(backup)}
                    showRestoreButton={true}
                    mode="row"
                    restoreButtonText={t('options.restore')}
                  />
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  onClick={() => setShowCloudBackups(false)}
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
                  {t('options.close')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Restore Confirmation Modal */}
        {restoreConfirm && (
          <div
            onClick={() => setRestoreConfirm(null)}
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
              zIndex: 10001
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
                {t('options.confirmRestore')}
              </h3>
              <p style={{ margin: '0 0 8px 0', color: 'rgba(255, 255, 255, 0.8)', lineHeight: 1.5 }}>
                {t('options.restoreMatchToThisState')}
              </p>
              <div style={{
                background: 'rgba(255,255,255,0.05)',
                padding: '12px',
                borderRadius: '8px',
                marginBottom: '16px'
              }}>
                <div style={{ fontWeight: 600, fontSize: '16px' }}>
                  {restoreConfirm.homePoints !== undefined ? (
                    t('options.backupSetScore', { setIndex: restoreConfirm.setIndex, homePoints: restoreConfirm.homePoints, awayPoints: restoreConfirm.awayPoints })
                  ) : (
                    restoreConfirm.name
                  )}
                </div>
                <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)', marginTop: '4px' }}>
                  {restoreConfirm.timestamp || restoreConfirm.created_at}
                </div>
              </div>
              <p style={{ margin: '0 0 16px 0', color: '#ef4444', fontSize: '13px' }}>
                {t('options.warningStateReplaced')}
              </p>
              <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
                <button
                  onClick={() => setRestoreConfirm(null)}
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
                  {t('options.cancel')}
                </button>
                <button
                  onClick={() => handleRestore(restoreConfirm)}
                  style={{
                    padding: '10px 20px',
                    fontSize: '14px',
                    fontWeight: 600,
                    background: '#22c55e',
                    color: '#000',
                    border: 'none',
                    borderRadius: '8px',
                    cursor: 'pointer'
                  }}
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
                  {t('options.cancel')}
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

      </div>
    </Modal>
  )
}
