import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { getTabletStatusSummary, formatAge } from '../utils/connectionHealth'

export default function TabletStatusIndicator({ match }) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState({ top: 0, right: 12 })
  const buttonRef = useRef(null)
  const [, setTick] = useState(0)

  // Force re-render every 5s to update heartbeat ages
  useEffect(() => {
    if (!menuOpen) return
    const interval = setInterval(() => setTick(n => n + 1), 5000)
    return () => clearInterval(interval)
  }, [menuOpen])

  const summary = getTabletStatusSummary(match)

  // Don't render if no roles are enabled
  if (summary.expectedCount === 0) return null

  const overallColor = summary.overallStatus === 'ok' ? '#22c55e'
    : summary.overallStatus === 'issues' ? '#eab308'
    : '#6b7280'

  const openMenu = useCallback(() => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect()
      setMenuPos({
        top: rect.bottom + 4,
        right: Math.max(12, window.innerWidth - rect.right)
      })
    }
    setMenuOpen(prev => !prev)
  }, [])

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return
    const handleClick = (e) => {
      if (buttonRef.current && !buttonRef.current.contains(e.target)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [menuOpen])

  const roleColors = {
    referee: '#3b82f6',
    bench_home: '#10b981',
    bench_away: '#ef4444'
  }

  return (
    <div ref={buttonRef} style={{ position: 'relative' }}>
      <button
        onClick={openMenu}
        title={t('tabletStatus.title', 'Tablet Status')}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '4px 10px',
          fontSize: 'clamp(9px, 1.1vw, 11px)',
          fontWeight: 600,
          background: `${overallColor}15`,
          color: overallColor,
          border: `1px solid ${overallColor}30`,
          borderRadius: '6px',
          cursor: 'pointer',
          transition: 'all 0.2s',
          whiteSpace: 'nowrap'
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = `${overallColor}25`
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = `${overallColor}15`
        }}
      >
        {/* Status dot */}
        <span style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: overallColor,
          flexShrink: 0
        }} />
        <span>{summary.connectedCount}/{summary.expectedCount}</span>
        <span style={{ fontSize: '8px', marginLeft: '2px' }}>{menuOpen ? '▲' : '▼'}</span>
      </button>

      {menuOpen && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: `${menuPos.top}px`,
            right: `${menuPos.right}px`,
            maxWidth: 'calc(100vw - 24px)',
            width: '260px',
            background: 'rgba(0, 0, 0, 0.95)',
            border: '1px solid rgba(255, 255, 255, 0.2)',
            borderRadius: '8px',
            padding: '12px',
            zIndex: 1000,
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.6)'
          }}
        >
          <div style={{
            fontSize: 11,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
            color: 'rgba(255,255,255,0.5)',
            marginBottom: 10
          }}>
            {t('tabletStatus.title', 'Tablet Status')}
          </div>

          {summary.roles.map((role) => (
            <div key={role.role} style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 0',
              borderBottom: '1px solid rgba(255,255,255,0.08)'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: role.color,
                  flexShrink: 0
                }} />
                <span style={{
                  fontSize: 13,
                  fontWeight: 500,
                  color: roleColors[role.role] || '#fff'
                }}>
                  {t(`tabletStatus.role.${role.role}`, role.label)}
                </span>
              </div>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11,
                color: role.color
              }}>
                <span>{t(`tabletStatus.status.${role.status}`, role.status)}</span>
                {role.ageMs != null && (
                  <span style={{
                    fontFamily: 'monospace',
                    fontSize: 10,
                    color: 'rgba(255,255,255,0.4)'
                  }}>
                    {formatAge(role.ageMs)}
                  </span>
                )}
              </div>
            </div>
          ))}

          {/* Overall summary */}
          <div style={{
            marginTop: 10,
            padding: '8px 10px',
            background: `${overallColor}10`,
            borderRadius: 6,
            fontSize: 12,
            color: overallColor,
            textAlign: 'center'
          }}>
            {summary.overallStatus === 'ok'
              ? t('tabletStatus.allConnected', 'All devices connected')
              : t('tabletStatus.issuesDetected', {
                  defaultValue: '{{count}} device(s) with issues',
                  count: summary.expectedCount - summary.connectedCount
                })
            }
          </div>
        </div>
      )}
    </div>
  )
}
