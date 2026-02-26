import React, { useState, useEffect, useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db/db'
import { apiFrom, apiStorage } from './lib/apiClient'
import App from '../scoresheet_pdf/App_Scoresheet'

// Fetch scoresheet data from Supabase storage (only _final files)
const fetchFromStorage = async (date, game) => {
  try {
    const storagePath = `${date}/game${game}_final.json`
    console.log('[Scoresheet] Fetching from storage:', storagePath)

    const { data, error } = await apiStorage
      .from('scoresheets')
      .download(storagePath)

    if (error) {
      console.error('[Scoresheet] Storage fetch error:', error)
      return null
    }

    const text = await data.text()
    return JSON.parse(text)
  } catch (error) {
    console.error('[Scoresheet] Error fetching from storage:', error)
    return null
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

// Format date for display
const formatDate = (dateStr) => {
  try {
    const date = new Date(dateStr + 'T12:00:00')
    return date.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    })
  } catch {
    return dateStr
  }
}

// Collapsible section component for hierarchical grouping
const CollapsibleSection = ({ title, count, depth = 0, defaultOpen = false, children }) => {
  const [isOpen, setIsOpen] = useState(defaultOpen)

  const depthClasses = [
    'text-base font-bold',
    'text-sm font-semibold',
    'text-sm font-medium',
    'text-xs font-medium'
  ]

  const depthBorderColors = [
    'border-l-blue-500',
    'border-l-indigo-400',
    'border-l-violet-400',
    'border-l-purple-300'
  ]

  return (
    <div className="mb-2" style={{ marginLeft: depth > 0 ? 12 : 0 }}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`w-full flex items-center justify-between p-3 bg-white rounded-lg border border-gray-200 border-l-4 ${depthBorderColors[depth] || depthBorderColors[3]} hover:bg-gray-50 transition-colors cursor-pointer`}
      >
        <div className="flex items-center gap-2">
          <span
            className="text-gray-400 text-xs transition-transform duration-200"
            style={{ display: 'inline-block', transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
          >
            &#9654;
          </span>
          <span className={`text-gray-800 ${depthClasses[depth] || depthClasses[3]}`}>{title}</span>
          <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">{count}</span>
        </div>
      </button>
      {isOpen && (
        <div className="mt-1">
          {children}
        </div>
      )}
    </div>
  )
}

// Match card component for individual matches
const MatchCard = ({ match }) => {
  const homeTeam = match.home_team?.name || 'Team A'
  const awayTeam = match.away_team?.name || 'Team B'
  const finalScore = match.final_score || ''
  const scheduledAt = match.scheduled_at || match.created_at
  const date = scheduledAt ? new Date(scheduledAt).toISOString().slice(0, 10) : null
  const gameNumber = match.game_n || match.external_id
  const displayDate = scheduledAt ? formatDate(new Date(scheduledAt).toISOString().slice(0, 10)) : ''

  return (
    <div
      className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200 hover:shadow-md transition-shadow mb-2"
      style={{ marginLeft: 12 }}
    >
      <div className="flex-1">
        <div className="flex items-center gap-3 mb-1">
          {match.game_n && (
            <span className="text-xs font-semibold text-blue-600 bg-blue-50 px-2 py-0.5 rounded">
              Game {match.game_n}
            </span>
          )}
          {finalScore && (
            <span className="text-sm font-semibold text-emerald-600">{finalScore}</span>
          )}
        </div>
        <div className="text-base font-medium text-gray-800">
          {homeTeam} vs {awayTeam}
        </div>
        {displayDate && (
          <div className="text-xs text-gray-400 mt-1">{displayDate}</div>
        )}
      </div>
      <div className="flex gap-2">
        {date && gameNumber && (
          <>
            <a
              href={`?date=${date}&game=${gameNumber}`}
              className="px-4 py-2 text-sm font-medium bg-blue-500 text-white rounded-md hover:bg-blue-600"
            >
              View
            </a>
            <a
              href={`?date=${date}&game=${gameNumber}&action=save`}
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 text-sm font-medium bg-gray-100 text-gray-600 border border-gray-200 rounded-md hover:bg-gray-200"
            >
              Download PDF
            </a>
          </>
        )}
      </div>
    </div>
  )
}

// Scoresheet viewer component
const ScoresheetViewer = ({ date, game, action }) => {
  const [matchData, setMatchData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    const loadData = async () => {
      try {
        const data = await fetchFromStorage(date, game)
        if (data) {
          setMatchData(data)
        } else {
          setError(`Scoresheet not found: ${date}/game${game}_final.json`)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load scoresheet')
      } finally {
        setLoading(false)
      }
    }
    loadData()
  }, [date, game])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-lg text-gray-600">Loading scoresheet...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-5">
        <div className="text-2xl font-bold text-red-500">Scoresheet Not Found</div>
        <div className="text-gray-600">{error}</div>
        <button
          onClick={() => window.location.href = '/'}
          className="px-5 py-2.5 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
        >
          Back to List
        </button>
      </div>
    )
  }

  return <App matchData={matchData} autoAction={action} />
}

// Scoresheet list component with hierarchical grouping
const ScoresheetList = () => {
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
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-lg text-gray-600">Loading scoresheets...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-5">
        <div className="text-2xl font-bold text-red-500">Error Loading Scoresheets</div>
        <div className="text-gray-600">{error}</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 p-5">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-4 mb-6">
          <img src={`${import.meta.env.BASE_URL}openvolley_no_bg.png`} alt="OpenVolley" className="w-12 h-12" />
          <div>
            <h1 className="text-2xl font-bold text-gray-800">Scoresheet Archive</h1>
            <p className="text-gray-500">
              {matches.length} scoresheet{matches.length !== 1 ? 's' : ''} available
            </p>
          </div>
        </div>

        {matches.length === 0 ? (
          <div className="text-center py-16 bg-white rounded-xl border border-gray-200">
            <div className="text-5xl mb-4">📋</div>
            <div className="text-lg text-gray-500">No scoresheets uploaded yet</div>
          </div>
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
                          {lGroup.matches.map(match => (
                            <MatchCard key={match.external_id} match={match} />
                          ))}
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
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-lg text-gray-600">Loading scoresheet...</div>
      </div>
    )
  }

  if (match === null) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-5">
        <div className="text-2xl font-bold text-red-500">Match Not Found</div>
        <div className="text-gray-600">Match ID: {matchId}</div>
        <button
          onClick={() => window.close()}
          className="px-5 py-2.5 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
        >
          Close Window
        </button>
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
