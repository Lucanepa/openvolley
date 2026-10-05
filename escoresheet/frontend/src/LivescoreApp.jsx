import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from './lib/supabaseClient'
import { apiFrom } from './lib/apiClient'
import UpdateBanner from './components/UpdateBanner'
import DashboardHeader from './components/DashboardHeader'
import ServerConnectionScreen from './components/ServerConnectionScreen'
import { setBackendOverride, getBackendOverride, isServedFromLocalServer, isStaticDeployment } from './utils/backendConfig'
import { applyLiveChange, visibleGames } from './utils/livescoreChanges'
import { listedGames, trackWatched, needsFinalRefetch, FINAL_REFETCH_DELAYS_MS, jitterDelay, applyMatchRowChange, isEndedStatus, shouldAutoConnect, liveSetsWon, liveSetResults, liveSetNumber, countLiveGames, LIVE_FETCH_WINDOW_MS } from './utils/livescoreModel'
import mikasaVolleyball from './mikasa_v200w.png'
import { PhoneIcon } from './components/icons'

function shouldAutoConnectNow() {
  if (typeof window === 'undefined') return false
  return shouldAutoConnect({
    servedFromLocalServer: isServedFromLocalServer(),
    staticDeployment: isStaticDeployment(),
    search: window.location.search,
    hasOverride: !!getBackendOverride()
  })
}

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
  // Livescore needs no PIN: skip the connection screen whenever the server is
  // known (LAN server / desktop app, *.openvolley.app, ?match= / ?server=, or a
  // server chosen earlier on this device). See utils/livescoreModel.js.
  const [serverReady, setServerReady] = useState(() => shouldAutoConnectNow())
  const [liveGames, setLiveGames] = useState([]) // All games from match_live_state
  const [selectedGame, setSelectedGame] = useState(null) // UUID of selected game for fullscreen
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // A refetch failed after an earlier success: keep showing the last good
  // list with a small notice instead of replacing it with the error view.
  const [stale, setStale] = useState(false)
  const hasLoadedRef = useRef(false)
  const channelRef = useRef(null)
  const [viewportWidth, setViewportWidth] = useState(() => typeof window !== 'undefined' ? window.innerWidth : 400)
  const [viewportHeight, setViewportHeight] = useState(() => typeof window !== 'undefined' ? window.innerHeight : 700)

  // Matches shown as started in this session (stay listed after an undo to
  // 0:0) and matches watched while they could still change their set results.
  const shownStartedRef = useRef(new Set())
  // When this page saw each row change (the scorer's clock may be off)
  const rowChangesRef = useRef(new Map())
  const watchedRef = useRef(new Set())
  const finalRefetchAttemptsRef = useRef(new Map())
  const [finalRefetchTick, setFinalRefetchTick] = useState(0)
  // Clock for dropping stale rows (finished hours ago, abandoned) from the list
  const [listNow, setListNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setListNow(Date.now()), 60 * 1000)
    return () => clearInterval(timer)
  }, [])

  // ?server= sets the backend for this and later visits (the initial state
  // already counts it as a known server)
  useEffect(() => {
    const serverParam = new URLSearchParams(window.location.search).get('server')
    if (serverParam) {
      setBackendOverride(serverParam.startsWith('http') ? serverParam : `https://${serverParam}`)
    }
  }, [])

  // Handle server connection established
  const handleServerConnected = useCallback(() => {
    setServerReady(true)
  }, [])

  // Back to the connection screen (e.g. a stored LAN server is unreachable)
  const handleChangeServer = useCallback(() => {
    setSelectedGame(null)
    hasLoadedRef.current = false
    setStale(false)
    setLiveGames([])
    setServerReady(false)
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
    try {
      const { data, error: fetchError } = await apiFrom('match_live_state')
        .select('*, matches!match_live_state_match_id_fkey_cascade(set_results)')
        .eq('sport_type', 'indoor')
        // Rows of old (finished or abandoned) matches stay in the table
        .gte('updated_at', new Date(Date.now() - LIVE_FETCH_WINDOW_MS).toISOString())
        .order('updated_at', { ascending: false })

      if (fetchError) {
        console.error('[Livescore] Error fetching games:', fetchError)
        if (hasLoadedRef.current) setStale(true)
        else setError(fetchError.message)
      } else {
        setLiveGames(visibleGames(data))
        hasLoadedRef.current = true
        setError(null)
        setStale(false)
      }
    } catch (err) {
      console.error('[Livescore] Exception:', err)
      if (hasLoadedRef.current) setStale(true)
      else setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial fetch and subscribe to realtime updates, once the server is known
  // (a server chosen on the connection screen is used by both).
  useEffect(() => {
    if (!serverReady) return undefined
    fetchLiveGames()

    if (!supabase) return undefined

    // Subscribe to every indoor match_live_state change (relay realtime shim)
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
          // INSERT/UPDATE upsert by match_id and merge into the loaded row (keeps
          // the joined set_results); an UPDATE for an unknown game is an insert;
          // probe rows are ignored. See utils/livescoreChanges.js.
          setLiveGames(prev => applyLiveChange(prev, payload))
          if (payload.eventType === 'DELETE') {
            // If the deleted game was selected, clear selection to go back to list
            setSelectedGame(prev => prev === payload.old?.match_id ? null : prev)
          }
        }
      )
      // FINAL set chips: set_results is written to the matches row by the
      // scorer's sync queue, not to match_live_state, so take it from the
      // match row's own change (secrets are stripped by the hub).
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'matches',
          filter: 'sport_type=eq.indoor'
        },
        (payload) => setLiveGames(prev => applyMatchRowChange(prev, payload))
      )
      .subscribe((status) => {
        console.log('[Livescore] Subscription status:', status)
        // SUBSCRIBED repeats after every reconnect: refetch to catch up on
        // whatever changed while the socket was down.
        if (status === 'SUBSCRIBED') fetchLiveGames()
      })

    channelRef.current = channel

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current)
        channelRef.current = null
      }
    }
  }, [fetchLiveGames, serverReady])

  // Only started (or finished) matches are listed: a match appears when it is
  // under way, not at the first lineup confirm. See utils/livescoreModel.js.
  const shownGames = useMemo(() => listedGames(liveGames, shownStartedRef.current, listNow, rowChangesRef.current), [liveGames, listNow])

  // FINAL view set results: match_live_state UPDATEs carry no set_results,
  // so a match that ends while this page watches it keeps the (empty)
  // matches.set_results of the first load until the realtime matches UPDATE
  // above brings them. Safety net for a missed change: refetch (with the
  // join) a few times, jittered so viewers do not refetch in step.
  trackWatched(liveGames, watchedRef.current)
  const finalPendingKey = liveGames
    .filter((g) => needsFinalRefetch(g, watchedRef.current) &&
      (finalRefetchAttemptsRef.current.get(g.match_id) || 0) < FINAL_REFETCH_DELAYS_MS.length)
    .map((g) => g.match_id)
    .join(',')
  useEffect(() => {
    if (!finalPendingKey || !serverReady) return undefined
    const ids = finalPendingKey.split(',')
    const attempts = finalRefetchAttemptsRef.current
    const attempt = Math.min(...ids.map((id) => attempts.get(id) || 0))
    const timer = setTimeout(async () => {
      for (const id of ids) attempts.set(id, (attempts.get(id) || 0) + 1)
      await fetchLiveGames()
      setFinalRefetchTick((n) => n + 1)
    }, jitterDelay(FINAL_REFETCH_DELAYS_MS[attempt]))
    return () => clearTimeout(timer)
  }, [finalPendingKey, finalRefetchTick, fetchLiveGames, serverReady])

  // Get selected game data
  const selectedGameData = selectedGame
    ? liveGames.find(g => g.match_id === selectedGame)
    : null

  // Helper to compute left/right from A/B based on side_a
  const getLeftRight = (game) => {
    const sideA = game.side_a || 'left' // default Team A on left
    const isALeft = sideA === 'left'
    const isMatchEnded = isEndedStatus(game.match_status)
    const isInSetInterval = !isMatchEnded && game.set_interval_active

    // When match is ended, show set score as main score (a finished match
    // counts its set results, see liveSetsWon)
    const setsWon = liveSetsWon(game)
    const leftSets = isALeft ? setsWon.a : setsWon.b
    const rightSets = isALeft ? setsWon.b : setsWon.a
    const leftPoints = isALeft ? (game.points_a || 0) : (game.points_b || 0)
    const rightPoints = isALeft ? (game.points_b || 0) : (game.points_a || 0)

    // Set results (live-state row, else the joined matches row), stored as
    // {set, home, away}: as Team A / Team B (Team A is home or away), to left/right
    const setResults = liveSetResults(game).map(s => ({
      set: s.set,
      left: isALeft ? s.a : s.b,
      right: isALeft ? s.b : s.a
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

  // Last refetch failed after an earlier success: the scores shown may be old.
  const staleNotice = stale ? (
    <div
      role="status"
      style={{
        position: 'fixed',
        bottom: '8px',
        left: '50%',
        transform: 'translateX(-50%)',
        padding: '4px 10px',
        borderRadius: '6px',
        background: 'var(--panel)',
        color: 'var(--muted)',
        fontSize: '12px',
        zIndex: 50,
        pointerEvents: 'none'
      }}
    >
      {t('livescore.staleData', 'Connection problem: showing the last known scores')}
    </div>
  ) : null

  // Fullscreen view for selected game
  if (selectedGameData) {
    const { leftName, rightName, leftScore, rightScore, leftSets, rightSets, isMatchEnded, servingTeam, setResults } = getLeftRight(selectedGameData)
    const currentSet = liveSetNumber(selectedGameData)
    const gameN = selectedGameData.game_n || ''
    const league = selectedGameData.league || ''
    const gender = selectedGameData.gender || ''

    return (
      <div style={{
        minHeight: '100dvh',
        background: 'var(--bg)',
        color: 'var(--text)',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        display: 'flex',
        flexDirection: 'column'
      }}>
        {staleNotice}
        {/* Narrow screen blocking overlay */}
        {(viewportWidth < 357 || viewportHeight < 650) && (
          <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(15, 23, 42, 0.5)',
            zIndex: 99999,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
            textAlign: 'center'
          }}>
            <div style={{ marginBottom: '24px', color: '#ffffff' }}><PhoneIcon size={64} /></div>
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
            gap: '2vmin',
            width: '100%',
            maxWidth: 'min(96vw, 2600px)'
          }}>
            {/* Left Ball - hidden when match ended */}
            {!isMatchEnded && (
              <div style={{ width: 'clamp(48px, 14vmin, 260px)', display: 'flex', justifyContent: 'center' }}>
                {servingTeam === 'left' && (
                  <img src={ballImage} onError={(e) => e.target.src = mikasaVolleyball} alt="Serve" style={{ width: 'clamp(36px, 11vmin, 200px)', height: 'clamp(36px, 11vmin, 200px)' }} />
                )}
              </div>
            )}

            {/* Left Score + Name */}
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 'clamp(64px, 30vmin, 640px)', fontWeight: 700, lineHeight: 1 }}>
                {leftScore}
              </div>
              <div style={{ fontSize: 'clamp(18px, 6vmin, 130px)', color: 'var(--muted)', marginTop: '1vmin' }}>
                {leftName}
              </div>
            </div>

            {/* Colon */}
            <div style={{ fontSize: 'clamp(40px, 20vmin, 400px)', color: 'var(--muted)', lineHeight: 1 }}>
              :
            </div>

            {/* Right Score + Name */}
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 'clamp(64px, 30vmin, 640px)', fontWeight: 700, lineHeight: 1 }}>
                {rightScore}
              </div>
              <div style={{ fontSize: 'clamp(18px, 6vmin, 130px)', color: 'var(--muted)', marginTop: '1vmin' }}>
                {rightName}
              </div>
            </div>

            {/* Right Ball - hidden when match ended */}
            {!isMatchEnded && (
              <div style={{ width: 'clamp(48px, 14vmin, 260px)', display: 'flex', justifyContent: 'center' }}>
                {servingTeam === 'right' && (
                  <img src={ballImage} onError={(e) => e.target.src = mikasaVolleyball} alt="Serve" style={{ width: 'clamp(36px, 11vmin, 200px)', height: 'clamp(36px, 11vmin, 200px)' }} />
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
                  fontSize: 'clamp(28px, 10vmin, 220px)',
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
                        fontSize: 'clamp(14px, 4vmin, 64px)',
                        color: 'var(--muted)',
                        padding: '0.5vmin 1.5vmin',
                        background: 'var(--panel-2)',
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
                  fontSize: 'clamp(32px, 14vmin, 300px)',
                  fontWeight: 700,
                  padding: '1vmin 2vmin',
                  background: 'var(--panel)',
                  borderRadius: '8px'
                }}>
                  {leftSets}
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 'clamp(24px, 8vmin, 170px)', fontWeight: 800 }}>
                    {t('livescore.set', 'SET')}
                  </div>
                  <div style={{ fontSize: 'clamp(24px, 8vmin, 170px)', fontWeight: 800 }}>
                    {currentSet}
                  </div>
                </div>
                <div style={{
                  fontSize: 'clamp(32px, 14vmin, 300px)',
                  fontWeight: 700,
                  padding: '1vmin 2vmin',
                  background: 'var(--panel)',
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
      minHeight: '100dvh',
      background: 'var(--bg)',
      color: 'var(--text)',
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
          backgroundColor: 'rgba(15, 23, 42, 0.5)',
          zIndex: 99999,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          textAlign: 'center'
        }}>
          <div style={{ marginBottom: '24px', color: '#ffffff' }}><PhoneIcon size={64} /></div>
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
      {staleNotice}

      {/* Header */}
      <DashboardHeader
        title={t('livescore.title', 'Live Scores')}
        subtitle={`${countLiveGames(shownGames)} ${countLiveGames(shownGames) === 1 ? 'game' : 'games'} live`}
        onLoadGames={fetchLiveGames}
        loadingMatches={loading}
        matchCount={shownGames.length}
        showOptionsMenu={false}
      />

      {/* Content */}
      <div style={{ padding: '16px' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '40px', color: 'var(--muted)' }}>
            {t('common.loading', 'Loading...')}
          </div>
        ) : error ? (
          <div style={{ textAlign: 'center', padding: '40px' }}>
            <div style={{ color: '#ef4444', marginBottom: '16px' }}>{error}</div>
            <button
              onClick={fetchLiveGames}
              style={{
                padding: '10px 20px',
                background: 'var(--panel)',
                border: 'none',
                borderRadius: '6px',
                color: 'var(--text)',
                cursor: 'pointer'
              }}
            >
              {t('common.retry', 'Retry')}
            </button>
            {/* A stored server (e.g. a venue LAN server) may be unreachable now */}
            <button
              onClick={handleChangeServer}
              style={{
                marginLeft: '8px',
                padding: '10px 20px',
                background: 'var(--panel)',
                border: 'none',
                borderRadius: '6px',
                color: 'var(--text)',
                cursor: 'pointer'
              }}
            >
              {t('connection.changeServer', 'Change server')}
            </button>
          </div>
        ) : shownGames.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px', color: 'var(--muted)' }}>
            <img src={ballImage} onError={(e) => e.target.src = mikasaVolleyball} alt="" style={{ width: '60px', opacity: 0.5, marginBottom: '16px' }} />
            <div>{t('livescore.noActiveGame', 'No live games')}</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
            {shownGames.map((game) => {
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
                    background: 'var(--panel-2)',
                    border: '1px solid var(--border)',
                    borderRadius: '12px',
                    color: 'var(--text)',
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
                      color: 'var(--muted)',
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
                    <span style={{ fontSize: '20px', color: 'var(--muted)' }}>:</span>
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
                    color: isMatchEnded ? '#22c55e' : 'var(--muted)',
                    textAlign: 'center',
                    fontWeight: isMatchEnded ? 600 : 400
                  }}>
                    {isMatchEnded
                      ? t('livescore.final', 'FINAL')
                      : `Set ${liveSetNumber(game)} • Sets: ${leftSets} - ${rightSets}`
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
