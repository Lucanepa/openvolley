import { useState } from 'react'
import Modal from '../Modal'
import { listCloudBackups, loadCloudBackup } from '../../utils/logger'
import { restoreMatchInPlace } from '../../utils/backupManager'

function InfoDot({ title }) {
  return (
    <div
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '16px',
        height: '16px',
        borderRadius: '50%',
        background: 'rgba(255, 255, 255, 0.2)',
        color: 'rgba(255, 255, 255, 0.7)',
        fontSize: '11px',
        fontWeight: 600,
        cursor: 'help'
      }}
      title={title}
      onClick={() => alert(title)}
    >
      i
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
  const [clearCacheModal, setClearCacheModal] = useState(null) // { type: 'cache' | 'all' }
  const [showCloudBackups, setShowCloudBackups] = useState(false)
  const [cloudBackups, setCloudBackups] = useState([])
  const [backupsLoading, setBackupsLoading] = useState(false)
  const [restoreConfirm, setRestoreConfirm] = useState(null) // backup to confirm restore

  // Load cloud backups
  const loadBackups = async () => {
    if (!matchId) {
      alert('No match ID available')
      return
    }
    setBackupsLoading(true)
    try {
      const backups = await listCloudBackups(matchId)
      setCloudBackups(backups)
      setShowCloudBackups(true)
    } catch (err) {
      console.error('Failed to load backups:', err)
      alert('Failed to load cloud backups')
    } finally {
      setBackupsLoading(false)
    }
  }

  // Restore from a cloud backup
  const handleRestore = async (backup) => {
    try {
      const backupData = await loadCloudBackup(backup.path)
      if (!backupData) {
        alert('Failed to load backup data')
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
      alert('Failed to restore backup: ' + err.message)
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
      alert('Failed to clear cache: ' + error.message)
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
    desktop: 'Full layout with court visualization',
    tablet: 'Scaled-down layout optimized for 768-1024px screens',
    smartphone: 'Compact 3-column layout without court, optimized for <768px screens'
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
        <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>Options</h2>
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
          title="Close"
        >
          ×
        </button>
      </div>
      <div style={{ padding: '24px', maxHeight: 'calc(80vh - 60px)', overflowY: 'auto' }}>
        {serverManagementAvailable && (
          <Section title="Live Server" paddingBottom="24px">
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
                    <span style={{ fontWeight: 600 }}>Server Running</span>
                  </div>
                  <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.7)', marginLeft: '24px' }}>
                    <div>Hostname: <span style={{ fontFamily: 'monospace' }}>{serverStatus.hostname || 'escoresheet.local'}</span></div>
                    <div>IP Address: <span style={{ fontFamily: 'monospace' }}>{serverStatus.localIP}</span></div>
                    <div>Protocol: <span style={{ textTransform: 'uppercase' }}>{serverStatus.protocol || 'https'}</span></div>
                  </div>
                </div>

                <div style={{
                  background: 'rgba(15, 23, 42, 0.5)',
                  padding: '12px',
                  borderRadius: '8px',
                  marginBottom: '12px',
                  fontSize: '12px'
                }}>
                  <div style={{ fontWeight: 600, marginBottom: '8px' }}>Connection URLs:</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontFamily: 'monospace', fontSize: '11px' }}>
                    <div style={{ wordBreak: 'break-all' }}>
                      <span style={{ color: 'rgba(255,255,255,0.6)' }}>Main: </span>
                      {serverStatus.urls?.mainIP || `${serverStatus.protocol}://${serverStatus.localIP}:${serverStatus.port}/`}
                    </div>
                    <div style={{ wordBreak: 'break-all' }}>
                      <span style={{ color: 'rgba(255,255,255,0.6)' }}>Referee: </span>
                      {serverStatus.urls?.refereeIP || `${serverStatus.protocol}://${serverStatus.localIP}:${serverStatus.port}/referee`}
                    </div>
                    <div style={{ wordBreak: 'break-all' }}>
                      <span style={{ color: 'rgba(255,255,255,0.6)' }}>Bench: </span>
                      {serverStatus.urls?.benchIP || `${serverStatus.protocol}://${serverStatus.localIP}:${serverStatus.port}/bench`}
                    </div>
                    <div style={{ wordBreak: 'break-all' }}>
                      <span style={{ color: 'rgba(255,255,255,0.6)' }}>WebSocket: </span>
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
                  {serverLoading ? 'Stopping…' : 'Stop Server'}
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
                    <span style={{ fontWeight: 600 }}>Server Not Running</span>
                  </div>
                </div>
                <p style={{ fontSize: '14px', color: 'rgba(255,255,255,0.7)', marginBottom: '12px' }}>
                  Start the live server to allow referee, bench, and livescore apps to connect.
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
                  {serverLoading ? 'Starting…' : 'Start Server'}
                </button>
              </div>
            )}
          </Section>
        )}

        <Section title="Match Options">
          <Row style={{ marginBottom: '12px' }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                <div style={{ fontWeight: 600, fontSize: '15px' }}>Check Accidental Rally Start</div>
                <InfoDot title={`Ask for confirmation if "Start Rally" is pressed within ${accidentalRallyStartDuration}s of awarding a point`} />
              </div>
              {checkAccidentalRallyStart && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
                  <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)' }}>Duration:</span>
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
                  <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)' }}>seconds</span>
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
                <div style={{ fontWeight: 600, fontSize: '15px' }}>Check Accidental Point Award</div>
                <InfoDot title={`Ask for confirmation if a point is awarded within ${accidentalPointAwardDuration}s of starting the rally`} />
              </div>
              {checkAccidentalPointAward && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
                  <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)' }}>Duration:</span>
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
                  <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)' }}>seconds</span>
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
              <div style={{ fontWeight: 600, fontSize: '15px' }}>Show Names on Court</div>
              <InfoDot title="Display player last names below the court position circles" />
            </div>
            <ToggleSwitch
              value={displayOptions?.showNamesOnCourt ?? true}
              onToggle={() => displayOptions?.setShowNamesOnCourt?.(!displayOptions?.showNamesOnCourt)}
            />
          </Row>
          <Row style={{ marginBottom: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ fontWeight: 600, fontSize: '15px' }}>Manage Captain on Court</div>
              <InfoDot title="Automatically track which player acts as captain when team captain is not on court" />
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
              <div style={{ fontWeight: 600, fontSize: '15px' }}>Libero Exit Confirmation</div>
              <InfoDot title="Show confirmation modal when libero must exit after player rotation" />
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
              <div style={{ fontWeight: 600, fontSize: '15px' }}>Libero Entry Suggestion</div>
              <InfoDot title="Show suggestion modal to substitute libero for player rotating to back row" />
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
              <div style={{ fontWeight: 600, fontSize: '15px' }}>Set Interval Duration</div>
              <InfoDot title="Duration of interval between sets (default 3 minutes)" />
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

          <Row style={{ marginBottom: '12px' }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: keybindingsEnabled && onOpenKeybindings ? '8px' : 0 }}>
                <div style={{ fontWeight: 600, fontSize: '15px' }}>Keyboard Shortcuts</div>
                <InfoDot title="Use keyboard keys to control scoring and actions" />
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
                  Configure Keys
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
              <div style={{ fontWeight: 600, fontSize: '15px' }}>Auto-download Data at Set End</div>
              <InfoDot title="Automatically download game data when a set ends for backup. In case of emergencies, the local data can be used to restore the game." />
            </div>
            <ToggleSwitch
              value={displayOptions?.autoDownloadAtSetEnd ?? true}
              onToggle={() => displayOptions?.setAutoDownloadAtSetEnd?.(!displayOptions?.autoDownloadAtSetEnd)}
            />
          </Row>
        </Section>

        <Section title="Display Mode">
          <Row style={{ marginBottom: '12px', alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
                <div style={{ fontWeight: 600, fontSize: '15px' }}>Screen Mode</div>
                <InfoDot title="Choose a display mode optimized for your screen size. Tablet and smartphone modes will enter fullscreen and rotate to landscape." />
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
                    <span>{mode === 'auto' ? `Auto (${detectedDisplayMode})` : mode}</span>
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
                    Exit {displayMode} mode
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
            <span>Setup Connections</span>
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
            <span>Show Guide</span>
          </button>
        </div>

        <Section title="Cloud Backup">
          <Row style={{ flexDirection: 'column', alignItems: 'stretch', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ fontWeight: 600, fontSize: '15px' }}>Restore from Cloud</div>
              <InfoDot title="Browse and restore from automatic cloud backups saved during the match" />
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
              {backupsLoading ? 'Loading...' : 'Browse Cloud Backups'}
            </button>
            {!matchId && (
              <p style={{ margin: 0, fontSize: '12px', color: 'rgba(255,255,255,0.5)' }}>
                Start a match to access cloud backups
              </p>
            )}
          </Row>
        </Section>

        <Section title="Cache Management" borderBottom={false}>
          <Row style={{ flexDirection: 'column', alignItems: 'stretch', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ fontWeight: 600, fontSize: '15px' }}>Clear Application Cache</div>
              <InfoDot title="Clears service worker caches and optionally localStorage. Use if app behaves unexpectedly." />
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
                Clear Cache
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
                Clear All (includes settings)
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
                Cloud Backups
              </h3>

              {cloudBackups.length === 0 ? (
                <p style={{ color: 'rgba(255,255,255,0.7)', textAlign: 'center', padding: '24px 0' }}>
                  No cloud backups found for this match
                </p>
              ) : (
                <div style={{ flex: 1, overflowY: 'auto', marginBottom: '16px' }}>
                  {cloudBackups.map((backup, index) => (
                    <div
                      key={backup.name}
                      onClick={() => setRestoreConfirm(backup)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '12px',
                        background: index % 2 === 0 ? 'rgba(255,255,255,0.05)' : 'transparent',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        transition: 'background 0.2s'
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(59, 130, 246, 0.2)'}
                      onMouseLeave={(e) => e.currentTarget.style.background = index % 2 === 0 ? 'rgba(255,255,255,0.05)' : 'transparent'}
                    >
                      <div>
                        <div style={{ fontWeight: 600, fontSize: '15px', marginBottom: '4px' }}>
                          {backup.homePoints !== undefined ? (
                            <>Set {backup.setIndex}: {backup.homePoints} - {backup.awayPoints}</>
                          ) : (
                            backup.name
                          )}
                        </div>
                        <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)' }}>
                          #{backup.sequence || index + 1} • {backup.timestamp || backup.created_at || 'Unknown time'}
                        </div>
                      </div>
                      <div style={{
                        padding: '6px 12px',
                        fontSize: '12px',
                        fontWeight: 600,
                        background: 'rgba(34, 197, 94, 0.2)',
                        color: '#22c55e',
                        borderRadius: '4px'
                      }}>
                        Restore
                      </div>
                    </div>
                  ))}
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
                  Close
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
                Confirm Restore
              </h3>
              <p style={{ margin: '0 0 8px 0', color: 'rgba(255, 255, 255, 0.8)', lineHeight: 1.5 }}>
                Restore match to this state?
              </p>
              <div style={{
                background: 'rgba(255,255,255,0.05)',
                padding: '12px',
                borderRadius: '8px',
                marginBottom: '16px'
              }}>
                <div style={{ fontWeight: 600, fontSize: '16px' }}>
                  {restoreConfirm.homePoints !== undefined ? (
                    <>Set {restoreConfirm.setIndex}: {restoreConfirm.homePoints} - {restoreConfirm.awayPoints}</>
                  ) : (
                    restoreConfirm.name
                  )}
                </div>
                <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)', marginTop: '4px' }}>
                  {restoreConfirm.timestamp || restoreConfirm.created_at}
                </div>
              </div>
              <p style={{ margin: '0 0 16px 0', color: '#ef4444', fontSize: '13px' }}>
                Warning: Current match state will be replaced.
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
                  Cancel
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
                  Restore
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
                Confirm Clear Cache
              </h3>
              <p style={{ margin: '0 0 16px 0', color: 'rgba(255, 255, 255, 0.8)', lineHeight: 1.5 }}>
                {clearCacheModal.type === 'all'
                  ? 'This will clear all cached data AND your settings. The page will reload after clearing.'
                  : 'This will clear cached files. Your settings will be preserved. The page will reload after clearing.'
                }
              </p>
              {clearCacheModal.type === 'all' && (
                <p style={{ margin: '0 0 16px 0', color: '#ef4444', fontSize: '13px' }}>
                  Warning: This will reset all your preferences to defaults.
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
                  Cancel
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
                  Clear {clearCacheModal.type === 'all' ? 'All' : 'Cache'}
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </Modal>
  )
}
