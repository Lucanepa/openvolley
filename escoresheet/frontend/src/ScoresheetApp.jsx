import React, { useState, useEffect, useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db/db'
import { apiFrom, apiStorage } from './lib/apiClient'
import './i18n' // the scoresheet components call useTranslation (own entry, own i18n init)
import App from '../scoresheet_pdf/App_Scoresheet'
import { ArrowLeft, ChevronRight, ClipboardList, FileX2, Lock, LogOut, X } from 'lucide-react'
import { cn } from './ui/cn.js'
import { Card } from './ui/Card.jsx'
import { Button, FOCUS_RING } from './ui/Button.jsx'
import { Field } from './ui/Field.jsx'
import { Input } from './ui/Input.jsx'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { Row, RowList, DateRail } from './ui/Row.jsx'
import { Chip, CountBadge } from './ui/Chip.jsx'
import { EmptyState } from './ui/EmptyState.jsx'
import { GateMessage } from './ui/ErrorScreen.jsx'
import { AppSpinner } from './ui/AppSpinner.jsx'
import { weekdayLabel, dayLabel, timeLabel } from './ui/format.js'
import { scheduledInstant } from './components/dashboards/EntryKit.jsx'
import { describeScoresheetLoadError, findOwnScoresheet, redactScoresheetPath } from '../scoresheet_pdf/utils/scoresheetStorage'
import { BRAND } from './brand'

// Fetch an approved scoresheet (_final file) from cloud storage. Only the
// account that uploaded it may list or read it (backend README "Who can read a
// scoresheet"), and its name has a random part, so it is found by listing the
// date folder. Returns { data } or { error } with the storage error (status,
// code) so the viewer can tell sign-in / not yours / not found apart.
const fetchFromStorage = async (date, game) => {
  try {
    const bucket = apiStorage.from('scoresheets')
    const found = await findOwnScoresheet(bucket, date, game)
    if (found.error) {
      console.warn('[Scoresheet] Storage lookup:', found.error.code || found.error.status, found.error.message)
      return { data: null, error: found.error }
    }
    console.log('[Scoresheet] Fetching from storage:', redactScoresheetPath(found.path))

    const { data, error } = await bucket.download(found.path)

    if (error) {
      console.warn('[Scoresheet] Storage fetch error:', error.code || error.status, error.message)
      return { data: null, error }
    }

    const text = await data.text()
    return { data: JSON.parse(text), error: null }
  } catch (error) {
    console.error('[Scoresheet] Error fetching from storage:', error)
    return { data: null, error: { message: error instanceof Error ? error.message : 'Failed to load scoresheet' } }
  }
}

// Fetch archived matches from Supabase matches table (indoor only, finalized)
const fetchArchiveMatches = async () => {
  try {
    const { data, error } = await apiFrom('matches')
      .select('external_id, game_n, scheduled_at, match_info, home_team, away_team, final_score, winner, created_at')
      .eq('sport_type', 'indoor')
      .eq('status', 'final')
      .eq('test', false)
      .order('scheduled_at', { ascending: false })
      .limit(500)

    if (error) {
      console.error('[Archive] Error fetching matches:', error)
      return []
    }

    return data || []
  } catch (error) {
    console.error('[Archive] Error fetching matches:', error)
    return []
  }
}

// Scoresheets open only for the account that uploaded them (backend README
// "Who can read a scoresheet"). The session is per origin (localStorage), so
// this site signs in on its own; the scorer app's session does not reach it.
const OWNER_ONLY_NOTE = 'Scoresheets open only for the scorer account that uploaded them. Sign in with that account to view or download yours.'

// Email + password sign-in (no sign-up or reset here: an account without
// scoresheets has nothing to open on this site).
const ArchiveSignIn = ({ onDone, autoFocus = false }) => {
  const { signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    const { error: signInError } = await signIn(email.trim(), password)
    setBusy(false)
    if (signInError) {
      setError(signInError.message || 'Sign-in failed')
      return
    }
    setPassword('')
    onDone?.()
  }
  return (
    <form onSubmit={submit} className="space-y-3 text-left" aria-label="Sign in">
      {error && (
        <p role="alert" className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}
      <Field label="Email">
        <Input size="lg" type="email" autoComplete="email" required autoFocus={autoFocus} value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="Password">
        <Input size="lg" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Button variant="hero" block type="submit" loading={busy} disabled={busy}>
        {busy ? 'Signing in...' : 'Sign in'}
      </Button>
    </form>
  )
}

// Signed in: who, and sign out. Anonymous: the sign-in toggle.
const AccountBar = ({ onSignIn, signInOpen }) => {
  const { user, signOut, loading } = useAuth()
  if (loading) return null
  if (user) {
    return (
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1">
        <span className="min-w-0 truncate text-sm text-stone-600" title={user.email}>
          <span className="sr-only">Signed in as </span>{user.email}
        </span>
        <Button variant="secondary" size="xl" className="bg-white" onClick={() => signOut()}>
          <LogOut className="h-4 w-4" aria-hidden /> Sign out
        </Button>
      </div>
    )
  }
  return (
    <Button variant="dark" size="xl" onClick={onSignIn} aria-expanded={signInOpen}>
      <Lock className="h-4 w-4" aria-hidden /> Sign in
    </Button>
  )
}

// Grouping sort orders
const LEVEL_ORDER = { senior: 0, U23: 1, U19: 2 }
const MATCH_TYPE_ORDER = { championship: 0, cup: 1, tournament: 2, friendly: 3 }
const GENDER_ORDER = { men: 0, women: 1 }

// Display labels
const LEVEL_LABELS = { senior: 'Senior', U23: 'U23', U19: 'U19' }
const MATCH_TYPE_LABELS = { championship: 'Championship', cup: 'Cup', tournament: 'Tournament', friendly: 'Friendly' }
const GENDER_LABELS = { men: 'Men', women: 'Women' }

function getSortOrder(map, key) {
  return map[key] !== undefined ? map[key] : 999
}

// Build hierarchical tree: Level > Match Type > Gender > League > Matches
function buildArchiveTree(matches) {
  const tree = {}

  for (const match of matches) {
    const info = match.match_info || {}

    // Level
    const levelKey = info.match_type_3 || 'other'
    const levelLabel = levelKey === 'other' && info.match_type_3_other
      ? info.match_type_3_other
      : (LEVEL_LABELS[levelKey] || levelKey)
    // Use the label as grouping key for custom "other" values
    const levelGroupKey = levelKey === 'other' && info.match_type_3_other
      ? `other_${info.match_type_3_other}`
      : levelKey

    // Match Type
    const mtKey = info.match_type_1 || 'other'
    const mtLabel = mtKey === 'other' && info.match_type_1_other
      ? info.match_type_1_other
      : (MATCH_TYPE_LABELS[mtKey] || mtKey)
    const mtGroupKey = mtKey === 'other' && info.match_type_1_other
      ? `other_${info.match_type_1_other}`
      : mtKey

    // Gender
    const genderKey = info.match_type_2 || 'other'
    const genderLabel = GENDER_LABELS[genderKey] || genderKey

    // League
    const league = info.league || 'Other'

    // Build nested structure
    if (!tree[levelGroupKey]) tree[levelGroupKey] = { label: levelLabel, sortKey: levelKey, children: {} }
    const levelNode = tree[levelGroupKey]

    if (!levelNode.children[mtGroupKey]) levelNode.children[mtGroupKey] = { label: mtLabel, sortKey: mtKey, children: {} }
    const mtNode = levelNode.children[mtGroupKey]

    if (!mtNode.children[genderKey]) mtNode.children[genderKey] = { label: genderLabel, sortKey: genderKey, children: {} }
    const genderNode = mtNode.children[genderKey]

    if (!genderNode.children[league]) genderNode.children[league] = []
    genderNode.children[league].push(match)
  }

  // Convert to sorted arrays
  const sortedTree = Object.entries(tree)
    .sort(([, a], [, b]) => getSortOrder(LEVEL_ORDER, a.sortKey) - getSortOrder(LEVEL_ORDER, b.sortKey))
    .map(([key, level]) => {
      const matchTypes = Object.entries(level.children)
        .sort(([, a], [, b]) => getSortOrder(MATCH_TYPE_ORDER, a.sortKey) - getSortOrder(MATCH_TYPE_ORDER, b.sortKey))
        .map(([mtKey, mt]) => {
          const genders = Object.entries(mt.children)
            .sort(([, a], [, b]) => getSortOrder(GENDER_ORDER, a.sortKey) - getSortOrder(GENDER_ORDER, b.sortKey))
            .map(([gKey, g]) => {
              const leagues = Object.entries(g.children)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([leagueName, leagueMatches]) => ({
                  league: leagueName,
                  matches: leagueMatches.sort((a, b) => {
                    const dateA = a.scheduled_at || a.created_at || ''
                    const dateB = b.scheduled_at || b.created_at || ''
                    return dateB.localeCompare(dateA)
                  })
                }))
              const totalCount = leagues.reduce((sum, l) => sum + l.matches.length, 0)
              return { gender: gKey, genderLabel: g.label, leagues, totalCount }
            })
          const totalCount = genders.reduce((sum, g) => sum + g.totalCount, 0)
          return { type: mtKey, typeLabel: mt.label, genders, totalCount }
        })
      const totalCount = matchTypes.reduce((sum, mt) => sum + mt.totalCount, 0)
      return { level: key, levelLabel: level.label, matchTypes, totalCount }
    })

  return sortedTree
}

// Get URL parameters
const getUrlParams = () => {
  const params = new URLSearchParams(window.location.search)
  const date = params.get('date')
  const game = params.get('game')
  const matchId = params.get('matchId')
  const action = params.get('action') || 'preview'
  return { date, game, matchId, action }
}

// Full-page loading state (kit spinner on the warm stone page).
const PageLoading = ({ label }) => (
  <div className="ov-kit flex min-h-screen items-center justify-center bg-gradient-to-br from-stone-100 via-stone-50 to-stone-100 p-4">
    <AppSpinner label={label} />
  </div>
)

// A list row's text-styled link: the dark lead tool and the outline tool (kit RowTool, as <a>).
const ROW_LINK = cn(
  'inline-flex h-8 flex-1 basis-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-1.5 text-[11px] font-medium transition-colors sm:flex-none sm:basis-auto sm:px-3 sm:text-xs',
  FOCUS_RING,
)

// Collapsible section component for hierarchical grouping
const CollapsibleSection = ({ title, count, depth = 0, defaultOpen = false, children }) => {
  const [isOpen, setIsOpen] = useState(defaultOpen)

  const depthClasses = [
    'text-base font-bold',
    'text-sm font-semibold',
    'text-sm font-medium',
    'text-xs font-medium'
  ]

  return (
    <div className="mb-2" style={{ marginLeft: depth > 0 ? 12 : 0 }}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        className={cn(
          'flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-xl border border-stone-200/70 bg-white px-3 py-2 text-left shadow-card transition-colors hover:bg-stone-50',
          FOCUS_RING,
        )}
      >
        <ChevronRight
          size={16}
          className={cn('shrink-0 text-stone-400 transition-transform duration-200', isOpen && 'rotate-90')}
          aria-hidden
        />
        <span className={cn('min-w-0 text-stone-900', depthClasses[depth] || depthClasses[3])}>{title}</span>
        <CountBadge tone="stone">{count}</CountBadge>
      </button>
      {isOpen && (
        <div className="mt-1">
          {children}
        </div>
      )}
    </div>
  )
}

// One archived match: date rail, home over away, game number and final score chips, view / download tools
const MatchCard = ({ match }) => {
  const homeTeam = match.home_team?.name || 'Team A'
  const awayTeam = match.away_team?.name || 'Team B'
  const finalScore = match.final_score || ''
  const scheduledAt = match.scheduled_at || match.created_at
  const date = scheduledAt ? new Date(scheduledAt).toISOString().slice(0, 10) : null
  const gameNumber = match.game_n || match.external_id
  const when = scheduledInstant(scheduledAt)
  const day = when ? dayLabel(when) : ''

  return (
    <Row
      leading={
        <DateRail
          weekday={day ? weekdayLabel(when, 'en') : undefined}
          date={day || '–'}
          time={day ? timeLabel(when) || undefined : undefined}
        />
      }
      title={
        <div className="min-w-0 text-left">
          <p className="text-sm font-semibold leading-snug break-words text-stone-900 sm:text-[15px]">{homeTeam}</p>
          <p className="text-sm leading-snug break-words text-stone-600 sm:text-[15px]">
            <span className="sr-only">vs </span>{awayTeam}
          </p>
        </div>
      }
      chips={(match.game_n || finalScore) ? (
        <>
          {match.game_n && <Chip>Game {match.game_n}</Chip>}
          {finalScore && <Chip tone="emerald"><span className="tabular-nums">{finalScore}</span></Chip>}
        </>
      ) : undefined}
      tools={date && gameNumber ? (
        <>
          <a
            href={`?date=${date}&game=${gameNumber}`}
            className={cn(ROW_LINK, 'bg-slate-900 text-white hover:bg-slate-800')}
          >
            View
          </a>
          <a
            href={`?date=${date}&game=${gameNumber}&action=save`}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(ROW_LINK, 'border border-stone-300 bg-white text-stone-600 hover:bg-stone-50')}
          >
            Download PDF
          </a>
        </>
      ) : undefined}
    />
  )
}

// Scoresheet viewer component
const ScoresheetViewer = ({ date, game, action }) => {
  const { user, loading: authLoading, signOut } = useAuth()
  const [matchData, setMatchData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const userId = user?.id || null

  useEffect(() => {
    if (authLoading) return
    // No session on this site: storage would only answer 401, so ask for the
    // sign-in straight away (no failing request in the console).
    if (!userId) {
      setError(describeScoresheetLoadError({ status: 401, code: 'missing_token' }, `${date}, game ${game}`))
      setLoading(false)
      return
    }
    let cancelled = false
    const loadData = async () => {
      setLoading(true)
      setError(null)
      try {
        const { data, error: loadError } = await fetchFromStorage(date, game)
        if (cancelled) return
        if (data) {
          setMatchData(data)
        } else {
          setError(describeScoresheetLoadError(loadError, `${date}, game ${game}`))
        }
      } catch (err) {
        if (!cancelled) setError(describeScoresheetLoadError({ message: err instanceof Error ? err.message : undefined }, `${date}, game ${game}`))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    loadData()
    return () => { cancelled = true }
  }, [date, game, userId, authLoading])

  if (loading || authLoading) {
    return <PageLoading label="Loading scoresheet..." />
  }

  const backToList = { label: 'Back to list', icon: <ArrowLeft className="h-4 w-4" />, onClick: () => { window.location.href = window.location.pathname } }

  if (error?.kind === 'signin') {
    return (
      <div className="ov-kit flex min-h-screen items-center justify-center bg-gradient-to-br from-stone-100 via-stone-50 to-stone-100 p-4">
        <div className="w-full max-w-sm rounded-3xl border border-stone-200/70 bg-white p-6 shadow-card-lg sm:p-8">
          <Lock className="mx-auto h-8 w-8 text-red-600" aria-hidden />
          <h1 className="mt-3 text-center text-base font-semibold text-stone-900">Sign in to open this scoresheet</h1>
          <p className="mt-1.5 mb-5 text-center text-sm text-stone-600">{OWNER_ONLY_NOTE}</p>
          <ArchiveSignIn autoFocus />
          <button
            type="button"
            onClick={backToList.onClick}
            className={cn('mt-3 inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg text-sm text-stone-600 transition-colors hover:text-stone-900', FOCUS_RING)}
          >
            <ArrowLeft className="h-4 w-4" aria-hidden /> Back to list
          </button>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="ov-kit">
        <GateMessage
          icon={FileX2}
          title={error.title}
          body={error.message}
          action={backToList}
          secondary={userId && (error.kind === 'forbidden' || error.kind === 'notfound') ? { label: 'Sign in with another account', onClick: () => signOut() } : undefined}
        />
      </div>
    )
  }

  return <App matchData={matchData} autoAction={action} />
}

// Scoresheet list component with hierarchical grouping
const ScoresheetList = () => {
  const { user } = useAuth()
  const [signInOpen, setSignInOpen] = useState(false)
  const [matches, setMatches] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    const loadList = async () => {
      try {
        const items = await fetchArchiveMatches()
        setMatches(items)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load scoresheets')
      } finally {
        setLoading(false)
      }
    }
    loadList()
  }, [])

  const tree = useMemo(() => buildArchiveTree(matches), [matches])

  if (loading) {
    return <PageLoading label="Loading scoresheets..." />
  }

  if (error) {
    return (
      <div className="ov-kit">
        <GateMessage title="Error loading scoresheets" body={error} />
      </div>
    )
  }

  return (
    <div className="ov-kit min-h-screen bg-gradient-to-b from-stone-50 to-stone-100 px-4 py-6 sm:py-8">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <Card className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <img src={BRAND.mark} alt="OpenVolley" className="h-10 w-10 shrink-0" />
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-bold tracking-tight text-stone-900 sm:text-2xl">Scoresheet archive</h1>
            <p className="text-sm text-stone-500">
              {matches.length} scoresheet{matches.length !== 1 ? 's' : ''} available
            </p>
          </div>
          <div className="ml-auto">
            <AccountBar signInOpen={signInOpen} onSignIn={() => setSignInOpen((o) => !o)} />
          </div>
        </Card>

        {!user && (
          <Card>
            <p className="flex items-start gap-2 text-sm text-stone-600">
              <Lock className="mt-0.5 h-4 w-4 shrink-0 text-stone-500" aria-hidden />
              <span>{OWNER_ONLY_NOTE}</span>
            </p>
            {signInOpen && (
              <div className="mt-4 max-w-sm">
                <ArchiveSignIn autoFocus onDone={() => setSignInOpen(false)} />
              </div>
            )}
          </Card>
        )}

        {matches.length === 0 ? (
          <Card>
            <EmptyState icon={ClipboardList}>No scoresheets uploaded yet</EmptyState>
          </Card>
        ) : (
          tree.map(levelGroup => (
            <CollapsibleSection
              key={levelGroup.level}
              title={levelGroup.levelLabel}
              count={levelGroup.totalCount}
              depth={0}
              defaultOpen={tree.length === 1}
            >
              {levelGroup.matchTypes.map(mtGroup => (
                <CollapsibleSection
                  key={mtGroup.type}
                  title={mtGroup.typeLabel}
                  count={mtGroup.totalCount}
                  depth={1}
                  defaultOpen={levelGroup.matchTypes.length === 1}
                >
                  {mtGroup.genders.map(gGroup => (
                    <CollapsibleSection
                      key={gGroup.gender}
                      title={gGroup.genderLabel}
                      count={gGroup.totalCount}
                      depth={2}
                      defaultOpen={mtGroup.genders.length === 1}
                    >
                      {gGroup.leagues.map(lGroup => (
                        <CollapsibleSection
                          key={lGroup.league}
                          title={lGroup.league}
                          count={lGroup.matches.length}
                          depth={3}
                          defaultOpen={gGroup.leagues.length === 1}
                        >
                          <Card pad="list" stack={false} className="mb-2 ml-3">
                            <RowList soft>
                              {lGroup.matches.map(match => (
                                <MatchCard key={match.external_id} match={match} />
                              ))}
                            </RowList>
                          </Card>
                        </CollapsibleSection>
                      ))}
                    </CollapsibleSection>
                  ))}
                </CollapsibleSection>
              ))}
            </CollapsibleSection>
          ))
        )}
      </div>
    </div>
  )
}

// MatchId viewer component - loads from IndexedDB
const MatchIdViewer = ({ matchId, action }) => {
  // Convert matchId to number if it's a numeric string
  const numericMatchId = !isNaN(matchId) ? parseInt(matchId, 10) : matchId

  // Use live queries to get real-time data from IndexedDB
  const match = useLiveQuery(
    async () => {
      if (!numericMatchId) return null
      return await db.matches.get(numericMatchId)
    },
    [numericMatchId]
  )

  const homeTeam = useLiveQuery(
    async () => {
      if (!match?.homeTeamId) return null
      return await db.teams.get(match.homeTeamId)
    },
    [match]
  )

  const awayTeam = useLiveQuery(
    async () => {
      if (!match?.awayTeamId) return null
      return await db.teams.get(match.awayTeamId)
    },
    [match]
  )

  const homePlayers = useLiveQuery(
    async () => {
      if (!match?.homeTeamId) return []
      return await db.players.where('teamId').equals(match.homeTeamId).toArray()
    },
    [match]
  )

  const awayPlayers = useLiveQuery(
    async () => {
      if (!match?.awayTeamId) return []
      return await db.players.where('teamId').equals(match.awayTeamId).toArray()
    },
    [match]
  )

  const sets = useLiveQuery(
    async () => {
      if (!numericMatchId) return []
      return await db.sets.where('matchId').equals(numericMatchId).sortBy('index')
    },
    [numericMatchId]
  )

  const events = useLiveQuery(
    async () => {
      if (!numericMatchId) return []
      return await db.events.where('matchId').equals(numericMatchId).sortBy('seq')
    },
    [numericMatchId]
  )

  // Show loading state while initial data is being fetched
  if (match === undefined) {
    return <PageLoading label="Loading scoresheet..." />
  }

  if (match === null) {
    return (
      <div className="ov-kit">
        <GateMessage
          icon={FileX2}
          title="Match not found"
          body={`Match ID: ${matchId}`}
          action={{ label: 'Close window', icon: <X className="h-4 w-4" />, onClick: () => window.close() }}
        />
      </div>
    )
  }

  // Build match data from live queries
  const matchData = {
    match: match || {},
    homeTeam: homeTeam || null,
    awayTeam: awayTeam || null,
    homePlayers: homePlayers || [],
    awayPlayers: awayPlayers || [],
    sets: sets || [],
    events: events || [],
    sanctions: []
  }

  return <App matchData={matchData} autoAction={action} />
}

// Main app component
export default function ScoresheetApp() {
  return (
    <AuthProvider>
      <ScoresheetRoutes />
    </AuthProvider>
  )
}

function ScoresheetRoutes() {
  const { date, game, matchId, action } = getUrlParams()

  // Priority: 1. matchId (from local IndexedDB), 2. date+game (from Supabase storage), 3. list
  if (matchId) {
    return <MatchIdViewer matchId={matchId} action={action} />
  }

  // If date and game are provided, show the scoresheet viewer (from Supabase)
  if (date && game) {
    return <ScoresheetViewer date={date} game={game} action={action} />
  }

  // Otherwise show the list
  return <ScoresheetList />
}
