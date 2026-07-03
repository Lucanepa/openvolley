import { useState, useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import SupportFeedbackModal from '../SupportFeedbackModal'
import UserButton from '../auth/UserButton'
import { useScaledLayout } from '../../hooks/useScaledLayout'

const RELEASES_PAGE = 'https://github.com/Lucanepa/openvolley/releases'
const RELEASES_API = 'https://api.github.com/repos/Lucanepa/openvolley/releases?per_page=20'

function detectDesktopOS() {
  const ua = navigator.userAgent
  if (/android|iphone|ipad|ipod|mobile|tablet/i.test(ua)) return null
  if (/Windows/i.test(ua)) return 'windows'
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macos'
  if (/Linux/i.test(ua)) return 'linux'
  return null
}

// Already running inside the Electron/Tauri desktop app — no point offering the download.
function isInsideDesktopApp() {
  return typeof window !== 'undefined' &&
    (!!window.electronAPI || !!window.__TAURI__ || !!window.__TAURI_INTERNALS__)
}

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
  const desktopOS = useMemo(() => detectDesktopOS(), [])
  const inDesktopApp = useMemo(() => isInsideDesktopApp(), [])

  // Direct installer links from the newest desktop-v* GitHub release. On any
  // failure (offline, rate limit, no release yet) the section falls back to
  // linking the releases page.
  const [desktopApp, setDesktopApp] = useState(null)
  useEffect(() => {
    if (!desktopOS || inDesktopApp) return
    let cancelled = false
    fetch(RELEASES_API)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(releases => {
        if (cancelled || !Array.isArray(releases)) return
        const rel = releases.find(r => !r.draft && !r.prerelease && r.tag_name?.startsWith('desktop-v'))
        if (!rel) return
        const asset = ext => rel.assets?.find(a => a.name?.toLowerCase().endsWith(ext))?.browser_download_url
        setDesktopApp({
          version: rel.tag_name.replace('desktop-v', ''),
          exe: asset('.exe'),
          appimage: asset('.appimage'),
          deb: asset('.deb'),
          page: rel.html_url
        })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [desktopOS, inDesktopApp])

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
                background: 'var(--panel)',
                borderRadius,
                padding: `${Math.round(12 * scaleFactor)}px`,
                display: 'flex',
                flexDirection: 'column',
                gap: tinyGap,
                boxShadow: '0 8px 32px rgba(15, 23, 42, 0.15)',
                border: '1px solid var(--border)'
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
              background: 'var(--panel-2)',
              border: '1px solid var(--border)',
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
              background: 'var(--panel)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
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

        {/* Downloads (desktop app + server) - desktop browsers only, hidden inside the app */}
        {desktopOS && !inDesktopApp && (() => {
          const downloadLinkStyle = {
            display: 'inline-flex',
            alignItems: 'center',
            gap: tinyGap,
            padding: smallPadding,
            fontSize: `${Math.round(14 * scaleFactor)}px`,
            color: 'var(--muted)',
            background: 'none',
            border: '1px solid var(--border)',
            borderRadius: smallBorderRadius,
            textDecoration: 'none',
            cursor: 'pointer',
            transition: 'all 0.2s'
          }
          const hoverIn = (e) => {
            e.currentTarget.style.color = 'var(--text)'
            e.currentTarget.style.borderColor = 'var(--muted)'
          }
          const hoverOut = (e) => {
            e.currentTarget.style.color = 'var(--muted)'
            e.currentTarget.style.borderColor = 'var(--border)'
          }
          const appHref =
            (desktopOS === 'windows' && desktopApp?.exe) ||
            (desktopOS === 'linux' && desktopApp?.appimage) ||
            desktopApp?.page || RELEASES_PAGE
          const appLabel = t('home.downloadApp', 'Download the desktop app — offline scoretable + tablet server') +
            (desktopApp?.version ? ` (v${desktopApp.version})` : '')
          return (
            <div style={{ marginTop: gap, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tinyGap }}>
              <a
                href={appHref}
                target="_blank"
                rel="noopener noreferrer"
                style={downloadLinkStyle}
                onMouseEnter={hoverIn}
                onMouseLeave={hoverOut}
              >
                <span>↓</span>
                <span>{appLabel}</span>
              </a>
              {desktopOS === 'linux' && desktopApp?.deb && (
                <a
                  href={desktopApp.deb}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ ...downloadLinkStyle, border: 'none', padding: 0, fontSize: `${Math.round(12 * scaleFactor)}px` }}
                  onMouseEnter={hoverIn}
                  onMouseLeave={hoverOut}
                >
                  {t('home.downloadAppDeb', 'or get the .deb package')}
                </a>
              )}
              <a
                href={RELEASES_PAGE}
                target="_blank"
                rel="noopener noreferrer"
                style={{ ...downloadLinkStyle, border: 'none', padding: 0, fontSize: `${Math.round(12 * scaleFactor)}px` }}
                onMouseEnter={hoverIn}
                onMouseLeave={hoverOut}
              >
                {t('home.downloadServer', 'Download Server — Referee without internet')}
              </a>
            </div>
          )
        })()}

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
