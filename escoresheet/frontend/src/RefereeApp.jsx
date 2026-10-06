import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { validatePin, listAvailableMatches, validatePinSupabase, listAvailableMatchesSupabase, getMatchData, setRelayDevice, getRelayServerStatus } from './utils/serverDataSync'
import { refereeJoinableMatches } from './utils/relayMatchList'
import Referee from './components/Referee'
import Modal from './components/Modal'
import UpdateBanner from './components/UpdateBanner'
import DashboardHeader from './components/DashboardHeader'
import ServerConnectionScreen from './components/ServerConnectionScreen'
import { isServedFromLocalServer } from './utils/backendConfig'
import { loadMatchList } from './utils/matchListSource'
import { applyServerParam } from './utils/backendConfig'
import { Whistle } from './ui/AppSpinner.jsx'
import { db } from './db/db'
import { Check, ChevronRight, CalendarX2, Loader2, RefreshCw } from 'lucide-react'
import { Button } from './ui/Button.jsx'
import { IconButton } from './ui/IconButton.jsx'
import { Field, FormError } from './ui/Field.jsx'
import { EmptyState, EmptyInset } from './ui/EmptyState.jsx'
import { RowList } from './ui/Row.jsx'
import { SkeletonRows } from './ui/Skeleton.jsx'
import { EntryPage, EntryCard, PinInput, ListLabel, GameRow } from './components/dashboards/EntryKit.jsx'

// Master PIN for testing without a match
const MASTER_PIN = '123456'

/**
 * Re-check a stored referee PIN (after a reload) the way handlePinSubmit checks
 * a typed one: the backend's database check first, then the LAN relay. The
 * match must still be the stored one. Ids stay strings: they are seed keys
 * ('match_…'), and Number() of one is NaN.
 * @returns {Promise<object|null>} the match, or null
 */
export async function revalidateRefereeSession(storedMatchId, storedPin, { checkCloud = validatePinSupabase, checkLan = validatePin } = {}) {
  const same = (r) => r?.success && r.match && String(r.match.id) === String(storedMatchId)
  let result = null
  try { result = await checkCloud(storedPin, 'referee') } catch { result = null }
  if (same(result)) return result.match
  try { result = await checkLan(storedPin, 'referee') } catch { result = null }
  return same(result) ? result.match : null
}

// A failed check that never reached a server (offline, timeout, no backend),
// as opposed to a server answering that the PIN is wrong.
const UNREACHABLE_RE = /failed to fetch|networkerror|load failed|timed out|not available|network request failed/i
const isUnreachable = (r) => !!r && (r.unreachable === true || UNREACHABLE_RE.test(String(r.error || '')))

/**
 * Check a typed referee PIN: the backend's database check, then the LAN relay
 * (relay-only matches are known there only). A thrown relay error is a failed
 * check, not the message to show: the relay's "No match found ... make sure
 * the main scoresheet is running" sent referees to check the scoresheet when
 * they had only mistyped the PIN.
 * @returns {Promise<{ match: object|null, source?: 'supabase'|'websocket', reason?: 'invalid'|'unreachable' }>}
 */
export async function validateRefereePin(pin, { checkCloud = validatePinSupabase, checkLan = validatePin } = {}) {
  const ok = (r) => r?.success && r.match
  let cloud
  try { cloud = await checkCloud(pin, 'referee') } catch (err) { cloud = { success: false, error: err?.message, unreachable: err?.name === 'TypeError' } }
  if (ok(cloud)) return { match: cloud.match, source: 'supabase' }
  let lan
  try { lan = await checkLan(pin, 'referee') } catch (err) { lan = { success: false, error: err?.message, unreachable: err?.name === 'TypeError' } }
  if (ok(lan)) return { match: lan.match, source: 'websocket' }
  return { match: null, reason: isUnreachable(cloud) && isUnreachable(lan) ? 'unreachable' : 'invalid' }
}

export default function RefereeApp() {
  const { t, i18n } = useTranslation()
  // Label this tablet on the relay (scorer's tablet status) before the
  // dashboard subscribes
  useState(() => setRelayDevice('referee'))
  const [serverReady, setServerReady] = useState(isServedFromLocalServer())
  const [autoConnectMatch, setAutoConnectMatch] = useState(null) // match seed_key from URL params
  const [linkedMatch, setLinkedMatch] = useState(null) // { id: seed key, gameNumber } preselected by a link
  const [pinInput, setPinInput] = useState('')
  const [matchId, setMatchId] = useState(null)
  const [error, setError] = useState('')
  const [match, setMatch] = useState(null)
  const [isLoading, setIsLoading] = useState(false)
  const [availableMatches, setAvailableMatches] = useState([])
  const [selectedGameNumber, setSelectedGameNumber] = useState('')
  const [loadingMatches, setLoadingMatches] = useState(false)
  const [showGameModal, setShowGameModal] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [serverConnected, setServerConnected] = useState(false)
  const [isMasterMode, setIsMasterMode] = useState(false)
  const [wakeLockActive, setWakeLockActive] = useState(false)
  const [testModeClicks, setTestModeClicks] = useState(0)
  const wakeLockRef = useRef(null)
  const testModeTimeoutRef = useRef(null)

  const [connectionStatuses, setConnectionStatuses] = useState({
    api: 'unknown',
    server: 'unknown',
    websocket: 'unknown',
    scoreboard: 'unknown',
    match: 'unknown',
    db: 'unknown'
  })

  // Check URL params for auto-connect on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const matchParam = params.get('match')
    const serverParam = params.get('server')

    if (serverParam) {
      applyServerParam(serverParam)
    }

    if (matchParam) {
      setAutoConnectMatch(matchParam)
      // Skip server connection screen if we have URL params
      setServerReady(true)
    }
  }, [])

  // A match link (QR code) only preselects the match: the referee still enters
  // the PIN, like the bench (the link alone is no access). The PIN check
  // returns the match's id (its seed key); the relay copy's match.id is the
  // scorer's Dexie id, which is no match key.
  useEffect(() => {
    if (!autoConnectMatch || !serverReady) return

    const doAutoConnect = async () => {
      let gameNumber = null
      try {
        const result = await getMatchData(autoConnectMatch)
        if (result?.success && result.match) {
          gameNumber = result.match.gameNumber ?? result.match.gameN ?? result.match.game_n ?? null
        }
      } catch { /* the PIN step still works without the details */ }
      setLinkedMatch({ id: String(autoConnectMatch), gameNumber })
      if (gameNumber != null) setSelectedGameNumber(String(gameNumber))
      setAutoConnectMatch(null)
    }
    doAutoConnect()
  }, [autoConnectMatch, serverReady])

  // The linked match in the game list (by its seed key) gives its game number
  useEffect(() => {
    if (!linkedMatch || selectedGameNumber) return
    const listed = availableMatches.find(m => String(m.id) === linkedMatch.id)
    if (listed?.gameNumber != null) setSelectedGameNumber(String(listed.gameNumber))
  }, [linkedMatch, availableMatches, selectedGameNumber])

  // Handle server connection established
  const handleServerConnected = useCallback(() => {
    setServerReady(true)
  }, [])


  // Check connection statuses
  const checkConnectionStatuses = async () => {
    const statuses = {
      api: 'unknown',
      server: 'unknown',
      websocket: 'unknown',
      scoreboard: 'unknown',
      match: 'unknown',
      db: 'unknown'
    }
    const debugInfo = {}
    
    // Check API/Server connection
    try {
      const result = await listAvailableMatches()
      if (result.success) {
        statuses.api = 'connected'
        statuses.server = 'connected'
        setServerConnected(true)
        debugInfo.api = { status: 'connected', message: 'API endpoint responding' }
        debugInfo.server = { status: 'connected', message: 'Server is reachable' }
      } else {
        statuses.api = 'disconnected'
        statuses.server = 'disconnected'
        setServerConnected(false)
        debugInfo.api = { status: 'disconnected', message: `API request failed: ${result.error || 'Unknown error'}` }
        debugInfo.server = { status: 'disconnected', message: `Server request failed: ${result.error || 'Unknown error'}` }
      }
    } catch (err) {
      statuses.api = 'disconnected'
      statuses.server = 'disconnected'
      setServerConnected(false)
      debugInfo.api = { status: 'disconnected', message: `Network error: ${err.message || 'Failed to connect to API'}` }
      debugInfo.server = { status: 'disconnected', message: `Network error: ${err.message || 'Failed to connect to server'}` }
    }
    
    // Relay reachable? An HTTP status check on the configured backend: the old
    // check opened (and dropped) a WebSocket on every load just to see it open.
    const relayStatus = await getRelayServerStatus()
    statuses.websocket = relayStatus.running ? 'connected' : 'disconnected'
    debugInfo.websocket = relayStatus.running
      ? { status: 'connected', message: 'WebSocket server is reachable' }
      : { status: 'disconnected', message: 'WebSocket server is not reachable' }

    statuses.scoreboard = statuses.server
    debugInfo.scoreboard = debugInfo.server
    
    if (matchId && match) {
      statuses.match = match.status === 'live' ? 'live' : match.status === 'scheduled' ? 'scheduled' : 'final'
      debugInfo.match = { status: statuses.match, message: `Match status: ${statuses.match}` }
    } else if (isMasterMode) {
      statuses.match = 'test_mode'
      debugInfo.match = { status: 'test_mode', message: 'Running in test mode with master PIN' }
    } else {
      statuses.match = 'no_match'
      debugInfo.match = { status: 'no_match', message: 'No match connected.' }
    }
    
    try {
      await db.matches.count()
      statuses.db = 'connected'
      debugInfo.db = { status: 'connected', message: 'IndexedDB is accessible' }
    } catch (err) {
      statuses.db = 'disconnected'
      debugInfo.db = { status: 'disconnected', message: `IndexedDB error: ${err.message}` }
    }
    
    setConnectionStatuses(statuses)
  }

  // Load available matches function - called on mount and manually via button.
  // Cloud first, relay as fallback; on a page served by a local relay (venue
  // tablet, desktop app) the relay first, so a cloud that hangs without an
  // internet uplink never holds up the list (see loadMatchList).
  const loadMatches = useCallback(async () => {
    setLoadingMatches(true)
    try {
      const { result, source } = await loadMatchList({
        listCloud: listAvailableMatchesSupabase,
        // The relay lists every published match (display devices pick theirs
        // there): offer only those with the referee connection on.
        listRelay: async () => {
          const r = await listAvailableMatches()
          return r?.success ? { ...r, matches: refereeJoinableMatches(r.matches) } : r
        },
        relayFirst: isServedFromLocalServer()
      })

      if (result.success && result.matches) {
        console.log(`[RefereeApp] Available games (${source}):`, result.matches.length, '| Games:', result.matches.map(m => ({
          gameNumber: m.gameNumber,
          refereeEnabled: m.refereeConnectionEnabled
        })))
        setAvailableMatches(result.matches)
        setServerConnected(true)
      } else {
        setServerConnected(false)
      }
    } catch (err) {
      console.error('[RefereeApp] Failed to load matches:', err)
      setServerConnected(false)
    } finally {
      setLoadingMatches(false)
    }
  }, [])

  // Load matches on mount only (no auto-polling - use manual refresh button)
  useEffect(() => {
    loadMatches()
    checkConnectionStatuses()
  }, [loadMatches])
  
  // Fullscreen functionality
  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen()
        setIsFullscreen(true)
      } else {
        await document.exitFullscreen()
        setIsFullscreen(false)
      }
    } catch (error) {
      console.error('Error toggling fullscreen:', error)
    }
  }
  
  // Listen for fullscreen changes
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement)
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  // Wake lock - request on mount
  useEffect(() => {
    const enableWakeLock = async () => {
      try {
        if ('wakeLock' in navigator) {
          if (wakeLockRef.current) {
            try { await wakeLockRef.current.release() } catch (e) {}
          }
          wakeLockRef.current = await navigator.wakeLock.request('screen')
          console.log('[WakeLock] Screen wake lock acquired (RefereeApp)')
          setWakeLockActive(true)
          wakeLockRef.current.addEventListener('release', () => {
            console.log('[WakeLock] Screen wake lock released (RefereeApp)')
            if (!wakeLockRef.current) {
              setWakeLockActive(false)
            }
          })
        }
      } catch (err) {
        console.log('[WakeLock] Wake lock failed:', err.message)
      }
    }

    enableWakeLock()

    // Re-enable on visibility change
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        enableWakeLock()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {})
        wakeLockRef.current = null
      }
    }
  }, [])

  // Toggle wake lock manually
  const toggleWakeLock = useCallback(async () => {
    if (wakeLockActive) {
      if (wakeLockRef.current) {
        try {
          await wakeLockRef.current.release()
          wakeLockRef.current = null
        } catch (e) {}
      }
      setWakeLockActive(false)
      console.log('[WakeLock] Manually disabled')
    } else {
      try {
        if ('wakeLock' in navigator) {
          wakeLockRef.current = await navigator.wakeLock.request('screen')
          setWakeLockActive(true)
          console.log('[WakeLock] Manually enabled')
        }
      } catch (err) {
        console.log('[WakeLock] Failed to enable:', err.message)
        setWakeLockActive(true)
      }
    }
  }, [wakeLockActive])

  // Auto-connect on mount if we have stored credentials
  useEffect(() => {
    const storedMatchId = localStorage.getItem('refereeMatchId')
    const storedPin = localStorage.getItem('refereePin')
    const storedMasterMode = localStorage.getItem('refereeMasterMode')
    
    if (storedMasterMode === 'true') {
      setIsMasterMode(true)
      setMatchId(-1) // Use -1 as a sentinel for master mode
    } else if (storedMatchId && storedPin) {
      revalidateRefereeSession(storedMatchId, storedPin)
        .then(restored => {
          if (restored) {
            // Numeric LAN ids stay numbers, seed keys stay strings
            setMatchId(/^\d+$/.test(String(restored.id)) ? Number(restored.id) : restored.id)
            setMatch(restored)
            setPinInput(storedPin)
            // The backend chosen before the reload is still configured
            setServerReady(true)
          } else {
            localStorage.removeItem('refereeMatchId')
            localStorage.removeItem('refereePin')
          }
        })
        .catch(() => { /* unreachable now: keep the credentials for the next load */ })
    }
  }, [])
  
  const handleSelectGame = (gameNumber) => {
    setSelectedGameNumber(gameNumber)
    setShowGameModal(false)
  }

  // Monitor match connection status
  useEffect(() => {
    if (match && match.refereeConnectionEnabled === false) {
      setMatchId(null)
      setMatch(null)
      setPinInput('')
      setIsMasterMode(false)
      localStorage.removeItem('refereeMatchId')
      localStorage.removeItem('refereePin')
      localStorage.removeItem('refereeMasterMode')
      setError(t('refereeDashboard.errors.connectionDisabled'))
    }
  }, [match, t])

  const handlePinSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setIsLoading(true)

    if (!pinInput || pinInput.length !== 6) {
      setError(t('refereeDashboard.errors.enterPin'))
      setIsLoading(false)
      return
    }

    // Master PIN enters test mode, but only when no real match uses that PIN
    // (it used to be checked first and shadowed a real match's referee PIN).
    const enterMasterMode = () => {
      setIsMasterMode(true)
      setMatchId(-1) // Use -1 as sentinel for master/test mode
      localStorage.setItem('refereeMasterMode', 'true')
    }

    try {
      // Backend database check first, then the LAN relay
      const result = await validateRefereePin(pinInput.trim())

      if (result.match) {
        console.log(`[RefereeApp] PIN validated via ${result.source}`)
        setLinkedMatch(null)
        setMatchId(result.match.id)
        setMatch(result.match)
        localStorage.setItem('refereeMatchId', String(result.match.id))
        localStorage.setItem('refereePin', pinInput)
      } else if (pinInput === MASTER_PIN) {
        enterMasterMode()
      } else {
        setError(result.reason === 'unreachable'
          ? t('refereeDashboard.errors.serverUnreachable', 'No connection to the server – check the Wi-Fi and try again.')
          : t('refereeDashboard.errors.invalidPin'))
        setPinInput('')
        localStorage.removeItem('refereeMatchId')
        localStorage.removeItem('refereePin')
      }
    } catch (err) {
      if (pinInput === MASTER_PIN) {
        enterMasterMode()
        return
      }
      console.error('Error validating PIN:', err)
      setError(t('refereeDashboard.errors.invalidPin'))
      setPinInput('')
    } finally {
      setIsLoading(false)
    }
  }

  const handleExit = useCallback((reason) => {
    setMatchId(null)
    setMatch(null)
    setPinInput('')
    setIsMasterMode(false)
    localStorage.removeItem('refereeMatchId')
    localStorage.removeItem('refereePin')
    localStorage.removeItem('refereeMasterMode')

    if (reason === 'heartbeat_failure') {
      setError(t('refereeDashboard.errors.connectionLost'))
    } else {
      setError('')
    }

    // Refresh the match list when returning to home
    loadMatches()
  }, [t, loadMatches])

  // Monitor match status - clear credentials if match becomes final
  useEffect(() => {
    if (match && match.status === 'final') {
      localStorage.removeItem('refereeMatchId')
      localStorage.removeItem('refereePin')
      setMatchId(null)
      setMatch(null)
      setPinInput('')
      setError(t('refereeDashboard.errors.matchEnded'))
    }
  }, [match, t])

  // Hidden test mode - 6 clicks on "No active game found"
  const handleTestModeClick = useCallback(() => {
    if (testModeTimeoutRef.current) {
      clearTimeout(testModeTimeoutRef.current)
    }

    setTestModeClicks(prev => {
      const newCount = prev + 1
      if (newCount >= 6) {
        // Trigger test/master mode
        setIsMasterMode(true)
        setMatchId(-1)
        localStorage.setItem('refereeMasterMode', 'true')
        return 0
      }
      return newCount
    })

    // Reset clicks after 2 seconds of no clicking
    testModeTimeoutRef.current = setTimeout(() => {
      setTestModeClicks(0)
    }, 2000)
  }, [])

  // Show server connection screen first (unless auto-connecting via URL params)
  if (!serverReady) {
    return <ServerConnectionScreen onConnected={handleServerConnected} />
  }

  // Render Referee component if connected (either to match or in master mode)
  if (matchId) {
    return <Referee matchId={matchId} onExit={handleExit} isMasterMode={isMasterMode} />
  }

  return (
    <div style={{
      height: '100dvh',
      width: '100vw',
      maxWidth: '100vw',
      margin: '0 auto',
      overflow: 'hidden',
      background: 'var(--bg)',
      color: 'var(--text)',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      boxSizing: 'border-box'
    }}>
      <UpdateBanner />

      {/* Header */}
      <DashboardHeader
        title={t('refereeDashboard.title')}
        connectionStatuses={connectionStatuses}
        onLoadGames={() => { loadMatches(); checkConnectionStatuses() }}
        loadingMatches={loadingMatches}
        matchCount={availableMatches.length}
        showFullscreen={true}
        isFullscreen={isFullscreen}
        onToggleFullscreen={toggleFullscreen}
        showWakeLock={true}
        wakeLockActive={wakeLockActive}
        onToggleWakeLock={toggleWakeLock}
      />

      {/* Main content */}
      <EntryPage className="overflow-y-auto">
        <EntryCard
          art={<Whistle size={96} className="text-stone-900" />}
          title={t('refereeDashboard.dashboardTitle')}
        >
          {/* Show "no active game" when server is connected but no games available */}
          {serverConnected && availableMatches.length === 0 && !loadingMatches && !linkedMatch ? (
            <div onClick={handleTestModeClick} className="cursor-default select-none">
              <EmptyState
                icon={CalendarX2}
                className="py-6"
                action={
                  <Button
                    variant="secondary"
                    size="xl"
                    icon={RefreshCw}
                    onClick={() => { loadMatches(); checkConnectionStatuses() }}
                    disabled={loadingMatches}
                  >
                    {loadingMatches ? t('common.loading', 'Loading...') : t('refereeDashboard.loadGames', 'Load games')}
                  </Button>
                }
              >
                {t('refereeDashboard.noActiveGame')}
              </EmptyState>
            </div>
          ) : (
          <form onSubmit={handlePinSubmit} className="flex flex-col gap-4 text-left">
            {availableMatches.length > 0 && (
              <div className="flex flex-col gap-3">
                <ListLabel
                  action={
                    <IconButton
                      variant="outline"
                      className="h-11 w-11"
                      icon={loadingMatches ? <Loader2 size={16} className="animate-spin" aria-hidden /> : RefreshCw}
                      label={t('refereeDashboard.loadGames', 'Load games')}
                      onClick={() => { loadMatches(); checkConnectionStatuses() }}
                      disabled={loadingMatches}
                    />
                  }
                >
                  {t('refereeDashboard.selectGame')} ({t('refereeDashboard.gamesAvailable', { count: availableMatches.length })})
                </ListLabel>

                <Button
                  variant="secondary"
                  size="xl"
                  block
                  iconRight={ChevronRight}
                  onClick={() => setShowGameModal(true)}
                  disabled={isLoading}
                >
                  {t('refereeDashboard.selectGame')}
                </Button>

                {selectedGameNumber && (() => {
                  const selected = availableMatches.find(m => String(m.gameNumber) === String(selectedGameNumber))
                  if (!selected) return null

                  return (
                    <RowList framed soft className="rounded-lg">
                      <GameRow
                        match={selected}
                        lang={i18n.language}
                        home={selected.homeTeam}
                        away={selected.awayTeam}
                        gameLabel={t('refereeDashboard.gameNumber', { number: selected.gameNumber })}
                        noDate={selected.dateTime || t('refereeDashboard.tbd')}
                      />
                    </RowList>
                  )
                })()}
              </div>
            )}

            {/* Only show PIN input when offline OR when a game has been selected */}
            {(!serverConnected || linkedMatch || (availableMatches.length > 0 && selectedGameNumber)) && (
              <Field label={t('refereeDashboard.connectionPin')} className="text-left">
                <PinInput
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value.replace(/\D/g, ''))}
                  placeholder="000000"
                  aria-label={t('refereeDashboard.connectionPin')}
                  maxLength={6}
                  disabled={isLoading}
                  invalid={!!error}
                />
              </Field>
            )}

            <FormError size="md" className="text-center">{error}</FormError>

            {(!serverConnected || linkedMatch || (availableMatches.length > 0 && selectedGameNumber)) && (
              <Button type="submit" size="xl" block disabled={isLoading} loading={isLoading}>
                {isLoading ? t('refereeDashboard.connecting') : t('refereeDashboard.enter')}
              </Button>
            )}
          </form>
          )}
        </EntryCard>
      </EntryPage>

      <Modal
        title={t('refereeDashboard.selectGameTitle')}
        open={showGameModal}
        onClose={() => setShowGameModal(false)}
        width={600}
      >
        <div className="ov-kit max-h-[70vh] overflow-y-auto">
          {loadingMatches ? (
            <SkeletonRows rows={3} pill={false} />
          ) : availableMatches.length === 0 ? (
            <EmptyInset className="text-center">{t('refereeDashboard.noAvailableGames')}</EmptyInset>
          ) : (
            <RowList soft>
              {availableMatches.map((m) => (
                <GameRow
                  key={m.id}
                  match={m}
                  lang={i18n.language}
                  home={m.homeTeam}
                  away={m.awayTeam}
                  gameLabel={t('refereeDashboard.gameNumber', { number: m.gameNumber })}
                  noDate={m.dateTime || t('refereeDashboard.tbd')}
                  onOpen={() => handleSelectGame(m.gameNumber)}
                  selectedLabel={selectedGameNumber === String(m.gameNumber) ? t('refereeDashboard.selected', 'Selected') : undefined}
                  status={selectedGameNumber === String(m.gameNumber)
                    ? <Check size={16} className="text-stone-900" aria-hidden />
                    : <ChevronRight size={16} className="text-stone-400" aria-hidden />}
                />
              ))}
            </RowList>
          )}
        </div>
      </Modal>
    </div>
  )
}
