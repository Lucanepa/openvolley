import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from './Modal'
import { getApiUrl } from '../utils/backendConfig'

// Styles
const selectStyle = {
  width: 'auto',
  minWidth: '80px',
  padding: '10px 32px 10px 12px',
  fontSize: '14px',
  background: '#000000',
  border: '1px solid rgba(255,255,255,0.3)',
  borderRadius: '8px',
  color: '#ffffff',
  cursor: 'pointer',
  appearance: 'none',
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23ffffff' d='M6 8L1 3h10z'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 12px center'
}

const labelStyle = {
  display: 'block',
  fontSize: '12px',
  fontWeight: 600,
  color: 'rgba(255,255,255,0.7)',
  marginBottom: '6px'
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

export default function LoadOfficialMatchModal({ open, onClose, onSelectMatch }) {
  const { t } = useTranslation()

  // Dynamic leagues from backend
  const [allLeagues, setAllLeagues] = useState([])
  const [loadingConfig, setLoadingConfig] = useState(false)

  // Filter state (simplified: just gender and league)
  const [gender, setGender] = useState('')
  const [league, setLeague] = useState('')

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
      alert(t('loadOfficialMatch.reminderAlert', 'Set the League group if present, Team colours and Team Short names'))
    }, 100)
  }

  // Reset state when modal closes
  useEffect(() => {
    if (!open) {
      setGender('')
      setLeague('')
      setMatches([])
      setError(null)
    }
  }, [open])

  const gridColumns = '80px 90px 55px 1fr'

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
        top: -16,
        background: '#111827',
        borderBottom: '1px solid rgba(255,255,255,0.1)',
        padding: '12px 0 12px 0',
        marginBottom: '16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        zIndex: 10
      }}>
        <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>
          {t('loadOfficialMatch.title', 'Load Official Match')}
        </h2>
        <button
          onClick={onClose}
          style={{
            width: '32px',
            height: '32px',
            borderRadius: '6px',
            background: 'rgba(255,255,255,0.1)',
            border: 'none',
            color: 'var(--text)',
            fontSize: '18px',
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
      <div style={{ marginBottom: '16px' }}>
        {loadingConfig ? (
          <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: '14px' }}>
            {t('loadOfficialMatch.loading', 'Loading...')}
          </div>
        ) : (
          <div style={{
            display: 'flex',
            gap: '12px',
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
                  <option key={l.code} value={l.code}>{l.code}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* Selection Path - shown when selections are made */}
        {gender && (
          <div style={{
            borderTop: '1px solid rgba(255,255,255,0.2)',
            marginTop: '12px',
            paddingTop: '10px'
          }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              fontSize: '13px',
              color: 'rgba(255,255,255,0.8)'
            }}>
              <span>
                {gender === 'men' ? `${t('matchSetup.men', 'Men')} ♂` : `${t('matchSetup.women', 'Women')} ♀`}
              </span>
              {league && (
                <>
                  <span style={{ color: 'rgba(255,255,255,0.4)' }}>|</span>
                  <span style={{ fontWeight: 600 }}>{league}</span>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Matches Table */}
      <div style={{ maxHeight: '350px', overflowY: 'auto' }}>
        {loading && (
          <div style={{ textAlign: 'center', padding: '40px', color: 'rgba(255,255,255,0.6)' }}>
            <div style={{ fontSize: '24px', marginBottom: '8px' }}>⏳</div>
            {t('loadOfficialMatch.loading', 'Loading matches...')}
          </div>
        )}

        {error && (
          <div style={{
            textAlign: 'center',
            padding: '40px',
            color: '#ef4444',
            background: 'rgba(239, 68, 68, 0.1)',
            borderRadius: '8px'
          }}>
            {error}
          </div>
        )}

        {!loading && !error && league && matches.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px', color: 'rgba(255,255,255,0.6)' }}>
            {t('loadOfficialMatch.noUpcomingMatches', 'No upcoming matches found')}
          </div>
        )}

        {!loading && !error && matches.length > 0 && (
          <>
            {/* Table Header */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: gridColumns,
              gap: '8px',
              padding: '8px 10px',
              fontSize: '11px',
              fontWeight: 600,
              color: 'rgba(255,255,255,0.5)',
              borderBottom: '2px solid rgba(255,255,255,0.2)',
              marginBottom: '2px',
              alignItems: 'center'
            }}>
              <span style={{ textAlign: 'center' }}>{t('loadOfficialMatch.gameN', 'Game #')}</span>
              <span style={{ textAlign: 'center' }}>{t('loadOfficialMatch.date', 'Date')}</span>
              <span style={{ textAlign: 'center' }}>{t('loadOfficialMatch.time', 'Time')}</span>
              <span>{t('loadOfficialMatch.homeVsAway', 'Home vs Away')}</span>
            </div>

            {/* Table Rows */}
            {matches.map((match, index) => (
              <div
                key={match.gameN}
                onClick={() => handleSelectMatch(match)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: gridColumns,
                  gap: '8px',
                  alignItems: 'center',
                  padding: '10px',
                  background: index % 2 === 0 ? 'rgba(255,255,255,0.05)' : 'transparent',
                  cursor: 'pointer',
                  borderRadius: '4px',
                  transition: 'background 0.15s'
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(59, 130, 246, 0.2)'}
                onMouseLeave={e => e.currentTarget.style.background = index % 2 === 0 ? 'rgba(255,255,255,0.05)' : 'transparent'}
              >
                <span style={{ fontWeight: 600, textAlign: 'center', fontSize: '12px' }}>
                  {match.gameN}
                </span>
                <span style={{ textAlign: 'center', fontSize: '12px' }}>
                  {formatDisplayDate(match.dtstart)}
                </span>
                <span style={{ textAlign: 'center', fontSize: '12px' }}>
                  {formatDisplayTime(match.dtstart)}
                </span>
                <span style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: '12px'
                }}>
                  <span style={{ fontWeight: 600 }}>{match.home}</span>
                  <span style={{ color: 'rgba(255,255,255,0.5)', margin: '0 6px' }}>vs</span>
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
