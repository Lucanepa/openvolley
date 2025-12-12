import { useState, useEffect, useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import SignaturePad from './SignaturePad'
import Modal from './Modal'
import mikasaVolleyball from '../mikasa_v200w.png'

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
  const parts = dateStr.split('.')
  if (parts.length !== 3) return dateStr
  const [day, month, year] = parts
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
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

export default function CoinToss({ matchId, onConfirm, onBack, onGoHome }) {
  // Team info state (loaded from DB)
  const [home, setHome] = useState('Home')
  const [away, setAway] = useState('Away')
  const [homeShortName, setHomeShortName] = useState('')
  const [awayShortName, setAwayShortName] = useState('')
  const [homeColor, setHomeColor] = useState('#ef4444')
  const [awayColor, setAwayColor] = useState('#3b82f6')

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
  const [openSignature, setOpenSignature] = useState(null)

  // Signatures
  const [homeCoachSignature, setHomeCoachSignature] = useState(null)
  const [homeCaptainSignature, setHomeCaptainSignature] = useState(null)
  const [awayCoachSignature, setAwayCoachSignature] = useState(null)
  const [awayCaptainSignature, setAwayCaptainSignature] = useState(null)
  const [savedSignatures, setSavedSignatures] = useState({
    homeCoach: null, homeCaptain: null, awayCoach: null, awayCaptain: null
  })

  // Check if coin toss was previously confirmed
  const isCoinTossConfirmed = useMemo(() => {
    return homeCoachSignature && homeCaptainSignature && awayCoachSignature && awayCaptainSignature &&
           homeCoachSignature === savedSignatures.homeCoach &&
           homeCaptainSignature === savedSignatures.homeCaptain &&
           awayCoachSignature === savedSignatures.awayCoach &&
           awayCaptainSignature === savedSignatures.awayCaptain
  }, [homeCoachSignature, homeCaptainSignature, awayCoachSignature, awayCaptainSignature, savedSignatures])

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
          setHome(homeTeam.name || 'Home')
          setHomeShortName(homeTeam.shortName || '')
          setHomeColor(homeTeam.color || '#ef4444')
        }
        if (awayTeam) {
          setAway(awayTeam.name || 'Away')
          setAwayShortName(awayTeam.shortName || '')
          setAwayColor(awayTeam.color || '#3b82f6')
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
            dob: p.dob || '',
            libero: p.libero || '',
            isCaptain: p.isCaptain || false
          })).sort((a, b) => (a.number || 999) - (b.number || 999)))
        }

        if (awayPlayers.length) {
          setAwayRoster(awayPlayers.map(p => ({
            number: p.number,
            lastName: p.lastName || (p.name ? p.name.split(' ')[0] : ''),
            firstName: p.firstName || (p.name ? p.name.split(' ').slice(1).join(' ') : ''),
            dob: p.dob || '',
            libero: p.libero || '',
            isCaptain: p.isCaptain || false
          })).sort((a, b) => (a.number || 999) - (b.number || 999)))
        }

        // Load bench officials
        if (homeTeam?.benchOfficials?.length) {
          setBenchHome(homeTeam.benchOfficials)
        }
        if (awayTeam?.benchOfficials?.length) {
          setBenchAway(awayTeam.benchOfficials)
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

  async function confirmCoinToss() {
    // Only check signatures for official matches
    if (!match?.test) {
      if (!homeCoachSignature || !homeCaptainSignature || !awayCoachSignature || !awayCaptainSignature) {
        setNoticeModal({ message: 'Please complete all signatures before confirming the coin toss.' })
        return
      }
    }

    if (!matchId) {
      console.error('[COIN TOSS] No match ID available')
      alert('Error: No match ID found')
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
        coinTossServeB: serveB
      }

      // Only save signatures for official matches
      if (!match?.test) {
        updateData.homeCoachSignature = homeCoachSignature
        updateData.homeCaptainSignature = homeCaptainSignature
        updateData.awayCoachSignature = awayCoachSignature
        updateData.awayCaptainSignature = awayCaptainSignature
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

      // Add match update to sync queue
      const updatedMatch = await db.matches.get(matchId)
      if (updatedMatch) {
        await db.sync_queue.add({
          resource: 'match',
          action: 'update',
          payload: {
            id: String(matchId),
            status: updatedMatch.status || null,
            hall: updatedMatch.hall || null,
            city: updatedMatch.city || null,
            league: updatedMatch.league || null,
            scheduled_at: updatedMatch.scheduledAt || null
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
              isCaptain: !!p.isCaptain
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
              isCaptain: !!p.isCaptain
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

    // Add first set to sync queue
    await db.sync_queue.add({
      resource: 'set',
      action: 'insert',
      payload: {
        external_id: String(firstSetId),
        match_id: String(matchId),
        index: 1,
        home_points: 0,
        away_points: 0,
        finished: false,
        test: isTest,
        created_at: new Date().toISOString()
      },
      ts: new Date().toISOString(),
      status: 'queued'
    })

    // Update match status to 'live'
    await db.matches.update(matchId, { status: 'live' })

    // Update saved signatures
    setSavedSignatures({
      homeCoach: homeCoachSignature,
      homeCaptain: homeCaptainSignature,
      awayCoach: awayCoachSignature,
      awayCaptain: awayCaptainSignature
    })

    // Small delay to ensure DB commits
    await new Promise(resolve => setTimeout(resolve, 100))

    // Navigate to scoreboard
    onConfirm(matchId)
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
      if (matchData) {
        await db.sync_queue.add({
          resource: 'match',
          action: 'update',
          payload: {
            id: String(matchId),
            status: matchData.status || null,
            hall: matchData.hall || null,
            city: matchData.city || null,
            league: matchData.league || null,
            scheduled_at: matchData.scheduledAt || null
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
  const getDisplayName = (name, shortName) => {
    if (name && name.length > 15 && shortName) return shortName
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
  const imageSize = '48px'
  const volleyballImage = (
    <div style={{
      width: imageSize, height: imageSize, display: 'flex',
      alignItems: 'center', justifyContent: 'center', flexShrink: 0
    }}>
      <img
        src={mikasaVolleyball}
        alt="Mikasa V200W Volleyball"
        style={{ maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto', objectFit: 'contain' }}
      />
    </div>
  )
  const volleyballPlaceholder = (
    <div style={{
      width: imageSize, height: imageSize, display: 'flex',
      alignItems: 'center', justifyContent: 'center', background:'transparent', flexShrink: 0
    }}>
      <div style={{ width: '24px', height: '24px', background: 'transparent' }} />
    </div>
  )

  if (!match) {
    return <div className="setup"><p>Loading...</p></div>
  }

  return (
    <div className="setup">
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
        <button className="secondary" onClick={onBack}>← Back</button>
        <h1 style={{ margin: 0 }}>Coin Toss</h1>
        {onGoHome ? (
          <button className="secondary" onClick={onGoHome}>Home</button>
        ) : (
          <div style={{ width: 80 }}></div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)', gap: 12, marginBottom: 24, alignItems: 'start' }}>
        {/* Team A */}
        <div style={{ minWidth: 0 }}>
          <h1 style={{ margin: 2, fontSize: '20px', fontWeight: 700, textAlign: 'center' }}>Team A</h1>
          <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8, minHeight: '40px' }}>
            <button
              type="button"
              style={{
                background: teamAInfo.color,
                color: isBrightColor(teamAInfo.color) ? '#000' : '#fff',
                flex: 1, padding: '8px 12px', fontSize: '13px', width: '100%',
                fontWeight: 600, border: 'none', borderRadius: '8px',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                minWidth: 0
              }}
              title={teamAInfo.name}
            >
              {getDisplayName(teamAInfo.name, teamAInfo.shortName)}
            </button>
          </div>

          <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'center', height: '48px', alignItems: 'center' }}>
            {serveA ? volleyballImage : volleyballPlaceholder}
          </div>

          {/* Team A Roster Button */}
          <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'center' }}>
            <button
              type="button"
              className="secondary"
              onClick={() => setRosterModal('teamA')}
              style={{ padding: '6px 12px', fontSize: '12px' }}
            >
              Roster ({teamAInfo.roster.length})
            </button>
          </div>

          {/* Team A Signatures */}
          <div style={{ marginTop: 16, paddingTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <button
                onClick={() => { setSignatureMenuA(!signatureMenuA); setSignatureMenuB(false) }}
                className={`sign ${teamACoachSig && teamACaptainSig ? 'signed' : ''}`}
                style={{ fontSize: '12px', padding: '6px 12px', minWidth: 'auto' }}
              >
                Sign A {teamACoachSig && teamACaptainSig ? '✓' : `(${(teamACoachSig ? 1 : 0) + (teamACaptainSig ? 1 : 0)}/2)`}
              </button>
            </div>
            {signatureMenuA && (
              <div style={{
                marginTop: '8px',
                background: 'var(--card)', border: '1px solid rgba(255,255,255,0.2)',
                borderRadius: '8px', padding: '8px',
                display: 'flex', flexDirection: 'column', gap: '6px'
              }}>
                <button
                  onClick={() => { setOpenSignature(teamA === 'home' ? 'home-coach' : 'away-coach'); setSignatureMenuA(false) }}
                  className={`sign ${teamACoachSig ? 'signed' : ''}`}
                  style={{ fontSize: '11px', padding: '6px 10px' }}
                >
                  Coach {teamACoachSig ? '✓' : ''}
                </button>
                <button
                  onClick={() => { setOpenSignature(teamA === 'home' ? 'home-captain' : 'away-captain'); setSignatureMenuA(false) }}
                  className={`sign ${teamACaptainSig ? 'signed' : ''}`}
                  style={{ fontSize: '11px', padding: '6px 10px' }}
                >
                  Captain {teamACaptainSig ? '✓' : ''}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Middle buttons */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center', alignSelf: 'stretch', padding: '0 4px' }}>
          <div style={{ height: '40px', display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: '24px' }}>
            <button className="secondary" onClick={switchTeams} style={{ padding: '6px 10px', fontSize: '11px', whiteSpace: 'nowrap' }}>
              ⇄ Teams
            </button>
          </div>
          <div style={{ height: '48px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <button className="secondary" onClick={switchServe} style={{ padding: '6px 10px', fontSize: '11px', whiteSpace: 'nowrap' }}>
              ⇄ Serve
            </button>
          </div>
        </div>

        {/* Team B */}
        <div style={{ minWidth: 0 }}>
          <h1 style={{ margin: 2, fontSize: '20px', fontWeight: 700, textAlign: 'center' }}>Team B</h1>
          <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8, minHeight: '40px' }}>
            <button
              type="button"
              style={{
                background: teamBInfo.color,
                color: isBrightColor(teamBInfo.color) ? '#000' : '#fff',
                flex: 1, padding: '8px 12px', fontSize: '13px', width: '100%',
                fontWeight: 600, border: 'none', borderRadius: '8px',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                minWidth: 0
              }}
              title={teamBInfo.name}
            >
              {getDisplayName(teamBInfo.name, teamBInfo.shortName)}
            </button>
          </div>

          <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'center', height: '48px', alignItems: 'center' }}>
            {serveB ? volleyballImage : volleyballPlaceholder}
          </div>

          {/* Team B Roster Button */}
          <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'center' }}>
            <button
              type="button"
              className="secondary"
              onClick={() => setRosterModal('teamB')}
              style={{ padding: '6px 12px', fontSize: '12px' }}
            >
              Roster ({teamBInfo.roster.length})
            </button>
          </div>

          {/* Team B Signatures */}
          <div style={{ marginTop: 16, paddingTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <button
                onClick={() => { setSignatureMenuB(!signatureMenuB); setSignatureMenuA(false) }}
                className={`sign ${teamBCoachSig && teamBCaptainSig ? 'signed' : ''}`}
                style={{ fontSize: '12px', padding: '6px 12px', minWidth: 'auto' }}
              >
                Sign B {teamBCoachSig && teamBCaptainSig ? '✓' : `(${(teamBCoachSig ? 1 : 0) + (teamBCaptainSig ? 1 : 0)}/2)`}
              </button>
            </div>
            {signatureMenuB && (
              <div style={{
                marginTop: '8px',
                background: 'var(--card)', border: '1px solid rgba(255,255,255,0.2)',
                borderRadius: '8px', padding: '8px',
                display: 'flex', flexDirection: 'column', gap: '6px'
              }}>
                <button
                  onClick={() => { setOpenSignature(teamB === 'home' ? 'home-coach' : 'away-coach'); setSignatureMenuB(false) }}
                  className={`sign ${teamBCoachSig ? 'signed' : ''}`}
                  style={{ fontSize: '11px', padding: '6px 10px' }}
                >
                  Coach {teamBCoachSig ? '✓' : ''}
                </button>
                <button
                  onClick={() => { setOpenSignature(teamB === 'home' ? 'home-captain' : 'away-captain'); setSignatureMenuB(false) }}
                  className={`sign ${teamBCaptainSig ? 'signed' : ''}`}
                  style={{ fontSize: '11px', padding: '6px 10px' }}
                >
                  Captain {teamBCaptainSig ? '✓' : ''}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Confirm Button */}
      <div style={{ display: 'flex', justifyContent: 'center', marginTop: 24 }}>
        {isCoinTossConfirmed ? (
          <button onClick={handleReturnToMatch} style={{ padding: '12px 24px', fontSize: '14px' }}>
            Return to match
          </button>
        ) : (
          <button onClick={confirmCoinToss} style={{ padding: '12px 24px', fontSize: '14px' }}>
            Confirm Coin Toss Result
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

        return (
          <Modal
            title={`${teamInfo.name} - Roster`}
            open={true}
            onClose={() => setRosterModal(null)}
            width={600}
          >
            <div style={{ maxHeight: '70vh', overflowY: 'auto' }}>
              {/* Players Section */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <h4 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>Players ({roster.length})</h4>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setAddPlayerModal(rosterModal)}
                    style={{ padding: '4px 8px', fontSize: '12px' }}
                  >
                    + Add Player
                  </button>
                </div>
                <table className="roster-table" style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Name</th>
                      <th style={{ width: '90px' }}>DOB</th>
                      <th>Role</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rosterEntries.map(({ player: p, index: originalIdx }) => (
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
                              style={{
                                width: p.isCaptain ? '24px' : '28px',
                                height: p.isCaptain ? '24px' : 'auto',
                                padding: '0', margin: '0', background: 'transparent',
                                border: p.isCaptain ? '2px solid var(--accent)' : 'none',
                                borderRadius: p.isCaptain ? '50%' : '0',
                                color: 'var(--text)', textAlign: 'center', fontSize: '12px'
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
                            <label style={{ display: 'flex', alignItems: 'center', gap: '2px', cursor: 'pointer' }}>
                              <input
                                type="radio"
                                name={`${currentTeam}-captain-modal`}
                                checked={p.isCaptain || false}
                                onChange={e => {
                                  const updated = roster.map((player, idx) => ({
                                    ...player,
                                    isCaptain: idx === originalIdx ? e.target.checked : false
                                  }))
                                  setRoster(updated)
                                }}
                                style={{ width: '12px', height: '12px', margin: 0, accentColor: 'var(--accent)' }}
                              />
                              <span style={{ fontSize: '10px', fontWeight: 600 }}>C</span>
                            </label>
                          </div>
                        </td>
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
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Bench Officials Section */}
              <div style={{ borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <h4 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>Bench Officials ({bench.length})</h4>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setBench([...bench, initBench('Coach')])}
                    style={{ padding: '4px 8px', fontSize: '12px' }}
                  >
                    + Add
                  </button>
                </div>
                <table className="roster-table" style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <th>Role</th>
                      <th>Name</th>
                      <th style={{ width: '90px' }}>DOB</th>
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
            title={`Add Player - ${isTeamA ? 'Team A' : 'Team B'}`}
            open={true}
            onClose={() => setAddPlayerModal(null)}
            width={500}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ display: 'block', marginBottom: 4 }}>Number</label>
                <input
                  type="number"
                  inputMode="numeric"
                  value={num}
                  onChange={e => currentTeam === 'home' ? setHomeNum(e.target.value) : setAwayNum(e.target.value)}
                  style={{ width: '100%', padding: '8px', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '4px', color: 'var(--text)' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 4 }}>Last Name</label>
                <input
                  type="text"
                  className="capitalize"
                  value={last}
                  onChange={e => currentTeam === 'home' ? setHomeLast(e.target.value) : setAwayLast(e.target.value)}
                  style={{ width: '100%', padding: '8px', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '4px', color: 'var(--text)' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 4 }}>First Name</label>
                <input
                  type="text"
                  className="capitalize"
                  value={first}
                  onChange={e => currentTeam === 'home' ? setHomeFirst(e.target.value) : setAwayFirst(e.target.value)}
                  style={{ width: '100%', padding: '8px', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '4px', color: 'var(--text)' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 4 }}>Date of Birth</label>
                <input
                  type="date"
                  value={dob ? formatDateToISO(dob) : ''}
                  onChange={e => {
                    const value = e.target.value ? formatDateToDDMMYYYY(e.target.value) : ''
                    currentTeam === 'home' ? setHomeDob(value) : setAwayDob(value)
                  }}
                  style={{ width: '100%', padding: '8px', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '4px', color: 'var(--text)' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 4 }}>Libero</label>
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
                  <option value="">none</option>
                  {!roster.some(p => p.libero === 'libero1') && <option value="libero1">Libero 1</option>}
                  {!roster.some(p => p.libero === 'libero2') && <option value="libero2">Libero 2</option>}
                </select>
              </div>
              <div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={captain}
                    onChange={e => currentTeam === 'home' ? setHomeCaptain(e.target.checked) : setAwayCaptain(e.target.checked)}
                  />
                  <span>Captain</span>
                </label>
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
                <button className="secondary" onClick={() => setAddPlayerModal(null)}>Cancel</button>
                <button onClick={() => {
                  if (!last || !first) {
                    alert('Please enter last name and first name')
                    return
                  }
                  const newPlayer = { number: num ? Number(num) : null, lastName: last, firstName: first, dob, libero, isCaptain: captain }

                  if (currentTeam === 'home') {
                    setHomeRoster(list => {
                      const cleared = captain ? list.map(p => ({ ...p, isCaptain: false })) : [...list]
                      return [...cleared, newPlayer].sort((a,b) => (a.number ?? 999) - (b.number ?? 999))
                    })
                    setHomeNum(''); setHomeFirst(''); setHomeLast(''); setHomeDob(''); setHomeLibero(''); setHomeCaptain(false)
                  } else {
                    setAwayRoster(list => {
                      const cleared = captain ? list.map(p => ({ ...p, isCaptain: false })) : [...list]
                      return [...cleared, newPlayer].sort((a,b) => (a.number ?? 999) - (b.number ?? 999))
                    })
                    setAwayNum(''); setAwayFirst(''); setAwayLast(''); setAwayDob(''); setAwayLibero(''); setAwayCaptain(false)
                  }
                  setAddPlayerModal(null)
                }}>Add Player</button>
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
            title="Delete Player"
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
          title="Notice"
          open={true}
          onClose={() => setNoticeModal(null)}
          width={400}
          hideCloseButton={true}
        >
          <div style={{ padding: '24px', textAlign: 'center' }}>
            <p style={{ marginBottom: '24px', fontSize: '16px', color: 'var(--text)' }}>
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
      />
    </div>
  )
}
