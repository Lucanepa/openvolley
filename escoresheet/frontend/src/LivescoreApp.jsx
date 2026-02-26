import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from './lib/supabaseClient'
import { apiFrom } from './lib/apiClient'
import UpdateBanner from './components/UpdateBanner'
import DashboardHeader from './components/DashboardHeader'
import ServerConnectionScreen from './components/ServerConnectionScreen'
import { setBackendOverride, isServedFromLocalServer } from './utils/backendConfig'
import mikasaVolleyball from './mikasa_v200w.png'

// Primary ball image (with mikasa as fallback)
const ballImage = `${import.meta.env.BASE_URL}ball.png`

/**
 * Simplified Livescore App
 * - Subscribes to match_live_state table
 * - Shows all live games with scores
 * - Select a game to view fullscreen
 */
export default function LivescoreApp() {
  const { t } = useTranslation()
  const [serverReady, setServerReady] = useState(isServedFromLocalServer())
  const [liveGames, setLiveGames] = useState([]) // All games from match_live_state
  const [selectedGame, setSelectedGame] = useState(null) // UUID of selected game for fullscreen
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const channelRef = useRef(null)
  const [viewportWidth, setViewportWidth] = useState(() => typeof window !== 'undefined' ? window.innerWidth : 400)
  const [viewportHeight, setViewportHeight] = useState(() => typeof window !== 'undefined' ? window.innerHeight : 700)

  // Check URL params for auto-connect on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const matchParam = params.get('match')
    const serverParam = params.get('server')

    if (serverParam) {
      setBackendOverride(serverParam.startsWith('http') ? serverParam : `https://${serverParam}`)
    }

    // Livescore can auto-connect — it doesn't need PIN
    if (matchParam || serverParam) {
      setServerReady(true)
    }
  }, [])

  // Handle server connection established
  const handleServerConnected = useCallback(() => {
    setServerReady(true)
  }, [])

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
      const { data, error: fetchError } = await apiFrom('match_live_state')
        .select('*, matches!match_live_state_match_id_fkey_cascade(set_results)')
        .eq('sport_type', 'indoor')
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
          table: 'match_live_state',
          filter: 'sport_type=eq.indoor'
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
    const isMatchEnded = game.match_status === 'ended' || game.match_status === 'final'
    const isInSetInterval = !isMatchEnded && game.set_interval_active

    // When match is ended, show set score as main score
    const leftSets = isALeft ? (game.sets_won_a || 0) : (game.sets_won_b || 0)
    const rightSets = isALeft ? (game.sets_won_b || 0) : (game.sets_won_a || 0)
    const leftPoints = isALeft ? (game.points_a || 0) : (game.points_b || 0)
    const rightPoints = isALeft ? (game.points_b || 0) : (game.points_a || 0)

    // Get set results from joined matches table and transform to left/right
    // Format from DB: [{set: 1, home: 25, away: 20}, ...]
    // Team A is always home in our system
    const rawSetResults = game.matches?.set_results || []
    const setResults = rawSetResults.map(s => ({
      set: s.set,
      left: isALeft ? s.home : s.away,
      right: isALeft ? s.away : s.home
    }))

    return {
      leftName: isALeft ? (game.team_a_name || 'Team A') : (game.team_b_name || 'Team B'),
      rightName: isALeft ? (game.team_b_name || 'Team B') : (game.team_a_name || 'Team A'),
      // Main score: show sets if match ended or in set interval, otherwise points
      leftScore: (isMatchEnded || isInSetInterval) ? leftSets : leftPoints,
      rightScore: (isMatchEnded || isInSetInterval) ? rightSets : rightPoints,
      leftSets,
      rightSets,
      leftPoints,
      rightPoints,
      isMatchEnded,
      isInSetInterval,
      // Serving: convert team key to side
      servingTeam: game.serving_team, // already 'left' or 'right'
      setResults
    }
  }

  // Fullscreen view for selected game
  if (selectedGameData) {
    const { leftName, rightName, leftScore, rightScore, leftSets, rightSets, isMatchEnded, servingTeam, setResults } = getLeftRight(selectedGameData)
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
                  document.documentElement.requestFullscreen().catch(() => { })
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
            gridTemplateColumns: isMatchEnded ? '1fr auto 1fr' : 'auto 1fr auto 1fr auto',
            alignItems: 'center',
            gap: '10px',
            width: '100%',
            maxWidth: '800px'
          }}>
            {/* Left Ball - hidden when match ended */}
            {!isMatchEnded && (
              <div style={{ width: '60px', display: 'flex', justifyContent: 'center' }}>
                {servingTeam === 'left' && (
                  <img src={ballImage} onError={(e) => e.target.src = mikasaVolleyball} alt="Serve" style={{ width: '50px', height: '50px' }} />
                )}
              </div>
            )}

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

            {/* Right Ball - hidden when match ended */}
            {!isMatchEnded && (
              <div style={{ width: '60px', display: 'flex', justifyContent: 'center' }}>
                {servingTeam === 'right' && (
                  <img src={ballImage} onError={(e) => e.target.src = mikasaVolleyball} alt="Serve" style={{ width: '50px', height: '50px' }} />
                )}
              </div>
            )}
          </div>

          {/* Set Score or Final indicator */}
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '12px',
            marginTop: '40px'
          }}>
            {isMatchEnded ? (
              /* Show FINAL badge and each set's final score */
              <>
                <div style={{
                  fontSize: 'clamp(28px, 8vw, 56px)',
                  fontWeight: 800,
                  color: '#22c55e'
                }}>
                  {t('livescore.final', 'FINAL')}
                </div>
                {setResults.length > 0 && (
                  <div style={{
                    display: 'flex',
                    gap: '16px',
                    flexWrap: 'wrap',
                    justifyContent: 'center'
                  }}>
                    {setResults.map((s) => (
                      <div key={s.set} style={{
                        fontSize: 'clamp(14px, 4vw, 20px)',
                        color: 'rgba(255,255,255,0.6)',
                        padding: '4px 12px',
                        background: 'rgba(255,255,255,0.05)',
                        borderRadius: '6px'
                      }}>
                        {s.left}-{s.right}
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              /* Show set scores during match */
              <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
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
            )}
          </div>
        </div>
      </div>
    )
  }

  // Show server connection screen first (unless auto-connecting via URL params)
  if (!serverReady) {
    return <ServerConnectionScreen onConnected={handleServerConnected} />
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
                document.documentElement.requestFullscreen().catch(() => { })
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
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
            {liveGames.map((game) => {
              const { leftName, rightName, leftScore, rightScore, leftSets, rightSets, isMatchEnded, servingTeam } = getLeftRight(game)
              const gameN = game.game_n || ''
              const league = game.league || ''
              const rawGender = game.gender || ''
              // Convert gender to symbol
              const genderSymbol = rawGender.toLowerCase().startsWith('m') ? '♂'
                : rawGender.toLowerCase().startsWith('f') || rawGender.toLowerCase().startsWith('w') ? '♀'
                  : rawGender

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
                    transition: 'background 0.2s',
                    width: 'auto'
                  }}
                >
                  {/* Game N, League, Gender */}
                  {(gameN || league || genderSymbol) && (
                    <div style={{
                      marginBottom: '8px',
                      fontSize: '12px',
                      color: 'rgba(255,255,255,0.5)',
                      textAlign: 'center'
                    }}>
                      {gameN && <span style={{ fontWeight: 600, color: 'var(--accent)' }}>Game {gameN}</span>}
                      {gameN && (league || genderSymbol) && ' • '}
                      {[league, genderSymbol].filter(Boolean).join(' • ')}
                    </div>
                  )}

                  {/* Teams and Score */}
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr auto auto auto 1fr',
                    alignItems: 'center',
                    gap: '8px'
                  }}>
                    {/* Left Team - right aligned */}
                    <div style={{
                      fontSize: '14px',
                      fontWeight: 600,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'flex-end',
                      gap: '6px'
                    }}>
                      {!isMatchEnded && servingTeam === 'left' && (
                        <img src={ballImage} onError={(e) => e.target.src = mikasaVolleyball} alt="" style={{ width: '14px', height: '14px' }} />
                      )}
                      {leftName}
                    </div>

                    {/* Score - colon centered */}
                    <span style={{ fontSize: '28px', fontWeight: 700, textAlign: 'right', minWidth: '24px' }}>{leftScore}</span>
                    <span style={{ fontSize: '20px', color: 'rgba(255,255,255,0.4)' }}>:</span>
                    <span style={{ fontSize: '28px', fontWeight: 700, textAlign: 'left', minWidth: '24px' }}>{rightScore}</span>

                    {/* Right Team - left aligned */}
                    <div style={{
                      fontSize: '14px',
                      fontWeight: 600,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'flex-start',
                      gap: '6px'
                    }}>
                      {rightName}
                      {!isMatchEnded && servingTeam === 'right' && (
                        <img src={ballImage} onError={(e) => e.target.src = mikasaVolleyball} alt="" style={{ width: '14px', height: '14px' }} />
                      )}
                    </div>
                  </div>

                  {/* Set Score or Final indicator */}
                  <div style={{
                    marginTop: '8px',
                    fontSize: '12px',
                    color: isMatchEnded ? '#22c55e' : 'rgba(255,255,255,0.5)',
                    textAlign: 'center',
                    fontWeight: isMatchEnded ? 600 : 400
                  }}>
                    {isMatchEnded
                      ? t('livescore.final', 'FINAL')
                      : `Set ${game.current_set || 1} • Sets: ${leftSets} - ${rightSets}`
                    }
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
