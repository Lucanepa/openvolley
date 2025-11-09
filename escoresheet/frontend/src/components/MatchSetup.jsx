import { useState, useEffect } from 'react'
import { db } from '../db/db'
import SignaturePad from './SignaturePad'
import mikasaVolleyball from '../mikasa_v200w.png'

export default function MatchSetup({ onStart }) {
  const [home, setHome] = useState('Home')
  const [away, setAway] = useState('Away')

  // Match info fields
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [hall, setHall] = useState('')
  const [city, setCity] = useState('')
  const [type1, setType1] = useState('championship') // championship | cup
  const [type2, setType2] = useState('men') // men | women
  const [type3, setType3] = useState('senior') // senior | U23 | U19
  const [gameN, setGameN] = useState('')
  const [league, setLeague] = useState('')
  const [homeColor, setHomeColor] = useState('#ef4444')
  const [awayColor, setAwayColor] = useState('#3b82f6')

  // Rosters
  const [homeRoster, setHomeRoster] = useState([])
  const [awayRoster, setAwayRoster] = useState([])
  const [homeNum, setHomeNum] = useState('')
  const [homeFirst, setHomeFirst] = useState('')
  const [homeLast, setHomeLast] = useState('')
  const [homeDob, setHomeDob] = useState('')
  const [homeLibero, setHomeLibero] = useState('') // '', 'libero1', 'libero2'
  const [homeCaptain, setHomeCaptain] = useState(false)

  const [awayNum, setAwayNum] = useState('')
  const [awayFirst, setAwayFirst] = useState('')
  const [awayLast, setAwayLast] = useState('')
  const [awayDob, setAwayDob] = useState('')
  const [awayLibero, setAwayLibero] = useState('')
  const [awayCaptain, setAwayCaptain] = useState(false)

  // Officials
  const [ref1First, setRef1First] = useState('')
  const [ref1Last, setRef1Last] = useState('')
  const [ref1Country, setRef1Country] = useState('CH')
  const [ref1Dob, setRef1Dob] = useState('')

  const [ref2First, setRef2First] = useState('')
  const [ref2Last, setRef2Last] = useState('')
  const [ref2Country, setRef2Country] = useState('CH')
  const [ref2Dob, setRef2Dob] = useState('')

  const [scorerFirst, setScorerFirst] = useState('')
  const [scorerLast, setScorerLast] = useState('')
  const [scorerCountry, setScorerCountry] = useState('CH')
  const [scorerDob, setScorerDob] = useState('')

  const [asstFirst, setAsstFirst] = useState('')
  const [asstLast, setAsstLast] = useState('')
  const [asstCountry, setAsstCountry] = useState('CH')
  const [asstDob, setAsstDob] = useState('')

  // Bench
  const initBench = role => ({ role, firstName: '', lastName: '', dob: '' })
  const [benchHome, setBenchHome] = useState([
    initBench('Coach'), initBench('Assistant Coach 1'), initBench('Assistant Coach 2'), initBench('Medic'), initBench('Physiotherapist')
  ])
  const [benchAway, setBenchAway] = useState([
    initBench('Coach'), initBench('Assistant Coach 1'), initBench('Assistant Coach 2'), initBench('Medic'), initBench('Physiotherapist')
  ])

  // UI state for views
  const [currentView, setCurrentView] = useState('main') // 'main', 'info', 'officials', 'home', 'away', 'coin-toss'
  const [openSignature, setOpenSignature] = useState(null) // 'home-coach', 'home-captain', 'away-coach', 'away-captain'
  const [showRoster, setShowRoster] = useState({ home: false, away: false })
  
  // Coin toss state
  const [teamA, setTeamA] = useState('home') // 'home' or 'away'
  const [teamB, setTeamB] = useState('away') // 'home' or 'away'
  const [serveA, setServeA] = useState(true) // true = serves, false = receives
  const [serveB, setServeB] = useState(false) // true = serves, false = receives
  const [pendingMatchId, setPendingMatchId] = useState(null) // Store match ID before coin toss
  const [showBothRosters, setShowBothRosters] = useState(false) // Show both rosters in match setup
  const [homeHasAds, setHomeHasAds] = useState(false) // Has ads on uniform
  const [awayHasAds, setAwayHasAds] = useState(false) // Has ads on uniform

  // Cities in Kanton Zürich
  const citiesZurich = [
    'Zürich', 'Winterthur', 'Uster', 'Dübendorf', 'Dietikon', 'Wetzikon', 'Horgen', 
    'Bülach', 'Kloten', 'Meilen', 'Adliswil', 'Thalwil', 'Küsnacht', 'Opfikon', 
    'Volketswil', 'Schlieren', 'Wallisellen', 'Regensdorf', 'Pfäffikon', 'Illnau-Effretikon',
    'Stäfa', 'Wädenswil', 'Männedorf', 'Rüti', 'Gossau', 'Bassersdorf', 'Richterswil',
    'Wald', 'Affoltern am Albis', 'Dielsdorf', 'Embrach', 'Hinwil', 'Küssnacht', 
    'Oberrieden', 'Uitikon', 'Egg', 'Fällanden', 'Maur', 'Rümlang', 'Zollikon'
  ].sort()

  const teamColors = ['#FFFFFF','#ef4444','#f59e0b','#22c55e','#3b82f6','#a855f7','#ec4899','#14b8a6','#eab308','#6366f1','#84cc16','#10b981','#f97316','#06b6d4','#dc2626','#64748b']

  const homeCounts = {
    players: homeRoster.length,
    liberos: homeRoster.filter(p => p.libero === 'libero1' || p.libero === 'libero2').length,
    bench: benchHome.filter(m => m.firstName || m.lastName || m.dob).length
  }
  const awayCounts = {
    players: awayRoster.length,
    liberos: awayRoster.filter(p => p.libero === 'libero1' || p.libero === 'libero2').length,
    bench: benchAway.filter(m => m.firstName || m.lastName || m.dob).length
  }

  // Signatures and lock
  const [homeCoachSignature, setHomeCoachSignature] = useState(null)
  const [homeCaptainSignature, setHomeCaptainSignature] = useState(null)
  const [awayCoachSignature, setAwayCoachSignature] = useState(null)
  const [awayCaptainSignature, setAwayCaptainSignature] = useState(null)
  const isHomeLocked = homeCoachSignature && homeCaptainSignature
  const isAwayLocked = awayCoachSignature && awayCaptainSignature

  function unlockTeam(side) {
    const pass = typeof window !== 'undefined' ? window.prompt('Enter 1st Referee password to unlock:') : ''
    if (pass === '1234') {
      if (side === 'home') { setHomeCoachSignature(null); setHomeCaptainSignature(null) }
      if (side === 'away') { setAwayCoachSignature(null); setAwayCaptainSignature(null) }
    } else if (pass !== null) {
      alert('Wrong password')
    }
  }

  // Load saved draft data on mount
  useEffect(() => {
    async function loadDraft() {
      try {
        const draft = await db.match_setup.orderBy('updatedAt').last()
        if (draft) {
          if (draft.home !== undefined) setHome(draft.home)
          if (draft.away !== undefined) setAway(draft.away)
          if (draft.date !== undefined) setDate(draft.date)
          if (draft.time !== undefined) setTime(draft.time)
          if (draft.hall !== undefined) setHall(draft.hall)
          if (draft.city !== undefined) setCity(draft.city)
          if (draft.type1 !== undefined) setType1(draft.type1)
          if (draft.type2 !== undefined) setType2(draft.type2)
          if (draft.type3 !== undefined) setType3(draft.type3)
          if (draft.gameN !== undefined) setGameN(draft.gameN)
          if (draft.league !== undefined) setLeague(draft.league)
          if (draft.homeColor !== undefined) setHomeColor(draft.homeColor)
          if (draft.awayColor !== undefined) setAwayColor(draft.awayColor)
          if (draft.homeRoster !== undefined) setHomeRoster(draft.homeRoster)
          if (draft.awayRoster !== undefined) setAwayRoster(draft.awayRoster)
          if (draft.benchHome !== undefined) setBenchHome(draft.benchHome)
          if (draft.benchAway !== undefined) setBenchAway(draft.benchAway)
          if (draft.ref1First !== undefined) setRef1First(draft.ref1First)
          if (draft.ref1Last !== undefined) setRef1Last(draft.ref1Last)
          if (draft.ref1Country !== undefined) setRef1Country(draft.ref1Country)
          if (draft.ref1Dob !== undefined) setRef1Dob(draft.ref1Dob)
          if (draft.ref2First !== undefined) setRef2First(draft.ref2First)
          if (draft.ref2Last !== undefined) setRef2Last(draft.ref2Last)
          if (draft.ref2Country !== undefined) setRef2Country(draft.ref2Country)
          if (draft.ref2Dob !== undefined) setRef2Dob(draft.ref2Dob)
          if (draft.scorerFirst !== undefined) setScorerFirst(draft.scorerFirst)
          if (draft.scorerLast !== undefined) setScorerLast(draft.scorerLast)
          if (draft.scorerCountry !== undefined) setScorerCountry(draft.scorerCountry)
          if (draft.scorerDob !== undefined) setScorerDob(draft.scorerDob)
          if (draft.asstFirst !== undefined) setAsstFirst(draft.asstFirst)
          if (draft.asstLast !== undefined) setAsstLast(draft.asstLast)
          if (draft.asstCountry !== undefined) setAsstCountry(draft.asstCountry)
          if (draft.asstDob !== undefined) setAsstDob(draft.asstDob)
          if (draft.homeCoachSignature !== undefined) setHomeCoachSignature(draft.homeCoachSignature)
          if (draft.homeCaptainSignature !== undefined) setHomeCaptainSignature(draft.homeCaptainSignature)
          if (draft.awayCoachSignature !== undefined) setAwayCoachSignature(draft.awayCoachSignature)
          if (draft.awayCaptainSignature !== undefined) setAwayCaptainSignature(draft.awayCaptainSignature)
        }
      } catch (error) {
        console.error('Error loading draft:', error)
      }
    }
    loadDraft()
  }, [])

  // Save draft data to database
  async function saveDraft(silent = false) {
    try {
      const draft = {
        home,
        away,
        date,
        time,
        hall,
        city,
        type1,
        type2,
        type3,
        gameN,
        league,
        homeColor,
        awayColor,
        homeRoster,
        awayRoster,
        benchHome,
        benchAway,
        ref1First,
        ref1Last,
        ref1Country,
        ref1Dob,
        ref2First,
        ref2Last,
        ref2Country,
        ref2Dob,
        scorerFirst,
        scorerLast,
        scorerCountry,
        scorerDob,
        asstFirst,
        asstLast,
        asstCountry,
        asstDob,
        homeCoachSignature,
        homeCaptainSignature,
        awayCoachSignature,
        awayCaptainSignature,
        updatedAt: new Date().toISOString()
      }
      // Get existing draft or create new one
      const existing = await db.match_setup.orderBy('updatedAt').last()
      if (existing) {
        await db.match_setup.update(existing.id, draft)
      } else {
        await db.match_setup.add(draft)
      }
      return true
    } catch (error) {
      console.error('Error saving draft:', error)
      if (!silent) {
        alert('Error saving data')
      }
      return false
    }
  }

  // Auto-save when data changes (debounced)
  useEffect(() => {
    if (currentView === 'info' || currentView === 'officials' || currentView === 'home' || currentView === 'away') {
      const timeoutId = setTimeout(() => {
        saveDraft(true) // Silent auto-save
      }, 500) // Debounce 500ms
      
      return () => clearTimeout(timeoutId)
    }
  }, [date, time, hall, city, type1, type2, type3, gameN, league, home, away, homeColor, awayColor, homeRoster, awayRoster, benchHome, benchAway, ref1First, ref1Last, ref1Country, ref1Dob, ref2First, ref2Last, ref2Country, ref2Dob, scorerFirst, scorerLast, scorerCountry, scorerDob, asstFirst, asstLast, asstCountry, asstDob, homeCoachSignature, homeCaptainSignature, awayCoachSignature, awayCaptainSignature, currentView])

  // Date formatting helpers
  function formatDateToDDMMYYYY(dateStr) {
    if (!dateStr) return ''
    // If already in DD/MM/YYYY format, return as-is
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) return dateStr
    // If in ISO format (YYYY-MM-DD), convert to DD/MM/YYYY
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      const [year, month, day] = dateStr.split('-')
      return `${day}/${month}/${year}`
    }
    // Try to parse as date
    const date = new Date(dateStr)
    if (!isNaN(date.getTime())) {
      const day = String(date.getDate()).padStart(2, '0')
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const year = date.getFullYear()
      return `${day}/${month}/${year}`
    }
    return dateStr
  }

  function formatDateToISO(dateStr) {
    if (!dateStr) return ''
    // If already in ISO format (YYYY-MM-DD), return as-is
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr
    // If in DD/MM/YYYY format, convert to YYYY-MM-DD
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) {
      const [day, month, year] = dateStr.split('/')
      return `${year}-${month}-${day}`
    }
    // Try to parse as date
    const date = new Date(dateStr)
    if (!isNaN(date.getTime())) {
      const year = date.getFullYear()
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      return `${year}-${month}-${day}`
    }
    return dateStr
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

  function formatRoster(roster, bench) {
    // All players sorted by number (ascending)
    const players = [...roster].sort((a, b) => {
      const an = a.number ?? 999
      const bn = b.number ?? 999
      return an - bn
    })
    // Liberos sorted by number (ascending)
    const liberos = roster.filter(p => p.libero).sort((a, b) => {
      const an = a.number ?? 999
      const bn = b.number ?? 999
      return an - bn
    })
    // Bench sorted by role: C, AC1, AC2, M, P
    const benchOrder = ['Coach', 'Assistant Coach 1', 'Assistant Coach 2', 'Medic', 'Physiotherapist']
    const benchSorted = bench
      .filter(m => m.firstName || m.lastName || m.dob)
      .sort((a, b) => benchOrder.indexOf(a.role) - benchOrder.indexOf(b.role))
    
    return { players, liberos, bench: benchSorted }
  }

  async function createMatch() {
    const homeId = await db.teams.add({ name: home, color: homeColor, createdAt: new Date().toISOString() })
    const awayId = await db.teams.add({ name: away, color: awayColor, createdAt: new Date().toISOString() })

    const scheduledAt = (() => {
      if (!date && !time) return new Date().toISOString()
      const iso = new Date(`${date}T${time || '00:00'}:00`).toISOString()
      return iso
    })()

    const matchId = await db.matches.add({
      homeTeamId: homeId,
      awayTeamId: awayId,
      status: 'live',
      scheduledAt,
      hall,
      city,
      match_type_1: type1,
      match_type_2: type2,
      match_type_3: type3,
      game_n: gameN ? Number(gameN) : null,
      league,
      officials: [
        { role: '1st referee', firstName: ref1First, lastName: ref1Last, country: ref1Country, dob: ref1Dob },
        { role: '2nd referee', firstName: ref2First, lastName: ref2Last, country: ref2Country, dob: ref2Dob },
        { role: 'scorer', firstName: scorerFirst, lastName: scorerLast, country: scorerCountry, dob: scorerDob },
        { role: 'assistant scorer', firstName: asstFirst, lastName: asstLast, country: asstCountry, dob: asstDob }
      ],
      bench_home: benchHome,
      bench_away: benchAway,
      homeCoachSignature: null,
      homeCaptainSignature: null,
      awayCoachSignature: null,
      awayCaptainSignature: null,
      createdAt: new Date().toISOString()
    })
    if (homeRoster.length) {
      await db.players.bulkAdd(
        homeRoster.map(p => ({
          teamId: homeId,
          number: p.number,
          name: `${p.lastName} ${p.firstName}`,
          lastName: p.lastName,
          firstName: p.firstName,
          dob: p.dob || null,
          libero: p.libero || '',
          isCaptain: !!p.isCaptain,
          role: null,
          createdAt: new Date().toISOString()
        }))
      )
    }
    if (awayRoster.length) {
      await db.players.bulkAdd(
        awayRoster.map(p => ({
          teamId: awayId,
          number: p.number,
          name: `${p.lastName} ${p.firstName}`,
          lastName: p.lastName,
          firstName: p.firstName,
          dob: p.dob || null,
          libero: p.libero || '',
          isCaptain: !!p.isCaptain,
          role: null,
          createdAt: new Date().toISOString()
        }))
      )
    }
    // Don't start match yet - go to coin toss first
    setPendingMatchId(matchId)
    setCurrentView('coin-toss')
  }

  function switchTeams() {
    const temp = teamA
    setTeamA(teamB)
    setTeamB(temp)
  }

  function switchServe() {
    setServeA(!serveA)
    setServeB(!serveB)
  }

  async function confirmCoinToss() {
    if (!homeCoachSignature || !homeCaptainSignature || !awayCoachSignature || !awayCaptainSignature) {
      alert('Please complete all signatures')
      return
    }
    
    // Update match with signatures
    await db.matches.update(pendingMatchId, {
      homeCoachSignature,
      homeCaptainSignature,
      awayCoachSignature,
      awayCaptainSignature
    })
    
    // Create first set
    await db.sets.add({ matchId: pendingMatchId, index: 1, homePoints: 0, awayPoints: 0, finished: false })
    
    // Start the match
    onStart(pendingMatchId)
  }

  if (currentView === 'info') {
    return (
      <div className="setup">
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
          <button className="secondary" onClick={()=>setCurrentView('main')}>← Back</button>
          <h2>Match info</h2>
          <div style={{ width: 80 }}></div>
        </div>
        <div className="row">
          <div className="field"><label>Date</label><input className="w-dob" type="date" value={date} onChange={e=>setDate(e.target.value)} /></div>
          <div className="field"><label>Time</label><input className="w-80" type="time" value={time} onChange={e=>setTime(e.target.value)} /></div>
          <div className="field">
            <label>City</label>
            <input 
              className="w-120 capitalize" 
              value={city} 
              onChange={e=>setCity(e.target.value)}
              list="cities-zurich"
              placeholder="Enter city"
            />
            <datalist id="cities-zurich">
              {citiesZurich.map(c => <option key={c} value={c} />)}
            </datalist>
          </div>
          <div className="field"><label>Hall</label><input className="w-200 capitalize" value={hall} onChange={e=>setHall(e.target.value)} /></div>
        </div>
        <div className="row" style={{ marginTop:12 }}>
          <div className="field">
            <label>Match Type</label>
            <select className="w-120" value={type1} onChange={e=>setType1(e.target.value)}>
              <option value="championship">Championship</option>
              <option value="cup">Cup</option>
            </select>
          </div>
          <div className="field">
            <label>Match Category</label>
            <select className="w-120" value={type2} onChange={e=>setType2(e.target.value)}>
              <option value="men">Men</option>
              <option value="women">Women</option>
            </select>
          </div>
          <div className="field">
            <label>Match Level</label>
            <select className="w-90" value={type3} onChange={e=>setType3(e.target.value)}>
              <option value="senior">Senior</option>
              <option value="U23">U23</option>
              <option value="U21">U21</option>
              <option value="U19">U19</option>
            </select>
          </div>
        </div>
        <div className="row" style={{ marginTop:12 }}>
          <div className="field"><label>Game #</label><input className="w-80" type="number" inputMode="numeric" value={gameN} onChange={e=>setGameN(e.target.value)} /></div>
          <div className="field"><label>League</label><input className="w-100 capitalize" value={league} onChange={e=>setLeague(e.target.value)} /></div>
        </div>
        <div style={{ display:'flex', justifyContent:'flex-end', marginTop:16 }}>
          <button onClick={() => setCurrentView('main')}>Confirm</button>
        </div>
      </div>
    )
  }

  if (currentView === 'officials') {
    return (
      <div className="setup">
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
          <button className="secondary" onClick={()=>setCurrentView('main')}>← Back</button>
          <h2>Match officials</h2>
          <div style={{ width: 80 }}></div>
        </div>
        <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
          <div>
            <h4 style={{ marginTop:0 }}>1st Referee</h4>
            <div className="row">
              <div className="field"><label>Last Name</label><input className="w-name capitalize" value={ref1Last} onChange={e=>setRef1Last(e.target.value)} /></div>
              <div className="field"><label>First Name</label><input className="w-name capitalize" value={ref1First} onChange={e=>setRef1First(e.target.value)} /></div>
              <div className="field"><label>Country</label><input className="w-90" value={ref1Country} onChange={e=>setRef1Country(e.target.value)} /></div>
              <div className="field"><label>Date of birth</label><input className="w-dob" type="date" value={ref1Dob ? formatDateToISO(ref1Dob) : ''} onChange={e=>setRef1Dob(e.target.value ? formatDateToDDMMYYYY(e.target.value) : '')} /></div>
            </div>
          </div>

          <div>
            <h4 style={{ marginTop:0 }}>2nd Referee</h4>
            <div className="row">
              <div className="field"><label>Last Name</label><input className="w-name capitalize" value={ref2Last} onChange={e=>setRef2Last(e.target.value)} /></div>
              <div className="field"><label>First Name</label><input className="w-name capitalize" value={ref2First} onChange={e=>setRef2First(e.target.value)} /></div>
              <div className="field"><label>Country</label><input className="w-90" value={ref2Country} onChange={e=>setRef2Country(e.target.value)} /></div>
              <div className="field"><label>Date of birth</label><input className="w-dob" type="date" value={ref2Dob ? formatDateToISO(ref2Dob) : ''} onChange={e=>setRef2Dob(e.target.value ? formatDateToDDMMYYYY(e.target.value) : '')} /></div>
            </div>
          </div>

          <div>
            <h4 style={{ marginTop:0 }}>Scorer</h4>
            <div className="row">
              <div className="field"><label>Last Name</label><input className="w-name capitalize" value={scorerLast} onChange={e=>setScorerLast(e.target.value)} /></div>
              <div className="field"><label>First Name</label><input className="w-name capitalize" value={scorerFirst} onChange={e=>setScorerFirst(e.target.value)} /></div>
              <div className="field"><label>Country</label><input className="w-90" value={scorerCountry} onChange={e=>setScorerCountry(e.target.value)} /></div>
              <div className="field"><label>Date of birth</label><input className="w-dob" type="date" value={scorerDob ? formatDateToISO(scorerDob) : ''} onChange={e=>setScorerDob(e.target.value ? formatDateToDDMMYYYY(e.target.value) : '')} /></div>
            </div>
          </div>

          <div>
            <h4 style={{ marginTop:0 }}>Assistant Scorer</h4>
            <div className="row">
              <div className="field"><label>Last Name</label><input className="w-name capitalize" value={asstLast} onChange={e=>setAsstLast(e.target.value)} /></div>
              <div className="field"><label>First Name</label><input className="w-name capitalize" value={asstFirst} onChange={e=>setAsstFirst(e.target.value)} /></div>
              <div className="field"><label>Country</label><input className="w-90" value={asstCountry} onChange={e=>setAsstCountry(e.target.value)} /></div>
              <div className="field"><label>Date of birth</label><input className="w-dob" type="date" value={asstDob ? formatDateToISO(asstDob) : ''} onChange={e=>setAsstDob(e.target.value ? formatDateToDDMMYYYY(e.target.value) : '')} /></div>
            </div>
          </div>
        </div>
        <div style={{ display:'flex', justifyContent:'flex-end', marginTop:16 }}>
          <button onClick={() => setCurrentView('main')}>Confirm</button>
        </div>
      </div>
    )
  }

  if (currentView === 'home') {
    return (
      <div className="setup">
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
          <button className="secondary" onClick={()=>setCurrentView('main')}>← Back</button>
          <h2>Home team</h2>
          <div style={{ width: 80 }}></div>
        </div>
        <div className="row" style={{ alignItems:'center' }}>
          <label className="inline"><span>Name</span><input className="w-180 capitalize" value={home} onChange={e=>setHome(e.target.value)} /></label>
          <div className="inline" style={{ gap:6 }}>
            {teamColors.map(c => (
              <button key={c} type="button" className="secondary" onClick={()=>setHomeColor(c)} style={{ width:18, height:18, borderRadius:6, background:c, border: homeColor===c?'2px solid #fff':'1px solid rgba(255,255,255,.2)' }} />
            ))}
          </div>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <label className="inline" style={{ 
            display: 'flex', 
            alignItems: 'center', 
            gap: 8, 
            padding: '8px 12px',
            border: '1px solid rgba(255,255,255,0.2)',
            borderRadius: '8px',
            background: homeHasAds ? 'rgba(34, 197, 94, 0.1)' : 'transparent',
            cursor: 'pointer',
            width: 'fit-content'
          }}>
            <input 
              type="checkbox" 
              checked={homeHasAds} 
              onChange={e=>setHomeHasAds(e.target.checked)}
              style={{ cursor: 'pointer', width: '16px', height: '16px' }}
            />
            <span style={{ fontWeight: 500 }}>Ads</span>
          </label>
        </div>
        {isHomeLocked && (
          <div className="panel" style={{ marginTop:8 }}>
            <p className="text-sm">Locked (signed by Coach and Captain). <button className="secondary" onClick={()=>unlockTeam('home')}>Unlock</button></p>
          </div>
        )}
        <h4>Roster</h4>
        <div className="row" style={{ width: '100%', maxWidth: '100%', overflow: 'hidden' }}>
          <input disabled={isHomeLocked} className="w-num" placeholder="#" type="number" inputMode="numeric" value={homeNum} onChange={e=>setHomeNum(e.target.value)} />
          <input disabled={isHomeLocked} className="w-name capitalize" placeholder="Last Name" value={homeLast} onChange={e=>setHomeLast(e.target.value)} />
          <input disabled={isHomeLocked} className="w-name capitalize" placeholder="First Name" value={homeFirst} onChange={e=>setHomeFirst(e.target.value)} />
          <input disabled={isHomeLocked} className="w-dob" placeholder="Date of birth (dd/mm/yyyy)" type="date" value={homeDob ? formatDateToISO(homeDob) : ''} onChange={e=>setHomeDob(e.target.value ? formatDateToDDMMYYYY(e.target.value) : '')} />
          <select disabled={isHomeLocked} className="w-90" value={homeLibero} onChange={e=>setHomeLibero(e.target.value)}>
            <option value="">none</option>
            <option value="libero1">Libero 1</option>
            <option value="libero2">Libero 2</option>
          </select>
          <label className="inline"><input disabled={isHomeLocked} type="radio" name="homeCaptain" checked={homeCaptain} onChange={()=>setHomeCaptain(true)} /> Captain</label>
          <button disabled={isHomeLocked} type="button" className="secondary" onClick={() => {
            if (!homeLast || !homeFirst) return
            const newPlayer = { number: homeNum ? Number(homeNum) : null, lastName: homeLast, firstName: homeFirst, dob: homeDob, libero: homeLibero, isCaptain: homeCaptain }
            setHomeRoster(list => {
              const cleared = homeCaptain ? list.map(p => ({ ...p, isCaptain: false })) : [...list]
              const next = [...cleared, newPlayer].sort((a,b) => {
                const an = a.number ?? 999
                const bn = b.number ?? 999
                return an - bn
              })
              return next
            })
            setHomeNum(''); setHomeFirst(''); setHomeLast(''); setHomeDob(''); setHomeLibero(''); setHomeCaptain(false)
          }}>Add</button>
        </div>
        <ul className="roster-list">
          {homeRoster.map((p, i) => (
            <li key={`h-${i}`} style={{ display:'flex', flexWrap:'wrap', justifyContent:'space-between', gap:8 }}>
              <span>#{p.number ?? ''} {p.lastName} {p.firstName} {p.libero ? `(${p.libero})` : ''} {p.isCaptain ? '[C]' : ''}</span>
              <button type="button" className="secondary" onClick={() => setHomeRoster(list => list.filter((_, idx) => idx !== i))}>Remove</button>
            </li>
          ))}
        </ul>
        <h4>Bench — Home</h4>
        {benchHome.map((m, i) => (
          <div key={`bh-${i}`} className="row bench-row" style={{ alignItems:'center' }}>
            <input disabled className="w-220" value={m.role} />
            <input disabled={isHomeLocked} className="w-name capitalize" placeholder="Last Name" value={m.lastName} onChange={e=>setBenchHome(arr => { const a=[...arr]; a[i]={...a[i], lastName:e.target.value}; return a })} />
            <input disabled={isHomeLocked} className="w-name capitalize" placeholder="First Name" value={m.firstName} onChange={e=>setBenchHome(arr => { const a=[...arr]; a[i]={...a[i], firstName:e.target.value}; return a })} />
            <input disabled={isHomeLocked} className="w-dob" placeholder="Date of birth (dd/mm/yyyy)" type="date" value={m.dob ? formatDateToISO(m.dob) : ''} onChange={e=>setBenchHome(arr => { const a=[...arr]; a[i]={...a[i], dob:e.target.value ? formatDateToDDMMYYYY(e.target.value) : ''}; return a })} />
          </div>
        ))}
        <div style={{ display:'flex', justifyContent:'flex-end', marginTop:16 }}>
          <button onClick={() => setCurrentView('main')}>Confirm</button>
        </div>
      </div>
    )
  }

  if (currentView === 'away') {
    return (
      <div className="setup">
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
          <button className="secondary" onClick={()=>setCurrentView('main')}>← Back</button>
          <h2>Away team</h2>
          <div style={{ width: 80 }}></div>
        </div>
        <div className="row" style={{ alignItems:'center' }}>
          <label className="inline"><span>Name</span><input className="w-300 capitalize" value={away} onChange={e=>setAway(e.target.value)} /></label>
          <div className="inline" style={{ gap:6 }}>
            {teamColors.map(c => (
              <button key={c} type="button" className="secondary" onClick={()=>setAwayColor(c)} style={{ width:18, height:18, borderRadius:6, background:c, border: awayColor===c?'2px solid #fff':'1px solid rgba(255,255,255,.2)' }} />
            ))}
          </div>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <label className="inline" style={{ 
            display: 'flex', 
            alignItems: 'center', 
            gap: 8, 
            padding: '8px 12px',
            border: '1px solid rgba(255,255,255,0.2)',
            borderRadius: '8px',
            background: awayHasAds ? 'rgba(34, 197, 94, 0.1)' : 'transparent',
            cursor: 'pointer',
            width: 'fit-content'
          }}>
            <input 
              type="checkbox" 
              checked={awayHasAds} 
              onChange={e=>setAwayHasAds(e.target.checked)}
              style={{ cursor: 'pointer', width: '16px', height: '16px' }}
            />
            <span style={{ fontWeight: 500 }}>Ads</span>
          </label>
        </div>
        {isAwayLocked && (
          <div className="panel" style={{ marginTop:8 }}>
            <p className="text-sm">Locked (signed by Coach and Captain). <button className="secondary" onClick={()=>unlockTeam('away')}>Unlock</button></p>
          </div>
        )}
        <h4>Roster</h4>
        <div className="row" style={{ width: '100%', maxWidth: '100%', overflow: 'hidden' }}>
          <input disabled={isAwayLocked} className="w-num" placeholder="#" type="number" inputMode="numeric" value={awayNum} onChange={e=>setAwayNum(e.target.value)} />
          <input disabled={isAwayLocked} className="w-name capitalize" placeholder="Last Name" value={awayLast} onChange={e=>setAwayLast(e.target.value)} />
          <input disabled={isAwayLocked} className="w-name capitalize" placeholder="First Name" value={awayFirst} onChange={e=>setAwayFirst(e.target.value)} />
          <input disabled={isAwayLocked} className="w-dob" placeholder="Date of birth (dd/mm/yyyy)" type="date" value={awayDob ? formatDateToISO(awayDob) : ''} onChange={e=>setAwayDob(e.target.value ? formatDateToDDMMYYYY(e.target.value) : '')} />
          <select disabled={isAwayLocked} className="w-120" value={awayLibero} onChange={e=>setAwayLibero(e.target.value)}>
            <option value="">none</option>
            <option value="libero1">libero 1</option>
            <option value="libero2">libero 2</option>
          </select>
          <label className="inline"><input disabled={isAwayLocked} type="radio" name="awayCaptain" checked={awayCaptain} onChange={()=>setAwayCaptain(true)} /> Captain</label>
          <button disabled={isAwayLocked} type="button" className="secondary" onClick={() => {
            if (!awayLast || !awayFirst) return
            const newPlayer = { number: awayNum ? Number(awayNum) : null, lastName: awayLast, firstName: awayFirst, dob: awayDob, libero: awayLibero, isCaptain: awayCaptain }
            setAwayRoster(list => {
              const cleared = awayCaptain ? list.map(p => ({ ...p, isCaptain: false })) : [...list]
              const next = [...cleared, newPlayer].sort((a,b) => {
                const an = a.number ?? 999
                const bn = b.number ?? 999
                return an - bn
              })
              return next
            })
            setAwayNum(''); setAwayFirst(''); setAwayLast(''); setAwayDob(''); setAwayLibero(''); setAwayCaptain(false)
          }}>Add</button>
        </div>
        <ul className="roster-list">
          {awayRoster.map((p, i) => (
            <li key={`a-${i}`} style={{ display:'flex', flexWrap:'wrap', justifyContent:'space-between', gap:8 }}>
              <span>#{p.number ?? ''} {p.lastName} {p.firstName} {p.libero ? `(${p.libero})` : ''} {p.isCaptain ? '[C]' : ''}</span>
              <button type="button" className="secondary" onClick={() => setAwayRoster(list => list.filter((_, idx) => idx !== i))}>Remove</button>
            </li>
          ))}
        </ul>
        <h4>Bench — Away</h4>
        {benchAway.map((m, i) => (
          <div key={`ba-${i}`} className="row bench-row" style={{ alignItems:'center' }}>
            <input disabled className="w-220" value={m.role} />
            <input disabled={isAwayLocked} className="w-name capitalize" placeholder="Last Name" value={m.lastName} onChange={e=>setBenchAway(arr => { const a=[...arr]; a[i]={...a[i], lastName:e.target.value}; return a })} />
            <input disabled={isAwayLocked} className="w-name capitalize" placeholder="First Name" value={m.firstName} onChange={e=>setBenchAway(arr => { const a=[...arr]; a[i]={...a[i], firstName:e.target.value}; return a })} />
            <input disabled={isAwayLocked} className="w-dob" placeholder="Date of birth (dd/mm/yyyy)" type="date" value={m.dob ? formatDateToISO(m.dob) : ''} onChange={e=>setBenchAway(arr => { const a=[...arr]; a[i]={...a[i], dob:e.target.value ? formatDateToDDMMYYYY(e.target.value) : ''}; return a })} />
          </div>
        ))}
        <div style={{ display:'flex', justifyContent:'flex-end', marginTop:16 }}>
          <button onClick={() => setCurrentView('main')}>Confirm</button>
        </div>
      </div>
    )
  }

  if (currentView === 'coin-toss') {
    const teamAInfo = teamA === 'home' ? { name: home, color: homeColor, roster: homeRoster, bench: benchHome } : { name: away, color: awayColor, roster: awayRoster, bench: benchAway }
    const teamBInfo = teamB === 'home' ? { name: home, color: homeColor, roster: homeRoster, bench: benchHome } : { name: away, color: awayColor, roster: awayRoster, bench: benchAway }
    
    const teamACoachSig = teamA === 'home' ? homeCoachSignature : awayCoachSignature
    const teamACaptainSig = teamA === 'home' ? homeCaptainSignature : awayCaptainSignature
    const teamBCoachSig = teamB === 'home' ? homeCoachSignature : awayCoachSignature
    const teamBCaptainSig = teamB === 'home' ? homeCaptainSignature : awayCaptainSignature

    // Volleyball images
    const volleyballImage = (
      <img 
        src={mikasaVolleyball} 
        alt="Mikasa V200W Volleyball" 
        style={{ width: '64px', height: '64px', objectFit: 'contain' }}
      />
    )
    const volleyballPlaceholder = (
      <div style={{ 
        width: '64px', 
        height: '64px', 
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.05)'
      }}>
        <div style={{ 
          width: '32px', 
          height: '32px', 
          background: 'transparent'
        }} />
      </div>
    )

    return (
      <div className="setup">
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
          <button className="secondary" onClick={()=>setCurrentView('main')}>← Back</button>
          <h2>Coin Toss</h2>
          <div style={{ width: 80 }}></div>
        </div>
        
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 24, marginBottom: 24, alignItems: 'start' }}>
          {/* Team A */}
          <div>
            <h3>Team A</h3>
            <div style={{ marginBottom: 16 }}>
              <button 
                type="button"
                style={{ 
                  background: teamAInfo.color, 
                  color: '#fff', 
                  width: '100%',
                  padding: '12px',
                  fontSize: '14px',
                  fontWeight: 600,
                  border: 'none',
                  borderRadius: '8px'
                }}
              >
                {teamAInfo.name}
              </button>
            </div>
            
            <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'center', minHeight: '64px', alignItems: 'center' }}>
              {serveA ? volleyballImage : volleyballPlaceholder}
            </div>
            
            <div style={{ marginBottom: 16 }}>
              <button className="secondary" onClick={() => setShowRoster({ ...showRoster, home: teamA === 'home' ? !showRoster.home : showRoster.home, away: teamA === 'away' ? !showRoster.away : showRoster.away })}>
                {((teamA === 'home' && showRoster.home) || (teamA === 'away' && showRoster.away)) ? 'Hide' : 'Show'} Roster
              </button>
            </div>
            
            {((teamA === 'home' && showRoster.home) || (teamA === 'away' && showRoster.away)) && (() => {
              const { players, liberos, bench } = formatRoster(teamAInfo.roster, teamAInfo.bench)
              return (
                <div className="panel" style={{ marginBottom: 16 }}>
                  {players.length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <strong>Players</strong>
                      <ul className="roster-list" style={{ listStyle: 'none', paddingLeft: 0 }}>
                        {players.map((p, i) => (
                          <li key={`p-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                            {p.isCaptain ? (
                              <span style={{ 
                                display: 'inline-flex', 
                                alignItems: 'center', 
                                justifyContent: 'center',
                                width: 24, 
                                height: 24, 
                                borderRadius: '50%', 
                                border: '2px solid var(--text)',
                                fontSize: 12,
                                fontWeight: 600
                              }}>#{p.number ?? ''}</span>
                            ) : (
                              <span>#{p.number ?? ''}</span>
                            )}
                            {p.libero && (
                              <span style={{ color: '#3b82f6', fontWeight: 600 }}>
                                {p.libero === 'libero1' ? 'L1' : 'L2'}
                              </span>
                            )}
                            <span>{p.lastName} {p.firstName}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {liberos.length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <strong>Liberos</strong>
                      <ul className="roster-list" style={{ listStyle: 'none', paddingLeft: 0 }}>
                        {liberos.map((p, i) => (
                          <li key={`l-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                            {p.isCaptain ? (
                              <span style={{ 
                                display: 'inline-flex', 
                                alignItems: 'center', 
                                justifyContent: 'center',
                                width: 24, 
                                height: 24, 
                                borderRadius: '50%', 
                                border: '2px solid var(--text)',
                                fontSize: 12,
                                fontWeight: 600
                              }}>#{p.number ?? ''}</span>
                            ) : (
                              <span>#{p.number ?? ''}</span>
                            )}
                            <span style={{ color: '#3b82f6', fontWeight: 600 }}>
                              {p.libero === 'libero1' ? 'L1' : 'L2'}
                            </span>
                            <span>{p.lastName} {p.firstName}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {bench.length > 0 && (
                    <div>
                      <strong>Bench</strong>
                      <ul className="roster-list" style={{ listStyle: 'none', paddingLeft: 0 }}>
                        {bench.map((m, i) => (
                          <li key={`b-${i}`} style={{ marginBottom: 4 }}>{m.role}: {m.lastName} {m.firstName}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )
            })()}
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
              <div>
                <span style={{ display: 'block', marginBottom: 8 }}>Coach</span>
                {teamACoachSig ? (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <img src={teamACoachSig} alt="Coach signature" style={{ maxWidth: 200, maxHeight: 60, border: '1px solid rgba(255,255,255,.2)', borderRadius: 4 }} />
                    <button className="secondary" onClick={() => {
                      if (teamA === 'home') setHomeCoachSignature(null)
                      else setAwayCoachSignature(null)
                    }}>Remove</button>
                  </div>
                ) : (
                  <button className="secondary" onClick={() => setOpenSignature(teamA === 'home' ? 'home-coach' : 'away-coach')}>Sign</button>
                )}
              </div>
              <div>
                <span style={{ display: 'block', marginBottom: 8 }}>Captain</span>
                {teamACaptainSig ? (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <img src={teamACaptainSig} alt="Captain signature" style={{ maxWidth: 200, maxHeight: 60, border: '1px solid rgba(255,255,255,.2)', borderRadius: 4 }} />
                    <button className="secondary" onClick={() => {
                      if (teamA === 'home') setHomeCaptainSignature(null)
                      else setAwayCaptainSignature(null)
                    }}>Remove</button>
                  </div>
                ) : (
                  <button className="secondary" onClick={() => setOpenSignature(teamA === 'home' ? 'home-captain' : 'away-captain')}>Sign</button>
                )}
              </div>
            </div>
          </div>
          
          {/* Middle buttons */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, justifyContent: 'center', alignItems: 'center', paddingTop: 40 }}>
            <button className="secondary" onClick={switchTeams} style={{ padding: '8px 16px' }}>
              Switch Teams
            </button>
            <button className="secondary" onClick={switchServe} style={{ padding: '8px 16px' }}>
              Switch Serve
            </button>
          </div>
          
          {/* Team B */}
          <div>
            <h3>Team B</h3>
            <div style={{ marginBottom: 16 }}>
              <button 
                type="button"
                style={{ 
                  background: teamBInfo.color, 
                  color: '#fff', 
                  width: '100%',
                  padding: '12px',
                  fontSize: '14px',
                  fontWeight: 600,
                  border: 'none',
                  borderRadius: '8px'
                }}
              >
                {teamBInfo.name}
              </button>
            </div>
            
            <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'center', minHeight: '64px', alignItems: 'center' }}>
              {serveB ? volleyballImage : volleyballPlaceholder}
            </div>
            
            <div style={{ marginBottom: 16 }}>
              <button className="secondary" onClick={() => setShowRoster({ ...showRoster, home: teamB === 'home' ? !showRoster.home : showRoster.home, away: teamB === 'away' ? !showRoster.away : showRoster.away })}>
                {((teamB === 'home' && showRoster.home) || (teamB === 'away' && showRoster.away)) ? 'Hide' : 'Show'} Roster
              </button>
            </div>
            
            {((teamB === 'home' && showRoster.home) || (teamB === 'away' && showRoster.away)) && (() => {
              const { players, liberos, bench } = formatRoster(teamBInfo.roster, teamBInfo.bench)
              return (
                <div className="panel" style={{ marginBottom: 16 }}>
                  {players.length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <strong>Players</strong>
                      <ul className="roster-list" style={{ listStyle: 'none', paddingLeft: 0 }}>
                        {players.map((p, i) => (
                          <li key={`p-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                            {p.isCaptain ? (
                              <span style={{ 
                                display: 'inline-flex', 
                                alignItems: 'center', 
                                justifyContent: 'center',
                                width: 24, 
                                height: 24, 
                                borderRadius: '50%', 
                                border: '2px solid var(--text)',
                                fontSize: 12,
                                fontWeight: 600
                              }}>#{p.number ?? ''}</span>
                            ) : (
                              <span>#{p.number ?? ''}</span>
                            )}
                            {p.libero && (
                              <span style={{ color: '#3b82f6', fontWeight: 600 }}>
                                {p.libero === 'libero1' ? 'L1' : 'L2'}
                              </span>
                            )}
                            <span>{p.lastName} {p.firstName}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {liberos.length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <strong>Liberos</strong>
                      <ul className="roster-list" style={{ listStyle: 'none', paddingLeft: 0 }}>
                        {liberos.map((p, i) => (
                          <li key={`l-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                            {p.isCaptain ? (
                              <span style={{ 
                                display: 'inline-flex', 
                                alignItems: 'center', 
                                justifyContent: 'center',
                                width: 24, 
                                height: 24, 
                                borderRadius: '50%', 
                                border: '2px solid var(--text)',
                                fontSize: 12,
                                fontWeight: 600
                              }}>#{p.number ?? ''}</span>
                            ) : (
                              <span>#{p.number ?? ''}</span>
                            )}
                            <span style={{ color: '#3b82f6', fontWeight: 600 }}>
                              {p.libero === 'libero1' ? 'L1' : 'L2'}
                            </span>
                            <span>{p.lastName} {p.firstName}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {bench.length > 0 && (
                    <div>
                      <strong>Bench</strong>
                      <ul className="roster-list" style={{ listStyle: 'none', paddingLeft: 0 }}>
                        {bench.map((m, i) => (
                          <li key={`b-${i}`} style={{ marginBottom: 4 }}>{m.role}: {m.lastName} {m.firstName}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )
            })()}
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
              <div>
                <span style={{ display: 'block', marginBottom: 8 }}>Coach</span>
                {teamBCoachSig ? (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <img src={teamBCoachSig} alt="Coach signature" style={{ maxWidth: 200, maxHeight: 60, border: '1px solid rgba(255,255,255,.2)', borderRadius: 4 }} />
                    <button className="secondary" onClick={() => {
                      if (teamB === 'home') setHomeCoachSignature(null)
                      else setAwayCoachSignature(null)
                    }}>Remove</button>
                  </div>
                ) : (
                  <button className="secondary" onClick={() => setOpenSignature(teamB === 'home' ? 'home-coach' : 'away-coach')}>Sign</button>
                )}
              </div>
              <div>
                <span style={{ display: 'block', marginBottom: 8 }}>Captain</span>
                {teamBCaptainSig ? (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <img src={teamBCaptainSig} alt="Captain signature" style={{ maxWidth: 200, maxHeight: 60, border: '1px solid rgba(255,255,255,.2)', borderRadius: 4 }} />
                    <button className="secondary" onClick={() => {
                      if (teamB === 'home') setHomeCaptainSignature(null)
                      else setAwayCaptainSignature(null)
                    }}>Remove</button>
                  </div>
                ) : (
                  <button className="secondary" onClick={() => setOpenSignature(teamB === 'home' ? 'home-captain' : 'away-captain')}>Sign</button>
                )}
              </div>
            </div>
          </div>
        </div>
        
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 24 }}>
          <button onClick={confirmCoinToss} style={{ padding: '12px 24px', fontSize: '14px' }}>
            Confirm Coin Toss Result
          </button>
        </div>
        
        <SignaturePad 
          open={openSignature !== null} 
          onClose={() => setOpenSignature(null)} 
          onSave={handleSignatureSave}
          title={openSignature === 'home-coach' ? 'Home Coach Signature' : 
                 openSignature === 'home-captain' ? 'Home Captain Signature' :
                 openSignature === 'away-coach' ? 'Away Coach Signature' :
                 openSignature === 'away-captain' ? 'Away Captain Signature' : 'Sign'}
        />
      </div>
    )
  }

  return (
    <div className="setup">
      <h2>Create Match</h2>
      <div className="grid-4">
        <div className="card" style={{ order: 1 }}>
          <div>
            <h3>Match info</h3>
            <p className="text-sm">{date || time || hall || city || league ? 'Configured' : 'Not set'}</p>
          </div>
          <div className="actions"><button className="secondary" onClick={()=>setCurrentView('info')}>Edit</button></div>
        </div>
        <div className="card" style={{ order: 2 }}>
          <div>
            <h3>Match officials</h3>
            <p className="text-sm">Edit referees and scorers</p>
          </div>
          <div className="actions"><button className="secondary" onClick={()=>setCurrentView('officials')}>Edit</button></div>
        </div>
        <div className="card" style={{ order: 3 }}>
          <div>
            <h3>Home team</h3>
            <div className="inline" style={{ justifyContent:'space-between', alignItems:'center' }}>
              <p className="text-sm">{home}</p>
              <div className="shirt" style={{ background: homeColor }} />
            </div>
            <p className="text-sm">{homeCounts.players} players • {homeCounts.liberos} liberos • {homeCounts.bench} bench</p>
          </div>
          <div className="actions"><button className="secondary" onClick={()=>setCurrentView('home')}>Edit</button></div>
        </div>
        <div className="card" style={{ order: 4 }}>
          <div>
            <h3>Away team</h3>
            <div className="inline" style={{ justifyContent:'space-between', alignItems:'center' }}>
              <p className="text-sm">{away}</p>
              <div className="shirt" style={{ background: awayColor }} />
            </div>
            <p className="text-sm">{awayCounts.players} players • {awayCounts.liberos} liberos • {awayCounts.bench} bench</p>
          </div>
          <div className="actions"><button className="secondary" onClick={()=>setCurrentView('away')}>Edit</button></div>
        </div>
      </div>

      <div style={{ display:'flex', justifyContent:'space-between', marginTop:12, alignItems:'center' }}>
        <button className="secondary" onClick={() => setShowBothRosters(!showBothRosters)}>
          {showBothRosters ? 'Hide' : 'Show'} Rosters
        </button>
        <button onClick={createMatch}>Start Match</button>
      </div>

      {showBothRosters && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginTop: 24 }}>
          <div className="panel">
            <h3>Home Team Roster</h3>
            {(() => {
              const { players, liberos, bench } = formatRoster(homeRoster, benchHome)
              return (
                <>
                  {players.length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <strong>Players</strong>
                      <ul className="roster-list" style={{ listStyle: 'none', paddingLeft: 0 }}>
                        {players.map((p, i) => (
                          <li key={`p-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                            {p.isCaptain ? (
                              <span style={{ 
                                display: 'inline-flex', 
                                alignItems: 'center', 
                                justifyContent: 'center',
                                width: 24, 
                                height: 24, 
                                borderRadius: '50%', 
                                border: '2px solid var(--text)',
                                fontSize: 12,
                                fontWeight: 600
                              }}>#{p.number ?? ''}</span>
                            ) : (
                              <span>#{p.number ?? ''}</span>
                            )}
                            {p.libero && (
                              <span style={{ color: '#3b82f6', fontWeight: 600 }}>
                                {p.libero === 'libero1' ? 'L1' : 'L2'}
                              </span>
                            )}
                            <span>{p.lastName} {p.firstName}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {liberos.length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <strong>Liberos</strong>
                      <ul className="roster-list" style={{ listStyle: 'none', paddingLeft: 0 }}>
                        {liberos.map((p, i) => (
                          <li key={`l-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                            {p.isCaptain ? (
                              <span style={{ 
                                display: 'inline-flex', 
                                alignItems: 'center', 
                                justifyContent: 'center',
                                width: 24, 
                                height: 24, 
                                borderRadius: '50%', 
                                border: '2px solid var(--text)',
                                fontSize: 12,
                                fontWeight: 600
                              }}>#{p.number ?? ''}</span>
                            ) : (
                              <span>#{p.number ?? ''}</span>
                            )}
                            <span style={{ color: '#3b82f6', fontWeight: 600 }}>
                              {p.libero === 'libero1' ? 'L1' : 'L2'}
                            </span>
                            <span>{p.lastName} {p.firstName}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {bench.length > 0 && (
                    <div>
                      <strong>Bench</strong>
                      <ul className="roster-list" style={{ listStyle: 'none', paddingLeft: 0 }}>
                        {bench.map((m, i) => (
                          <li key={`b-${i}`} style={{ marginBottom: 4 }}>{m.role}: {m.lastName} {m.firstName}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )
            })()}
          </div>
          <div className="panel">
            <h3>Away Team Roster</h3>
            {(() => {
              const { players, liberos, bench } = formatRoster(awayRoster, benchAway)
              return (
                <>
                  {players.length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <strong>Players</strong>
                      <ul className="roster-list" style={{ listStyle: 'none', paddingLeft: 0 }}>
                        {players.map((p, i) => (
                          <li key={`p-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                            {p.isCaptain ? (
                              <span style={{ 
                                display: 'inline-flex', 
                                alignItems: 'center', 
                                justifyContent: 'center',
                                width: 24, 
                                height: 24, 
                                borderRadius: '50%', 
                                border: '2px solid var(--text)',
                                fontSize: 12,
                                fontWeight: 600
                              }}>#{p.number ?? ''}</span>
                            ) : (
                              <span>#{p.number ?? ''}</span>
                            )}
                            {p.libero && (
                              <span style={{ color: '#3b82f6', fontWeight: 600 }}>
                                {p.libero === 'libero1' ? 'L1' : 'L2'}
                              </span>
                            )}
                            <span>{p.lastName} {p.firstName}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {liberos.length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <strong>Liberos</strong>
                      <ul className="roster-list" style={{ listStyle: 'none', paddingLeft: 0 }}>
                        {liberos.map((p, i) => (
                          <li key={`l-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                            {p.isCaptain ? (
                              <span style={{ 
                                display: 'inline-flex', 
                                alignItems: 'center', 
                                justifyContent: 'center',
                                width: 24, 
                                height: 24, 
                                borderRadius: '50%', 
                                border: '2px solid var(--text)',
                                fontSize: 12,
                                fontWeight: 600
                              }}>#{p.number ?? ''}</span>
                            ) : (
                              <span>#{p.number ?? ''}</span>
                            )}
                            <span style={{ color: '#3b82f6', fontWeight: 600 }}>
                              {p.libero === 'libero1' ? 'L1' : 'L2'}
                            </span>
                            <span>{p.lastName} {p.firstName}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {bench.length > 0 && (
                    <div>
                      <strong>Bench</strong>
                      <ul className="roster-list" style={{ listStyle: 'none', paddingLeft: 0 }}>
                        {bench.map((m, i) => (
                          <li key={`b-${i}`} style={{ marginBottom: 4 }}>{m.role}: {m.lastName} {m.firstName}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )
            })()}
          </div>
        </div>
      )}

      <SignaturePad 
        open={openSignature !== null} 
        onClose={() => setOpenSignature(null)} 
        onSave={handleSignatureSave}
        title={openSignature === 'home-coach' ? 'Home Coach Signature' : 
               openSignature === 'home-captain' ? 'Home Captain Signature' :
               openSignature === 'away-coach' ? 'Away Coach Signature' :
               openSignature === 'away-captain' ? 'Away Captain Signature' : 'Sign'}
      />
    </div>
  )
}
