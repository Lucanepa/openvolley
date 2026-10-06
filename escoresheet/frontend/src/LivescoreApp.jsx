import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from './lib/supabaseClient'
import { apiFrom } from './lib/apiClient'
import UpdateBanner from './components/UpdateBanner'
import DashboardHeader from './components/DashboardHeader'
import ServerConnectionScreen from './components/ServerConnectionScreen'
import { applyServerParam, getApiUrl, getBackendOverride, isServedFromLocalServer, isStaticDeployment } from './utils/backendConfig'
import { createRelayLivescoreFeed, fetchRelayLivescoreList, relayLivescoreMode, relayLivescoreWsUrl } from './utils/relayLivescore'
import { applyLiveChange, visibleGames } from './utils/livescoreChanges'
import { listedGames, trackWatched, needsFinalRefetch, FINAL_REFETCH_DELAYS_MS, jitterDelay, applyMatchRowChange, shouldAutoConnect, liveSetNumber, countLiveGames, LIVE_FETCH_WINDOW_MS, liveScoreboard, settleLiveChange } from './utils/livescoreModel'
import ballFallback from './ball_fallback.png'
import { AlertTriangle, Radio, RefreshCw, Server } from 'lucide-react'
import { cn } from './ui/cn.js'
import { BANNER_BASE, BANNER } from './ui/tones.js'
import { Button, ButtonGroup } from './ui/Button.jsx'
import { Card } from './ui/Card.jsx'
import { FormError } from './ui/Field.jsx'
import { EmptyState } from './ui/EmptyState.jsx'
import { Row, RowList, DateRail } from './ui/Row.jsx'
import { Chip } from './ui/Chip.jsx'
import { StatusPill } from './ui/StatusPill.jsx'
import { SkeletonRows } from './ui/Skeleton.jsx'

function shouldAutoConnectNow() {
  if (typeof window === 'undefined') return false
  return shouldAutoConnect({
    servedFromLocalServer: isServedFromLocalServer(),
    staticDeployment: isStaticDeployment(),
    search: window.location.search,
    hasOverride: !!getBackendOverride()
  })
}

// A venue relay (desktop app, venue server) on this machine or the local
// network: the livescore reads it instead of the cloud (utils/relayLivescore).
function relayLivescoreNow() {
  if (typeof window === 'undefined') return false
  return relayLivescoreMode({
    servedFromLocalServer: isServedFromLocalServer(),
    origin: window.location?.origin || null,
    override: getBackendOverride()
  })
}

// Primary ball image (with a bundled copy as fallback)
const ballImage = `${import.meta.env.BASE_URL}ball.png`

/**
 * Simplified Livescore App
 * - Subscribes to match_live_state table (cloud), or to a venue relay's
 *   public match summaries on the hall Wi-Fi / Bluetooth without internet
 *   (utils/relayLivescore: no PIN, never anything but the public summary)
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
  // The venue relay feed (relay mode), and why its data may be old
  const relayFeedRef = useRef(null)
  const relayDownRef = useRef({ list: false, socket: false })

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
      applyServerParam(serverParam)
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

  // Fetch all live games from match_live_state (relay mode: the relay's list)
  const fetchLiveGames = useCallback(async () => {
    if (relayFeedRef.current) {
      await relayFeedRef.current.refresh()
      return
    }
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

    if (relayLivescoreNow()) {
      // The relay's list (every 10 s) and one socket for every match's summary
      // The socket counts as down until it opened: no scores come without it
      const down = relayDownRef.current
      down.list = false
      down.socket = true
      const showStale = () => setStale(hasLoadedRef.current && (down.list || down.socket))
      const feed = createRelayLivescoreFeed({
        listMatches: () => fetchRelayLivescoreList(getApiUrl('/api/match/list?finished=1')),
        getWsUrl: () => relayLivescoreWsUrl(),
        onChange: (rows) => setLiveGames(rows),
        onList: ({ ok, error: listError }) => {
          down.list = !ok
          if (ok) {
            hasLoadedRef.current = true
            setError(null)
          } else if (!hasLoadedRef.current) {
            setError(listError || 'The relay did not answer')
          }
          showStale()
          setLoading(false)
        },
        onLive: (on) => {
          down.socket = !on
          showStale()
        }
      })
      relayFeedRef.current = feed
      feed.start()
      return () => {
        feed.stop()
        if (relayFeedRef.current === feed) relayFeedRef.current = null
      }
    }

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
          // probe rows are ignored. See utils/livescoreChanges.js. Frames older
          // than the shown row are dropped, and the match-end set_end frame
          // keeps the last set's sides (utils/livescoreModel settleLiveChange).
          setLiveGames(prev => {
            const settled = settleLiveChange(prev, payload)
            return settled ? applyLiveChange(prev, settled) : prev
          })
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

  // Left/right view of a game (sides from side_a, main digits, phase, finished
  // sets): utils/livescoreModel liveScoreboard
  const getLeftRight = liveScoreboard
  // Label for a set break / running timeout (null while the ball is in play)
  const phaseLabel = (phase) => (phase === 'set_break'
    ? t('livescore.setBreak', 'Set break')
    : phase === 'timeout' ? t('scoreboard.timeout', 'Timeout') : null)

  // Last refetch failed after an earlier success: the scores shown may be old.
  const staleNotice = stale ? (
    <div
      role="status"
      className="ov-kit pointer-events-none fixed inset-x-0 z-[70] flex justify-center px-4"
      style={{ bottom: 'calc(8px + env(safe-area-inset-bottom, 0px))' }}
    >
      <div className={cn(BANNER_BASE, BANNER.mild)}>
        <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
        <span>{t('livescore.staleData', 'Connection problem: showing the last known scores')}</span>
      </div>
    </div>
  ) : null

  // Fullscreen view for selected game
  if (selectedGameData) {
    const { leftName, rightName, leftScore, rightScore, leftSets, rightSets, isMatchEnded, servingTeam, setResults, phase } = getLeftRight(selectedGameData)
    const currentSet = liveSetNumber(selectedGameData)
    const breakLabel = phaseLabel(phase)
    // Finished sets as chips: at FINAL and during the match
    const setChips = setResults.length > 0 ? (
      <div style={{
        display: 'flex',
        gap: 'clamp(8px, 2vmin, 24px)',
        flexWrap: 'wrap',
        justifyContent: 'center'
      }}>
        {setResults.map((s) => (
          <div key={s.set} style={{
            fontSize: 'clamp(16px, 4vmin, 64px)',
            fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
            color: '#44403c', // stone-700
            padding: '0.6vmin 1.8vmin',
            background: '#ffffff',
            border: '1px solid #e7e5e4', // stone-200
            borderRadius: '8px'
          }}>
            {s.left}–{s.right}
          </div>
        ))}
      </div>
    ) : null
    const gameN = selectedGameData.game_n || ''
    const league = selectedGameData.league || ''
    const gender = selectedGameData.gender || ''

    // The public viewer works on any screen (no "screen too small" gate):
    // laptops at 1366x768, 1024x600 tablets and phones in either orientation.
    // Sizes follow the smaller viewport side, the scores also the width, so two
    // digits and the serve ball fit a 360 px phone. Names sit in their own
    // grid row: a name that wraps no longer lifts its score above the other.
    const serveBall = (side) => (
      <span aria-hidden={servingTeam !== side} style={{ display: 'flex', flex: '0 0 auto', width: 'clamp(32px, min(12vmin, 9vw), 200px)', justifyContent: 'center' }}>
        {servingTeam === side && (
          <img src={ballImage} onError={(e) => e.target.src = ballFallback} alt={t('livescore.serving', 'Serving')} style={{ width: '100%', height: 'auto', aspectRatio: '1 / 1' }} />
        )}
      </span>
    )
    const scoreStyle = { fontSize: 'clamp(56px, min(30vmin, 19vw), 640px)', fontWeight: 700, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }
    const nameStyle = { fontSize: 'clamp(16px, min(6vmin, 5vw), 130px)', fontWeight: 600, color: '#57534e', lineHeight: 1.2, textAlign: 'center', overflowWrap: 'anywhere', marginTop: '1vmin' }

    return (
      <div className="ov-kit" style={{
        minHeight: '100dvh',
        background: 'var(--bg)',
        color: 'var(--text)',
        display: 'flex',
        flexDirection: 'column'
      }}>
        {staleNotice}

        {/* Header: visible Back on the left, menu on the right */}
        <DashboardHeader
          title={gameN ? `Game ${gameN}` : t('livescore.title', 'Live score')}
          subtitle={[league, gender].filter(Boolean).join(' • ') || null}
          onBack={() => setSelectedGame(null)}
          backLabel={t('common.back', 'Back')}
          backButton
          menuAlign="end"
          showOptionsMenu={false}
        />

        {/* Score Display */}
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 'clamp(12px, 3vmin, 40px) 16px'
        }}>
          {/* Point score (sets once the match ended) */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
            alignItems: 'center',
            columnGap: '2vmin',
            width: '100%',
            maxWidth: 'min(100%, 2600px)'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '2vmin', minWidth: 0 }}>
              {!isMatchEnded && serveBall('left')}
              <span style={scoreStyle}>{leftScore}</span>
            </div>
            <div aria-hidden="true" style={{ fontSize: 'clamp(36px, min(20vmin, 12vw), 400px)', color: 'var(--muted)', lineHeight: 1 }}>
              :
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '2vmin', minWidth: 0 }}>
              <span style={scoreStyle}>{rightScore}</span>
              {!isMatchEnded && serveBall('right')}
            </div>
            <div style={{ ...nameStyle, alignSelf: 'start' }}>{leftName}</div>
            <div />
            <div style={{ ...nameStyle, alignSelf: 'start' }}>{rightName}</div>
          </div>

          {/* Set score or the final result */}
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '12px',
            marginTop: 'clamp(16px, 5vmin, 64px)'
          }}>
            {isMatchEnded ? (
              /* Final badge and each set's score */
              <>
                <div style={{
                  fontSize: 'clamp(28px, 10vmin, 220px)',
                  fontWeight: 800,
                  lineHeight: 1,
                  color: '#047857' // emerald-700: done state, AA on the stone page
                }}>
                  {t('livescore.final', 'Final')}
                </div>
                {setChips}
              </>
            ) : (
              /* Sets won and the current set during the match */
              <>
              {breakLabel && (
                <div role="status" style={{
                  fontSize: 'clamp(16px, 5vmin, 96px)',
                  fontWeight: 800,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em'
                }}>
                  {breakLabel}
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 'clamp(12px, 3vmin, 40px)' }}>
                <div style={{
                  fontSize: 'clamp(32px, 14vmin, 300px)',
                  fontWeight: 700,
                  lineHeight: 1.1,
                  fontVariantNumeric: 'tabular-nums',
                  padding: '1vmin 2.5vmin',
                  background: '#ffffff',
                  border: '1px solid #e7e5e4',
                  borderRadius: '12px'
                }}>
                  {leftSets}
                </div>
                <div style={{ textAlign: 'center', fontSize: 'clamp(22px, 7vmin, 170px)', fontWeight: 800, lineHeight: 1.05 }}>
                  <div>{t('livescore.set', 'SET')}</div>
                  <div style={{ fontVariantNumeric: 'tabular-nums' }}>{currentSet}</div>
                </div>
                <div style={{
                  fontSize: 'clamp(32px, 14vmin, 300px)',
                  fontWeight: 700,
                  lineHeight: 1.1,
                  fontVariantNumeric: 'tabular-nums',
                  padding: '1vmin 2.5vmin',
                  background: '#ffffff',
                  border: '1px solid #e7e5e4',
                  borderRadius: '12px'
                }}>
                  {rightSets}
                </div>
              </div>
              {setChips}
              </>
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
    <div className="ov-kit" style={{
      minHeight: '100dvh',
      background: 'var(--bg)',
      color: 'var(--text)'
    }}>
      <UpdateBanner />
      {staleNotice}

      {/* Header */}
      <DashboardHeader
        title={t('livescore.title', 'Live scores')}
        subtitle={`${countLiveGames(shownGames)} ${countLiveGames(shownGames) === 1 ? 'game' : 'games'} live`}
        onLoadGames={fetchLiveGames}
        loadingMatches={loading}
        matchCount={shownGames.length}
        menuAlign="end"
        showOptionsMenu={false}
      />

      {/* Content */}
      <div className="ov-kit px-4 py-6">
        {loading ? (
          <Card pad="list" className="mx-auto max-w-3xl">
            <span className="sr-only">{t('common.loading', 'Loading...')}</span>
            <SkeletonRows rows={3} />
          </Card>
        ) : error ? (
          <Card className="mx-auto max-w-md text-center">
            <FormError size="md">{error}</FormError>
            <ButtonGroup className="mt-4 justify-center">
              <Button variant="secondary" size="xl" icon={RefreshCw} onClick={fetchLiveGames}>
                {t('common.retry', 'Retry')}
              </Button>
              {/* A stored server (e.g. a venue LAN server) may be unreachable now */}
              <Button variant="ghost" size="xl" icon={Server} onClick={handleChangeServer}>
                {t('connection.changeServer', 'Change server')}
              </Button>
            </ButtonGroup>
          </Card>
        ) : shownGames.length === 0 ? (
          <Card className="mx-auto max-w-md">
            <EmptyState icon={Radio}>{t('livescore.noActiveGame', 'No live games')}</EmptyState>
          </Card>
        ) : (
          <Card pad="list" className="mx-auto max-w-3xl">
            <RowList soft>
            {shownGames.map((game) => {
              const { leftName, rightName, leftScore, rightScore, leftSets, rightSets, isMatchEnded, servingTeam, setResults, phase } = getLeftRight(game)
              const breakLabel = phaseLabel(phase)
              const gameN = game.game_n || ''
              const league = game.league || ''
              const rawGender = game.gender || ''
              // Convert gender to symbol
              const genderSymbol = rawGender.toLowerCase().startsWith('m') ? '♂'
                : rawGender.toLowerCase().startsWith('f') || rawGender.toLowerCase().startsWith('w') ? '♀'
                  : rawGender
              const tone = isMatchEnded ? 'emerald' : 'red'
              const serveBall = (
                <img src={ballImage} onError={(e) => e.target.src = ballFallback} alt={t('livescore.serving', 'Serving')} className="inline-block h-5 w-5 shrink-0" />
              )

              return (
                <Row
                  key={game.match_id}
                  tone={tone}
                  onOpen={() => setSelectedGame(game.match_id)}
                  label={[
                    `${leftName} ${leftScore} – ${rightScore} ${rightName}`,
                    isMatchEnded ? t('livescore.final', 'Final') : `Set ${liveSetNumber(game)}`,
                    breakLabel || '',
                    setResults.length > 0 ? setResults.map((r) => `${r.left}-${r.right}`).join(' ') : '',
                    gameN ? t('livescore.game', { number: gameN }) : '',
                  ].filter(Boolean).join(', ')}
                  className="min-h-11"
                  leading={
                    <DateRail
                      tone={tone}
                      weekday={gameN ? t('benchDashboard.game', 'Game') : undefined}
                      date={gameN || '–'}
                      time={genderSymbol || undefined}
                      league={league || undefined}
                    />
                  }
                  title={
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 text-left">
                      <p className="flex min-w-0 items-center gap-1.5 text-sm font-semibold leading-snug break-words text-stone-900 sm:text-[15px]">
                        <span className="min-w-0">{leftName}</span>
                        {!isMatchEnded && servingTeam === 'left' && serveBall}
                      </p>
                      <span className="text-right text-[28px] font-bold leading-tight tabular-nums text-stone-900 sm:text-3xl">{leftScore}</span>
                      <p className="flex min-w-0 items-center gap-1.5 text-sm font-semibold leading-snug break-words text-stone-900 sm:text-[15px]">
                        <span className="min-w-0">{rightName}</span>
                        {!isMatchEnded && servingTeam === 'right' && serveBall}
                      </p>
                      <span className="text-right text-[28px] font-bold leading-tight tabular-nums text-stone-900 sm:text-3xl">{rightScore}</span>
                    </div>
                  }
                  meta={!isMatchEnded ? <span className="tabular-nums">{`Sets: ${leftSets} – ${rightSets}`}</span> : undefined}
                  chips={setResults.length > 0 || game.test
                    ? [
                        // A rehearsal match on the venue relay (the cloud never lists one)
                        ...(game.test ? [<Chip key="test">{t('livescore.testMatch', 'Test match')}</Chip>] : []),
                        ...setResults.map((r) => <Chip key={r.set}><span className="tabular-nums">{r.left}–{r.right}</span></Chip>)
                      ]
                    : undefined}
                  status={isMatchEnded
                    ? <StatusPill tone="done">{t('livescore.final', 'Final')}</StatusPill>
                    : breakLabel
                      ? <StatusPill tone="todo">{breakLabel}</StatusPill>
                      : <StatusPill tone="brand"><span className="tabular-nums">{`Set ${liveSetNumber(game)}`}</span></StatusPill>}
                />
              )
            })}
            </RowList>
          </Card>
        )}
      </div>
    </div>
  )
}
