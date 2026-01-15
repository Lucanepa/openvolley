import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '../i18n'

// Flag SVG components for language selector
const FlagGB = () => (
  <svg width="20" height="14" viewBox="0 0 60 42" style={{ borderRadius: '2px', boxShadow: '0 0 1px rgba(0,0,0,0.3)' }}>
    <rect width="60" height="42" fill="#012169" />
    <path d="M0,0 L60,42 M60,0 L0,42" stroke="#fff" strokeWidth="7" />
    <path d="M0,0 L60,42 M60,0 L0,42" stroke="#C8102E" strokeWidth="4" clipPath="url(#gbClip)" />
    <path d="M30,0 V42 M0,21 H60" stroke="#fff" strokeWidth="12" />
    <path d="M30,0 V42 M0,21 H60" stroke="#C8102E" strokeWidth="7" />
  </svg>
)

const FlagIT = () => (
  <svg width="20" height="14" viewBox="0 0 60 42" style={{ borderRadius: '2px', boxShadow: '0 0 1px rgba(0,0,0,0.3)' }}>
    <rect width="20" height="42" fill="#009246" />
    <rect x="20" width="20" height="42" fill="#fff" />
    <rect x="40" width="20" height="42" fill="#CE2B37" />
  </svg>
)

const FlagDE = () => (
  <svg width="20" height="14" viewBox="0 0 60 42" style={{ borderRadius: '2px', boxShadow: '0 0 1px rgba(0,0,0,0.3)' }}>
    <rect width="60" height="14" fill="#000" />
    <rect y="14" width="60" height="14" fill="#DD0000" />
    <rect y="28" width="60" height="14" fill="#FFCE00" />
  </svg>
)

const FlagFR = () => (
  <svg width="20" height="14" viewBox="0 0 60 42" style={{ borderRadius: '2px', boxShadow: '0 0 1px rgba(0,0,0,0.3)' }}>
    <rect width="20" height="42" fill="#002395" />
    <rect x="20" width="20" height="42" fill="#fff" />
    <rect x="40" width="20" height="42" fill="#ED2939" />
  </svg>
)

const FlagCH = () => (
  <svg width="14" height="14" viewBox="0 0 32 32" style={{ borderRadius: '2px', boxShadow: '0 0 1px rgba(0,0,0,0.3)' }}>
    <rect width="32" height="32" fill="#ff0000" />
    <rect x="14" y="6" width="4" height="20" fill="#fff" />
    <rect x="6" y="14" width="20" height="4" fill="#fff" />
  </svg>
)

const languages = [
  { code: 'en', Flag: FlagGB, label: 'EN' },
  { code: 'it', Flag: FlagIT, label: 'IT' },
  { code: 'de', Flag: FlagDE, label: 'DE' },
  { code: 'de-CH', Flag: FlagCH, label: 'DE' },
  { code: 'fr', Flag: FlagFR, label: 'FR' }
]

/**
 * SimpleHeader - 3-column header for all dashboard apps
 * Left: Title/version
 * Middle: Hamburger menu (collapsible)
 * Right: Fullscreen button
 */
export default function SimpleHeader({
  title,
  version,
  menuItems = [], // Array of { icon, label, onClick, active, color, toggle, badge, badgeColor, disabled, divider }
  onFullscreen,
  isFullscreen = false,
  toggleOptions // Optional: segmented toggle [{ label: '1 REF', active: false, onClick }, { label: '2 REF', active: true, onClick }]
}) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const [versionExpanded, setVersionExpanded] = useState(false)
  const [languageExpanded, setLanguageExpanded] = useState(false)
  const currentVersion = version || __APP_VERSION__

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return
    const handleClick = (e) => {
      if (!e.target.closest('.simple-header-menu')) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [menuOpen])

  return (
    <div style={{
      height: '40px',
      minHeight: '40px',
      maxHeight: '40px',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '0 12px',
      background: 'rgba(0, 0, 0, 0.3)',
      borderBottom: '1px solid rgba(255, 255, 255, 0.1)'
    }}>
      {/* LEFT: Title/Version or Toggle */}
      <div style={{
        flex: '1 1 0',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        minWidth: 0
      }}>
        {/* Segmented Toggle (like LOCAL/REMOTE) */}
        {toggleOptions && toggleOptions.length > 0 ? (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            background: 'rgba(255, 255, 255, 0.1)',
            borderRadius: '6px',
            padding: '2px',
            gap: '2px'
          }}>
            {toggleOptions.map((option, idx) => (
              <button
                key={idx}
                onClick={option.onClick}
                style={{
                  padding: '4px 10px',
                  fontSize: 'clamp(11px, 2.5vw, 13px)',
                  fontWeight: 600,
                  background: option.active ? 'rgba(59, 130, 246, 0.3)' : 'transparent',
                  color: option.active ? '#60a5fa' : 'rgba(255, 255, 255, 0.6)',
                  border: option.active ? '1px solid rgba(59, 130, 246, 0.5)' : '1px solid transparent',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  whiteSpace: 'nowrap'
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : title ? (
          <span style={{
            fontSize: 'clamp(12px, 3vw, 15px)',
            fontWeight: 700,
            color: '#fff',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}>
            {title}
          </span>
        ) : null}
      </div>

      {/* MIDDLE: Hamburger Menu */}
      <div
        className="simple-header-menu"
        style={{
          flex: '0 0 auto',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          position: 'relative'
        }}
      >
        {menuItems.length > 0 && (
          <>
            <button
              onClick={(e) => {
                e.stopPropagation()
                setMenuOpen(!menuOpen)
              }}
              style={{
                padding: '6px 14px',
                fontSize: '16px',
                background: menuOpen ? 'rgba(255, 255, 255, 0.2)' : 'rgba(255, 255, 255, 0.1)',
                color: '#fff',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                borderRadius: '6px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '28px',
                minWidth: '44px',
                transition: 'all 0.15s'
              }}
              title="Menu"
            >
              {menuOpen ? '✕' : '☰'}
            </button>

            {/* Dropdown Menu */}
            {menuOpen && (
              <>
                {/* Backdrop */}
                <div
                  onClick={() => setMenuOpen(false)}
                  style={{
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    zIndex: 998
                  }}
                />
                <div style={{
                  position: 'absolute',
                  top: '100%',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  marginTop: '6px',
                  background: '#1a1a2e',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: '10px',
                  overflow: 'hidden',
                  zIndex: 1000,
                  minWidth: '200px',
                  maxWidth: '280px',
                  boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)'
                }}>
                  {menuItems.map((item, index) => {
                    // Divider
                    if (item.divider) {
                      return (
                        <div
                          key={`divider-${index}`}
                          style={{
                            height: '1px',
                            background: 'rgba(255, 255, 255, 0.1)',
                            margin: '4px 0'
                          }}
                        />
                      )
                    }

                    // Section header
                    if (item.header) {
                      return (
                        <div
                          key={`header-${index}`}
                          style={{
                            padding: '8px 14px 4px',
                            fontSize: '10px',
                            fontWeight: 700,
                            color: 'rgba(255, 255, 255, 0.4)',
                            textTransform: 'uppercase',
                            letterSpacing: '0.5px'
                          }}
                        >
                          {item.header}
                        </div>
                      )
                    }

                    return (
                      <button
                        key={index}
                        onClick={(e) => {
                          e.stopPropagation()
                          if (!item.disabled && item.onClick) {
                            item.onClick()
                          }
                          if (!item.keepOpen) {
                            setMenuOpen(false)
                          }
                        }}
                        disabled={item.disabled}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '10px',
                          width: '100%',
                          padding: '12px 14px',
                          fontSize: '13px',
                          fontWeight: 500,
                          background: item.active
                            ? (item.color ? `${item.color}20` : 'rgba(255, 255, 255, 0.1)')
                            : 'transparent',
                          color: item.disabled
                            ? 'rgba(255, 255, 255, 0.3)'
                            : (item.color || '#fff'),
                          border: 'none',
                          cursor: item.disabled ? 'not-allowed' : 'pointer',
                          textAlign: 'left',
                          opacity: item.disabled ? 0.5 : 1,
                          transition: 'background 0.15s'
                        }}
                        onMouseEnter={(e) => {
                          if (!item.disabled) {
                            e.currentTarget.style.background = item.active
                              ? (item.color ? `${item.color}30` : 'rgba(255, 255, 255, 0.15)')
                              : 'rgba(255, 255, 255, 0.08)'
                          }
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = item.active
                            ? (item.color ? `${item.color}20` : 'rgba(255, 255, 255, 0.1)')
                            : 'transparent'
                        }}
                      >
                        {item.icon && <span style={{ fontSize: '15px', width: '20px', textAlign: 'center' }}>{item.icon}</span>}
                        <span style={{ flex: 1 }}>{item.label}</span>

                        {/* Badge */}
                        {item.badge && (
                          <span style={{
                            padding: '2px 6px',
                            fontSize: '9px',
                            fontWeight: 700,
                            background: item.badgeColor || 'rgba(255, 255, 255, 0.2)',
                            color: item.badgeTextColor || '#fff',
                            borderRadius: '4px'
                          }}>
                            {item.badge}
                          </span>
                        )}

                        {/* Toggle switch */}
                        {item.toggle !== undefined && (
                          <span style={{
                            width: '36px',
                            height: '20px',
                            background: item.toggle ? '#22c55e' : 'rgba(255, 255, 255, 0.2)',
                            borderRadius: '10px',
                            position: 'relative',
                            transition: 'background 0.2s',
                            flexShrink: 0
                          }}>
                            <span style={{
                              position: 'absolute',
                              top: '2px',
                              left: item.toggle ? '18px' : '2px',
                              width: '16px',
                              height: '16px',
                              background: '#fff',
                              borderRadius: '50%',
                              transition: 'left 0.2s'
                            }} />
                          </span>
                        )}

                        {/* Submenu arrow */}
                        {item.submenu && (
                          <span style={{ fontSize: '10px', color: 'rgba(255, 255, 255, 0.5)' }}>▶</span>
                        )}
                      </button>
                    )
                  })}

                  {/* Language selector */}
                  <div style={{ height: '1px', background: 'rgba(255, 255, 255, 0.1)', margin: '4px 0' }} />
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setLanguageExpanded(!languageExpanded)
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      width: '100%',
                      padding: '10px 14px',
                      fontSize: '11px',
                      fontWeight: 500,
                      background: 'transparent',
                      color: 'rgba(255, 255, 255, 0.6)',
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left'
                    }}
                  >
                    <span style={{ fontSize: '13px', width: '20px', textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {(() => { const current = languages.find(l => l.code === i18n.language); return current ? <current.Flag /> : <FlagGB /> })()}
                    </span>
                    <span style={{ flex: 1 }}>{t('header.language', 'Language')}</span>
                    <span style={{
                      fontSize: '8px',
                      transform: languageExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                      transition: 'transform 0.2s'
                    }}>▼</span>
                  </button>

                  {/* Language options */}
                  {languageExpanded && (
                    <div style={{
                      borderTop: '1px solid rgba(255, 255, 255, 0.1)',
                      background: 'rgba(0, 0, 0, 0.2)'
                    }}>
                      {languages.map((lang) => (
                        <button
                          key={lang.code}
                          onClick={(e) => {
                            e.stopPropagation()
                            i18n.changeLanguage(lang.code)
                            setLanguageExpanded(false)
                          }}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '10px',
                            width: '100%',
                            padding: '10px 14px 10px 44px',
                            fontSize: '12px',
                            fontWeight: i18n.language === lang.code ? 600 : 400,
                            background: i18n.language === lang.code ? 'rgba(74, 222, 128, 0.15)' : 'transparent',
                            color: i18n.language === lang.code ? '#4ade80' : 'rgba(255, 255, 255, 0.8)',
                            border: 'none',
                            borderLeft: i18n.language === lang.code ? '3px solid #22c55e' : '3px solid transparent',
                            cursor: 'pointer',
                            textAlign: 'left',
                            transition: 'all 0.15s'
                          }}
                          onMouseEnter={(e) => {
                            if (i18n.language !== lang.code) {
                              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)'
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (i18n.language !== lang.code) {
                              e.currentTarget.style.background = 'transparent'
                            }
                          }}
                        >
                          <span style={{ display: 'flex', alignItems: 'center' }}><lang.Flag /></span>
                          <span>{lang.label}</span>
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Version info at bottom */}
                  <div style={{ height: '1px', background: 'rgba(255, 255, 255, 0.1)', margin: '4px 0' }} />
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setVersionExpanded(!versionExpanded)
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      width: '100%',
                      padding: '10px 14px',
                      fontSize: '11px',
                      fontWeight: 500,
                      background: 'transparent',
                      color: 'rgba(255, 255, 255, 0.6)',
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left'
                    }}
                  >
                    <span style={{ fontSize: '13px', width: '20px', textAlign: 'center' }}>📋</span>
                    <span style={{ flex: 1 }}>Version {currentVersion}</span>
                    <span style={{
                      fontSize: '8px',
                      transform: versionExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                      transition: 'transform 0.2s'
                    }}>▼</span>
                  </button>

                  {/* Version history removed */}
                </div>
              </>
            )}
          </>
        )}
      </div>

      {/* RIGHT: Fullscreen Button */}
      <div style={{
        flex: '1 1 0',
        display: 'flex',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: '8px'
      }}>
        {onFullscreen && (
          <button
            onClick={onFullscreen}
            style={{
              padding: '6px 12px',
              fontSize: '14px',
              fontWeight: 600,
              background: isFullscreen ? 'rgba(34, 197, 94, 0.2)' : 'rgba(255, 255, 255, 0.1)',
              color: isFullscreen ? '#22c55e' : '#fff',
              border: isFullscreen ? '1px solid rgba(34, 197, 94, 0.4)' : '1px solid rgba(255, 255, 255, 0.2)',
              borderRadius: '6px',
              cursor: 'pointer',
              height: '28px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              transition: 'all 0.15s'
            }}
            title={isFullscreen ? t('header.exitFullscreen', 'Exit Fullscreen') : t('header.fullscreen', 'Fullscreen')}
          >
            {isFullscreen ? '⛶' : '⛶'}
          </button>
        )}
      </div>
    </div>
  )
}
