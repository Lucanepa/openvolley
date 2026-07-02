import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../contexts/AuthContext'
import { apiFrom } from '../../lib/apiClient'

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
        .select('external_id, team_a, team_b, final_score, winner, status, start_time, created_at')
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

  const getStatusColor = (status) => {
    switch (status) {
      case 'live': return '#22c55e'
      case 'finished': return '#6b7280'
      default: return '#f59e0b'
    }
  }

  const modalStyle = {
    position: 'fixed',
    inset: 0,
    background: 'rgba(15, 23, 42, 0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2000
  }

  const contentStyle = {
    width: 'min(90vw, 500px)',
    maxHeight: '80vh',
    background: 'var(--panel)',
    border: '2px solid #3b82f6',
    borderRadius: 12,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column'
  }

  const headerStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 20px',
    background: 'rgba(59, 130, 246, 0.1)',
    borderBottom: '1px solid rgba(59, 130, 246, 0.3)'
  }

  return (
    <div style={modalStyle} onClick={onClose}>
      <div style={contentStyle} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={headerStyle}>
          <h2 style={{ margin: 0, color: 'var(--text)', fontSize: 20, fontWeight: 600 }}>
            {t('matchHistory.title', 'My Matches')}
          </h2>
          <button
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--muted)',
              fontSize: 24,
              cursor: 'pointer',
              padding: 0,
              lineHeight: 1
            }}
          >
            x
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          {error && (
            <div style={{
              padding: '10px 14px',
              background: 'rgba(239, 68, 68, 0.15)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              borderRadius: 8,
              color: '#ef4444',
              marginBottom: 16,
              fontSize: 14
            }}>
              {error}
            </div>
          )}

          {loading ? (
            <div style={{ textAlign: 'center', color: 'var(--muted)', padding: 40 }}>
              {t('common.loading', 'Loading...')}
            </div>
          ) : matches.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--muted)', padding: 40 }}>
              <div style={{ fontSize: 48, marginBottom: 12, opacity: 0.5 }}>📋</div>
              <p>{t('matchHistory.noMatches', 'No matches yet')}</p>
              <p style={{ fontSize: 13, marginTop: 8 }}>
                {t('matchHistory.noMatchesHint', 'Matches you score will appear here')}
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {matches.map((match, index) => (
                <div
                  key={match.match_external_id || index}
                  onClick={() => onSelectMatch?.(match)}
                  style={{
                    padding: '14px 16px',
                    background: 'var(--panel-2)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    cursor: onSelectMatch ? 'pointer' : 'default',
                    transition: 'border-color 0.2s'
                  }}
                  onMouseEnter={e => {
                    if (onSelectMatch) e.currentTarget.style.borderColor = '#3b82f6'
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.borderColor = 'var(--border)'
                  }}
                >
                  {/* Top row: Teams and score */}
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: 8
                  }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ color: 'var(--text)', fontWeight: 500 }}>
                        {getTeamName(match.team_a)}
                      </div>
                      <div style={{ color: 'var(--muted)', fontSize: 13 }}>
                        {t('matchHistory.vs', 'vs')}
                      </div>
                      <div style={{ color: 'var(--text)', fontWeight: 500 }}>
                        {getTeamName(match.team_b)}
                      </div>
                    </div>
                    {match.final_score && (
                      <div style={{
                        fontSize: 24,
                        fontWeight: 700,
                        color: '#3b82f6',
                        fontFamily: 'monospace'
                      }}>
                        {match.final_score}
                      </div>
                    )}
                  </div>

                  {/* Bottom row: Date, role, status */}
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: 12
                  }}>
                    <div style={{ color: 'var(--muted)' }}>
                      {formatDate(match.start_time || match.created_at)}
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{
                        padding: '2px 8px',
                        background: 'var(--panel-2)',
                        borderRadius: 4,
                        color: 'var(--muted)',
                        textTransform: 'capitalize'
                      }}>
                        {match.userRole || 'scorer'}
                      </span>
                      {match.status && (
                        <span style={{
                          padding: '2px 8px',
                          background: `${getStatusColor(match.status)}20`,
                          color: getStatusColor(match.status),
                          borderRadius: 4,
                          textTransform: 'capitalize'
                        }}>
                          {match.status}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 16px',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'flex-end'
        }}>
          <button
            onClick={onClose}
            style={{
              padding: '8px 20px',
              background: 'var(--panel-2)',
              color: 'var(--text)',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer'
            }}
          >
            {t('common.close', 'Close')}
          </button>
        </div>
      </div>
    </div>
  )
}
