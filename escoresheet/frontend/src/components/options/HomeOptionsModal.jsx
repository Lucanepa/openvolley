import { useState } from 'react'
import Modal from '../Modal'

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
        title={title}
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

export default function HomeOptionsModal({
  open,
  onClose,
  onOpenGuide,
  onOpenConnectionSetup,
  matchOptions,
  displayOptions,
  wakeLock,
  backup = null // Optional backup props from useAutoBackup
}) {
  const [clearCacheModal, setClearCacheModal] = useState(null) // { type: 'cache' | 'all' }

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
    activeDisplayMode,
    enterDisplayMode,
    exitDisplayMode
  } = displayOptions

  const { wakeLockActive, toggleWakeLock } = wakeLock

  const modeDescriptions = {
    desktop: 'Full layout with court visualization',
    tablet: 'Scaled-down layout optimized for 768-1024px screens',
    smartphone: 'Compact 3-column layout without court, optimized for <768px screens'
  }

  return (
    <Modal
      open={true}
      title="Options"
      onClose={onClose}
      width={500}
    >
      <div style={{ padding: '24px' }}>
        <Section title={null}>
          <Row style={{ marginBottom: '12px', alignItems: 'flex-start' }}>
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

          <Row style={{ marginBottom: '12px', alignItems: 'flex-start' }}>
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
              <div style={{ fontWeight: 600, fontSize: '15px' }}>Set 2-3 Interval Duration</div>
              <InfoDot title="Duration of break between sets 2 and 3" />
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

          <Row>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ fontWeight: 600, fontSize: '15px' }}>Keyboard Shortcuts</div>
              <InfoDot title="Use keyboard keys to control scoring and actions (configure in Scoreboard)" />
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

          <Row>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ fontWeight: 600, fontSize: '15px' }}>Screen Always On</div>
              <InfoDot title="Prevent screen from sleeping during scoring" />
            </div>
            <ToggleSwitch value={wakeLockActive} onToggle={toggleWakeLock} />
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

        {activeDisplayMode === 'desktop' && (
          <Section title="Download Desktop App" borderBottom={false}>
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
              <span>View Releases & Downloads</span>
              <span style={{ fontSize: '14px', opacity: 0.7 }}>↗</span>
            </a>
          </Section>
        )}

        <Section title="Environment">
          <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', marginBottom: '12px' }}>
            Quick links to all app pages. Open in new tabs for multi-device setup.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {[
              { path: '/', name: 'Scoreboard', desc: 'Main scoring interface' },
              { path: '/referee', name: 'Referee', desc: 'Referee Dashboard' },
              { path: '/bench', name: 'Bench', desc: 'Team Dashboard tablet' },
              { path: '/livescore', name: 'Livescore', desc: 'Public display' },
              { path: '/upload_roster', name: 'Upload Roster', desc: 'Import team rosters from PDF/CSV' }
            ].map(page => (
              <a
                key={page.path}
                href={`https://app.openvolley.app${page.path}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 14px',
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  borderRadius: '8px',
                  textDecoration: 'none',
                  color: 'var(--text)',
                  transition: 'all 0.2s'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                  e.currentTarget.style.borderColor = 'rgba(59, 130, 246, 0.4)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
                  e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)'
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '2px' }}>
                    {page.name}
                  </div>
                  <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)' }}>
                    {page.desc}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: '12px' }}>
                  <code style={{
                    fontSize: '10px',
                    padding: '3px 6px',
                    background: 'rgba(0,0,0,0.3)',
                    borderRadius: '4px',
                    color: 'rgba(255,255,255,0.6)'
                  }}>
                    {page.path === '/' ? '/' : page.path}
                  </code>
                  <span style={{ fontSize: '12px', opacity: 0.5 }}>↗</span>
                </div>
              </a>
            ))}
          </div>
          <div style={{
            marginTop: '12px',
            padding: '10px 12px',
            background: 'rgba(59, 130, 246, 0.1)',
            border: '1px solid rgba(59, 130, 246, 0.2)',
            borderRadius: '6px',
            fontSize: '11px',
            color: 'rgba(255,255,255,0.7)'
          }}>
            <strong style={{ color: '#3b82f6' }}>Tip:</strong> For local network setup, use your device's IP address instead of app.openvolley.app (e.g., http://192.168.1.100:5173/referee)
          </div>
        </Section>

        {backup && (
          <Section title="Backup">
            <Row style={{ flexDirection: 'column', alignItems: 'stretch', gap: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <div style={{ fontWeight: 600, fontSize: '15px' }}>Auto Backup</div>
                  <InfoDot title={backup.hasFileSystemAccess
                    ? "Automatically save match data to selected folder on every change"
                    : "Automatically download backup every few minutes during active match"
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
                    Backup Location: {backup.backupDirName || 'Not set'}
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
                      {backup.backupDirName ? 'Change Folder' : 'Select Backup Folder'}
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
                        Clear
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
                      Limited Browser Support
                    </div>
                    <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.7)', lineHeight: '1.4' }}>
                      Your browser doesn't support automatic folder backup. For best experience, use <strong style={{ color: '#fff' }}>Chrome</strong> or <strong style={{ color: '#fff' }}>Edge</strong> on desktop.
                    </div>
                  </div>
                  <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', marginBottom: '8px' }}>
                    Event-based auto-download (when enabled):
                  </div>
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, 1fr)',
                    gap: '6px',
                    fontSize: '11px',
                    color: 'rgba(255,255,255,0.7)'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ color: '#22c55e' }}>✓</span> Set Start
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ color: '#22c55e' }}>✓</span> Set End
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ color: '#22c55e' }}>✓</span> Match End
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ color: '#22c55e' }}>✓</span> Timeout Called
                    </div>
                  </div>
                  <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)', marginTop: '8px' }}>
                    Note: Each download creates a new file in your Downloads folder
                  </div>
                </div>
              )}

              {backup.lastBackup && (
                <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', marginTop: '4px' }}>
                  Last backup: {backup.lastBackup.toLocaleTimeString()}
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
                  {backup.isBackingUp ? 'Backing up...' : 'Download Backup Now'}
                </button>
              </div>
            </Row>
          </Section>
        )}

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

        <div style={{
          marginTop: '24px',
          paddingTop: '24px',
          borderTop: '1px solid rgba(255, 255, 255, 0.1)',
          textAlign: 'center',
          fontSize: '12px',
          color: 'var(--muted)'
        }}>
          Support: luca.canepa@gmail.com
        </div>
      </div>
    </Modal>
  )
}
