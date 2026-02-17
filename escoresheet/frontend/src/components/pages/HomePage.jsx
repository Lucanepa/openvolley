import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import SupportFeedbackModal from '../SupportFeedbackModal'
import UserButton from '../auth/UserButton'
import { useScaledLayout } from '../../hooks/useScaledLayout'

export default function HomePage({
  favicon,
  newMatchMenuOpen,
  setNewMatchMenuOpen,
  createNewOfficialMatch,
  createNewTestMatch,
  testMatchLoading,
  currentOfficialMatch,
  currentTestMatch,
  continueMatch,
  continueTestMatch,
  showDeleteMatchModal,
  restartTestMatch,
  onOpenSettings,
  onRestoreMatch
}) {
  const { t } = useTranslation()
  const [supportFeedbackOpen, setSupportFeedbackOpen] = useState(false)
  const { scaleFactor } = useScaledLayout()

  // Scaled dimensions
  const buttonWidth = `${Math.round(400 * scaleFactor)}px`
  const largeFontSize = `${Math.round(20 * scaleFactor)}px`
  const largePadding = `${Math.round(16 * scaleFactor)}px ${Math.round(24 * scaleFactor)}px`
  const mediumPadding = `${Math.round(12 * scaleFactor)}px ${Math.round(20 * scaleFactor)}px`
  const smallPadding = `${Math.round(10 * scaleFactor)}px ${Math.round(20 * scaleFactor)}px`
  const borderRadius = `${Math.round(12 * scaleFactor)}px`
  const smallBorderRadius = `${Math.round(8 * scaleFactor)}px`
  const gap = `${Math.round(16 * scaleFactor)}px`
  const smallGap = `${Math.round(12 * scaleFactor)}px`
  const tinyGap = `${Math.round(8 * scaleFactor)}px`

  return (
    <div className="home-view">
      <div className="home-content">
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: tinyGap
        }}>
          <h1 className="home-title" style={{ width: 'auto', margin: 0 }}>{t('home.title')}</h1>
        </div>
        <div className="home-logo" style={{
          width: `${Math.round(200 * scaleFactor)}px`,
          margin: `${Math.round(8 * scaleFactor)}px 0`
        }}>
          <img src={`${import.meta.env.BASE_URL}openvolley_no_bg.png`} alt="Openvolley" />
        </div>

        <div className="home-match-section" style={{ margin: '0 auto', width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap }}>
          {/* New Match Button with Collapsible Menu */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tinyGap }}>
            <button
              data-help-id="home-new-match-button"
              onClick={() => setNewMatchMenuOpen(!newMatchMenuOpen)}
              style={{
                width: buttonWidth,
                padding: largePadding,
                fontSize: largeFontSize,
                fontWeight: 600,
                background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
                color: '#fff',
                border: 'none',
                borderRadius,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: `${Math.round(10 * scaleFactor)}px`,
                transition: 'transform 0.2s, box-shadow 0.2s'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'translateY(-2px)'
                e.currentTarget.style.boxShadow = '0 8px 16px rgba(59, 130, 246, 0.3)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'translateY(0)'
                e.currentTarget.style.boxShadow = 'none'
              }}
            >
              <span>{t('home.newMatch')}</span>
              <span style={{ transform: newMatchMenuOpen ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }}>▼</span>
            </button>

            {/* Collapsible Menu - Pushes content down */}
            {newMatchMenuOpen && (
              <div style={{
                width: buttonWidth,
                background: 'rgba(0, 0, 0, 0.98)',
                borderRadius,
                padding: `${Math.round(12 * scaleFactor)}px`,
                display: 'flex',
                flexDirection: 'column',
                gap: tinyGap,
                boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
                border: '1px solid rgba(255, 255, 255, 0.1)'
              }}>
                <button
                  onClick={() => {
                    setNewMatchMenuOpen(false)
                    createNewOfficialMatch()
                  }}
                  style={{
                    width: '100%',
                    padding: mediumPadding,
                    fontSize: largeFontSize,
                    fontWeight: 600,
                    background: 'rgba(59, 246, 62, 0.1)',
                    color: 'rgba(59, 246, 62)',
                    border: '1px solid rgba(59, 246, 62, 0.3)',
                    borderRadius: smallBorderRadius,
                    cursor: 'pointer',
                    transition: 'background 0.2s'
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(59, 246, 62, 0.2)' }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(59, 246, 62, 0.1)' }}
                >
                  {t('home.officialMatch')}
                </button>
                <button
                  onClick={() => {
                    setNewMatchMenuOpen(false)
                    createNewTestMatch()
                  }}
                  disabled={testMatchLoading}
                  style={{
                    width: '100%',
                    padding: mediumPadding,
                    fontSize: largeFontSize,
                    fontWeight: 600,
                    background: testMatchLoading ? 'hsla(52, 100.00%, 50.00%, 0.05)' : 'hsla(52, 100.00%, 50.00%, 0.10)',
                    color: testMatchLoading ? 'hsla(52, 100.00%, 50.00%, 0.5)' : 'hsla(52, 100.00%, 50.00%, 1.00)',
                    border: testMatchLoading ? '1px solid hsla(52, 100.00%, 50.00%, 0.15)' : '1px solid hsla(52, 100.00%, 50.00%, 0.3)',
                    borderRadius: smallBorderRadius,
                    cursor: testMatchLoading ? 'not-allowed' : 'pointer',
                    transition: 'background 0.2s'
                  }}
                  onMouseEnter={(e) => { if (!testMatchLoading) e.currentTarget.style.background = 'rgba(168, 85, 247, 0.2)' }}
                  onMouseLeave={(e) => { if (!testMatchLoading) e.currentTarget.style.background = 'rgba(168, 85, 247, 0.1)' }}
                >
                  {testMatchLoading ? t('home.preparing') : t('home.testMatch')}
                </button>
              </div>
            )}
          </div>

          {/* Other buttons */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: smallGap }}>
            {/* Continue Match Button - only show when there's a match */}
            {(currentOfficialMatch || currentTestMatch) && (
              <button
                data-help-id="home-continue-button"
                onClick={() => {
                  if (currentOfficialMatch) {
                    continueMatch(currentOfficialMatch.id)
                  } else if (currentTestMatch) {
                    continueTestMatch()
                  }
                }}
                style={{
                  width: buttonWidth,
                  padding: largePadding,
                  fontSize: largeFontSize,
                  fontWeight: 600,
                  background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                  color: '#fff',
                  border: 'none',
                  borderRadius,
                  cursor: 'pointer',
                  transition: 'transform 0.2s, box-shadow 0.2s'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = 'translateY(-2px)'
                  e.currentTarget.style.boxShadow = '0 8px 16px rgba(16, 185, 129, 0.3)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'translateY(0)'
                  e.currentTarget.style.boxShadow = 'none'
                }}
              >
                {t('home.continueMatch')}
              </button>
            )}

            {/* Delete Match Button - only show when there's a match */}
            {(currentOfficialMatch || currentTestMatch) && (
              <button
                data-help-id="home-delete-button"
                onClick={() => {
                  if (currentOfficialMatch) {
                    showDeleteMatchModal()
                  } else if (currentTestMatch) {
                    restartTestMatch()
                  }
                }}
                style={{
                  width: buttonWidth,
                  padding: largePadding,
                  fontSize: largeFontSize,
                  fontWeight: 600,
                  background: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)',
                  color: '#fff',
                  border: 'none',
                  borderRadius,
                  cursor: 'pointer',
                  transition: 'transform 0.2s, box-shadow 0.2s'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = 'translateY(-2px)'
                  e.currentTarget.style.boxShadow = '0 8px 16px rgba(239, 68, 68, 0.3)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'translateY(0)'
                  e.currentTarget.style.boxShadow = 'none'
                }}
              >
                {t('home.deleteMatch')}
              </button>
            )}

          {/* Restore Match Button */}
          <button
            data-help-id="home-restore-button"
            onClick={onRestoreMatch}
            style={{
              width: buttonWidth,
              padding: largePadding,
              fontSize: largeFontSize,
              fontWeight: 600,
              background: 'linear-gradient(135deg, #f97316 0%, #ea580c 100%)',
              color: '#fff',
              border: 'none',
              borderRadius,
              cursor: 'pointer',
              transition: 'transform 0.2s, box-shadow 0.2s'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-2px)'
              e.currentTarget.style.boxShadow = '0 8px 16px rgba(249, 115, 22, 0.3)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)'
              e.currentTarget.style.boxShadow = 'none'
            }}
          >
            {t('home.restoreMatch')}
          </button>

          {/* Game PIN Display (if exists) */}
          {currentOfficialMatch?.gamePin && (
            <div style={{
              width: buttonWidth,
              marginTop: tinyGap,
              padding: `${Math.round(12 * scaleFactor)}px ${Math.round(16 * scaleFactor)}px`,
              background: 'rgba(255, 255, 255, 0.05)',
              borderRadius,
              textAlign: 'center'
            }}>
              <div style={{ fontSize: largeFontSize, color: 'var(--muted)', marginBottom: `${Math.round(4 * scaleFactor)}px`, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{t('home.gamePin')}</div>
              <div style={{ fontSize: largeFontSize, fontWeight: 700, fontFamily: 'monospace', letterSpacing: '2px' }}>
                {currentOfficialMatch.gamePin}
              </div>
            </div>
          )}

          </div>
        </div>
        <div style={{ marginTop: `${Math.round(50 * scaleFactor)}px`, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: smallGap }}>


          <button
            onClick={onOpenSettings}
            style={{
              padding: smallPadding,
              fontSize: largeFontSize,
              fontWeight: 600,
              background: 'rgba(255, 255, 255, 0.1)',
              color: 'var(--text)',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              borderRadius: smallBorderRadius,
              cursor: 'pointer',
              width: buttonWidth
            }}
          >
            {t('home.options')}
          </button>
          <button
            onClick={() => setSupportFeedbackOpen(true)}
            style={{
              padding: smallPadding,
              fontSize: largeFontSize,
              fontWeight: 600,
              background: 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)',
              color: '#fff',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              borderRadius: smallBorderRadius,
              cursor: 'pointer',
              width: buttonWidth,
              transition: 'transform 0.2s, box-shadow 0.2s'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-2px)'
              e.currentTarget.style.boxShadow = '0 8px 16px rgba(34, 197, 94, 0.3)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)'
              e.currentTarget.style.boxShadow = 'none'
            }}
          >
            {t('supportFeedback.button')}
          </button>
        </div>

        {/* Support & Feedback Modal */}
        <SupportFeedbackModal
          open={supportFeedbackOpen}
          onClose={() => setSupportFeedbackOpen(false)}
          currentPage="mainPage"
        />
      </div>
    </div>
  )
}
