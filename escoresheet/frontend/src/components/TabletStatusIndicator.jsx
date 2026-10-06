import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { getTabletStatusSummary, formatAge } from '../utils/connectionHealth'
import { applyRelayTablets, relayMatchKey } from '../utils/serverDataSync'
import { useRelayTablets } from '../hooks/useRealtimeConnection'
import { ChevronDown } from 'lucide-react'
import { cn } from '../ui/cn.js'
import { StatusPill } from '../ui/StatusPill.jsx'
import { FOCUS_RING, KIT_SCOPE, POPOVER_PANEL, STATUS_PILL, STATUS_TONES } from './chromeClasses'

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

  // Heartbeats alone never reached the scorer device: the relay's subscriber
  // list for this match (by seed key) says which tablets are actually there.
  const anyEnabled = !!(match?.refereeConnectionEnabled || match?.homeTeamConnectionEnabled || match?.awayTeamConnectionEnabled)
  const relayTablets = useRelayTablets(relayMatchKey(match), match, { enabled: anyEnabled })
  const summary = applyRelayTablets(getTabletStatusSummary(match), relayTablets)

  // Kit status tones: emerald all connected, amber some missing, stone none.
  const overallTone = STATUS_TONES[summary.overallStatus === 'ok' ? 'ok'
    : summary.overallStatus === 'issues' ? 'warn'
    : 'neutral']

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

  // Don't render if no roles are enabled. Must stay below every hook: the
  // scorer toggles connections mid-match, and an early return above a hook
  // changes the hook count between renders (React throws and unmounts).
  if (summary.expectedCount === 0) return null

  const SUMMARY_BOX = {
    ok: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    issues: 'border-amber-200 bg-amber-50 text-amber-800',
    none: 'border-stone-200 bg-stone-50 text-stone-600'
  }

  // Per-device heartbeat state -> kit tone (a StatusPill per device).
  const roleTone = (status) => STATUS_TONES[status === 'connected' ? 'ok' : status === 'stale' ? 'warn' : 'error']

  return (
    <div ref={buttonRef} style={{ position: 'relative' }}>
      <span className={KIT_SCOPE}>
        <button
          type="button"
          onClick={openMenu}
          aria-expanded={menuOpen}
          title={t('tabletStatus.title', 'Tablet status')}
          className={cn(STATUS_PILL, FOCUS_RING, overallTone.pill)}
        >
          {/* Status dot */}
          <span className={cn('h-2 w-2 shrink-0 rounded-full', overallTone.dot)} />
          <span className="tabular-nums">{summary.connectedCount}/{summary.expectedCount}</span>
          <ChevronDown size={12} aria-hidden="true" className={cn('opacity-70 transition-transform', menuOpen && 'rotate-180')} />
        </button>
      </span>

      {menuOpen && (
        <div
          onClick={(e) => e.stopPropagation()}
          className={cn('fixed w-[260px] max-w-[calc(100vw-24px)]', POPOVER_PANEL)}
          style={{
            top: `${menuPos.top}px`,
            right: `${menuPos.right}px`,
            zIndex: 1000
          }}
        >
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-500">
            {t('tabletStatus.title', 'Tablet status')}
          </div>

          <div className="divide-y divide-stone-100">
            {summary.roles.map((role) => {
              const tone = roleTone(role.status)
              return (
                <div key={role.role} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0 truncate text-sm font-medium text-stone-800">
                    {t(`tabletStatus.role.${role.role}`, role.label)}
                  </span>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <StatusPill className={tone.tint}>{t(`tabletStatus.status.${role.status}`, role.status)}</StatusPill>
                    {role.ageMs != null && (
                      <span className="font-mono text-[10px] text-stone-500">
                        {formatAge(role.ageMs)}
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Overall summary */}
          <div className={cn('mt-2 rounded-lg border px-2.5 py-2 text-center text-xs font-medium', SUMMARY_BOX[summary.overallStatus] || SUMMARY_BOX.none)}>
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
