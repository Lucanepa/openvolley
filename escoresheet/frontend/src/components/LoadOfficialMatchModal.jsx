import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from './Modal'
import { getApiUrl } from '../utils/backendConfig'
import { useAlert } from '../contexts/AlertContext'
import { useScaledLayout } from '../hooks/useScaledLayout'

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

  // For codes ending in M or D (men/damen) like 1LM, 2LD, 3LM
  if (code.endsWith('M') || code.endsWith('D')) {
    return `${code.slice(0, -1)} (${genderSymbol})`
  }

  // For codes like U23D-1, U23D-2, etc.
  const match = code.match(/^(.+?)(M|D)(-\d+)?$/)
  if (match) {
    return `${match[1]}${match[3] || ''} (${genderSymbol})`
  }

  return code
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

export default function LoadOfficialMatchModal({ open, onClose, onSelectMatch }) {
  const { t } = useTranslation()
  const { showAlert } = useAlert()
  const { scaleFactor } = useScaledLayout()

  // Scaled styles
  const selectStyle = {
    width: 'auto',
    minWidth: `${Math.round(80 * scaleFactor)}px`,
    padding: `${Math.round(10 * scaleFactor)}px ${Math.round(32 * scaleFactor)}px ${Math.round(10 * scaleFactor)}px ${Math.round(12 * scaleFactor)}px`,
    fontSize: `${Math.round(14 * scaleFactor)}px`,
    background: '#000000',
    border: '1px solid rgba(255,255,255,0.3)',
    borderRadius: `${Math.round(8 * scaleFactor)}px`,
    color: '#ffffff',
    cursor: 'pointer',
    appearance: 'none',
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23ffffff' d='M6 8L1 3h10z'/%3E%3C/svg%3E")`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: `right ${Math.round(12 * scaleFactor)}px center`
  }

  const labelStyle = {
    display: 'block',
    fontSize: `${Math.round(12 * scaleFactor)}px`,
    fontWeight: 600,
    color: 'rgba(255,255,255,0.7)',
    marginBottom: `${Math.round(6 * scaleFactor)}px`
  }

  const filterButtonStyle = {
    padding: `${Math.round(6 * scaleFactor)}px ${Math.round(12 * scaleFactor)}px`,
    fontSize: `${Math.round(12 * scaleFactor)}px`,
    background: 'rgba(255,255,255,0.1)',
    border: '1px solid rgba(255,255,255,0.2)',
    borderRadius: `${Math.round(6 * scaleFactor)}px`,
    color: '#ffffff',
    cursor: 'pointer',
    transition: 'all 0.15s'
  }

  const filterButtonActiveStyle = {
    ...filterButtonStyle,
    background: 'rgba(59, 130, 246, 0.3)',
    borderColor: 'rgba(59, 130, 246, 0.5)'
  }

  // Dynamic leagues from backend
  const [allLeagues, setAllLeagues] = useState([])
  const [loadingConfig, setLoadingConfig] = useState(false)

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

  // Fetch available leagues when modal opens
  useEffect(() => {
    if (!open) return
    fetchLeaguesConfig()
  }, [open])

  const fetchLeaguesConfig = async () => {
    setLoadingConfig(true)
    setError(null)
    try {
      const apiUrl = getApiUrl('/api/official-matches/leagues')
      if (!apiUrl) {
        setError(t('loadOfficialMatch.backendNotAvailable', 'Backend server not available'))
        setLoadingConfig(false)
        return
      }
      const response = await fetch(apiUrl)
      const data = await response.json()
      if (data.success) {
        setAllLeagues(data.leagues || [])
      } else {
        setError(data.error || 'Failed to load leagues')
      }
    } catch (err) {
      console.error('Failed to fetch leagues config:', err)
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

  const fetchMatches = async () => {
    // Find the league info to get federation
    const leagueInfo = allLeagues.find(l => l.code === league)
    if (!leagueInfo) return

    setLoading(true)
    setError(null)

    try {
      const apiUrl = getApiUrl(`/api/official-matches?federation=${leagueInfo.federation}&league=${league}`)

      if (!apiUrl) {
        setError(t('loadOfficialMatch.backendNotAvailable', 'Backend server not available'))
        setLoading(false)
        return
      }

      const response = await fetch(apiUrl)

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const data = await response.json()

      if (data.success) {
        setMatches(data.matches || [])
      } else {
        setError(data.error || t('loadOfficialMatch.fetchError', 'Failed to load matches'))
      }
    } catch (err) {
      console.error('Failed to fetch official matches:', err)
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
    // Transform iCal data to MatchSetup state format
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
      away: match.away
    }

    onSelectMatch(matchData)
    onClose()

    // Show reminder alert after modal closes
    setTimeout(() => {
      showAlert(t('loadOfficialMatch.reminderAlert', 'Set the League group if present, Team colours and Team Short names'), 'info')
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
      {/* Sticky Header */}
      <div style={{
        position: 'sticky',
        top: Math.round(-16 * scaleFactor),
        background: '#111827',
        borderBottom: '1px solid rgba(255,255,255,0.1)',
        padding: `${Math.round(12 * scaleFactor)}px 0`,
        marginBottom: `${Math.round(16 * scaleFactor)}px`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        zIndex: 10
      }}>
        <h2 style={{ margin: 0, fontSize: `${Math.round(18 * scaleFactor)}px`, fontWeight: 600 }}>
          {t('loadOfficialMatch.title', 'Load Match from Schedule')}
        </h2>
        <button
          onClick={onClose}
          style={{
            width: `${Math.round(32 * scaleFactor)}px`,
            height: `${Math.round(32 * scaleFactor)}px`,
            borderRadius: `${Math.round(6 * scaleFactor)}px`,
            background: 'rgba(255,255,255,0.1)',
            border: 'none',
            color: 'var(--text)',
            fontSize: `${Math.round(18 * scaleFactor)}px`,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          ×
        </button>
      </div>

      {/* Filters - 2 Dropdowns */}
      <div style={{ marginBottom: `${Math.round(16 * scaleFactor)}px` }}>
        {loadingConfig ? (
          <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: `${Math.round(14 * scaleFactor)}px` }}>
            {t('loadOfficialMatch.loading', 'Loading...')}
          </div>
        ) : (
          <div style={{
            display: 'flex',
            gap: `${Math.round(12 * scaleFactor)}px`,
            alignItems: 'flex-end'
          }}>
            {/* Gender Dropdown */}
            <div>
              <label style={labelStyle}>{t('loadOfficialMatch.gender', 'Gender')}</label>
              <select
                value={gender}
                onChange={e => setGender(e.target.value)}
                style={selectStyle}
              >
                <option value="">{t('loadOfficialMatch.selectGender', 'Select...')}</option>
                <option value="men">{t('matchSetup.men', 'Men')} ♂</option>
                <option value="women">{t('matchSetup.women', 'Women')} ♀</option>
              </select>
            </div>

            {/* League Dropdown */}
            <div>
              <label style={labelStyle}>{t('loadOfficialMatch.league', 'League')}</label>
              <select
                value={league}
                onChange={e => setLeague(e.target.value)}
                style={{ ...selectStyle, opacity: gender ? 1 : 0.5 }}
                disabled={!gender}
              >
                <option value="">{t('loadOfficialMatch.selectLeague', 'Select...')}</option>
                {availableLeagues.map(l => (
                  <option key={l.code} value={l.code}>{formatLeagueDisplay(l.code, l.gender)}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* Selection Path - shown when selections are made */}
        {gender && (
          <div style={{
            borderTop: '1px solid rgba(255,255,255,0.2)',
            marginTop: `${Math.round(12 * scaleFactor)}px`,
            paddingTop: `${Math.round(10 * scaleFactor)}px`
          }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: `${Math.round(8 * scaleFactor)}px`,
              fontSize: `${Math.round(13 * scaleFactor)}px`,
              color: 'rgba(255,255,255,0.8)'
            }}>
              <span>
                {gender === 'men' ? `${t('matchSetup.men', 'Men')} ♂` : `${t('matchSetup.women', 'Women')} ♀`}
              </span>
              {league && (
                <>
                  <span style={{ color: 'rgba(255,255,255,0.4)' }}>|</span>
                  <span style={{ fontWeight: 600 }}>{formatLeagueDisplay(league, gender)}</span>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Search and Date Filters - shown when matches are loaded */}
      {matches.length > 0 && (
        <div style={{
          marginBottom: `${Math.round(12 * scaleFactor)}px`,
          display: 'flex',
          gap: `${Math.round(12 * scaleFactor)}px`,
          alignItems: 'center',
          flexWrap: 'wrap'
        }}>
          {/* Search Input */}
          <div style={{ flex: 1, minWidth: `${Math.round(150 * scaleFactor)}px` }}>
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder={t('loadOfficialMatch.searchPlaceholder', 'Search...')}
              style={{
                width: '100%',
                padding: `${Math.round(8 * scaleFactor)}px ${Math.round(12 * scaleFactor)}px`,
                fontSize: `${Math.round(13 * scaleFactor)}px`,
                background: '#000000',
                border: '1px solid rgba(255,255,255,0.3)',
                borderRadius: `${Math.round(6 * scaleFactor)}px`,
                color: '#ffffff',
                outline: 'none'
              }}
            />
          </div>

          {/* Date Filter Buttons */}
          <div style={{ display: 'flex', gap: `${Math.round(6 * scaleFactor)}px`, alignItems: 'center' }}>
            <button
              onClick={() => setDateFilter(dateFilter === 'today' ? '' : 'today')}
              style={dateFilter === 'today' ? filterButtonActiveStyle : filterButtonStyle}
            >
              {t('loadOfficialMatch.today', 'Today')}
            </button>
            <button
              onClick={() => setDateFilter(dateFilter === 'tomorrow' ? '' : 'tomorrow')}
              style={dateFilter === 'tomorrow' ? filterButtonActiveStyle : filterButtonStyle}
            >
              {t('loadOfficialMatch.tomorrow', 'Tomorrow')}
            </button>
            {dateFilter && (
              <button
                onClick={() => setDateFilter('')}
                style={{
                  ...filterButtonStyle,
                  padding: `${Math.round(6 * scaleFactor)}px ${Math.round(8 * scaleFactor)}px`,
                  background: 'rgba(239, 68, 68, 0.2)',
                  borderColor: 'rgba(239, 68, 68, 0.3)'
                }}
                title={t('loadOfficialMatch.clearFilter', 'Clear filter')}
              >
                ✕
              </button>
            )}
          </div>
        </div>
      )}

      {/* Matches Table */}
      <div style={{ maxHeight: `${Math.round(350 * scaleFactor)}px`, overflowY: 'auto' }}>
        {loading && (
          <div style={{ textAlign: 'center', padding: `${Math.round(40 * scaleFactor)}px`, color: 'rgba(255,255,255,0.6)' }}>
            <div style={{ fontSize: `${Math.round(24 * scaleFactor)}px`, marginBottom: `${Math.round(8 * scaleFactor)}px` }}>⏳</div>
            {t('loadOfficialMatch.loading', 'Loading matches...')}
          </div>
        )}

        {error && (
          <div style={{
            textAlign: 'center',
            padding: `${Math.round(40 * scaleFactor)}px`,
            color: '#ef4444',
            background: 'rgba(239, 68, 68, 0.1)',
            borderRadius: `${Math.round(8 * scaleFactor)}px`
          }}>
            {error}
          </div>
        )}

        {!loading && !error && league && matches.length === 0 && (
          <div style={{ textAlign: 'center', padding: `${Math.round(40 * scaleFactor)}px`, color: 'rgba(255,255,255,0.6)' }}>
            {t('loadOfficialMatch.noUpcomingMatches', 'No upcoming matches found')}
          </div>
        )}

        {!loading && !error && matches.length > 0 && filteredMatches.length === 0 && (
          <div style={{ textAlign: 'center', padding: `${Math.round(40 * scaleFactor)}px`, color: 'rgba(255,255,255,0.6)' }}>
            {t('loadOfficialMatch.noMatchesForFilter', 'No matches found for this filter')}
          </div>
        )}

        {!loading && !error && filteredMatches.length > 0 && (
          <>
            {/* Table Header */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: gridColumns,
              gap: `${Math.round(8 * scaleFactor)}px`,
              padding: `${Math.round(8 * scaleFactor)}px ${Math.round(10 * scaleFactor)}px`,
              fontSize: `${Math.round(11 * scaleFactor)}px`,
              fontWeight: 600,
              color: 'rgba(255,255,255,0.5)',
              borderBottom: '2px solid rgba(255,255,255,0.2)',
              marginBottom: `${Math.round(2 * scaleFactor)}px`,
              alignItems: 'center'
            }}>
              <span style={{ textAlign: 'center' }}>{t('loadOfficialMatch.gameN', 'Game #')}</span>
              <span style={{ textAlign: 'center' }}>{t('loadOfficialMatch.date', 'Date')}</span>
              <span style={{ textAlign: 'center' }}>{t('loadOfficialMatch.time', 'Time')}</span>
              <span>{t('loadOfficialMatch.homeVsAway', 'Home vs Away')}</span>
            </div>

            {/* Table Rows */}
            {filteredMatches.map((match, index) => (
              <div
                key={match.gameN}
                onClick={() => handleSelectMatch(match)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: gridColumns,
                  gap: `${Math.round(8 * scaleFactor)}px`,
                  alignItems: 'center',
                  padding: `${Math.round(10 * scaleFactor)}px`,
                  background: index % 2 === 0 ? 'rgba(255,255,255,0.05)' : 'transparent',
                  cursor: 'pointer',
                  borderRadius: `${Math.round(4 * scaleFactor)}px`,
                  transition: 'background 0.15s'
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(59, 130, 246, 0.2)'}
                onMouseLeave={e => e.currentTarget.style.background = index % 2 === 0 ? 'rgba(255,255,255,0.05)' : 'transparent'}
              >
                <span style={{ fontWeight: 600, textAlign: 'center', fontSize: `${Math.round(12 * scaleFactor)}px` }}>
                  {match.gameN}
                </span>
                <span style={{ textAlign: 'center', fontSize: `${Math.round(12 * scaleFactor)}px` }}>
                  {formatDisplayDate(match.dtstart)}
                </span>
                <span style={{ textAlign: 'center', fontSize: `${Math.round(12 * scaleFactor)}px` }}>
                  {formatDisplayTime(match.dtstart)}
                </span>
                <span style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: `${Math.round(12 * scaleFactor)}px`
                }}>
                  <span style={{ fontWeight: 600 }}>{match.home}</span>
                  <span style={{ color: 'rgba(255,255,255,0.5)', margin: `0 ${Math.round(6 * scaleFactor)}px` }}>{t('common.vs', 'vs')}</span>
                  <span style={{ fontWeight: 600 }}>{match.away}</span>
                </span>
              </div>
            ))}
          </>
        )}
      </div>
    </Modal>
  )
}
