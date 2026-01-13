import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { formatTimeLocal } from '../utils/timeUtils'

function formatDateTime(iso, t) {
  if (!iso) return t('gameList.dateTbc', 'Date TBC')
  try {
    const date = new Date(iso)
    // Format date in local timezone
    const datePart = date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit'
    })
    // Format time using utility for consistency
    const timePart = formatTimeLocal(iso)
    return `${datePart}, ${timePart}`
  } catch (error) {
    return iso
  }
}

export default function GameList({ matches, loading, onSelectMatch, onDeleteMatchData, onLoadTestData }) {
  const { t } = useTranslation()
  const grouped = useMemo(() => {
    if (!matches || !matches.length) return []
    return matches.reduce((acc, match) => {
      const key = match.league || 'Other'
      if (!acc[key]) acc[key] = []
      acc[key].push(match)
      return acc
    }, {})
  }, [matches])

  if (loading) {
    return (
      <div className="game-list">
        <p>{t('gameList.loadingGames', 'Loading games...')}</p>
      </div>
    )
  }

  if (!matches || matches.length === 0) {
    return (
      <div className="game-list">
        <p>{t('gameList.noGamesAvailable', 'No games available.')}</p>
      </div>
    )
  }

  return (
    <div className="game-list">
      <div className="game-list-header">
        <div>
          <h2>{t('gameList.upcomingMatches', 'Upcoming matches')}</h2>
          <p className="text-sm">{t('gameList.selectGameToStart', 'Select a game to start recording.')}</p>
        </div>
      </div>

      {Object.entries(grouped).map(([league, leagueMatches]) => (
        <section key={league} className="game-league">
          <header className="game-league-header">
            <h3>{league}</h3>
            <span>{leagueMatches.length} match{leagueMatches.length !== 1 ? 'es' : ''}</span>
          </header>
          <div className="game-grid">
            {leagueMatches.map(match => {
              const dateTime = formatDateTime(match.scheduledAt, t)
              const [datePart, timePart] = dateTime.split(',')
              return (
                <div key={match.id} className="game-card">
                  <div className="game-card-content">
                    <div className="game-card-date">
                      <span className="game-card-day">{datePart?.trim()}</span>
                      <span className="game-card-time">{timePart?.trim()}</span>
                    </div>
                    <div className="game-card-teams">
                      <div className="game-card-team">{match.homeName}</div>
                      <div className="game-card-vs">{t('common.vs', 'vs')}</div>
                      <div className="game-card-team">{match.awayName}</div>
                    </div>
                    {match.hall && (
                      <div className="game-card-location">
                        {match.hall} — {match.city || t('common.tbc', 'TBC')}
                      </div>
                    )}
                    <div className="game-card-status">
                      <span className="game-card-status-label">{t('gameList.status', 'Status:')}</span>
                      <span className="game-card-status-value">{match.status || t('common.noData', 'No data')}</span>
                    </div>
                  </div>
                  <div className="game-card-actions">
                    <button onClick={() => onSelectMatch(match.id)}>
                      {t('gameList.openMatch', 'Open match')}
                    </button>
                    {onDeleteMatchData && (
                      <button className="secondary" onClick={() => onDeleteMatchData(match.id)}>
                        {t('gameList.deleteMatchData', 'Delete match data')}
                      </button>
                    )}
                    {onLoadTestData && (
                      <button className="secondary" onClick={() => onLoadTestData(match.id)}>
                        {t('gameList.loadTestData', 'Load test data')}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

