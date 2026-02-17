import { useState, useEffect, useMemo, useRef } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useTranslation } from 'react-i18next'
import { useAlert } from '../contexts/AlertContext'
import { useScaledLayout } from '../hooks/useScaledLayout'
import { db } from '../db/db'
import { supabase } from '../lib/supabaseClient'
import SignaturePad from './SignaturePad'
import Modal from './Modal'
import MenuList from './MenuList'
import mikasaVolleyball from '../mikasa_v200w.png'

// Primary ball image (with mikasa as fallback)
const ballImage = `${import.meta.env.BASE_URL}ball.png`
import { exportMatchData } from '../utils/backupManager'
import { uploadBackupToCloud, uploadLogsToCloud } from '../utils/logger'
import { uploadScoresheetAsync } from '../utils/scoresheetUploader'

// Generate a placeholder signature image (wavy line) for test matches
function generatePlaceholderSignature() {
  const canvas = document.createElement('canvas')
  canvas.width = 200
  canvas.height = 60
  const ctx = canvas.getContext('2d')
  ctx.strokeStyle = '#333'
  ctx.lineWidth = 2
  ctx.beginPath()
  const startX = 20
  const startY = 35
  ctx.moveTo(startX, startY)
  for (let x = startX; x < 180; x += 5) {
    ctx.lineTo(x, startY + Math.sin((x - startX) * 0.1) * 8 + (Math.random() - 0.5) * 4)
  }
  ctx.stroke()
  return canvas.toDataURL('image/png')
}

// Helper to generate short name from team name (e.g., "VBC Zürich" -> "VBC")
function generateShortName(name) {
  if (!name) return ''
  const cleaned = name.trim().toUpperCase()
  const words = cleaned.split(/\s+/)
  if (words.length > 1 && words[0].length <= 4) {
    return words[0]
  }
  return cleaned.substring(0, 4)
}

// Hook to detect if we should use compact sizing
function useCompactMode() {
  const [isCompact, setIsCompact] = useState(() => window.innerHeight < 700 || window.innerWidth < 600)

  useEffect(() => {
    const checkSize = () => {
      setIsCompact(window.innerHeight < 700 || window.innerWidth < 600)
    }
    window.addEventListener('resize', checkSize)
    return () => window.removeEventListener('resize', checkSize)
  }, [])

  return isCompact
}

// Bench roles constant
const BENCH_ROLES = [
  { value: 'Coach', label: 'C', fullLabel: 'Coach' },
  { value: 'Assistant Coach 1', label: 'AC1', fullLabel: 'Assistant Coach 1' },
  { value: 'Assistant Coach 2', label: 'AC2', fullLabel: 'Assistant Coach 2' },
  { value: 'Physiotherapist', label: 'P', fullLabel: 'Physiotherapist' },
  { value: 'Medic', label: 'M', fullLabel: 'Medic' }
]

// Helper function to determine if a color is bright/light
function isBrightColor(color) {
  if (!color || color === 'image.png') return false
  const hex = color.replace('#', '')
  const r = parseInt(hex.substr(0, 2), 16)
  const g = parseInt(hex.substr(2, 2), 16)
  const b = parseInt(hex.substr(4, 2), 16)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.5
}

// Date formatting helpers
function formatDateToDDMMYYYY(dateStr) {
  if (!dateStr) return ''
  const parts = dateStr.split('-')
  if (parts.length !== 3) return dateStr
  const [year, month, day] = parts
  return `${day}.${month}.${year}`
}

function formatDateToISO(dateStr) {
  if (!dateStr) return ''
  // Handle both dot and slash separators (dd.mm.yyyy or dd/mm/yyyy)
  const separator = dateStr.includes('/') ? '/' : '.'
  const parts = dateStr.split(separator)
  if (parts.length !== 3) return dateStr
  const [day, month, year] = parts
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
}

// Normalize DOB to dd.mm.yyyy format
function normalizeDob(dob) {
  if (!dob) return ''
  // If already in ISO format (yyyy-mm-dd), convert to dd.mm.yyyy
  if (dob.includes('-') && dob.length === 10 && dob.indexOf('-') === 4) {
    const [year, month, day] = dob.split('-')
    return `${day}.${month}.${year}`
  }
  // If using slashes (dd/mm/yyyy), convert to dots
  if (dob.includes('/')) {
    return dob.replace(/\//g, '.')
  }
  return dob
}

const getRoleOrder = (role) => {
  const roleMap = {
    'Coach': 0,
    'Assistant Coach 1': 1,
    'Assistant Coach 2': 2,
    'Physiotherapist': 3,
    'Medic': 4
  }
  return roleMap[role] ?? 999
}

const sortBenchByHierarchy = (bench) => {
  return [...bench].sort((a, b) => getRoleOrder(a.role) - getRoleOrder(b.role))
}

const initBench = role => ({ role, firstName: '', lastName: '', dob: '' })

export default function CoinToss({ matchId, onConfirm, onBack, lfpTrackingEnabled = false }) {
  const { t } = useTranslation()
  const { showAlert } = useAlert()
  const { vmin } = useScaledLayout()

  // Compact mode disabled - always use full layout
  const isCompact = false

  // Responsive sizing - scales with viewport height
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768
  const vhScale = Math.max(0.6, Math.min(1.4, vh / 900)) // scale factor based on viewport height
  const sizes = isCompact ? {
    headerFont: `${Math.round(22 * vhScale)}px`,
    teamButtonFont: `${Math.round(15 * vhScale)}px`,
    teamButtonPadding: `${Math.round(10 * vhScale)}px ${Math.round(14 * vhScale)}px`,
    volleyballSize: `${Math.round(60 * vhScale)}px`,
    // Unified button size for roster, sign, and switch buttons
    actionButtonFont: `${Math.round(14 * vhScale)}px`,
    actionButtonPadding: `${Math.round(10 * vhScale)}px ${Math.round(20 * vhScale)}px`,
    actionButtonMinWidth: `${Math.round(180 * vhScale)}px`,
    actionButtonMinHeight: `${Math.round(44 * vhScale)}px`,
    confirmButtonFont: `${Math.round(16 * vhScale)}px`,
    confirmButtonPadding: `${Math.round(14 * vhScale)}px ${Math.round(28 * vhScale)}px`,
    gap: Math.round(12 * vhScale),
    marginBottom: Math.round(24 * vhScale)
  } : {
    headerFont: `${Math.round(32 * vhScale)}px`,
    teamButtonFont: `${Math.round(22 * vhScale)}px`,
    teamButtonPadding: `${Math.round(14 * vhScale)}px ${Math.round(24 * vhScale)}px`,
    volleyballSize: `${Math.round(100 * vhScale)}px`,
    // Unified button size for roster, sign, and switch buttons
    actionButtonFont: `${Math.round(18 * vhScale)}px`,
    actionButtonPadding: `${Math.round(12 * vhScale)}px ${Math.round(28 * vhScale)}px`,
    actionButtonMinWidth: `${Math.round(220 * vhScale)}px`,
    actionButtonMinHeight: `${Math.round(52 * vhScale)}px`,
    confirmButtonFont: `${Math.round(20 * vhScale)}px`,
    confirmButtonPadding: `${Math.round(18 * vhScale)}px ${Math.round(36 * vhScale)}px`,
    gap: Math.round(24 * vhScale),
    marginBottom: Math.round(32 * vhScale)
  }

  // Team info state (loaded from DB)
  const [home, setHome] = useState(t('common.home'))
  const [away, setAway] = useState(t('common.away'))
  const [homeShortName, setHomeShortName] = useState('')
  const [awayShortName, setAwayShortName] = useState('')

  // Rosters
  const [homeRoster, setHomeRoster] = useState([])
  const [awayRoster, setAwayRoster] = useState([])

  // Add player form state
  const [homeNum, setHomeNum] = useState('')
  const [homeFirst, setHomeFirst] = useState('')
  const [homeLast, setHomeLast] = useState('')
  const [homeDob, setHomeDob] = useState('')
  const [homeLibero, setHomeLibero] = useState('')
  const [homeCaptain, setHomeCaptain] = useState(false)
  const [awayNum, setAwayNum] = useState('')
  const [awayFirst, setAwayFirst] = useState('')
  const [awayLast, setAwayLast] = useState('')
  const [awayDob, setAwayDob] = useState('')
  const [awayLibero, setAwayLibero] = useState('')
  const [awayCaptain, setAwayCaptain] = useState(false)

  // Bench
  const [benchHome, setBenchHome] = useState([initBench('Coach')])
  const [benchAway, setBenchAway] = useState([initBench('Coach')])

  // Coin toss state
  const [teamA, setTeamA] = useState('home')
  const [teamB, setTeamB] = useState('away')
  const [serveA, setServeA] = useState(true)
  const [serveB, setServeB] = useState(false)

  // UI state
  const [rosterModal, setRosterModal] = useState(null) // 'teamA' | 'teamB' | null
  const [signatureMenuA, setSignatureMenuA] = useState(false)
  const [signatureMenuB, setSignatureMenuB] = useState(false)
  const [addPlayerModal, setAddPlayerModal] = useState(null)
  const [deletePlayerModal, setDeletePlayerModal] = useState(null)
  const [noticeModal, setNoticeModal] = useState(null)
  const [initModal, setInitModal] = useState(null) // { status: 'syncing' | 'verifying' | 'success' | 'error', message: string }
  const [openSignature, setOpenSignature] = useState(null)
  const [birthdateConfirmModal, setBirthdateConfirmModal] = useState(null) // { suspiciousDates: [], onConfirm: fn }
  const [rosterModalSignature, setRosterModalSignature] = useState(null) // 'coach' | 'captain' | null - for signing within roster modal

  // Track original roster/bench data when modal opens for change detection
  const originalRosterDataRef = useRef(null) // { roster: [], bench: [] }

  // Signatures
  const [homeCoachSignature, setHomeCoachSignature] = useState(null)
  const [homeCaptainSignature, setHomeCaptainSignature] = useState(null)
  const [awayCoachSignature, setAwayCoachSignature] = useState(null)
  const [awayCaptainSignature, setAwayCaptainSignature] = useState(null)
  const [savedSignatures, setSavedSignatures] = useState({
    homeCoach: null, homeCaptain: null, awayCoach: null, awayCaptain: null
  })

  // Helper function to compare roster/bench for changes
  const hasRosterChanges = (originalRoster, currentRoster, originalBench, currentBench) => {
    if (!originalRoster || !originalBench) return false
    if (originalRoster.length !== currentRoster.length) return true
    if (originalBench.length !== currentBench.length) return true

    // Compare each player
    for (let i = 0; i < originalRoster.length; i++) {
      const orig = originalRoster[i]
      const curr = currentRoster[i]
      if (orig.number !== curr.number || orig.firstName !== curr.firstName ||
        orig.lastName !== curr.lastName || orig.dob !== curr.dob ||
        orig.libero !== curr.libero || orig.isCaptain !== curr.isCaptain) {
        return true
      }
    }

    // Compare each bench official
    for (let i = 0; i < originalBench.length; i++) {
      const orig = originalBench[i]
      const curr = currentBench[i]
      if (orig.role !== curr.role || orig.firstName !== curr.firstName ||
        orig.lastName !== curr.lastName || orig.dob !== curr.dob) {
        return true
      }
    }

    return false
  }

  // Sync roster changes to database
  const syncRosterToDatabase = async (teamType, roster, bench) => {
    if (!match) return

    const teamId = teamType === 'home' ? match.homeTeamId : match.awayTeamId
    if (!teamId) return

    try {
      await db.transaction('rw', db.players, db.matches, db.sync_queue, async () => {
        // Get existing players
        const existingPlayers = await db.players.where('teamId').equals(teamId).toArray()

        // Update or add players
        for (const player of roster) {
          const existingPlayer = existingPlayers.find(ep =>
            ep.number === player.number ||
            (ep.lastName === player.lastName && ep.firstName === player.firstName)
          )

          if (existingPlayer) {
            await db.players.update(existingPlayer.id, {
              number: player.number,
              firstName: player.firstName,
              lastName: player.lastName,
              dob: player.dob,
              libero: player.libero,
              isCaptain: player.isCaptain
            })
          } else {
            await db.players.add({
              teamId,
              number: player.number,
              firstName: player.firstName,
              lastName: player.lastName,
              dob: player.dob,
              libero: player.libero || '',
              isCaptain: player.isCaptain || false
            })
          }
        }

        // Delete players that are no longer in roster
        for (const ep of existingPlayers) {
          const stillExists = roster.some(p =>
            p.number === ep.number ||
            (p.lastName === ep.lastName && p.firstName === ep.firstName)
          )
          if (!stillExists) {
            await db.players.delete(ep.id)
          }
        }

        // Update bench in match
        const benchField = teamType === 'home' ? 'bench_home' : 'bench_away'
        await db.matches.update(match.id, { [benchField]: bench })
      })

      console.log(`[CoinToss] Roster synced for ${teamType} team (local)`)

      // Also sync to Supabase if match has seed_key
      if (supabase && match.seed_key) {
        try {
          const isHome = teamType === 'home'
          const teamKey = isHome ? 'home_team' : 'away_team'
          const playersKey = isHome ? 'players_home' : 'players_away'
          const benchKey = isHome ? 'bench_home' : 'bench_away'
          const teamName = isHome ? home : away
          const shortName = isHome ? homeShortName : awayShortName
          const color = isHome ? homeColor : awayColor

          // Update matches table
          const { data: supabaseMatch } = await supabase
            .from('matches')
            .update({
              [teamKey]: {
                name: teamName?.trim() || '',
                short_name: shortName || generateShortName(teamName),
                color: color
              },
              [playersKey]: roster.map(p => ({
                number: p.number || null,
                first_name: p.firstName || '',
                last_name: p.lastName || '',
                dob: p.dob || null,
                is_captain: !!p.isCaptain,
                is_lfp: !!p.isLfp,
                libero: p.libero || null
              })),
              [benchKey]: bench || []
            })
            .eq('external_id', match.seed_key)
            .select('id')
            .single()

          console.log(`[CoinToss] Roster synced for ${teamType} team (Supabase)`)

          // Also update match_live_state if it exists (just team info, not deprecated columns)
          if (supabaseMatch?.id) {
            const coinTossTeamA = match.coinTossTeamA || 'home'
            const homeIsTeamA = coinTossTeamA === 'home'
            // Determine if this team is Team A or Team B
            const isTeamA = (isHome && homeIsTeamA) || (!isHome && !homeIsTeamA)
            const colorLiveKey = isTeamA ? 'team_a_color' : 'team_b_color'
            const shortLiveKey = isTeamA ? 'team_a_short' : 'team_b_short'
            const nameLiveKey = isTeamA ? 'team_a_name' : 'team_b_name'

            await supabase
              .from('match_live_state')
              .update({
                [colorLiveKey]: color,
                [shortLiveKey]: shortName || generateShortName(teamName),
                [nameLiveKey]: teamName?.trim() || '',
                updated_at: new Date().toISOString()
              })
              .eq('match_id', supabaseMatch.id)

            console.log(`[CoinToss] Team info synced for ${teamType} team (match_live_state)`)
          }
        } catch (supabaseErr) {
          console.warn('[CoinToss] Failed to sync roster to Supabase:', supabaseErr)
        }
      }
    } catch (error) {
      console.error('[CoinToss] Failed to sync roster:', error)
    }
  }

  // Load match data
  const match = useLiveQuery(async () => {
    if (!matchId) return null
    try {
      return await db.matches.get(matchId)
    } catch (error) {
      console.error('Unable to load match', error)
      return null
    }
  }, [matchId])

  // Colors are derived from match - no local state (can't change in CoinToss)
  const homeColor = match?.homeColor || '#ef4444'
  const awayColor = match?.awayColor || '#3b82f6'

  // Check if coin toss was previously confirmed
  // Use the dedicated coinTossConfirmed field instead of signature comparison
  // This prevents false positives when signatures were already set in MatchSetup
  const isCoinTossConfirmed = useMemo(() => {
    return !!match?.coinTossConfirmed
  }, [match?.coinTossConfirmed])

  // Load initial data from DB
  useEffect(() => {
    if (!matchId || !match) return

    async function loadData() {
      try {
        // Load teams
        const [homeTeam, awayTeam] = await Promise.all([
          match.homeTeamId ? db.teams.get(match.homeTeamId) : null,
          match.awayTeamId ? db.teams.get(match.awayTeamId) : null
        ])

        if (homeTeam) {
          setHome(homeTeam.name || t('common.home'))
          // Use team shortName, or match-level shortName as fallback
          setHomeShortName(homeTeam.shortName || match.homeShortName || '')
        } else if (match.homeShortName) {
          setHomeShortName(match.homeShortName)
        }
        if (awayTeam) {
          setAway(awayTeam.name || t('common.away'))
          // Use team shortName, or match-level shortName as fallback
          setAwayShortName(awayTeam.shortName || match.awayShortName || '')
        } else if (match.awayShortName) {
          setAwayShortName(match.awayShortName)
        }

        // Load rosters
        const [homePlayers, awayPlayers] = await Promise.all([
          match.homeTeamId ? db.players.where('teamId').equals(match.homeTeamId).toArray() : [],
          match.awayTeamId ? db.players.where('teamId').equals(match.awayTeamId).toArray() : []
        ])

        if (homePlayers.length) {
          setHomeRoster(homePlayers.map(p => ({
            number: p.number,
            lastName: p.lastName || (p.name ? p.name.split(' ')[0] : ''),
            firstName: p.firstName || (p.name ? p.name.split(' ').slice(1).join(' ') : ''),
            dob: normalizeDob(p.dob) || '',
            libero: p.libero || '',
            isCaptain: p.isCaptain || false,
            isLfp: p.isLfp || false
          })).sort((a, b) => (a.number || 999) - (b.number || 999)))
        }

        if (awayPlayers.length) {
          setAwayRoster(awayPlayers.map(p => ({
            number: p.number,
            lastName: p.lastName || (p.name ? p.name.split(' ')[0] : ''),
            firstName: p.firstName || (p.name ? p.name.split(' ').slice(1).join(' ') : ''),
            dob: normalizeDob(p.dob) || '',
            libero: p.libero || '',
            isCaptain: p.isCaptain || false,
            isLfp: p.isLfp || false
          })).sort((a, b) => (a.number || 999) - (b.number || 999)))
        }

        // Load bench officials - check match object first, then team
        const homeBenchData = match.bench_home?.length ? match.bench_home : homeTeam?.benchOfficials
        const awayBenchData = match.bench_away?.length ? match.bench_away : awayTeam?.benchOfficials

        if (homeBenchData?.length) {
          setBenchHome(homeBenchData.map(b => ({
            ...b,
            dob: normalizeDob(b.dob) || ''
          })))
        }
        if (awayBenchData?.length) {
          setBenchAway(awayBenchData.map(b => ({
            ...b,
            dob: normalizeDob(b.dob) || ''
          })))
        }

        // Load coin toss data if previously saved
        if (match.coinTossTeamA !== undefined && match.coinTossTeamB !== undefined) {
          setTeamA(match.coinTossTeamA)
          setTeamB(match.coinTossTeamB)
          setServeA(match.coinTossServeA !== undefined ? match.coinTossServeA : true)
          setServeB(match.coinTossServeB !== undefined ? match.coinTossServeB : false)
        }

        // Load signatures
        if (match.homeCoachSignature) {
          setHomeCoachSignature(match.homeCoachSignature)
          setSavedSignatures(prev => ({ ...prev, homeCoach: match.homeCoachSignature }))
        }
        if (match.homeCaptainSignature) {
          setHomeCaptainSignature(match.homeCaptainSignature)
          setSavedSignatures(prev => ({ ...prev, homeCaptain: match.homeCaptainSignature }))
        }
        if (match.awayCoachSignature) {
          setAwayCoachSignature(match.awayCoachSignature)
          setSavedSignatures(prev => ({ ...prev, awayCoach: match.awayCoachSignature }))
        }
        if (match.awayCaptainSignature) {
          setAwayCaptainSignature(match.awayCaptainSignature)
          setSavedSignatures(prev => ({ ...prev, awayCaptain: match.awayCaptainSignature }))
        }

        // For test matches, pre-fill placeholder signatures so buttons show ✓
        if (match.test && !match.homeCoachSignature) {
          const placeholder = generatePlaceholderSignature()
          setHomeCoachSignature(placeholder)
          setHomeCaptainSignature(placeholder)
          setAwayCoachSignature(placeholder)
          setAwayCaptainSignature(placeholder)
        }
      } catch (error) {
        console.error('Error loading coin toss data:', error)
      }
    }

    loadData()
  }, [matchId, match?.id])

  function switchTeams() {
    const temp = teamA
    setTeamA(teamB)
    setTeamB(temp)
  }

  function switchServe() {
    setServeA(!serveA)
    setServeB(!serveB)
  }

  function handleSignatureSave(signatureImage) {
    if (openSignature === 'home-coach') {
      setHomeCoachSignature(signatureImage)
    } else if (openSignature === 'home-captain') {
      setHomeCaptainSignature(signatureImage)
    } else if (openSignature === 'away-coach') {
      setAwayCoachSignature(signatureImage)
    } else if (openSignature === 'away-captain') {
      setAwayCaptainSignature(signatureImage)
    }
    setOpenSignature(null)
  }

  // Execute coin toss after all validations pass
  async function proceedWithCoinToss() {
    console.log('[CoinToss] proceedWithCoinToss called')

    if (!matchId) {
      console.error('[CoinToss] No match ID available')
      setNoticeModal({ message: t('validation.noMatchId') })
      return
    }

    const matchData = await db.matches.get(matchId)
    if (!matchData) return

    const firstServeTeam = serveA ? teamA : teamB

    await db.transaction('rw', db.matches, db.players, db.sync_queue, db.events, db.teams, async () => {
      // Build update object
      const updateData = {
        firstServe: firstServeTeam,
        coinTossTeamA: teamA,
        coinTossTeamB: teamB,
        coinTossServeA: serveA,
        coinTossServeB: serveB,
        coinTossConfirmed: true  // Mark coin toss as confirmed
      }

      // Save signatures - use actual signatures for official matches, placeholder for test
      if (!match?.test) {
        updateData.homeCoachSignature = homeCoachSignature
        updateData.homeCaptainSignature = homeCaptainSignature
        updateData.awayCoachSignature = awayCoachSignature
        updateData.awayCaptainSignature = awayCaptainSignature
      } else {
        // Use placeholder signatures for test matches
        updateData.homeCoachSignature = homeCoachSignature || generatePlaceholderSignature()
        updateData.homeCaptainSignature = homeCaptainSignature || generatePlaceholderSignature()
        updateData.awayCoachSignature = awayCoachSignature || generatePlaceholderSignature()
        updateData.awayCaptainSignature = awayCaptainSignature || generatePlaceholderSignature()
      }

      await db.matches.update(matchId, updateData)

      // Check if coin toss event already exists
      const existingCoinTossEvent = await db.events
        .where('matchId').equals(matchId)
        .and(e => e.type === 'coin_toss')
        .first()

      // Create coin_toss event if it doesn't exist
      if (!existingCoinTossEvent) {
        await db.events.add({
          matchId: matchId,
          setIndex: 1,
          type: 'coin_toss',
          payload: {
            teamA: teamA,
            teamB: teamB,
            serveA: serveA,
            serveB: serveB,
            firstServe: firstServeTeam
          },
          ts: new Date().toISOString(),
          seq: 1
        })
      }

      // Add coin_toss event to sync queue (only if match has seed_key)
      if (match?.seed_key) {
        // We need to re-fetch the event to get the exact TS and payload if needed, 
        // but since we just constructed it or verified it exists, we can reconstruct the payload for sync.
        // Sync payload structure must match what Scoreboard.jsx uses (snake_case generally for properties if needed, 
        // essentially satisfying the 'events' table schema).
        // The events table takes a JSONB payload.

        await db.sync_queue.add({
          resource: 'event',
          action: 'insert',
          payload: {
            external_id: 'coin_toss_' + match.seed_key, // Unique ID for this event
            match_id: match.seed_key,
            set_index: 1,
            type: 'coin_toss',
            payload: {
              teamA: teamA,
              teamB: teamB,
              serveA: serveA,
              serveB: serveB,
              firstServe: firstServeTeam
            },
            seq: 1,
            test: !!match?.test,
            created_at: new Date().toISOString()
          },
          ts: Date.now(),
          status: 'queued'
        })
      }

      // Add match update to sync queue (only if match has seed_key)
      const updatedMatch = await db.matches.get(matchId)
      if (updatedMatch?.seed_key) {
        await db.sync_queue.add({
          resource: 'match',
          action: 'update',
          payload: {
            id: updatedMatch.seed_key, // Use seed_key (external_id) for Supabase lookup
            status: 'live', // Set status to live after coin toss is confirmed
            current_set: 1, // Match starts at set 1
            // JSONB columns only
            coin_toss: {
              team_a: teamA,
              team_b: teamB,
              serve_a: serveA,
              confirmed: true,
              first_serve: firstServeTeam
            },
            home_team: { name: home, short_name: homeShortName || generateShortName(home), color: homeColor },
            away_team: { name: away, short_name: awayShortName || generateShortName(away), color: awayColor },
            players_home: homeRoster.map(p => ({
              number: p.number,
              first_name: p.firstName,
              last_name: p.lastName,
              dob: p.dob || null,
              libero: p.libero || '',
              is_captain: !!p.isCaptain,
              is_lfp: !!p.isLfp
            })),
            players_away: awayRoster.map(p => ({
              number: p.number,
              first_name: p.firstName,
              last_name: p.lastName,
              dob: p.dob || null,
              libero: p.libero || '',
              is_captain: !!p.isCaptain,
              is_lfp: !!p.isLfp
            })),
            bench_home: benchHome.map(b => ({
              role: b.role,
              first_name: b.firstName || '',
              last_name: b.lastName || '',
              dob: b.dob || null
            })),
            bench_away: benchAway.map(b => ({
              role: b.role,
              first_name: b.firstName || '',
              last_name: b.lastName || '',
              dob: b.dob || null
            })),
            officials: updatedMatch.officials || []
          },
          ts: new Date().toISOString(),
          status: 'queued'
        })
      }

      // Update players for home team
      if (matchData.homeTeamId && homeRoster.length) {
        const existingPlayers = await db.players.where('teamId').equals(matchData.homeTeamId).toArray()

        for (const p of homeRoster) {
          const existingPlayer = existingPlayers.find(ep => ep.number === p.number)
          if (existingPlayer) {
            await db.players.update(existingPlayer.id, {
              name: `${p.lastName} ${p.firstName}`,
              lastName: p.lastName,
              firstName: p.firstName,
              dob: p.dob || null,
              libero: p.libero || '',
              isCaptain: !!p.isCaptain,
              isLfp: !!p.isLfp
            })
          } else {
            await db.players.add({
              teamId: matchData.homeTeamId,
              number: p.number,
              name: `${p.lastName} ${p.firstName}`,
              lastName: p.lastName,
              firstName: p.firstName,
              dob: p.dob || null,
              libero: p.libero || '',
              isCaptain: !!p.isCaptain,
              isLfp: !!p.isLfp,
              role: null,
              createdAt: new Date().toISOString()
            })
          }
        }

        // Delete removed players
        const rosterNumbers = new Set(homeRoster.map(p => p.number))
        for (const ep of existingPlayers) {
          if (!rosterNumbers.has(ep.number)) {
            await db.players.delete(ep.id)
          }
        }

        // Save bench officials
        await db.teams.update(matchData.homeTeamId, { benchOfficials: benchHome })
      }

      // Update players for away team
      if (matchData.awayTeamId && awayRoster.length) {
        const existingPlayers = await db.players.where('teamId').equals(matchData.awayTeamId).toArray()

        for (const p of awayRoster) {
          const existingPlayer = existingPlayers.find(ep => ep.number === p.number)
          if (existingPlayer) {
            await db.players.update(existingPlayer.id, {
              name: `${p.lastName} ${p.firstName}`,
              lastName: p.lastName,
              firstName: p.firstName,
              dob: p.dob || null,
              libero: p.libero || '',
              isCaptain: !!p.isCaptain,
              isLfp: !!p.isLfp
            })
          } else {
            await db.players.add({
              teamId: matchData.awayTeamId,
              number: p.number,
              name: `${p.lastName} ${p.firstName}`,
              lastName: p.lastName,
              firstName: p.firstName,
              dob: p.dob || null,
              libero: p.libero || '',
              isCaptain: !!p.isCaptain,
              isLfp: !!p.isLfp,
              role: null,
              createdAt: new Date().toISOString()
            })
          }
        }

        // Delete removed players
        const rosterNumbers = new Set(awayRoster.map(p => p.number))
        for (const ep of existingPlayers) {
          if (!rosterNumbers.has(ep.number)) {
            await db.players.delete(ep.id)
          }
        }

        // Save bench officials
        await db.teams.update(matchData.awayTeamId, { benchOfficials: benchAway })
      }
    })

    // Create first set
    const firstSetId = await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 0, finished: false })

    const isTest = match?.test || false

    // Add first set to sync queue (only for official matches)
    if (!isTest && match?.seed_key) {
      await db.sync_queue.add({
        resource: 'set',
        action: 'insert',
        payload: {
          external_id: String(firstSetId),
          match_id: match.seed_key, // Use seed_key (external_id) for Supabase lookup
          index: 1,
          home_points: 0,
          away_points: 0,
          finished: false,
          test: isTest,
          start_time: new Date().toISOString()
        },
        ts: new Date().toISOString(),
        status: 'queued'
      })
    }

    // Update match status to 'live' and set current_set to 1
    await db.matches.update(matchId, { status: 'live', current_set: 1 })
    console.log('[CoinToss] Match status updated to live, current_set: 1')

    // Sync match status to Supabase (including officials, signatures, and referee connection info)
    // Only sync if match has seed_key (for Supabase lookup)
    if (match?.seed_key) {
      await db.sync_queue.add({
        resource: 'match',
        action: 'update',
        payload: {
          id: match.seed_key, // Use seed_key (external_id) for Supabase lookup
          status: 'live',
          current_set: 1, // Match starts at set 1
          // Officials as JSONB
          officials: match?.officials || [],
          // Connections JSONB - include both referee and bench settings
          connections: {
            referee_enabled: match?.refereeConnectionEnabled === true,
            home_bench_enabled: match?.homeTeamConnectionEnabled === true,
            away_bench_enabled: match?.awayTeamConnectionEnabled === true
          },
          // Connection PINs JSONB - include both referee and bench PINs
          connection_pins: {
            referee: match?.refereePin || '',
            bench_home: match?.homeTeamPin || '',
            bench_away: match?.awayTeamPin || ''
          },
          // Signatures JSONB
          signatures: !match?.test ? {
            home_coach: homeCoachSignature || '',
            home_captain: homeCaptainSignature || '',
            away_coach: awayCoachSignature || '',
            away_captain: awayCaptainSignature || ''
          } : {}
        },
        ts: new Date().toISOString(),
        status: 'queued'
      })
    }

    // Create initial match_live_state entry for Referee app (only for official matches with Supabase)
    // A/B Model: Team A = coin toss winner (constant), side_a = which side they're on
    if (!isTest && supabase && match?.seed_key) {
      try {
        // First get the Supabase match UUID from external_id
        const { data: supabaseMatch, error: lookupError } = await supabase
          .from('matches')
          .select('id')
          .eq('external_id', match.seed_key)
          .maybeSingle()

        if (!lookupError && supabaseMatch?.id) {
          // Team A = coin toss winner, Team B = other team
          const teamAName = teamA === 'home' ? home : away
          const teamBName = teamA === 'home' ? away : home
          const teamAShort = teamA === 'home' ? homeShortName : awayShortName
          const teamBShort = teamA === 'home' ? awayShortName : homeShortName
          const teamAColor = teamA === 'home' ? homeColor : awayColor
          const teamBColor = teamA === 'home' ? awayColor : homeColor

          const { error: insertError } = await supabase
            .from('match_live_state')
            .upsert({
              match_id: supabaseMatch.id,
              current_set: 1,
              // Team info (constant throughout match)
              team_a_name: teamAName,
              team_a_short: teamAShort || teamAName?.substring(0, 3).toUpperCase(),
              team_a_color: teamAColor || '#ef4444',
              team_b_name: teamBName,
              team_b_short: teamBShort || teamBName?.substring(0, 3).toUpperCase(),
              team_b_color: teamBColor || '#3b82f6',
              // Scores
              sets_won_a: 0,
              sets_won_b: 0,
              points_a: 0,
              points_b: 0,
              // Side (Team A always on left in Set 1)
              side_a: 'left',
              // Stats
              timeouts_a: 0,
              timeouts_b: 0,
              subs_a: 0,
              subs_b: 0,
              match_status: 'starting',
              // Match metadata
              game_n: match.gameN || match.game_n || null,
              league: match.league || null,
              gender: match.match_type_2 || null,
              updated_at: new Date().toISOString()
            }, { onConflict: 'match_id' })

          if (insertError) {
            console.warn('[CoinToss] Failed to create initial match_live_state:', insertError)
          } else {
            console.log('[CoinToss] Created initial match_live_state for Referee app')
          }
        }
      } catch (err) {
        console.warn('[CoinToss] Error creating match_live_state:', err)
      }
    }

    // Cloud backup at coin toss (non-blocking)
    if (!match?.test) {
      const gameNum = match?.gameN || match?.game_n || null
      exportMatchData(matchId).then(backupData => {
        uploadBackupToCloud(matchId, backupData)
        uploadLogsToCloud(matchId, gameNum)
      }).catch(err => console.warn('[CoinToss] Cloud backup failed:', err))
    }

    // Update saved signatures
    setSavedSignatures({
      homeCoach: homeCoachSignature,
      homeCaptain: homeCaptainSignature,
      awayCoach: awayCoachSignature,
      awayCaptain: awayCaptainSignature
    })

    // Show initialization modal and wait for sync
    setInitModal({ status: 'syncing', message: t('coinToss.syncingMatch', 'Syncing match data...') })

    // Wait for sync queue to process (poll for completion)
    const maxAttempts = 30 // 15 seconds max
    let attempts = 0
    let syncComplete = false

    while (attempts < maxAttempts && !syncComplete) {
      await new Promise(resolve => setTimeout(resolve, 500))
      const queuedCount = await db.sync_queue.where('status').equals('queued').count()
      if (queuedCount === 0) {
        syncComplete = true
      }
      attempts++
    }

    if (!syncComplete) {
      console.warn('[CoinToss] Sync queue still has items after timeout, proceeding anyway')
    }

    // Verify status is 'live' in Supabase (only for official matches with Supabase configured)
    // This is non-blocking - if offline or error, we still proceed (local status is already 'live')
    let verificationSkipped = false

    if (!match?.test && supabase) {
      setInitModal({ status: 'verifying', message: t('coinToss.verifyingStatus', 'Verifying match status...') })

      try {
        // Get the match's external_id (seed_key) to look up in Supabase
        const localMatch = await db.matches.get(matchId)
        const seedKey = localMatch?.seed_key

        if (seedKey) {
          const { data: supabaseMatch, error } = await supabase
            .from('matches')
            .select('status')
            .eq('external_id', seedKey)
            .single()

          if (error) {
            // Network error or match not found - proceed anyway (offline mode)
            console.warn('[CoinToss] Could not verify match status in Supabase (offline?):', error.message)
            verificationSkipped = true
          } else if (supabaseMatch?.status !== 'live') {
            // Match exists but status is not 'live' - this is a real problem
            console.error('[CoinToss] Match status not live in Supabase:', supabaseMatch?.status)
            setInitModal({
              status: 'error',
              message: t('coinToss.statusNotLive', 'Match status is not "live" in database. Current status: {{status}}', { status: supabaseMatch?.status || 'unknown' })
            })
            return
          } else {
            console.log('[CoinToss] Match status verified as live in Supabase')
          }
        } else {
          // No seed key - skip verification
          verificationSkipped = true
        }
      } catch (err) {
        // Network error - proceed anyway (offline mode)
        console.warn('[CoinToss] Error verifying match status (offline?):', err.message)
        verificationSkipped = true
      }
    } else {
      verificationSkipped = true
    }

    if (verificationSkipped) {
      console.log('[CoinToss] Verification skipped (offline or no Supabase), proceeding with local status')
    }

    // Upload scoresheet to cloud (async, non-blocking)
    const updatedMatchForScoresheet = await db.matches.get(matchId)
    const allSets = await db.sets.where('matchId').equals(matchId).sortBy('index')
    const allEvents = await db.events.where('matchId').equals(matchId).sortBy('seq')
    uploadScoresheetAsync({
      match: updatedMatchForScoresheet,
      homeTeam: { name: home, shortName: homeShortName },
      awayTeam: { name: away, shortName: awayShortName },
      homePlayers: homeRoster,
      awayPlayers: awayRoster,
      sets: allSets,
      events: allEvents
    })

    // Success!
    setInitModal({ status: 'success', message: t('coinToss.matchInitialized', 'Match initialized!') })

    // Short delay to show success message
    await new Promise(resolve => setTimeout(resolve, 1000))

    setInitModal(null)
    console.log('[CoinToss] Coin toss complete, navigating to scoreboard')
    // Navigate to scoreboard
    onConfirm(matchId)
  }

  async function confirmCoinToss() {
    console.log('[CoinToss] confirmCoinToss called, match:', { id: matchId, test: match?.test })

    // Validation checks (skip for test matches)
    if (!match?.test) {
      const validationErrors = []

      // 1. Check team names are set (not default "Home"/"Away" or empty)
      if (!home || home === 'Home' || home.trim() === '') {
        validationErrors.push('Home team name is not set')
      }
      if (!away || away === 'Away' || away.trim() === '') {
        validationErrors.push('Away team name is not set')
      }

      // 2. Check at least 1 referee and 1 scorer with names
      const ref1 = match?.officials?.find(o => o.role === '1st referee')
      const scorer = match?.officials?.find(o => o.role === 'scorer')
      if (!ref1?.lastName || !ref1?.firstName) {
        validationErrors.push('1st Referee name is not set')
      }
      if (!scorer?.lastName || !scorer?.firstName) {
        validationErrors.push('Scorer name is not set')
      }

      // 3. Check match info (hall, city, league, date)
      if (!match?.hall || match.hall.trim() === '') {
        validationErrors.push('Hall is not set')
      }
      if (!match?.city || match.city.trim() === '') {
        validationErrors.push('City is not set')
      }
      if (!match?.league || match.league.trim() === '') {
        validationErrors.push('League is not set')
      }
      if (!match?.scheduledAt) {
        validationErrors.push('Match date/time is not set')
      }

      // 4. Check at least 6 non-libero players per team with numbers
      const homeNonLiberoWithNumbers = homeRoster.filter(p => !p.libero && p.number != null && p.number !== '')
      const awayNonLiberoWithNumbers = awayRoster.filter(p => !p.libero && p.number != null && p.number !== '')
      if (homeNonLiberoWithNumbers.length < 6) {
        validationErrors.push(`Home team needs at least 6 players with numbers (not liberos). Currently: ${homeNonLiberoWithNumbers.length}`)
      }
      if (awayNonLiberoWithNumbers.length < 6) {
        validationErrors.push(`Away team needs at least 6 players with numbers (not liberos). Currently: ${awayNonLiberoWithNumbers.length}`)
      }

      // 4b. Check ALL players have jersey numbers (including liberos)
      const homePlayersWithoutNumbers = homeRoster.filter(p => p.number == null || p.number === '')
      const awayPlayersWithoutNumbers = awayRoster.filter(p => p.number == null || p.number === '')
      if (homePlayersWithoutNumbers.length > 0) {
        validationErrors.push(`Home team: all players must have jersey numbers (${homePlayersWithoutNumbers.length} missing)`)
      }
      if (awayPlayersWithoutNumbers.length > 0) {
        validationErrors.push(`Away team: all players must have jersey numbers (${awayPlayersWithoutNumbers.length} missing)`)
      }

      // 5. Check at least 1 coach per team
      const homeCoach = benchHome.find(b => b.role === 'Coach' && (b.lastName || b.firstName))
      const awayCoach = benchAway.find(b => b.role === 'Coach' && (b.lastName || b.firstName))
      if (!homeCoach) {
        validationErrors.push('Home team coach is not set')
      }
      if (!awayCoach) {
        validationErrors.push('Away team coach is not set')
      }

      // 6. Check captain is set for each team
      const homeCaptainPlayer = homeRoster.find(p => p.isCaptain)
      const awayCaptainPlayer = awayRoster.find(p => p.isCaptain)
      if (!homeCaptainPlayer) {
        validationErrors.push('Home team captain is not set')
      }
      if (!awayCaptainPlayer) {
        validationErrors.push('Away team captain is not set')
      }

      // 7. Check for duplicate jersey numbers
      const homeNumbers = homeRoster.filter(p => p.number != null && p.number !== '').map(p => p.number)
      const homeDuplicateNumbers = homeNumbers.filter((num, idx) => homeNumbers.indexOf(num) !== idx)
      if (homeDuplicateNumbers.length > 0) {
        validationErrors.push(`Home team has duplicate jersey numbers: ${[...new Set(homeDuplicateNumbers)].join(', ')}`)
      }
      const awayNumbers = awayRoster.filter(p => p.number != null && p.number !== '').map(p => p.number)
      const awayDuplicateNumbers = awayNumbers.filter((num, idx) => awayNumbers.indexOf(num) !== idx)
      if (awayDuplicateNumbers.length > 0) {
        validationErrors.push(`Away team has duplicate jersey numbers: ${[...new Set(awayDuplicateNumbers)].join(', ')}`)
      }

      // 8. Check for duplicate players (same last name and first name)
      const homePlayerNames = homeRoster.map(p => `${(p.lastName || '').toLowerCase()} ${(p.firstName || '').toLowerCase()}`.trim())
      const homeDuplicatePlayers = homePlayerNames.filter((name, idx) => name && homePlayerNames.indexOf(name) !== idx)
      if (homeDuplicatePlayers.length > 0) {
        validationErrors.push(`Home team has duplicate players: ${[...new Set(homeDuplicatePlayers)].join(', ')}`)
      }
      const awayPlayerNames = awayRoster.map(p => `${(p.lastName || '').toLowerCase()} ${(p.firstName || '').toLowerCase()}`.trim())
      const awayDuplicatePlayers = awayPlayerNames.filter((name, idx) => name && awayPlayerNames.indexOf(name) !== idx)
      if (awayDuplicatePlayers.length > 0) {
        validationErrors.push(`Away team has duplicate players: ${[...new Set(awayDuplicatePlayers)].join(', ')}`)
      }

      // 9. Check no birthdate is exactly 01.01.1900 (placeholder/error date)
      const allRosterPlayers = [...homeRoster, ...awayRoster]
      const allBenchOfficials = [...benchHome, ...benchAway]
      const playersWithBadDate = allRosterPlayers.filter(p => p.dob === '01.01.1900' || p.dob === '01/01/1900')
      const benchWithBadDate = allBenchOfficials.filter(b => b.dob === '01.01.1900' || b.dob === '01/01/1900')
      if (playersWithBadDate.length > 0 || benchWithBadDate.length > 0) {
        validationErrors.push('Some players or officials have invalid birthdate (01.01.1900). Please correct these dates.')
      }

      // 10. Check for invalid player numbers (must be 1-99)
      const homeInvalidNumbers = homeRoster.filter(p => p.number != null && (p.number < 1 || p.number > 99))
      const awayInvalidNumbers = awayRoster.filter(p => p.number != null && (p.number < 1 || p.number > 99))
      if (homeInvalidNumbers.length > 0) {
        validationErrors.push(`Home team has invalid jersey numbers (must be 1-99): ${homeInvalidNumbers.map(p => p.number).join(', ')}`)
      }
      if (awayInvalidNumbers.length > 0) {
        validationErrors.push(`Away team has invalid jersey numbers (must be 1-99): ${awayInvalidNumbers.map(p => p.number).join(', ')}`)
      }

      // 11. Check for players without numbers
      const homeNoNumbers = homeRoster.filter(p => p.number == null || p.number === '')
      const awayNoNumbers = awayRoster.filter(p => p.number == null || p.number === '')
      if (homeNoNumbers.length > 0) {
        validationErrors.push(`Home team has ${homeNoNumbers.length} player(s) without jersey numbers`)
      }
      if (awayNoNumbers.length > 0) {
        validationErrors.push(`Away team has ${awayNoNumbers.length} player(s) without jersey numbers`)
      }

      // Show validation errors if any
      if (validationErrors.length > 0) {
        console.log('[CoinToss] Validation errors:', validationErrors)
        setNoticeModal({ message: validationErrors.join('\n') })
        return
      }
      console.log('[CoinToss] All validations passed')

      // 12. Check for dates that might be import errors (01.01.yyyy for any year) - ask for confirmation
      const suspiciousDates = []
      allRosterPlayers.forEach(p => {
        if (p.dob && (p.dob.startsWith('01.01.') || p.dob.startsWith('01/01/'))) {
          suspiciousDates.push(`${p.lastName || ''} ${p.firstName || ''}: ${p.dob}`)
        }
      })
      allBenchOfficials.forEach(b => {
        if (b.dob && (b.dob.startsWith('01.01.') || b.dob.startsWith('01/01/'))) {
          suspiciousDates.push(`${b.lastName || ''} ${b.firstName || ''} (${b.role}): ${b.dob}`)
        }
      })
      if (suspiciousDates.length > 0) {
        // Show modal and wait for user confirmation
        setBirthdateConfirmModal({
          suspiciousDates,
          onConfirm: () => {
            setBirthdateConfirmModal(null)
            // Continue with coin toss after confirmation
            proceedWithCoinToss()
          }
        })
        return
      }

      // Check signatures for official matches
      if (!homeCoachSignature || !homeCaptainSignature || !awayCoachSignature || !awayCaptainSignature) {
        setNoticeModal({ message: t('coinToss.validation.completeSignatures') })
        return
      }
    }

    // All validations passed, proceed
    proceedWithCoinToss()
  }

  async function handleReturnToMatch() {
    // Save coin toss result when returning
    if (matchId) {
      const firstServeTeam = serveA ? teamA : teamB
      await db.matches.update(matchId, {
        firstServe: firstServeTeam,
        coinTossTeamA: teamA,
        coinTossTeamB: teamB,
        coinTossServeA: serveA,
        coinTossServeB: serveB
      })

      const matchData = await db.matches.get(matchId)
      if (matchData?.seed_key) {
        await db.sync_queue.add({
          resource: 'match',
          action: 'update',
          payload: {
            id: matchData.seed_key, // Use seed_key (external_id) for Supabase lookup
            status: matchData.status || null,
            // JSONB columns only
            home_team: { name: home, short_name: homeShortName || generateShortName(home), color: homeColor },
            away_team: { name: away, short_name: awayShortName || generateShortName(away), color: awayColor },
            players_home: homeRoster.map(p => ({
              number: p.number,
              first_name: p.firstName,
              last_name: p.lastName,
              dob: p.dob || null,
              libero: p.libero || '',
              is_captain: !!p.isCaptain,
              is_lfp: !!p.isLfp
            })),
            players_away: awayRoster.map(p => ({
              number: p.number,
              first_name: p.firstName,
              last_name: p.lastName,
              dob: p.dob || null,
              libero: p.libero || '',
              is_captain: !!p.isCaptain,
              is_lfp: !!p.isLfp
            })),
            bench_home: benchHome.map(b => ({
              role: b.role,
              first_name: b.firstName || '',
              last_name: b.lastName || '',
              dob: b.dob || null
            })),
            bench_away: benchAway.map(b => ({
              role: b.role,
              first_name: b.firstName || '',
              last_name: b.lastName || '',
              dob: b.dob || null
            })),
            officials: matchData.officials || []
          },
          ts: new Date().toISOString(),
          status: 'queued'
        })
      }
    }
    onConfirm(matchId)
  }

  // Computed values
  const teamAInfo = teamA === 'home'
    ? { name: home, shortName: homeShortName, color: homeColor, roster: homeRoster, bench: benchHome }
    : { name: away, shortName: awayShortName, color: awayColor, roster: awayRoster, bench: benchAway }
  const teamBInfo = teamB === 'home'
    ? { name: home, shortName: homeShortName, color: homeColor, roster: homeRoster, bench: benchHome }
    : { name: away, shortName: awayShortName, color: awayColor, roster: awayRoster, bench: benchAway }

  // Get display name - use short name if name is too long
  const getDisplayName = (name) => {
    return name
  }

  const teamACoachSig = teamA === 'home' ? homeCoachSignature : awayCoachSignature
  const teamACaptainSig = teamA === 'home' ? homeCaptainSignature : awayCaptainSignature
  const teamBCoachSig = teamB === 'home' ? homeCoachSignature : awayCoachSignature
  const teamBCaptainSig = teamB === 'home' ? homeCaptainSignature : awayCaptainSignature

  const sortRosterEntries = roster =>
    (roster || [])
      .map((player, index) => ({ player, index }))
      .sort((a, b) => {
        const an = Number(a.player?.number) || 0
        const bn = Number(b.player?.number) || 0
        return an - bn
      })


  // Volleyball images - responsive size
  const volleyballImage = (
    <div style={{
      width: vmin(15), height: vmin(15), display: 'flex',
      alignItems: 'center', justifyContent: 'center', flexShrink: 0
    }}>
      <img
        src={ballImage} onError={(e) => e.target.src = mikasaVolleyball}
        alt="Volleyball"
        style={{ maxWidth: '100%', maxHeight: '100%' }}
      />
    </div>
  )
  const volleyballPlaceholder = (
    <div style={{
      width: vmin(15), height: vmin(15), display: 'flex',
      alignItems: 'center', justifyContent: 'center', background: 'transparent', flexShrink: 0
    }} />
  )

  if (!match) {
    return <div className="setup"><p>{t('common.loading')}</p></div>
  }

  return (
    <div className="setup" style={{
      width: '95vw',
      maxWidth: '100vw',
      height: '100%',
      maxHeight: '100%',
      padding: isCompact ? '0 12px' : '5px 24px',
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: Math.round(4 * vhScale), flexShrink: 0 }}>
        <button className="secondary" onClick={onBack}>← {t('common.back')}</button>
        <h1 style={{ margin: 0, fontSize: `${Math.round(46 * vhScale)}px`, fontWeight: 700, textAlign: 'center' }}>{t('coinToss.title')}</h1>
        <div style={{ width: '80px' }}></div>
      </div>

      {/* Switch buttons row */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: '16px', marginBottom: Math.round(8 * vhScale), flexShrink: 0 }}>
        <button
          data-help-id="cointoss-team-selector"
          onClick={switchTeams}
          style={{
            padding: '8px 20px', fontSize: '1.5em', fontWeight: 800,
            background: '#000', color: 'var(--accent)', border: 'none', borderRadius: '8px',
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px',
            minHeight: sizes.actionButtonMinHeight
          }}
        >
          <span style={{ fontSize: '1.5em' }}>⇄</span> {t('coinToss.switchTeams')}
        </button>
        <button
          data-help-id="cointoss-serve-selector"
          onClick={switchServe}
          style={{
            padding: '8px 20px', fontSize: '1.5em', fontWeight: 800,
            background: '#000', color: 'var(--accent)', border: 'none', borderRadius: '8px',
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px',
            minHeight: sizes.actionButtonMinHeight
          }}
        >
          <img src={ballImage} onError={(e) => { e.target.src = mikasaVolleyball }} alt="" style={{ width: '2.5em', height: '2.5em' }} /> {t('coinToss.switchServe')}
        </button>
      </div>

      <div data-help-id="cointoss-side-selector" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 16px minmax(0, 1fr)', gap: sizes.gap, flex: 1, alignItems: 'stretch' }}>
        {/* Team A */}
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', justifyContent: 'space-evenly' }}>
          {/* Row 1: Team label + Team name bar */}
          <div style={{ width: '100%' }}>
            <h1 style={{ margin: 0, marginBottom: Math.round(6 * vhScale), fontSize: sizes.headerFont, fontWeight: 700, textAlign: 'center' }}>{t('coinToss.teamA')}</h1>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%' }}>
              <div
                style={{
                  background: teamAInfo.color,
                  color: isBrightColor(teamAInfo.color) ? '#000' : '#fff',
                  flex: 1, padding: sizes.teamButtonPadding, fontSize: sizes.teamButtonFont, width: '100%',
                  fontWeight: 600, border: 'none', borderRadius: '8px',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  cursor: 'default'
                }}
                title={teamAInfo.name}
              >
                {getDisplayName(teamAInfo.name)}
              </div>
            </div>
          </div>
          {/* Row 2: Volleyball (vertically centered between team label and roster button) */}
          <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            {serveA ? volleyballImage : volleyballPlaceholder}
          </div>
          {/* Row 3: Roster Button */}
          <button
            type="button"
            className="secondary"
            onClick={() => setRosterModal('teamA')}
            style={{ padding: sizes.actionButtonPadding, fontSize: sizes.actionButtonFont, minWidth: sizes.actionButtonMinWidth, minHeight: sizes.actionButtonMinHeight, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            {t('coinToss.showRoster')} ({teamAInfo.roster.length})
          </button>
          {/* Row 4: Signatures */}
          <div style={{ display: 'flex', justifyContent: 'center', width: '100%', position: 'relative', marginTop: '12px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <button
                onClick={() => { setSignatureMenuA(!signatureMenuA); setSignatureMenuB(false) }}
                className={`sign ${teamACoachSig && teamACaptainSig ? 'signed' : ''}`}
                style={{ fontSize: sizes.actionButtonFont, padding: sizes.actionButtonPadding, minWidth: sizes.actionButtonMinWidth, minHeight: sizes.actionButtonMinHeight, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                {t('coinToss.signA')} {teamACoachSig && teamACaptainSig ? '✓' : `(${(teamACoachSig ? 1 : 0) + (teamACaptainSig ? 1 : 0)}/2)`}
              </button>
              {signatureMenuA && (
                <div style={{
                  position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)',
                  marginTop: '8px', zIndex: 10,
                  background: 'var(--card)', border: '1px solid rgba(255,255,255,0.2)',
                  borderRadius: '8px', padding: isCompact ? '8px' : '12px',
                  display: 'flex', flexDirection: 'column', gap: isCompact ? '6px' : '10px'
                }}>
                  <button
                    onClick={() => { setOpenSignature(teamA === 'home' ? 'home-coach' : 'away-coach'); setSignatureMenuA(false) }}
                    className={`sign ${teamACoachSig ? 'signed' : ''}`}
                    style={{ fontSize: sizes.actionButtonFont, padding: sizes.actionButtonPadding, minWidth: sizes.actionButtonMinWidth, minHeight: sizes.actionButtonMinHeight, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  >
                    {t('coinToss.coach')} {teamACoachSig ? '✓' : ''}
                  </button>
                  <button
                    onClick={() => { setOpenSignature(teamA === 'home' ? 'home-captain' : 'away-captain'); setSignatureMenuA(false) }}
                    className={`sign ${teamACaptainSig ? 'signed' : ''}`}
                    style={{ fontSize: sizes.actionButtonFont, padding: sizes.actionButtonPadding, minWidth: sizes.actionButtonMinWidth, minHeight: sizes.actionButtonMinHeight, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  >
                    {t('coinToss.captain')} {teamACaptainSig ? '✓' : ''}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Middle spacer */}
        <div style={{ width: '16px' }} />

        {/* Team B */}
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', justifyContent: 'space-evenly' }}>
          {/* Row 1: Team label + Team name bar */}
          <div style={{ width: '100%' }}>
            <h1 style={{ margin: 0, marginBottom: Math.round(6 * vhScale), fontSize: sizes.headerFont, fontWeight: 700, textAlign: 'center' }}>{t('coinToss.teamB')}</h1>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%' }}>
              <div
                style={{
                  background: teamBInfo.color,
                  color: isBrightColor(teamBInfo.color) ? '#000' : '#fff',
                  flex: 1, padding: sizes.teamButtonPadding, fontSize: sizes.teamButtonFont, width: '100%',
                  fontWeight: 600, border: 'none', borderRadius: '8px',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  cursor: 'default'
                }}
                title={teamBInfo.name}
              >
                {getDisplayName(teamBInfo.name)}
              </div>
            </div>
          </div>
          {/* Row 2: Volleyball (vertically centered between team label and roster button) */}
          <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            {serveB ? volleyballImage : volleyballPlaceholder}
          </div>
          {/* Row 3: Roster Button */}
          <button
            type="button"
            className="secondary"
            onClick={() => setRosterModal('teamB')}
            style={{ padding: sizes.actionButtonPadding, fontSize: sizes.actionButtonFont, minWidth: sizes.actionButtonMinWidth, minHeight: sizes.actionButtonMinHeight, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            {t('coinToss.showRoster')} ({teamBInfo.roster.length})
          </button>
          {/* Row 3: Signatures */}
          <div style={{ display: 'flex', justifyContent: 'center', width: '100%', position: 'relative', marginTop: '12px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <button
                onClick={() => { setSignatureMenuB(!signatureMenuB); setSignatureMenuA(false) }}
                className={`sign ${teamBCoachSig && teamBCaptainSig ? 'signed' : ''}`}
                style={{ fontSize: sizes.actionButtonFont, padding: sizes.actionButtonPadding, minWidth: sizes.actionButtonMinWidth, minHeight: sizes.actionButtonMinHeight, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                {t('coinToss.signB')} {teamBCoachSig && teamBCaptainSig ? '✓' : `(${(teamBCoachSig ? 1 : 0) + (teamBCaptainSig ? 1 : 0)}/2)`}
              </button>
              {signatureMenuB && (
                <div style={{
                  position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)',
                  marginTop: '8px', zIndex: 10,
                  background: 'var(--card)', border: '1px solid rgba(255,255,255,0.2)',
                  borderRadius: '8px', padding: isCompact ? '8px' : '12px',
                  display: 'flex', flexDirection: 'column', gap: isCompact ? '6px' : '10px'
                }}>
                  <button
                    onClick={() => { setOpenSignature(teamB === 'home' ? 'home-coach' : 'away-coach'); setSignatureMenuB(false) }}
                    className={`sign ${teamBCoachSig ? 'signed' : ''}`}
                    style={{ fontSize: sizes.actionButtonFont, padding: sizes.actionButtonPadding, minWidth: sizes.actionButtonMinWidth, minHeight: sizes.actionButtonMinHeight, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  >
                    {t('coinToss.coach')} {teamBCoachSig ? '✓' : ''}
                  </button>
                  <button
                    onClick={() => { setOpenSignature(teamB === 'home' ? 'home-captain' : 'away-captain'); setSignatureMenuB(false) }}
                    className={`sign ${teamBCaptainSig ? 'signed' : ''}`}
                    style={{ fontSize: sizes.actionButtonFont, padding: sizes.actionButtonPadding, minWidth: sizes.actionButtonMinWidth, minHeight: sizes.actionButtonMinHeight, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  >
                    {t('coinToss.captain')} {teamBCaptainSig ? '✓' : ''}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Bottom buttons */}

      <div style={{ display: 'flex', justifyContent: 'center', marginTop: Math.round(8 * vhScale), flexShrink: 0 }}>
        <MenuList
          buttonLabel={isCompact ? "📄" : `📄 ${t('header.scoresheet')}`}
          buttonClassName="secondary"
          buttonStyle={{
            background: '#22c55e',
            color: '#000',
            fontWeight: 600,
            padding: isCompact ? '4px 8px' : '8px 16px',
            fontSize: isCompact ? '12px' : '14px'
          }}
          showArrow={true}
          position="center"
          items={[
            {
              key: 'scoresheet-preview',
              label: `🔍 ${t('header.preview')}`,
              onClick: async () => {
                try {
                  if (!match) {
                    showAlert(t('coinToss.noMatchData'), 'error')
                    return
                  }

                  // Fetch teams and players for scoresheet
                  const [homeTeam, awayTeam, homePlayers, awayPlayers] = await Promise.all([
                    match.homeTeamId ? db.teams.get(match.homeTeamId) : null,
                    match.awayTeamId ? db.teams.get(match.awayTeamId) : null,
                    match.homeTeamId ? db.players.where('teamId').equals(match.homeTeamId).toArray() : [],
                    match.awayTeamId ? db.players.where('teamId').equals(match.awayTeamId).toArray() : []
                  ])

                  const scoresheetData = {
                    match,
                    homeTeam,
                    awayTeam,
                    homePlayers: homePlayers || [],
                    awayPlayers: awayPlayers || [],
                    sets: [],
                    events: [],
                    sanctions: []
                  }

                  sessionStorage.setItem('scoresheetData', JSON.stringify(scoresheetData))
                  const scoresheetWindow = window.open(`/scoresheet?matchId=${matchId}`, '_blank', 'width=1200,height=900')

                  if (!scoresheetWindow) {
                    showAlert(t('coinToss.allowPopups'), 'warning')
                  }
                } catch (error) {
                  console.error('Error opening scoresheet:', error)
                  showAlert(t('coinToss.failedToOpenScoresheet', { error: error.message || 'Unknown error' }), 'error')
                }
              }
            }
          ]}
        />
      </div>
      <div data-help-id="cointoss-confirm-button" style={{ display: 'flex', justifyContent: 'center', marginTop: isCompact ? 4 : 8, paddingBottom: isCompact ? 12 : 20, flexShrink: 0 }}>
        {isCoinTossConfirmed ? (
          <button onClick={handleReturnToMatch} style={{ padding: sizes.confirmButtonPadding, fontSize: sizes.confirmButtonFont }}>
            {t('coinToss.returnToMatch')}
          </button>
        ) : (
          <button onClick={confirmCoinToss} style={{ padding: sizes.confirmButtonPadding, fontSize: sizes.confirmButtonFont }}>
            {t('coinToss.confirmResult')}
          </button>
        )}
      </div>

      {/* Roster Modal */}
      {rosterModal && (() => {
        const isTeamA = rosterModal === 'teamA'
        const currentTeam = isTeamA ? teamA : teamB
        const teamInfo = isTeamA ? teamAInfo : teamBInfo
        const roster = currentTeam === 'home' ? homeRoster : awayRoster
        const setRoster = currentTeam === 'home' ? setHomeRoster : setAwayRoster
        const bench = currentTeam === 'home' ? benchHome : benchAway
        const setBench = currentTeam === 'home' ? setBenchHome : setBenchAway
        const sortedBench = sortBenchByHierarchy(bench)
        const rosterEntries = sortRosterEntries(roster)

        // Store original data on first render of modal
        if (!originalRosterDataRef.current) {
          originalRosterDataRef.current = {
            roster: JSON.parse(JSON.stringify(roster)),
            bench: JSON.parse(JSON.stringify(bench))
          }
        }

        // Check if there are changes
        const hasChanges = hasRosterChanges(
          originalRosterDataRef.current?.roster,
          roster,
          originalRosterDataRef.current?.bench,
          bench
        )

        // Get signature state for this team
        const coachSig = currentTeam === 'home' ? homeCoachSignature : awayCoachSignature
        const captainSig = currentTeam === 'home' ? homeCaptainSignature : awayCaptainSignature
        const setCoachSig = currentTeam === 'home' ? setHomeCoachSignature : setAwayCoachSignature
        const setCaptainSig = currentTeam === 'home' ? setHomeCaptainSignature : setAwayCaptainSignature

        // Handle close/modify
        const handleCloseOrModify = async () => {
          if (hasChanges) {
            await syncRosterToDatabase(currentTeam, roster, bench)
          }
          originalRosterDataRef.current = null
          setRosterModalSignature(null)
          setRosterModal(null)
        }

        return (
          <Modal
            title={t('roster.titleWithTeam', { team: teamInfo.name })}
            open={true}
            onClose={handleCloseOrModify}
            width={800}
            hideCloseButton={true}
          >
            <div style={{ maxHeight: '70vh', overflowY: 'auto', padding: '0 16px' }}>
              {/* Players Section */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <h4 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>{t('roster.playersCount', { count: roster.length })}</h4>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setAddPlayerModal(rosterModal)}
                    style={{ padding: '4px 8px', fontSize: '12px' }}
                  >
                    {t('roster.addPlayer')}
                  </button>
                </div>
                <table className="roster-table" style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <th>{t('roster.number')}</th>
                      <th>{t('roster.name')}</th>
                      <th style={{ width: '90px' }}>{t('roster.dob')}</th>
                      <th>{t('roster.role')}</th>
                      {lfpTrackingEnabled && <th style={{ textAlign: 'center' }}>LFP</th>}
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rosterEntries.map(({ player: p, index: originalIdx }) => {
                      // Check for duplicate jersey number
                      const isDuplicate = p.number != null && p.number !== '' &&
                        roster.some((other, idx) => idx !== originalIdx && other.number === p.number)

                      return (
                        <tr key={`roster-${originalIdx}`}>
                          <td style={{ verticalAlign: 'middle', padding: '6px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                              <input
                                type="number"
                                inputMode="numeric"
                                min="1" max="99"
                                value={p.number ?? ''}
                                onChange={e => {
                                  const val = e.target.value ? Number(e.target.value) : null
                                  if (val !== null && (val < 1 || val > 99)) return
                                  const updated = [...roster]
                                  updated[originalIdx] = { ...updated[originalIdx], number: val }
                                  setRoster(updated)
                                }}
                                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }}
                                title={isDuplicate ? t('roster.duplicateNumber') : ''}
                                style={{
                                  width: p.isCaptain ? '24px' : '28px',
                                  height: p.isCaptain ? '24px' : 'auto',
                                  padding: '0', margin: '0',
                                  background: isDuplicate ? 'rgba(239, 68, 68, 0.2)' : 'transparent',
                                  border: isDuplicate ? '2px solid #ef4444' : (p.isCaptain ? '2px solid var(--accent)' : 'none'),
                                  borderRadius: p.isCaptain ? '50%' : (isDuplicate ? '4px' : '0'),
                                  color: isDuplicate ? '#ef4444' : 'var(--text)',
                                  textAlign: 'center', fontSize: '12px'
                                }}
                              />
                              {p.libero && (
                                <span style={{ color: 'var(--accent)', fontSize: '10px', fontWeight: 700 }}>
                                  {p.libero === 'libero1' ? 'L1' : 'L2'}
                                </span>
                              )}
                            </div>
                          </td>
                          <td style={{ verticalAlign: 'middle', padding: '6px' }}>
                            <input
                              type="text"
                              value={`${p.lastName || ''} ${p.firstName || ''}`.trim() || ''}
                              onChange={e => {
                                const parts = e.target.value.split(' ').filter(p => p)
                                const lastName = parts.length > 0 ? parts[0] : ''
                                const firstName = parts.length > 1 ? parts.slice(1).join(' ') : ''
                                const updated = [...roster]
                                updated[originalIdx] = { ...updated[originalIdx], lastName, firstName }
                                setRoster(updated)
                              }}
                              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }}
                              style={{ width: '100%', padding: '0', background: 'transparent', border: 'none', color: 'var(--text)', fontSize: '12px' }}
                            />
                          </td>
                          <td style={{ verticalAlign: 'middle', padding: '6px', width: '90px' }}>
                            <input
                              type="date"
                              value={p.dob ? formatDateToISO(p.dob) : ''}
                              onChange={e => {
                                const value = e.target.value ? formatDateToDDMMYYYY(e.target.value) : ''
                                const updated = [...roster]
                                updated[originalIdx] = { ...updated[originalIdx], dob: value }
                                setRoster(updated)
                              }}
                              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }}
                              className="coin-toss-date-input"
                              style={{ width: '100%', padding: '0', background: 'transparent', border: 'none', color: 'var(--text)', fontSize: '12px' }}
                            />
                          </td>
                          <td style={{ verticalAlign: 'middle', padding: '6px' }}>
                            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                              <select
                                value={p.libero || ''}
                                onChange={e => {
                                  const updated = [...roster]
                                  const oldValue = updated[originalIdx].libero
                                  updated[originalIdx] = { ...updated[originalIdx], libero: e.target.value }
                                  if (e.target.value === 'libero2') {
                                    const hasL1 = updated.some((player, idx) => idx !== originalIdx && player.libero === 'libero1')
                                    if (!hasL1) updated[originalIdx] = { ...updated[originalIdx], libero: 'libero1' }
                                  }
                                  if (oldValue === 'libero1' && !e.target.value) {
                                    const l2Idx = updated.findIndex((player, idx) => idx !== originalIdx && player.libero === 'libero2')
                                    if (l2Idx !== -1) updated[l2Idx] = { ...updated[l2Idx], libero: 'libero1' }
                                  }
                                  setRoster(updated)
                                }}
                                style={{ padding: '0', background: 'transparent', border: 'none', color: 'var(--text)', fontSize: '12px' }}
                                className="coin-toss-select"
                              >
                                <option value="" style={{ background: 'var(--bg)', color: 'var(--text)' }}></option>
                                {!roster.some((player, idx) => idx !== originalIdx && player.libero === 'libero1') && (
                                  <option value="libero1" style={{ background: 'var(--bg)', color: 'var(--text)' }}>L1</option>
                                )}
                                {!roster.some((player, idx) => idx !== originalIdx && player.libero === 'libero2') && (
                                  <option value="libero2" style={{ background: 'var(--bg)', color: 'var(--text)' }}>L2</option>
                                )}
                              </select>
                              <div
                                onClick={() => {
                                  const updated = roster.map((player, idx) => ({
                                    ...player,
                                    isCaptain: idx === originalIdx ? !player.isCaptain : false
                                  }))
                                  setRoster(updated)
                                }}
                                style={{
                                  width: '20px',
                                  height: '20px',
                                  borderRadius: '4px',
                                  border: p.isCaptain ? '2px solid #22c55e' : '2px solid rgba(255,255,255,0.3)',
                                  background: p.isCaptain ? 'rgba(34, 197, 94, 0.15)' : 'transparent',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  cursor: 'pointer',
                                  fontSize: '10px',
                                  fontWeight: 700,
                                  color: p.isCaptain ? '#22c55e' : 'rgba(255,255,255,0.3)',
                                  userSelect: 'none'
                                }}
                              >
                                C
                              </div>
                            </div>
                          </td>
                          {lfpTrackingEnabled && (
                            <td style={{ verticalAlign: 'middle', padding: '4px', textAlign: 'center' }}>
                              <div
                                onClick={() => {
                                  const updated = [...roster]
                                  updated[originalIdx] = { ...updated[originalIdx], isLfp: !p.isLfp }
                                  setRoster(updated)
                                }}
                                style={{
                                  width: '20px',
                                  height: '20px',
                                  borderRadius: '4px',
                                  border: p.isLfp ? '2px solid #f97316' : '2px solid rgba(255,255,255,0.3)',
                                  background: p.isLfp ? 'rgba(249, 115, 22, 0.15)' : 'transparent',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  cursor: 'pointer',
                                  fontSize: '8px',
                                  fontWeight: 700,
                                  color: p.isLfp ? '#f97316' : 'rgba(255,255,255,0.3)',
                                  userSelect: 'none'
                                }}
                              >
                                {p.isLfp ? 'LFP' : '\u2014'}
                              </div>
                            </td>
                          )}
                          <td style={{ verticalAlign: 'middle', padding: '4px' }}>
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => setDeletePlayerModal({ team: rosterModal, index: originalIdx })}
                              style={{ padding: '2px', fontSize: '10px', minWidth: 'auto', width: '20px', height: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                            >
                              🗑️
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* Bench Officials Section */}
              <div style={{ borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <h4 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>{t('roster.benchOfficialsCount', { count: bench.length })}</h4>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setBench([...bench, initBench('Coach')])}
                    style={{ padding: '4px 8px', fontSize: '12px' }}
                  >
                    {t('roster.addBench')}
                  </button>
                </div>
                <table className="roster-table" style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <th>{t('roster.role')}</th>
                      <th>{t('roster.name')}</th>
                      <th style={{ width: '90px' }}>{t('roster.dob')}</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedBench.map((official) => {
                      const originalIdx = bench.findIndex(b => b === official)
                      return (
                        <tr key={`bench-${originalIdx}`}>
                          <td style={{ verticalAlign: 'middle', padding: '6px' }}>
                            <select
                              value={official.role || ''}
                              onChange={e => {
                                const updated = [...bench]
                                updated[originalIdx] = { ...updated[originalIdx], role: e.target.value }
                                setBench(updated)
                              }}
                              className="coin-toss-select"
                              style={{ padding: '0', background: 'transparent', border: 'none', color: 'var(--text)', fontSize: '12px', width: '100%' }}
                            >
                              {BENCH_ROLES.map(role => (
                                <option key={role.value} value={role.value} style={{ background: 'var(--bg)', color: 'var(--text)' }}>
                                  {role.label} - {role.fullLabel}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td style={{ verticalAlign: 'middle', padding: '6px' }}>
                            <input
                              type="text"
                              value={`${official.lastName || ''} ${official.firstName || ''}`.trim() || ''}
                              onChange={e => {
                                const parts = e.target.value.split(' ').filter(p => p)
                                const lastName = parts.length > 0 ? parts[0] : ''
                                const firstName = parts.length > 1 ? parts.slice(1).join(' ') : ''
                                const updated = [...bench]
                                updated[originalIdx] = { ...updated[originalIdx], lastName, firstName }
                                setBench(updated)
                              }}
                              style={{ width: '100%', padding: '0', background: 'transparent', border: 'none', color: 'var(--text)', fontSize: '12px' }}
                            />
                          </td>
                          <td style={{ verticalAlign: 'middle', padding: '6px', width: '90px' }}>
                            <input
                              type="date"
                              value={official.dob ? formatDateToISO(official.dob) : ''}
                              onChange={e => {
                                const value = e.target.value ? formatDateToDDMMYYYY(e.target.value) : ''
                                const updated = [...bench]
                                updated[originalIdx] = { ...updated[originalIdx], dob: value }
                                setBench(updated)
                              }}
                              className="coin-toss-date-input"
                              style={{ width: '100%', padding: '0', background: 'transparent', border: 'none', color: 'var(--text)', fontSize: '12px' }}
                            />
                          </td>
                          <td style={{ verticalAlign: 'middle', padding: '4px' }}>
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => setBench(bench.filter((_, i) => i !== originalIdx))}
                              style={{ padding: '2px', fontSize: '10px', minWidth: 'auto', width: '20px', height: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                            >
                              🗑️
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* Signatures Section */}
              <div style={{ borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 16, marginTop: 16 }}>
                <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: 600 }}>{t('roster.signatures')}</h4>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className={`sign ${coachSig ? 'signed' : ''}`}
                    onClick={() => setRosterModalSignature('coach')}
                    style={{ padding: '8px 16px', fontSize: '13px', flex: 1, minWidth: '120px' }}
                  >
                    {t('coinToss.coach')} {coachSig ? '✓' : ''}
                  </button>
                  <button
                    type="button"
                    className={`sign ${captainSig ? 'signed' : ''}`}
                    onClick={() => setRosterModalSignature('captain')}
                    style={{ padding: '8px 16px', fontSize: '13px', flex: 1, minWidth: '120px' }}
                  >
                    {t('coinToss.captain')} {captainSig ? '✓' : ''}
                  </button>
                </div>
              </div>

              {/* Signature Pad Modal */}
              {rosterModalSignature && (
                <div style={{
                  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100
                }}>
                  <div style={{
                    background: '#111827', padding: 16, borderRadius: 12,
                    border: '1px solid rgba(255,255,255,0.1)', maxWidth: '90vw'
                  }}>
                    <h3 style={{ margin: '0 0 12px 0' }}>
                      {t('roster.signatureTitle', { role: t(rosterModalSignature === 'coach' ? 'coinToss.coach' : 'coinToss.captain'), team: teamInfo.name })}
                    </h3>
                    <SignaturePad
                      onSave={(sig) => {
                        if (rosterModalSignature === 'coach') {
                          setCoachSig(sig)
                        } else {
                          setCaptainSig(sig)
                        }
                        setRosterModalSignature(null)
                      }}
                      onCancel={() => setRosterModalSignature(null)}
                      title={t('roster.signatureTitle', { role: t(rosterModalSignature === 'coach' ? 'coinToss.coach' : 'coinToss.captain'), team: '' }).replace(' - ', '')}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Custom Close/Modify Button */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 16, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.1)' }}>
              {hasChanges && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    // Revert to original data
                    if (originalRosterDataRef.current) {
                      setRoster(JSON.parse(JSON.stringify(originalRosterDataRef.current.roster)))
                      setBench(JSON.parse(JSON.stringify(originalRosterDataRef.current.bench)))
                    }
                    originalRosterDataRef.current = null
                    setRosterModalSignature(null)
                    setRosterModal(null)
                  }}
                  style={{ padding: '8px 20px', fontSize: '14px' }}
                >
                  {t('common.cancel')}
                </button>
              )}
              <button
                type="button"
                className={hasChanges ? 'primary' : 'secondary'}
                onClick={handleCloseOrModify}
                style={{ padding: '8px 20px', fontSize: '14px' }}
              >
                {hasChanges ? t('roster.modify') : t('common.close')}
              </button>
            </div>
          </Modal>
        )
      })()}

      {/* Add Player Modal */}
      {addPlayerModal && (() => {
        const isTeamA = addPlayerModal === 'teamA'
        const currentTeam = isTeamA ? teamA : teamB
        const roster = currentTeam === 'home' ? homeRoster : awayRoster
        const num = currentTeam === 'home' ? homeNum : awayNum
        const first = currentTeam === 'home' ? homeFirst : awayFirst
        const last = currentTeam === 'home' ? homeLast : awayLast
        const dob = currentTeam === 'home' ? homeDob : awayDob
        const libero = currentTeam === 'home' ? homeLibero : awayLibero
        const captain = currentTeam === 'home' ? homeCaptain : awayCaptain

        return (
          <Modal
            title={t('roster.addPlayerTitle', { team: t(isTeamA ? 'coinToss.teamA' : 'coinToss.teamB') })}
            open={true}
            onClose={() => setAddPlayerModal(null)}
            width={500}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ display: 'block', marginBottom: 4 }}>{t('roster.numberLabel')}</label>
                <input
                  type="number"
                  inputMode="numeric"
                  value={num}
                  onChange={e => currentTeam === 'home' ? setHomeNum(e.target.value) : setAwayNum(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }}
                  style={{ width: '100%', padding: '8px', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '4px', color: 'var(--text)' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 4 }}>{t('roster.lastName')}</label>
                <input
                  type="text"
                  className="capitalize"
                  value={last}
                  onChange={e => currentTeam === 'home' ? setHomeLast(e.target.value) : setAwayLast(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }}
                  style={{ width: '100%', padding: '8px', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '4px', color: 'var(--text)' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 4 }}>{t('roster.firstName')}</label>
                <input
                  type="text"
                  className="capitalize"
                  value={first}
                  onChange={e => currentTeam === 'home' ? setHomeFirst(e.target.value) : setAwayFirst(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }}
                  style={{ width: '100%', padding: '8px', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '4px', color: 'var(--text)' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 4 }}>{t('roster.dateOfBirth')}</label>
                <input
                  type="date"
                  value={dob ? formatDateToISO(dob) : ''}
                  onChange={e => {
                    const value = e.target.value ? formatDateToDDMMYYYY(e.target.value) : ''
                    currentTeam === 'home' ? setHomeDob(value) : setAwayDob(value)
                  }}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }}
                  style={{ width: '100%', padding: '8px', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '4px', color: 'var(--text)' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 4 }}>{t('roster.libero')}</label>
                <select
                  value={libero}
                  onChange={e => {
                    let newValue = e.target.value
                    if (newValue === 'libero2') {
                      const hasL1 = roster.some(p => p.libero === 'libero1')
                      if (!hasL1) newValue = 'libero1'
                    }
                    currentTeam === 'home' ? setHomeLibero(newValue) : setAwayLibero(newValue)
                  }}
                  style={{ width: '100%', padding: '8px', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '4px', color: 'var(--text)' }}
                >
                  <option value="">{t('roster.none')}</option>
                  {!roster.some(p => p.libero === 'libero1') && <option value="libero1">{t('roster.liberoFull1')}</option>}
                  {!roster.some(p => p.libero === 'libero2') && <option value="libero2">{t('roster.liberoFull2')}</option>}
                </select>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div
                  onClick={() => currentTeam === 'home' ? setHomeCaptain(!captain) : setAwayCaptain(!captain)}
                  style={{
                    width: '28px',
                    height: '28px',
                    borderRadius: '4px',
                    border: captain ? '2px solid #22c55e' : '2px solid rgba(255,255,255,0.3)',
                    background: captain ? 'rgba(34, 197, 94, 0.15)' : 'transparent',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    fontSize: '14px',
                    fontWeight: 700,
                    color: captain ? '#22c55e' : 'rgba(255,255,255,0.3)',
                    userSelect: 'none'
                  }}
                >
                  C
                </div>
                <span style={{ cursor: 'pointer' }} onClick={() => currentTeam === 'home' ? setHomeCaptain(!captain) : setAwayCaptain(!captain)}>
                  {t('coinToss.captain')}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
                <button className="secondary" onClick={() => setAddPlayerModal(null)}>{t('common.cancel')}</button>
                <button onClick={() => {
                  if (!last || !first) {
                    showAlert(t('roster.enterNames'), 'warning')
                    return
                  }
                  const newPlayer = { number: num ? Number(num) : null, lastName: last, firstName: first, dob, libero, isCaptain: captain }

                  if (currentTeam === 'home') {
                    setHomeRoster(list => {
                      const cleared = captain ? list.map(p => ({ ...p, isCaptain: false })) : [...list]
                      return [...cleared, newPlayer].sort((a, b) => (a.number ?? 999) - (b.number ?? 999))
                    })
                    setHomeNum(''); setHomeFirst(''); setHomeLast(''); setHomeDob(''); setHomeLibero(''); setHomeCaptain(false)
                  } else {
                    setAwayRoster(list => {
                      const cleared = captain ? list.map(p => ({ ...p, isCaptain: false })) : [...list]
                      return [...cleared, newPlayer].sort((a, b) => (a.number ?? 999) - (b.number ?? 999))
                    })
                    setAwayNum(''); setAwayFirst(''); setAwayLast(''); setAwayDob(''); setAwayLibero(''); setAwayCaptain(false)
                  }
                  setAddPlayerModal(null)
                }}>{t('roster.addPlayerButton')}</button>
              </div>
            </div>
          </Modal>
        )
      })()}

      {/* Delete Player Modal */}
      {deletePlayerModal && (() => {
        const isTeamA = deletePlayerModal.team === 'teamA'
        const currentTeam = isTeamA ? teamA : teamB
        const roster = currentTeam === 'home' ? homeRoster : awayRoster
        const player = roster[deletePlayerModal.index]
        const playerName = player ? `${player.lastName || ''} ${player.firstName || ''}`.trim() || `Player #${player.number || '?'}` : 'Player'

        return (
          <Modal
            title={t('modal.deletePlayer')}
            open={true}
            onClose={() => setDeletePlayerModal(null)}
            width={400}
          >
            <div style={{ padding: '16px 0' }}>
              <p style={{ marginBottom: 16 }}>
                Are you sure you want to delete <strong>{playerName}</strong> from {isTeamA ? 'Team A' : 'Team B'}?
              </p>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="secondary" onClick={() => setDeletePlayerModal(null)}>Cancel</button>
                <button onClick={() => {
                  if (currentTeam === 'home') {
                    setHomeRoster(list => list.filter((_, idx) => idx !== deletePlayerModal.index))
                  } else {
                    setAwayRoster(list => list.filter((_, idx) => idx !== deletePlayerModal.index))
                  }
                  setDeletePlayerModal(null)
                }}>Delete</button>
              </div>
            </div>
          </Modal>
        )
      })()}

      {/* Notice Modal */}
      {noticeModal && (
        <Modal
          title={t('matchSetup.modals.notice')}
          open={true}
          onClose={() => setNoticeModal(null)}
          width={400}
          hideCloseButton={true}
        >
          <div style={{ padding: '24px', textAlign: 'center' }}>
            <p style={{ marginBottom: '24px', fontSize: '16px', color: 'var(--text)', whiteSpace: 'pre-line' }}>
              {noticeModal.message}
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                onClick={() => setNoticeModal(null)}
                style={{
                  padding: '12px 24px', fontSize: '14px', fontWeight: 600,
                  background: 'var(--accent)', color: '#000',
                  border: 'none', borderRadius: '8px', cursor: 'pointer'
                }}
              >
                OK
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Initialization Modal */}
      {initModal && (
        <Modal
          title={initModal.status === 'success' ? t('coinToss.initialized', 'Match Initialized') :
            initModal.status === 'error' ? t('coinToss.initError', 'Initialization Error') :
              t('coinToss.initializing', 'Initializing Match')}
          open={true}
          onClose={initModal.status === 'error' ? () => setInitModal(null) : undefined}
          width={450}
          hideCloseButton={initModal.status !== 'error'}
        >
          <div style={{ padding: '24px', textAlign: 'center' }}>
            {/* Status Icon */}
            <div style={{ marginBottom: '20px' }}>
              {initModal.status === 'syncing' && (
                <div style={{
                  width: '60px', height: '60px', margin: '0 auto',
                  border: '4px solid rgba(59, 130, 246, 0.3)',
                  borderTop: '4px solid #3b82f6',
                  borderRadius: '50%',
                  animation: 'spin 1s linear infinite'
                }} />
              )}
              {initModal.status === 'verifying' && (
                <div style={{
                  width: '60px', height: '60px', margin: '0 auto',
                  border: '4px solid rgba(234, 179, 8, 0.3)',
                  borderTop: '4px solid #eab308',
                  borderRadius: '50%',
                  animation: 'spin 1s linear infinite'
                }} />
              )}
              {initModal.status === 'success' && (
                <div style={{
                  width: '60px', height: '60px', margin: '0 auto',
                  background: 'rgba(34, 197, 94, 0.2)',
                  borderRadius: '50%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center'
                }}>
                  <span style={{ fontSize: '32px', color: '#22c55e' }}>✓</span>
                </div>
              )}
              {initModal.status === 'error' && (
                <div style={{
                  width: '60px', height: '60px', margin: '0 auto',
                  background: 'rgba(239, 68, 68, 0.2)',
                  borderRadius: '50%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center'
                }}>
                  <span style={{ fontSize: '32px', color: '#ef4444' }}>✕</span>
                </div>
              )}
            </div>

            {/* Message */}
            <p style={{
              marginBottom: '24px',
              fontSize: '16px',
              color: initModal.status === 'error' ? '#ef4444' :
                initModal.status === 'success' ? '#22c55e' : 'var(--text)'
            }}>
              {initModal.message}
            </p>

            {/* Error button */}
            {initModal.status === 'error' && (
              <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
                <button
                  onClick={() => setInitModal(null)}
                  style={{
                    padding: '12px 24px', fontSize: '14px', fontWeight: 600,
                    background: 'rgba(239, 68, 68, 0.2)', color: '#ef4444',
                    border: '1px solid #ef4444', borderRadius: '8px', cursor: 'pointer'
                  }}
                >
                  {t('common.back', 'Back')}
                </button>
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* CSS for spinner animation */}
      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>

      {/* Birthdate Confirmation Modal */}
      {birthdateConfirmModal && (
        <Modal
          title={t('coinToss.confirmBirthdates')}
          open={true}
          onClose={() => setBirthdateConfirmModal(null)}
          width={500}
          hideCloseButton={true}
        >
          <div style={{ padding: '24px' }}>
            <p style={{ marginBottom: '16px', fontSize: '14px', color: '#eab308' }}>
              The following people have birthdates on January 1st, which may indicate import errors:
            </p>
            <div style={{
              background: 'rgba(234, 179, 8, 0.1)',
              border: '1px solid rgba(234, 179, 8, 0.3)',
              borderRadius: '8px',
              padding: '12px',
              marginBottom: '20px',
              maxHeight: '200px',
              overflowY: 'auto'
            }}>
              {birthdateConfirmModal.suspiciousDates.map((date, idx) => (
                <div key={idx} style={{ fontSize: '13px', color: 'var(--text)', padding: '4px 0' }}>
                  {date}
                </div>
              ))}
            </div>
            <p style={{ marginBottom: '20px', fontSize: '14px', color: 'var(--text)' }}>
              Are these dates correct?
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                onClick={() => setBirthdateConfirmModal(null)}
                className="secondary"
                style={{ padding: '12px 24px', fontSize: '14px' }}
              >
                No, go back
              </button>
              <button
                onClick={birthdateConfirmModal.onConfirm}
                style={{
                  padding: '12px 24px', fontSize: '14px', fontWeight: 600,
                  background: 'var(--accent)', color: '#000',
                  border: 'none', borderRadius: '8px', cursor: 'pointer'
                }}
              >
                Yes, continue
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Signature Pad */}
      <SignaturePad
        open={openSignature !== null}
        onClose={() => setOpenSignature(null)}
        onSave={handleSignatureSave}
        title={openSignature === 'home-coach' ? 'Home Coach Signature' :
          openSignature === 'home-captain' ? 'Home Captain Signature' :
            openSignature === 'away-coach' ? 'Away Coach Signature' :
              openSignature === 'away-captain' ? 'Away Captain Signature' : 'Sign'}
        existingSignature={
          openSignature === 'home-coach' ? homeCoachSignature :
            openSignature === 'home-captain' ? homeCaptainSignature :
              openSignature === 'away-coach' ? awayCoachSignature :
                openSignature === 'away-captain' ? awayCaptainSignature : null
        }
        readOnly={
          (openSignature === 'home-coach' && !!homeCoachSignature) ||
          (openSignature === 'home-captain' && !!homeCaptainSignature) ||
          (openSignature === 'away-coach' && !!awayCoachSignature) ||
          (openSignature === 'away-captain' && !!awayCaptainSignature)
        }
      />
    </div>
  )
}
