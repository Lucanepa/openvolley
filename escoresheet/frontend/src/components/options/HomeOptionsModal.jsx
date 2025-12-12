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
  matchOptions,
  displayOptions,
  wakeLock
}) {
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

        <div style={{ marginBottom: '24px' }}>
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
