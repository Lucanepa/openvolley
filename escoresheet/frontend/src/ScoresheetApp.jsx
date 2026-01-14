import React, { useState, useEffect } from 'react'
import { supabase } from './lib/supabaseClient'
import App from '../scoresheet_pdf/App_Scoresheet'

// Fetch scoresheet data from Supabase storage
const fetchFromStorage = async (date, game) => {
  try {
    if (!supabase) {
      console.error('Supabase client not available')
      return null
    }

    const storagePath = `${date}/game${game}.json`
    console.log('[Scoresheet] Fetching from storage:', storagePath)

    const { data, error } = await supabase.storage
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

// Fetch all scoresheets from storage
const fetchAllScoresheets = async () => {
  try {
    if (!supabase) {
      console.error('Supabase client not available')
      return []
    }

    // List all folders (dates) in the scoresheets bucket
    const { data: folders, error: foldersError } = await supabase.storage
      .from('scoresheets')
      .list('', { limit: 100, sortBy: { column: 'name', order: 'desc' } })

    if (foldersError) {
      console.error('[Scoresheet] Error listing folders:', foldersError)
      return []
    }

    const scoresheets = []

    // For each date folder, list the game files
    for (const folder of folders || []) {
      if (!folder.name || folder.name.startsWith('.')) continue

      const { data: files, error: filesError } = await supabase.storage
        .from('scoresheets')
        .list(folder.name, { limit: 50 })

      if (filesError) {
        console.error(`[Scoresheet] Error listing files in ${folder.name}:`, filesError)
        continue
      }

      for (const file of files || []) {
        if (!file.name.endsWith('.json')) continue

        // Extract game number from filename (game123.json -> 123)
        const gameMatch = file.name.match(/game(\d+)\.json/)
        if (!gameMatch) continue

        scoresheets.push({
          date: folder.name,
          game: gameMatch[1],
          path: `${folder.name}/${file.name}`
        })
      }
    }

    // Fetch metadata for each scoresheet (team names, score)
    const enrichedScoresheets = await Promise.all(
      scoresheets.slice(0, 50).map(async (item) => {
        try {
          const { data, error } = await supabase.storage
            .from('scoresheets')
            .download(item.path)

          if (error || !data) return item

          const text = await data.text()
          const json = JSON.parse(text)

          return {
            ...item,
            homeTeam: json.homeTeam?.name || json.match?.homeTeamName || 'Team A',
            awayTeam: json.awayTeam?.name || json.match?.awayTeamName || 'Team B',
            finalScore: json.match?.final_score || '',
            uploadedAt: json.uploadedAt
          }
        } catch {
          return item
        }
      })
    )

    return enrichedScoresheets
  } catch (error) {
    console.error('[Scoresheet] Error fetching scoresheets:', error)
    return []
  }
}

// Get URL parameters
const getUrlParams = () => {
  const params = new URLSearchParams(window.location.search)
  const date = params.get('date')
  const game = params.get('game')
  const action = params.get('action') || 'preview'
  return { date, game, action }
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
          setError(`Scoresheet not found: ${date}/game${game}.json`)
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

// Scoresheet list component
const ScoresheetList = () => {
  const [scoresheets, setScoresheets] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    const loadList = async () => {
      try {
        const items = await fetchAllScoresheets()
        setScoresheets(items)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load scoresheets')
      } finally {
        setLoading(false)
      }
    }
    loadList()
  }, [])

  // Group scoresheets by date
  const groupedByDate = scoresheets.reduce((acc, item) => {
    if (!acc[item.date]) acc[item.date] = []
    acc[item.date].push(item)
    return acc
  }, {})

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
          <img src="/openvolley_no_bg.png" alt="OpenVolley" className="w-12 h-12" />
          <div>
            <h1 className="text-2xl font-bold text-gray-800">Scoresheet Archive</h1>
            <p className="text-gray-500">
              {scoresheets.length} scoresheet{scoresheets.length !== 1 ? 's' : ''} available
            </p>
          </div>
        </div>

        {scoresheets.length === 0 ? (
          <div className="text-center py-16 bg-white rounded-xl border border-gray-200">
            <div className="text-5xl mb-4">📋</div>
            <div className="text-lg text-gray-500">No scoresheets uploaded yet</div>
          </div>
        ) : (
          Object.entries(groupedByDate)
            .sort(([a], [b]) => b.localeCompare(a))
            .map(([date, items]) => (
              <div key={date} className="mb-6">
                <h2 className="text-sm font-semibold text-gray-500 mb-3 pb-2 border-b border-gray-200">
                  {formatDate(date)}
                </h2>
                <div className="flex flex-col gap-2">
                  {items
                    .sort((a, b) => parseInt(a.game) - parseInt(b.game))
                    .map((item) => (
                      <div
                        key={item.path}
                        className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200 hover:shadow-md transition-shadow"
                      >
                        <div className="flex-1">
                          <div className="flex items-center gap-3 mb-1">
                            <span className="text-xs font-semibold text-blue-600 bg-blue-50 px-2 py-0.5 rounded">
                              Game {item.game}
                            </span>
                            {item.finalScore && (
                              <span className="text-sm font-semibold text-emerald-600">
                                {item.finalScore}
                              </span>
                            )}
                          </div>
                          <div className="text-base font-medium text-gray-800">
                            {item.homeTeam || 'Team A'} vs {item.awayTeam || 'Team B'}
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <a
                            href={`?date=${item.date}&game=${item.game}`}
                            className="px-4 py-2 text-sm font-medium bg-blue-500 text-white rounded-md hover:bg-blue-600"
                          >
                            View
                          </a>
                          <a
                            href={`?date=${item.date}&game=${item.game}&action=save`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="px-4 py-2 text-sm font-medium bg-gray-100 text-gray-600 border border-gray-200 rounded-md hover:bg-gray-200"
                          >
                            Download PDF
                          </a>
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            ))
        )}
      </div>
    </div>
  )
}

// Main app component
export default function ScoresheetApp() {
  const { date, game, action } = getUrlParams()

  // If date and game are provided, show the scoresheet viewer
  if (date && game) {
    return <ScoresheetViewer date={date} game={game} action={action} />
  }

  // Otherwise show the list
  return <ScoresheetList />
}
