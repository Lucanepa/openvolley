import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from './lib/supabaseClient'
import UpdateBanner from './components/UpdateBanner'
import DashboardHeader from './components/DashboardHeader'
import mikasaVolleyball from './mikasa_v200w.png'

// Primary ball image (with mikasa as fallback)
const ballImage = '/ball.png'

/**
 * Simplified Livescore App
 * - Subscribes to match_live_state table
 * - Shows all live games with scores
 * - Select a game to view fullscreen
 */
export default function LivescoreApp() {
  const { t } = useTranslation()
  const [liveGames, setLiveGames] = useState([]) // All games from match_live_state
  const [selectedGame, setSelectedGame] = useState(null) // UUID of selected game for fullscreen
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const channelRef = useRef(null)
  const [viewportWidth, setViewportWidth] = useState(() => typeof window !== 'undefined' ? window.innerWidth : 400)
  const [viewportHeight, setViewportHeight] = useState(() => typeof window !== 'undefined' ? window.innerHeight : 700)

  // Track viewport size for narrow screen blocking
  useEffect(() => {
    const handleResize = () => {
      setViewportWidth(window.innerWidth)
      setViewportHeight(window.innerHeight)
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // Fetch all live games from match_live_state
  const fetchLiveGames = useCallback(async () => {
    if (!supabase) {
      setError('Supabase not configured')
      setLoading(false)
      return
    }

    try {
      const { data, error: fetchError } = await supabase
        .from('match_live_state')
        .select('*')
        .order('updated_at', { ascending: false })

      if (fetchError) {
        console.error('[Livescore] Error fetching games:', fetchError)
        setError(fetchError.message)
      } else {
        setLiveGames(data || [])
        setError(null)
      }
    } catch (err) {
      console.error('[Livescore] Exception:', err)
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial fetch and subscribe to realtime updates
  useEffect(() => {
    fetchLiveGames()

    if (!supabase) return

    // Subscribe to ALL match_live_state changes (no filter = all games)
    const channel = supabase
      .channel('livescore-all-games')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'match_live_state'
        },
        (payload) => {
          console.log('[Livescore] Realtime update:', payload.eventType)

          if (payload.eventType === 'INSERT') {
            setLiveGames(prev => [payload.new, ...prev])
          } else if (payload.eventType === 'UPDATE') {
            setLiveGames(prev => prev.map(g =>
              g.match_id === payload.new.match_id ? payload.new : g
            ))
          } else if (payload.eventType === 'DELETE') {
            setLiveGames(prev => prev.filter(g => g.match_id !== payload.old.match_id))
            // If the deleted game was selected, clear selection to go back to list
            setSelectedGame(prev => prev === payload.old.match_id ? null : prev)
          }
        }
      )
      .subscribe((status) => {
        console.log('[Livescore] Subscription status:', status)
      })

    channelRef.current = channel

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current)
      }
    }
  }, [fetchLiveGames])

  // Get selected game data
  const selectedGameData = selectedGame
    ? liveGames.find(g => g.match_id === selectedGame)
    : null

  // Helper to compute left/right from A/B based on side_a
  const getLeftRight = (game) => {
    const sideA = game.side_a || 'left' // default Team A on left
    const isALeft = sideA === 'left'
    return {
      leftName: isALeft ? (game.team_a_name || 'Team A') : (game.team_b_name || 'Team B'),
      rightName: isALeft ? (game.team_b_name || 'Team B') : (game.team_a_name || 'Team A'),
      leftScore: isALeft ? (game.points_a || 0) : (game.points_b || 0),
      rightScore: isALeft ? (game.points_b || 0) : (game.points_a || 0),
      leftSets: isALeft ? (game.sets_won_a || 0) : (game.sets_won_b || 0),
      rightSets: isALeft ? (game.sets_won_b || 0) : (game.sets_won_a || 0),
      // Serving: convert team key to side
      servingTeam: game.serving_team // already 'left' or 'right'
    }
  }

  // Fullscreen view for selected game
  if (selectedGameData) {
    const { leftName, rightName, leftScore, rightScore, leftSets, rightSets, servingTeam } = getLeftRight(selectedGameData)
    const currentSet = selectedGameData.current_set || 1
    const gameN = selectedGameData.game_n || ''
    const league = selectedGameData.league || ''
    const gender = selectedGameData.gender || ''

    return (
      <div style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
        color: '#fff',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        display: 'flex',
        flexDirection: 'column'
      }}>
        {/* Narrow screen blocking overlay */}
        {(viewportWidth < 357 || viewportHeight < 650) && (
          <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.95)',
            zIndex: 99999,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
            textAlign: 'center'
          }}>
            <div style={{ fontSize: '64px', marginBottom: '24px' }}>📱</div>
            <h2 style={{
              fontSize: '24px',
              fontWeight: 700,
              color: '#ffffff',
              marginBottom: '16px'
            }}>
              {t('common.screenTooSmall', 'Screen too Small')}
            </h2>
            <p style={{
              fontSize: '16px',
              color: '#9ca3af',
              maxWidth: '300px',
              lineHeight: 1.5,
              marginBottom: '24px'
            }}>
              {t('common.screenTooSmallMessage', 'This app requires a minimum screen width of 357px. Please use a device with a wider screen or rotate your device to landscape mode.')}
            </p>
            <button
              onClick={() => {
                if (document.documentElement.requestFullscreen) {
                  document.documentElement.requestFullscreen().catch(() => {})
                }
              }}
              style={{
                padding: '12px 24px',
                fontSize: '16px',
                fontWeight: 600,
                background: 'var(--accent, #3b82f6)',
                color: '#000',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
              }}
            >
              <span>⛶</span>
              <span>{t('common.tryFullscreen', 'Try Fullscreen')}</span>
            </button>
            <p style={{
              fontSize: '12px',
              color: '#6b7280',
              marginTop: '12px'
            }}>
              {t('common.fullscreenHint', 'Fullscreen may provide more space by hiding browser UI.')}
            </p>
          </div>
        )}

        {/* Header */}
        <DashboardHeader
          title={gameN ? `Game ${gameN}` : t('livescore.title', 'Live Score')}
          subtitle={[league, gender].filter(Boolean).join(' • ') || null}
          onBack={() => setSelectedGame(null)}
          backLabel={t('common.back', 'Back')}
          showOptionsMenu={false}
        />

        {/* Score Display */}
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '20px'
        }}>
          {/* Point Score */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr auto 1fr auto',
            alignItems: 'center',
            gap: '10px',
            width: '100%',
            maxWidth: '800px'
          }}>
            {/* Left Ball */}
            <div style={{ width: '60px', display: 'flex', justifyContent: 'center' }}>
              {servingTeam === 'left' && (
                <img src={ballImage} onError={(e) => e.target.src = mikasaVolleyball} alt="Serve" style={{ width: '50px', height: '50px' }} />
              )}
            </div>

            {/* Left Score + Name */}
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 'clamp(60px, 18vw, 150px)', fontWeight: 700, lineHeight: 1 }}>
                {leftScore}
              </div>
              <div style={{ fontSize: 'clamp(14px, 3vw, 24px)', color: 'rgba(255,255,255,0.7)', marginTop: '8px' }}>
                {leftName}
              </div>
            </div>

            {/* Colon */}
            <div style={{ fontSize: 'clamp(40px, 12vw, 100px)', color: 'rgba(255,255,255,0.4)', lineHeight: 1 }}>
              :
            </div>

            {/* Right Score + Name */}
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 'clamp(60px, 18vw, 150px)', fontWeight: 700, lineHeight: 1 }}>
                {rightScore}
              </div>
              <div style={{ fontSize: 'clamp(14px, 3vw, 24px)', color: 'rgba(255,255,255,0.7)', marginTop: '8px' }}>
                {rightName}
              </div>
            </div>

            {/* Right Ball */}
            <div style={{ width: '60px', display: 'flex', justifyContent: 'center' }}>
              {servingTeam === 'right' && (
                <img src={ballImage} onError={(e) => e.target.src = mikasaVolleyball} alt="Serve" style={{ width: '50px', height: '50px' }} />
              )}
            </div>
          </div>

          {/* Set Score */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '20px',
            marginTop: '40px'
          }}>
            <div style={{
              fontSize: 'clamp(32px, 10vw, 80px)',
              fontWeight: 700,
              padding: '8px 16px',
              background: 'rgba(255,255,255,0.1)',
              borderRadius: '8px'
            }}>
              {leftSets}
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 'clamp(24px, 6vw, 48px)', fontWeight: 800 }}>
                {t('livescore.set', 'SET')}
              </div>
              <div style={{ fontSize: 'clamp(24px, 6vw, 48px)', fontWeight: 800 }}>
                {currentSet}
              </div>
            </div>
            <div style={{
              fontSize: 'clamp(32px, 10vw, 80px)',
              fontWeight: 700,
              padding: '8px 16px',
              background: 'rgba(255,255,255,0.1)',
              borderRadius: '8px'
            }}>
              {rightSets}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // List view - show all games
  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
      color: '#fff',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    }}>
      {/* Narrow screen blocking overlay */}
      {(viewportWidth < 357 || viewportHeight < 650) && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.95)',
          zIndex: 99999,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          textAlign: 'center'
        }}>
          <div style={{ fontSize: '64px', marginBottom: '24px' }}>📱</div>
          <h2 style={{
            fontSize: '24px',
            fontWeight: 700,
            color: '#ffffff',
            marginBottom: '16px'
          }}>
            {t('common.screenTooSmall', 'Screen too Small')}
          </h2>
          <p style={{
            fontSize: '16px',
            color: '#9ca3af',
            maxWidth: '300px',
            lineHeight: 1.5,
            marginBottom: '24px'
          }}>
            {t('common.screenTooSmallMessage', 'This app requires a minimum screen width of 357px. Please use a device with a wider screen or rotate your device to landscape mode.')}
          </p>
          <button
            onClick={() => {
              if (document.documentElement.requestFullscreen) {
                document.documentElement.requestFullscreen().catch(() => {})
              }
            }}
            style={{
              padding: '12px 24px',
              fontSize: '16px',
              fontWeight: 600,
              background: 'var(--accent, #3b82f6)',
              color: '#000',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '8px'
            }}
          >
            <span>⛶</span>
            <span>{t('common.tryFullscreen', 'Try Fullscreen')}</span>
          </button>
          <p style={{
            fontSize: '12px',
            color: '#6b7280',
            marginTop: '12px'
          }}>
            {t('common.fullscreenHint', 'Fullscreen may provide more space by hiding browser UI.')}
          </p>
        </div>
      )}

      <UpdateBanner />

      {/* Header */}
      <DashboardHeader
        title={t('livescore.title', 'Live Scores')}
        subtitle={`${liveGames.length} ${liveGames.length === 1 ? 'game' : 'games'} live`}
        onLoadGames={fetchLiveGames}
        loadingMatches={loading}
        matchCount={liveGames.length}
        showOptionsMenu={false}
      />

      {/* Content */}
      <div style={{ padding: '16px' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '40px', color: 'rgba(255,255,255,0.6)' }}>
            {t('common.loading', 'Loading...')}
          </div>
        ) : error ? (
          <div style={{ textAlign: 'center', padding: '40px' }}>
            <div style={{ color: '#ef4444', marginBottom: '16px' }}>{error}</div>
            <button
              onClick={fetchLiveGames}
              style={{
                padding: '10px 20px',
                background: 'rgba(255,255,255,0.1)',
                border: 'none',
                borderRadius: '6px',
                color: '#fff',
                cursor: 'pointer'
              }}
            >
              {t('common.retry', 'Retry')}
            </button>
          </div>
        ) : liveGames.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px', color: 'rgba(255,255,255,0.6)' }}>
            <img src={ballImage} onError={(e) => e.target.src = mikasaVolleyball} alt="" style={{ width: '60px', opacity: 0.5, marginBottom: '16px' }} />
            <div>{t('livescore.noActiveGame', 'No live games')}</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {liveGames.map((game) => {
              const { leftName, rightName, leftScore, rightScore, leftSets, rightSets, servingTeam } = getLeftRight(game)
              const gameN = game.game_n || ''
              const league = game.league || ''
              const gender = game.gender || ''

              return (
                <button
                  key={game.match_id}
                  onClick={() => setSelectedGame(game.match_id)}
                  style={{
                    padding: '16px',
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '12px',
                    color: '#fff',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'background 0.2s'
                  }}
                >
                  {/* Game N, League, Gender */}
                  {(gameN || league || gender) && (
                    <div style={{
                      marginBottom: '8px',
                      fontSize: '12px',
                      color: 'rgba(255,255,255,0.5)'
                    }}>
                      {gameN && <span style={{ fontWeight: 600, color: 'var(--accent)' }}>Game {gameN}</span>}
                      {gameN && (league || gender) && ' • '}
                      {[league, gender].filter(Boolean).join(' • ')}
                    </div>
                  )}

                  {/* Teams and Score */}
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr auto 1fr',
                    alignItems: 'center',
                    gap: '12px'
                  }}>
                    {/* Left Team */}
                    <div>
                      <div style={{
                        fontSize: '14px',
                        fontWeight: 600,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px'
                      }}>
                        {servingTeam === 'left' && (
                          <img src={ballImage} onError={(e) => e.target.src = mikasaVolleyball} alt="" style={{ width: '14px', height: '14px' }} />
                        )}
                        {leftName}
                      </div>
                    </div>

                    {/* Score */}
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px'
                    }}>
                      <span style={{ fontSize: '28px', fontWeight: 700 }}>{leftScore}</span>
                      <span style={{ fontSize: '20px', color: 'rgba(255,255,255,0.4)' }}>:</span>
                      <span style={{ fontSize: '28px', fontWeight: 700 }}>{rightScore}</span>
                    </div>

                    {/* Right Team */}
                    <div style={{ textAlign: 'right' }}>
                      <div style={{
                        fontSize: '14px',
                        fontWeight: 600,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'flex-end',
                        gap: '6px'
                      }}>
                        {rightName}
                        {servingTeam === 'right' && (
                          <img src={ballImage} onError={(e) => e.target.src = mikasaVolleyball} alt="" style={{ width: '14px', height: '14px' }} />
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Set Score */}
                  <div style={{
                    marginTop: '8px',
                    fontSize: '12px',
                    color: 'rgba(255,255,255,0.5)',
                    textAlign: 'center'
                  }}>
                    Set {game.current_set || 1} • Sets: {leftSets} - {rightSets}
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
