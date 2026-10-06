import { useState, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from './Modal'
import { getCloudApiUrl } from '../utils/backendConfig'
import { useAlert } from '../contexts/AlertContext'
import { useScaledLayout } from '../hooks/useScaledLayout'
import { apiFrom } from '../lib/apiClient'
import { AlertTriangle, Loader2, Search, X } from 'lucide-react'
import { cn, FOCUS_RING, IconButton } from '../ui'

// Kit recipes: native select at h-11 (tablet), compact label, filter pills
// (slate when on), sticky table head.
const SELECT_CLS = 'h-11 min-w-[8rem] rounded-xl border border-stone-300 bg-white px-3 text-sm text-stone-800 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:cursor-not-allowed disabled:opacity-50'
const LABEL_CLS = 'mb-1 block text-xs font-medium text-stone-500'
const PILL_CLS = 'shrink-0 h-9 px-3.5 rounded-full border text-xs font-medium whitespace-nowrap transition-colors'
const PILL_ON = 'bg-slate-900 border-slate-900 text-white'
const PILL_OFF = 'bg-white border-stone-200 text-stone-600 hover:bg-stone-100'

// Styles will be generated dynamically with scaleFactor

/**
 * Format league code for display
 * - ZCM/ZCD -> "Züri Cup (♂/♀)"
 * - Other leagues: replace M/D suffix with (♂/♀)
 */
function formatLeagueDisplay(code, gender) {
  const genderSymbol = gender === 'men' ? '♂' : '♀'

  // Handle Züri Cup
  if (code.startsWith('ZC')) {
    return `Züri Cup (${genderSymbol})`
  }

  // Display code as-is with gender symbol
  return `${code} (${genderSymbol})`
}

/**
 * Format ISO date string to DD.MM.YYYY
 */
function formatDisplayDate(isoString) {
  if (!isoString) return ''
  const date = new Date(isoString)
  const day = String(date.getDate()).padStart(2, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const year = date.getFullYear()
  return `${day}.${month}.${year}`
}

/**
 * Format ISO date string to HH:MM
 */
function formatDisplayTime(isoString) {
  if (!isoString) return ''
  const date = new Date(isoString)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

/**
 * Convert ISO string to local date (YYYY-MM-DD) for input
 */
function toLocalDate(isoString) {
  if (!isoString) return ''
  const date = new Date(isoString)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Convert ISO string to local time (HH:MM) for input
 */
function toLocalTime(isoString) {
  if (!isoString) return ''
  const date = new Date(isoString)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

/**
 * Check if a date is today (local time)
 */
function isToday(isoString) {
  if (!isoString) return false
  const date = new Date(isoString)
  const today = new Date()
  return date.getDate() === today.getDate() &&
         date.getMonth() === today.getMonth() &&
         date.getFullYear() === today.getFullYear()
}

/**
 * Check if a date is tomorrow (local time)
 */
function isTomorrow(isoString) {
  if (!isoString) return false
  const date = new Date(isoString)
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  return date.getDate() === tomorrow.getDate() &&
         date.getMonth() === tomorrow.getMonth() &&
         date.getFullYear() === tomorrow.getFullYear()
}

/**
 * Map a svrz_games row to the internal match format
 */
function mapSupabaseToMatchFormat(row) {
  return {
    gameN: row.game_number,
    dtstart: row.datetime,
    home: row.team_home,
    away: row.team_away,
    league: row.league,
    venue: row.hall,
    city: row.city,
    type1: row.match_type,
    type2: row.gender,
    type3: row.match_level,
    championshipType: row.championship_type,
    bestOf: row.match_format,
    referee1First: row.referee_1_first_name,
    referee1Last: row.referee_1_last_name,
    referee1Dob: row.referee_1_dob,
    referee2First: row.referee_2_first_name,
    referee2Last: row.referee_2_last_name,
    referee2Dob: row.referee_2_dob,
    hallAddress: row.hall_address,
    hallPostalCode: row.hall_postal_code,
    linesman1: row.linesman_1,
    linesman2: row.linesman_2,
    groupDisplay: row.group_display
  }
}

export default function LoadOfficialMatchModal({ open, onClose, onSelectMatch }) {
  const { t } = useTranslation()
  const { showAlert } = useAlert()
  const { scaleFactor } = useScaledLayout()


  // Dynamic leagues
  const [allLeagues, setAllLeagues] = useState([])
  const [loadingConfig, setLoadingConfig] = useState(false)
  const [dataSource, setDataSource] = useState(null) // 'supabase' | 'ical' | null

  // Filter state (simplified: just gender and league)
  const [gender, setGender] = useState('')
  const [league, setLeague] = useState('')

  // Search and date filter state
  const [searchQuery, setSearchQuery] = useState('')
  const [dateFilter, setDateFilter] = useState('') // '' | 'today' | 'tomorrow'

  // Data state
  const [matches, setMatches] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // Warning popover for league dropdown
  const [showLeagueWarning, setShowLeagueWarning] = useState(false)
  const leagueWarningRef = useRef(null)

  // Dismiss league warning on click outside
  useEffect(() => {
    if (!showLeagueWarning) return
    const handler = (e) => {
      if (leagueWarningRef.current && !leagueWarningRef.current.contains(e.target)) {
        setShowLeagueWarning(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showLeagueWarning])

  // Fetch available leagues when modal opens
  useEffect(() => {
    if (!open) return
    fetchLeaguesConfig()
  }, [open])

  const fetchLeaguesFromSupabase = async () => {
    const { data, error } = await apiFrom('svrz_games')
      .select('gender, league')
    if (error) throw error
    if (!data || data.length === 0) return null
    // Deduplicate gender+league pairs
    const seen = new Set()
    const leagues = []
    for (const row of data) {
      const key = `${row.gender}-${row.league}`
      if (!seen.has(key)) {
        seen.add(key)
        leagues.push({ code: row.league, gender: row.gender, federation: 'SVRZ' })
      }
    }
    // Sort: men first, then alphabetical by code
    leagues.sort((a, b) => {
      if (a.gender !== b.gender) return a.gender === 'men' ? -1 : 1
      return a.code.localeCompare(b.code)
    })
    return leagues
  }

  const fetchLeaguesFromIcal = async () => {
    const apiUrl = getCloudApiUrl('/api/official-matches/leagues')
    if (!apiUrl) return null
    const response = await fetch(apiUrl)
    const data = await response.json()
    if (data.success) return data.leagues || []
    return null
  }

  const fetchLeaguesConfig = async () => {
    setLoadingConfig(true)
    setError(null)
    try {
      // Try Supabase first
      const supabaseLeagues = await fetchLeaguesFromSupabase()
      if (supabaseLeagues && supabaseLeagues.length > 0) {
        setAllLeagues(supabaseLeagues)
        setDataSource('supabase')
        setLoadingConfig(false)
        return
      }
      console.warn('[Schedule] Supabase unavailable or returned no leagues, falling back to ICAL')
    } catch (err) {
      console.warn('[Schedule] Supabase failed, falling back to ICAL:', err)
    }
    // Fallback to ICAL
    try {
      const icalLeagues = await fetchLeaguesFromIcal()
      if (icalLeagues && icalLeagues.length > 0) {
        setAllLeagues(icalLeagues)
        setDataSource('ical')
      } else {
        setError(t('loadOfficialMatch.backendNotAvailable', 'Backend server not available'))
      }
    } catch (err) {
      console.error('[Schedule] ICAL fallback also failed:', err)
      setError(t('loadOfficialMatch.fetchError', 'Failed to load matches. Check your connection.'))
    } finally {
      setLoadingConfig(false)
    }
  }

  // Derive available leagues for selected gender
  const availableLeagues = useMemo(() => {
    if (!gender) return []
    return allLeagues.filter(l => l.gender === gender)
  }, [allLeagues, gender])

  // Reset league when gender changes
  useEffect(() => {
    setLeague('')
    setMatches([])
    setError(null)
  }, [gender])

  // Fetch matches when league is selected
  useEffect(() => {
    if (!league) return
    fetchMatches()
  }, [league])

  const fetchMatchesFromSupabase = async () => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const { data, error } = await apiFrom('svrz_games')
      .select('*')
      .eq('gender', gender)
      .eq('league', league)
      .gte('datetime', today.toISOString())
      .order('datetime', { ascending: true })
    if (error) throw error
    if (!data || data.length === 0) return null
    return data.map(mapSupabaseToMatchFormat)
  }

  const fetchMatchesFromIcal = async () => {
    const leagueInfo = allLeagues.find(l => l.code === league)
    if (!leagueInfo) return null
    const apiUrl = getCloudApiUrl(`/api/official-matches?federation=${leagueInfo.federation}&league=${league}`)
    if (!apiUrl) return null
    const response = await fetch(apiUrl)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    if (data.success) return data.matches || []
    return null
  }

  const fetchMatches = async () => {
    setLoading(true)
    setError(null)

    // Try API first if it was our leagues source (or try anyway)
    {
      try {
        const supabaseMatches = await fetchMatchesFromSupabase()
        if (supabaseMatches && supabaseMatches.length > 0) {
          setMatches(supabaseMatches)
          setLoading(false)
          return
        }
        console.warn(`[Schedule] Supabase returned no matches for ${gender}/${league}, falling back to ICAL`)
      } catch (err) {
        console.warn(`[Schedule] Supabase match query failed for ${gender}/${league}, falling back to ICAL:`, err)
      }
    }

    // Fallback to ICAL
    try {
      const icalMatches = await fetchMatchesFromIcal()
      if (icalMatches) {
        setMatches(icalMatches)
      } else {
        setError(t('loadOfficialMatch.backendNotAvailable', 'Backend server not available'))
      }
    } catch (err) {
      console.error('[Schedule] ICAL fallback also failed:', err)
      setError(t('loadOfficialMatch.fetchError', 'Failed to load matches. Check your connection.'))
    } finally {
      setLoading(false)
    }
  }

  // Filter matches by search query and date
  const filteredMatches = useMemo(() => {
    let result = matches

    // Apply date filter
    if (dateFilter === 'today') {
      result = result.filter(m => isToday(m.dtstart))
    } else if (dateFilter === 'tomorrow') {
      result = result.filter(m => isTomorrow(m.dtstart))
    }

    // Apply search filter (search in home/away team names, game number, and date)
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim()
      result = result.filter(m =>
        m.home?.toLowerCase().includes(query) ||
        m.away?.toLowerCase().includes(query) ||
        m.gameN?.toLowerCase().includes(query) ||
        formatDisplayDate(m.dtstart).toLowerCase().includes(query)
      )
    }

    return result
  }, [matches, searchQuery, dateFilter])

  const handleSelectMatch = (match) => {
    const matchData = {
      // Date/Time - convert to local formats for inputs
      date: toLocalDate(match.dtstart),
      time: toLocalTime(match.dtstart),

      // Location
      city: match.city,
      hall: match.venue,

      // Match type
      type1: match.type1,
      championshipType: match.championshipType,
      type2: match.type2,
      type3: match.type3,

      // Game details
      gameN: match.gameN,
      league: match.league,

      // Teams
      home: match.home,
      away: match.away,

      // Supabase-only fields (undefined when source is ICAL)
      bestOf: match.bestOf,
      referee1First: match.referee1First,
      referee1Last: match.referee1Last,
      referee1Dob: match.referee1Dob,
      referee2First: match.referee2First,
      referee2Last: match.referee2Last,
      referee2Dob: match.referee2Dob,
      linesman1: match.linesman1,
      linesman2: match.linesman2,
      groupDisplay: match.groupDisplay
    }

    onSelectMatch(matchData)
    onClose()

    // Show reminder alert after modal closes
    setTimeout(() => {
      showAlert(t('loadOfficialMatch.reminderAlert', 'Set teams colours and team short names'), 'info')
    }, 100)
  }

  // Reset state when modal closes
  useEffect(() => {
    if (!open) {
      setGender('')
      setLeague('')
      setMatches([])
      setError(null)
      setSearchQuery('')
      setDateFilter('')
      setDataSource(null)
    }
  }, [open])

  const gridColumns = `${Math.round(80 * scaleFactor)}px ${Math.round(90 * scaleFactor)}px ${Math.round(55 * scaleFactor)}px 1fr`

  return (
    <Modal
      title=""
      open={open}
      onClose={onClose}
      width={650}
      hideCloseButton={true}
    >
      <div className="ov-kit text-stone-800">
      {/* Sticky Header */}
      <div className="sticky -top-4 z-10 mb-4 flex items-center justify-between gap-3 border-b border-stone-200/70 bg-white py-2">
        <h2 className="text-lg font-bold text-stone-900">
          {t('loadOfficialMatch.title', 'Load match from schedule')}
        </h2>
        <IconButton variant="close" icon={X} label={t('common.close', 'Close')} onClick={onClose} />
      </div>

      {/* Filters - 2 Dropdowns */}
      <div className="mb-4">
        {loadingConfig ? (
          <div className="flex items-center gap-2 text-sm text-stone-500">
            <Loader2 size={14} className="animate-spin text-stone-400" aria-hidden="true" />
            {t('loadOfficialMatch.loading', 'Loading...')}
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-3 stack:flex-col stack:items-stretch">
            {/* Gender Dropdown */}
            <div>
              <label className={LABEL_CLS}>{t('loadOfficialMatch.gender', 'Gender')}</label>
              <select
                value={gender}
                onChange={e => setGender(e.target.value)}
                aria-label={t('loadOfficialMatch.gender', 'Gender')}
                className={cn(SELECT_CLS, 'stack:w-full')}
              >
                <option value="">{t('loadOfficialMatch.selectGender', 'Select...')}</option>
                <option value="men">{t('matchSetup.men', 'Men')} ♂</option>
                <option value="women">{t('matchSetup.women', 'Women')} ♀</option>
              </select>
            </div>

            {/* League Dropdown */}
            <div>
              <label className={LABEL_CLS}>{t('loadOfficialMatch.league', 'League')}</label>
              <div className="flex items-center">
                <select
                  value={league}
                  onChange={e => setLeague(e.target.value)}
                  aria-label={t('loadOfficialMatch.league', 'League')}
                  className={cn(SELECT_CLS, 'stack:min-w-0 stack:flex-1')}
                  disabled={!gender}
                >
                  <option value="">{t('loadOfficialMatch.selectLeague', 'Select...')}</option>
                  {availableLeagues.map(l => (
                    <option key={l.code} value={l.code}>{formatLeagueDisplay(l.code, l.gender)}</option>
                  ))}
                </select>
                {!gender && (
                  <span
                    ref={showLeagueWarning ? leagueWarningRef : undefined}
                    className="relative ml-1.5 inline-flex"
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        setShowLeagueWarning(v => !v)
                      }}
                      aria-expanded={showLeagueWarning}
                      aria-label={t('warnings.clickForDetails')}
                      className={cn('inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full stack:h-11 stack:w-11 text-amber-600 transition-colors hover:bg-amber-50', FOCUS_RING)}
                      title={t('warnings.clickForDetails')}
                    >
                      <AlertTriangle size={18} aria-hidden="true" />
                    </button>
                    {showLeagueWarning && (
                      <div
                        onClick={(e) => e.stopPropagation()}
                        className="absolute right-0 top-full z-40 mt-2 max-w-[90vw] whitespace-nowrap rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800 shadow-xl"
                      >
                        {t('warnings.selectGenderFirst')}
                      </div>
                    )}
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Selection Path - shown when selections are made */}
        {gender && (
          <div className="mt-3 border-t border-stone-100 pt-2.5">
            <div className="flex items-center gap-2 text-sm text-stone-700">
              <span>
                {gender === 'men' ? `${t('matchSetup.men', 'Men')} ♂` : `${t('matchSetup.women', 'Women')} ♀`}
              </span>
              {league && (
                <>
                  <span className="text-stone-300">·</span>
                  <span className="font-semibold text-stone-900">{formatLeagueDisplay(league, gender)}</span>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Search and Date Filters - shown when matches are loaded */}
      {matches.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-3 stack:flex-col stack:items-stretch">
          {/* Search Input */}
          <div className="relative min-w-[150px] flex-1">
            <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-stone-400" aria-hidden="true" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder={t('loadOfficialMatch.searchPlaceholder', 'Search...')}
              aria-label={t('loadOfficialMatch.searchPlaceholder', 'Search...')}
              className="h-11 w-full rounded-xl border border-stone-200 bg-white pl-10 pr-3 text-sm text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-red-700/20 focus:border-red-700/40"
            />
          </div>

          {/* Date Filter Buttons */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              aria-pressed={dateFilter === 'today'}
              onClick={() => setDateFilter(dateFilter === 'today' ? '' : 'today')}
              className={cn(PILL_CLS, dateFilter === 'today' ? PILL_ON : PILL_OFF, 'h-11', FOCUS_RING)}
            >
              {t('loadOfficialMatch.today', 'Today')}
            </button>
            <button
              type="button"
              aria-pressed={dateFilter === 'tomorrow'}
              onClick={() => setDateFilter(dateFilter === 'tomorrow' ? '' : 'tomorrow')}
              className={cn(PILL_CLS, dateFilter === 'tomorrow' ? PILL_ON : PILL_OFF, 'h-11', FOCUS_RING)}
            >
              {t('loadOfficialMatch.tomorrow', 'Tomorrow')}
            </button>
            {dateFilter && (
              <IconButton
                variant="close"
                icon={X}
                label={t('loadOfficialMatch.clearFilter', 'Clear filter')}
                onClick={() => setDateFilter('')}
              />
            )}
          </div>
        </div>
      )}

      {/* Matches Table */}
      <div className="max-h-[350px] overflow-y-auto rounded-lg border border-stone-200 empty:border-0">
        {loading && (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-sm text-stone-500">
            <Loader2 size={20} className="animate-spin text-stone-400" aria-hidden="true" />
            {t('loadOfficialMatch.loading', 'Loading matches...')}
          </div>
        )}

        {error && (
          <div role="alert" className="m-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-center text-sm text-red-700">
            {error}
          </div>
        )}

        {!loading && !error && league && matches.length === 0 && (
          <div className="px-4 py-10 text-center text-sm font-medium text-stone-500">
            {t('loadOfficialMatch.noUpcomingMatches', 'No upcoming matches found')}
          </div>
        )}

        {!loading && !error && matches.length > 0 && filteredMatches.length === 0 && (
          <div className="px-4 py-10 text-center text-sm font-medium text-stone-500">
            {t('loadOfficialMatch.noMatchesForFilter', 'No matches found for this filter')}
          </div>
        )}

        {!loading && !error && filteredMatches.length > 0 && (
          <div className="divide-y divide-stone-100">
            {/* Table Header */}
            <div
              className="sticky top-0 z-10 grid items-center gap-2 border-b border-stone-200 bg-stone-50 px-2.5 py-2 text-[11px] font-bold uppercase tracking-wide text-stone-500"
              style={{ gridTemplateColumns: gridColumns }}
            >
              <span className="text-center">{t('loadOfficialMatch.gameN', 'Game #')}</span>
              <span className="text-center">{t('loadOfficialMatch.date', 'Date')}</span>
              <span className="text-center">{t('loadOfficialMatch.time', 'Time')}</span>
              <span>{t('loadOfficialMatch.homeVsAway', 'Home vs away')}</span>
            </div>

            {/* Table Rows */}
            {filteredMatches.map((match) => (
              <div
                key={match.gameN}
                onClick={() => handleSelectMatch(match)}
                className="grid min-h-11 cursor-pointer items-center gap-2 px-2.5 py-2 text-xs tabular-nums text-stone-800 transition-colors hover:bg-stone-50"
                style={{ gridTemplateColumns: gridColumns }}
              >
                <span className="text-center font-semibold">
                  {match.gameN}
                </span>
                <span className="text-center">
                  {formatDisplayDate(match.dtstart)}
                </span>
                <span className="text-center">
                  {formatDisplayTime(match.dtstart)}
                </span>
                <span className="truncate">
                  <span className="font-semibold text-stone-900">{match.home}</span>
                  <span className="mx-1.5 text-stone-400">{t('common.vs', 'vs')}</span>
                  <span className="font-semibold text-stone-900">{match.away}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      </div>
    </Modal>
  )
}
