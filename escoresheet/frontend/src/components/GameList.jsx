import { useMemo } from 'react'

function formatDateTime(iso) {
  if (!iso) return 'Date TBC'
  try {
    const date = new Date(iso)
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })
  } catch (error) {
    return iso
  }
}

export default function GameList({ matches, loading, onSelectMatch, onDeleteMatchData, onLoadTestData }) {
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
        <p>Loading games…</p>
      </div>
    )
  }

  if (!matches || matches.length === 0) {
    return (
      <div className="game-list">
        <p>No games available.</p>
      </div>
    )
  }

  return (
    <div className="game-list">
      <div className="game-list-header">
        <div>
          <h2>Upcoming matches</h2>
          <p className="text-sm">Select a game to start recording.</p>
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
              const dateTime = formatDateTime(match.scheduledAt)
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
                      <div className="game-card-vs">vs</div>
                      <div className="game-card-team">{match.awayName}</div>
                    </div>
                    {match.hall && (
                      <div className="game-card-location">
                        {match.hall} — {match.city || 'TBC'}
                      </div>
                    )}
                    <div className="game-card-status">
                      <span className="game-card-status-label">Status:</span>
                      <span className="game-card-status-value">{match.status || 'No data'}</span>
                    </div>
                  </div>
                  <div className="game-card-actions">
                    <button onClick={() => onSelectMatch(match.id)}>
                      Open match
                    </button>
                    {onDeleteMatchData && (
                      <button className="secondary" onClick={() => onDeleteMatchData(match.id)}>
                        Delete match data
                      </button>
                    )}
                    {onLoadTestData && (
                      <button className="secondary" onClick={() => onLoadTestData(match.id)}>
                        Load test data
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

