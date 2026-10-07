import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../contexts/AuthContext'
import { apiFrom } from '../../lib/apiClient'
import { ClipboardIcon } from '../icons'
import { ChevronRight, Loader2, X } from 'lucide-react'
import { Button, cn, IconButton } from '../../ui'
import { finalScoresheetUrl } from '../../../scoresheet_pdf/utils/scoresheetStorage'
import { openAppWindow } from '../../utils/openAppWindow'
import { backdropDismiss } from '../../ui/backdropDismiss.js'

/**
 * Status pill of a My matches row. The database says 'live', 'final',
 * 'ended', 'approved' or 'setup' ('finished' in older rows). A finished match
 * is the done state (emerald), a running one the brand red, setup neutral.
 * Amber (warning) is not used: 'Final' used to fall through to it.
 * @returns {{ key: string, fallback: string, className: string }}
 */
export function matchStatusPill(status) {
  switch (status) {
    case 'live':
    case 'in_progress':
      return { key: 'matchHistory.status.live', fallback: 'Live', className: 'border-red-200 bg-red-50 text-red-700' }
    case 'final':
    case 'finished':
    case 'ended':
      return { key: 'matchHistory.status.final', fallback: 'Final', className: 'border-emerald-200 bg-emerald-50 text-emerald-700' }
    case 'approved':
      return { key: 'matchHistory.status.approved', fallback: 'Approved', className: 'border-emerald-200 bg-emerald-50 text-emerald-700' }
    case 'setup':
      return { key: 'matchHistory.status.setup', fallback: 'Setup', className: 'border-stone-200 bg-stone-50 text-stone-600' }
    default:
      return { key: '', fallback: String(status || ''), className: 'border-stone-200 bg-stone-50 text-stone-600' }
  }
}

export default function MatchHistory({ open, onClose, onSelectMatch }) {
  const { t } = useTranslation()
  const { user } = useAuth()

  const [matches, setMatches] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Fetch user's matches when modal opens
  useEffect(() => {
    if (open) {
      if (user) {
        fetchMatches()
      } else {
        // No user - show empty state
        setMatches([])
        setLoading(false)
      }
    }
  }, [open, user])

  const fetchMatches = async () => {
    setLoading(true)
    setError('')

    try {
      // Get user's match associations
      const { data: userMatches, error: userMatchesError } = await apiFrom('user_matches')
        .select('match_external_id, role, created_at')
        .eq('user_id', user.id)
        .eq('sport_type', 'indoor')
        .order('created_at', { ascending: false })

      if (userMatchesError) {
        throw userMatchesError
      }

      if (!userMatches || userMatches.length === 0) {
        setMatches([])
        setLoading(false)
        return
      }

      // Get match details for each match_external_id (which references matches.external_id)
      const matchIds = userMatches.map(m => m.match_external_id)
      const { data: matchDetails, error: matchError } = await apiFrom('matches')
        // matches has no team_a/team_b/start_time columns (the backend refuses
        // unknown ones): the teams are home_team/away_team, the date scheduled_at
        .select('external_id, game_n, home_team, away_team, final_score, winner, status, scheduled_at, created_at')
        .in('external_id', matchIds)
        .eq('sport_type', 'indoor')

      if (matchError) {
        throw matchError
      }

      // Combine data
      const combined = userMatches.map(um => {
        const match = matchDetails?.find(m => m.external_id === um.match_external_id) || {}
        return {
          ...um,
          ...match,
          userRole: um.role
        }
      })

      setMatches(combined)
    } catch (err) {
      console.error('Failed to fetch match history:', err)
      setError(err.message)
    }

    setLoading(false)
  }

  if (!open) return null

  // A finalized match opens its approved scoresheet, readable only by the
  // account that uploaded it: opened on this origin, where the session is.
  const openMatch = (match) => {
    if (onSelectMatch) return onSelectMatch(match)
    const url = finalScoresheetUrl(match)
    if (url) openAppWindow(url, { features: 'noopener' })
  }
  const canOpen = (match) => !!onSelectMatch || !!finalScoresheetUrl(match)

  const formatDate = (dateStr) => {
    if (!dateStr) return ''
    const date = new Date(dateStr)
    return date.toLocaleDateString(undefined, {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    })
  }

  const getTeamName = (team) => {
    if (!team) return t('matchHistory.unknown', 'Unknown')
    if (typeof team === 'string') return team
    return team.name || team.teamName || t('matchHistory.unknown', 'Unknown')
  }


  return (
    <div className="ov-kit fixed inset-0 flex items-center justify-center bg-stone-900/50 p-4 backdrop-blur-sm" style={{ zIndex: 2000 }} {...backdropDismiss(onClose)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="match-history-title"
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-stone-200/70 px-5 py-2 sm:px-6">
          <h2 id="match-history-title" className="text-lg font-bold text-stone-900">
            {t('matchHistory.title', 'My matches')}
          </h2>
          <IconButton variant="close" icon={X} label={t('common.close', 'Close')} onClick={onClose} className="-mr-2" />
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-3 py-3 sm:px-4">
          {error && (
            <p role="alert" className="mb-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-stone-500">
              <Loader2 size={16} className="animate-spin text-stone-400" aria-hidden="true" />
              {t('common.loading', 'Loading...')}
            </div>
          ) : matches.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 px-4 py-14 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-stone-100 text-stone-400"><ClipboardIcon size={26} /></div>
              <p className="text-sm font-medium text-stone-500">{t('matchHistory.noMatches', 'No matches yet')}</p>
              <p className="text-xs text-stone-400">
                {t('matchHistory.noMatchesHint', 'Matches you score will appear here')}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-stone-100">
              {matches.map((match, index) => {
                const openable = canOpen(match)
                const pill = match.status ? matchStatusPill(match.status) : null
                return (
                <div
                  key={`${match.match_external_id || index}:${match.userRole || ''}`}
                  // An openable row is a keyboard-reachable button (Enter / Space)
                  {...(openable ? {
                    role: 'button',
                    tabIndex: 0,
                    'aria-label': `${getTeamName(match.home_team)} – ${getTeamName(match.away_team)}${match.final_score ? ` ${match.final_score}` : ''}: ${t('matchHistory.openScoresheet', 'Open scoresheet')}`,
                    onClick: () => openMatch(match),
                    onKeyDown: (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        openMatch(match)
                      }
                    }
                  } : {})}
                  className={cn(
                    'rounded-md px-2 py-3 transition-colors',
                    openable && 'cursor-pointer hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60'
                  )}
                >
                  {/* Top row: Teams and score */}
                  <div className="mb-1.5 flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-stone-900">
                        {getTeamName(match.home_team)}
                      </div>
                      <div className="text-xs text-stone-500">
                        {t('matchHistory.vs', 'vs')}
                      </div>
                      <div className="text-sm font-semibold text-stone-900">
                        {getTeamName(match.away_team)}
                      </div>
                    </div>
                    {match.final_score && (
                      <div className="text-2xl font-bold tabular-nums text-stone-900">
                        {match.final_score}
                      </div>
                    )}
                  </div>

                  {/* Bottom row: Date, role, status */}
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <div className="tabular-nums text-stone-500">
                      {formatDate(match.scheduled_at || match.created_at)}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="inline-flex items-center whitespace-nowrap rounded border border-stone-200 bg-stone-50 px-1.5 py-[3px] text-[11px] font-semibold capitalize leading-none text-stone-600">
                        {match.userRole || 'scorer'}
                      </span>
                      {pill && (
                        <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium', pill.className)}>
                          {pill.key ? t(pill.key, pill.fallback) : pill.fallback}
                        </span>
                      )}
                      {openable && (
                        <ChevronRight size={16} aria-hidden="true" className="text-stone-400" />
                      )}
                    </div>
                  </div>
                </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end border-t border-stone-100 px-5 py-3 sm:px-6">
          <Button variant="secondary" size="xl" onClick={onClose} className="rounded-lg font-medium">
            {t('common.close', 'Close')}
          </Button>
        </div>
      </div>
    </div>
  )
}
