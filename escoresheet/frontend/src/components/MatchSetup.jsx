import { useState } from 'react'
import { db } from '../db/db'
import SignaturePad from './SignaturePad'

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
  const [currentView, setCurrentView] = useState('main') // 'main', 'info', 'officials', 'home', 'away'
  const [openSignature, setOpenSignature] = useState(null) // 'home-coach', 'home-captain', 'away-coach', 'away-captain'

  // Cities in Kanton Zürich
  const citiesZurich = [
    'Zürich', 'Winterthur', 'Uster', 'Dübendorf', 'Dietikon', 'Wetzikon', 'Horgen', 
    'Bülach', 'Kloten', 'Meilen', 'Adliswil', 'Thalwil', 'Küsnacht', 'Opfikon', 
    'Volketswil', 'Schlieren', 'Wallisellen', 'Regensdorf', 'Pfäffikon', 'Illnau-Effretikon',
    'Stäfa', 'Wädenswil', 'Männedorf', 'Rüti', 'Gossau', 'Bassersdorf', 'Richterswil',
    'Wald', 'Affoltern am Albis', 'Dielsdorf', 'Embrach', 'Hinwil', 'Küssnacht', 
    'Oberrieden', 'Uitikon', 'Egg', 'Fällanden', 'Maur', 'Rümlang', 'Zollikon'
  ].sort()

  const teamColors = ['#ef4444','#f59e0b','#22c55e','#3b82f6','#a855f7','#ec4899','#14b8a6','#eab308','#6366f1','#84cc16','#10b981','#f97316','#06b6d4','#dc2626','#64748b']

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
    await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 0, finished: false })
    onStart(matchId)
  }

  if (currentView === 'info') {
    return (
      <div className="setup">
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
          <button className="secondary" onClick={()=>setCurrentView('main')}>← Back</button>
          <h2>Match info</h2>
          <div style={{ width: 80 }}></div>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(min(100%, 140px), 1fr))', gap:12, width:'100%', maxWidth:'100%', overflow:'hidden' }}>
          <div className="field" style={{ minWidth:0 }}><label>Date</label><input type="date" value={date} onChange={e=>setDate(e.target.value)} /></div>
          <div className="field" style={{ minWidth:0 }}><label>Time</label><input type="time" value={time} onChange={e=>setTime(e.target.value)} /></div>
          <div className="field" style={{ minWidth:0 }}>
            <label>City</label>
            <input 
              className="capitalize" 
              value={city} 
              onChange={e=>setCity(e.target.value)}
              list="cities-zurich"
              placeholder="Enter city"
            />
            <datalist id="cities-zurich">
              {citiesZurich.map(c => <option key={c} value={c} />)}
            </datalist>
          </div>
          <div className="field" style={{ minWidth:0 }}><label>Hall</label><input className="capitalize" value={hall} onChange={e=>setHall(e.target.value)} /></div>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(min(100%, 150px), 1fr))', gap:12, marginTop:12, width:'100%', maxWidth:'100%', overflow:'hidden' }}>
          <div className="field" style={{ minWidth:0 }}>
            <label>Match Type</label>
            <select value={type1} onChange={e=>setType1(e.target.value)}>
              <option value="championship">Championship</option>
              <option value="cup">Cup</option>
            </select>
          </div>
          <div className="field" style={{ minWidth:0 }}>
            <label>Match Category</label>
            <select value={type2} onChange={e=>setType2(e.target.value)}>
              <option value="men">Men</option>
              <option value="women">Women</option>
            </select>
          </div>
          <div className="field" style={{ minWidth:0 }}>
            <label>Match Level</label>
            <select value={type3} onChange={e=>setType3(e.target.value)}>
              <option value="senior">Senior</option>
              <option value="U23">U23</option>
              <option value="U21">U21</option>
              <option value="U19">U19</option>
            </select>
          </div>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(min(100%, 140px), 1fr))', gap:12, marginTop:12, width:'100%', maxWidth:'100%', overflow:'hidden' }}>
          <div className="field" style={{ minWidth:0 }}><label>Game #</label><input type="number" inputMode="numeric" value={gameN} onChange={e=>setGameN(e.target.value)} /></div>
          <div className="field" style={{ minWidth:0 }}><label>League</label><input className="capitalize" value={league} onChange={e=>setLeague(e.target.value)} /></div>
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
        <div style={{ display:'flex', flexDirection:'column', gap:16, width:'100%', maxWidth:'100%', overflow:'hidden' }}>
          <div style={{ width:'100%', maxWidth:'100%' }}>
            <h4 style={{ marginTop:0 }}>1st Referee</h4>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(min(100%, 140px), 1fr))', gap:8, width:'100%', maxWidth:'100%' }}>
              <div className="field" style={{ minWidth:0 }}><label>Last Name</label><input className="capitalize" value={ref1Last} onChange={e=>setRef1Last(e.target.value)} /></div>
              <div className="field" style={{ minWidth:0 }}><label>First Name</label><input className="capitalize" value={ref1First} onChange={e=>setRef1First(e.target.value)} /></div>
              <div className="field" style={{ minWidth:0 }}><label>Country</label><input value={ref1Country} onChange={e=>setRef1Country(e.target.value)} /></div>
              <div className="field" style={{ minWidth:0 }}><label>Date of birth</label><input type="date" value={ref1Dob ? formatDateToISO(ref1Dob) : ''} onChange={e=>setRef1Dob(e.target.value ? formatDateToDDMMYYYY(e.target.value) : '')} /></div>
            </div>
          </div>

          <div style={{ width:'100%', maxWidth:'100%' }}>
            <h4 style={{ marginTop:0 }}>2nd Referee</h4>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(min(100%, 140px), 1fr))', gap:8, width:'100%', maxWidth:'100%' }}>
              <div className="field" style={{ minWidth:0 }}><label>Last Name</label><input className="capitalize" value={ref2Last} onChange={e=>setRef2Last(e.target.value)} /></div>
              <div className="field" style={{ minWidth:0 }}><label>First Name</label><input className="capitalize" value={ref2First} onChange={e=>setRef2First(e.target.value)} /></div>
              <div className="field" style={{ minWidth:0 }}><label>Country</label><input value={ref2Country} onChange={e=>setRef2Country(e.target.value)} /></div>
              <div className="field" style={{ minWidth:0 }}><label>Date of birth</label><input type="date" value={ref2Dob ? formatDateToISO(ref2Dob) : ''} onChange={e=>setRef2Dob(e.target.value ? formatDateToDDMMYYYY(e.target.value) : '')} /></div>
            </div>
          </div>

          <div style={{ width:'100%', maxWidth:'100%' }}>
            <h4 style={{ marginTop:0 }}>Scorer</h4>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(min(100%, 140px), 1fr))', gap:8, width:'100%', maxWidth:'100%' }}>
              <div className="field" style={{ minWidth:0 }}><label>Last Name</label><input className="capitalize" value={scorerLast} onChange={e=>setScorerLast(e.target.value)} /></div>
              <div className="field" style={{ minWidth:0 }}><label>First Name</label><input className="capitalize" value={scorerFirst} onChange={e=>setScorerFirst(e.target.value)} /></div>
              <div className="field" style={{ minWidth:0 }}><label>Country</label><input value={scorerCountry} onChange={e=>setScorerCountry(e.target.value)} /></div>
              <div className="field" style={{ minWidth:0 }}><label>Date of birth</label><input type="date" value={scorerDob ? formatDateToISO(scorerDob) : ''} onChange={e=>setScorerDob(e.target.value ? formatDateToDDMMYYYY(e.target.value) : '')} /></div>
            </div>
          </div>

          <div style={{ width:'100%', maxWidth:'100%' }}>
            <h4 style={{ marginTop:0 }}>Assistant Scorer</h4>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(min(100%, 140px), 1fr))', gap:8, width:'100%', maxWidth:'100%' }}>
              <div className="field" style={{ minWidth:0 }}><label>Last Name</label><input className="capitalize" value={asstLast} onChange={e=>setAsstLast(e.target.value)} /></div>
              <div className="field" style={{ minWidth:0 }}><label>First Name</label><input className="capitalize" value={asstFirst} onChange={e=>setAsstFirst(e.target.value)} /></div>
              <div className="field" style={{ minWidth:0 }}><label>Country</label><input value={asstCountry} onChange={e=>setAsstCountry(e.target.value)} /></div>
              <div className="field" style={{ minWidth:0 }}><label>Date of birth</label><input type="date" value={asstDob ? formatDateToISO(asstDob) : ''} onChange={e=>setAsstDob(e.target.value ? formatDateToDDMMYYYY(e.target.value) : '')} /></div>
            </div>
          </div>
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
          <label className="inline"><span>Name</span><input className="w-300 capitalize" value={home} onChange={e=>setHome(e.target.value)} /></label>
          <div className="inline" style={{ gap:6 }}>
            {teamColors.map(c => (
              <button key={c} type="button" className="secondary" onClick={()=>setHomeColor(c)} style={{ width:18, height:18, borderRadius:6, background:c, border: homeColor===c?'2px solid #fff':'1px solid rgba(255,255,255,.2)' }} />
            ))}
          </div>
        </div>
        {isHomeLocked && (
          <div className="panel" style={{ marginTop:8 }}>
            <p className="text-sm">Locked (signed by Coach and Captain). <button className="secondary" onClick={()=>unlockTeam('home')}>Unlock</button></p>
          </div>
        )}
        <h4>Roster</h4>
        <div className="row">
          <input disabled={isHomeLocked} className="w-num" placeholder="#" type="number" inputMode="numeric" value={homeNum} onChange={e=>setHomeNum(e.target.value)} />
          <input disabled={isHomeLocked} className="w-name capitalize" placeholder="Last Name" value={homeLast} onChange={e=>setHomeLast(e.target.value)} />
          <input disabled={isHomeLocked} className="w-name capitalize" placeholder="First Name" value={homeFirst} onChange={e=>setHomeFirst(e.target.value)} />
          <input disabled={isHomeLocked} className="w-dob" placeholder="Date of birth (dd/mm/yyyy)" type="date" value={homeDob ? formatDateToISO(homeDob) : ''} onChange={e=>setHomeDob(e.target.value ? formatDateToDDMMYYYY(e.target.value) : '')} />
          <select disabled={isHomeLocked} className="w-120" value={homeLibero} onChange={e=>setHomeLibero(e.target.value)}>
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
        <h4>Signatures</h4>
        <div className="row" style={{ gap: 12, alignItems: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span>Coach</span>
            {homeCoachSignature ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <img src={homeCoachSignature} alt="Coach signature" style={{ maxWidth: 200, maxHeight: 60, border: '1px solid rgba(255,255,255,.2)', borderRadius: 4 }} />
                <button className="secondary" onClick={() => setHomeCoachSignature(null)}>Remove</button>
              </div>
            ) : (
              <button className="secondary" onClick={() => setOpenSignature('home-coach')}>Sign</button>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span>Captain</span>
            {homeCaptainSignature ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <img src={homeCaptainSignature} alt="Captain signature" style={{ maxWidth: 200, maxHeight: 60, border: '1px solid rgba(255,255,255,.2)', borderRadius: 4 }} />
                <button className="secondary" onClick={() => setHomeCaptainSignature(null)}>Remove</button>
              </div>
            ) : (
              <button className="secondary" onClick={() => setOpenSignature('home-captain')}>Sign</button>
            )}
          </div>
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
        {isAwayLocked && (
          <div className="panel" style={{ marginTop:8 }}>
            <p className="text-sm">Locked (signed by Coach and Captain). <button className="secondary" onClick={()=>unlockTeam('away')}>Unlock</button></p>
          </div>
        )}
        <h4>Roster</h4>
        <div className="row">
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
        <h4>Signatures</h4>
        <div className="row" style={{ gap: 12, alignItems: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span>Coach</span>
            {awayCoachSignature ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <img src={awayCoachSignature} alt="Coach signature" style={{ maxWidth: 200, maxHeight: 60, border: '1px solid rgba(255,255,255,.2)', borderRadius: 4 }} />
                <button className="secondary" onClick={() => setAwayCoachSignature(null)}>Remove</button>
              </div>
            ) : (
              <button className="secondary" onClick={() => setOpenSignature('away-coach')}>Sign</button>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span>Captain</span>
            {awayCaptainSignature ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <img src={awayCaptainSignature} alt="Captain signature" style={{ maxWidth: 200, maxHeight: 60, border: '1px solid rgba(255,255,255,.2)', borderRadius: 4 }} />
                <button className="secondary" onClick={() => setAwayCaptainSignature(null)}>Remove</button>
              </div>
            ) : (
              <button className="secondary" onClick={() => setOpenSignature('away-captain')}>Sign</button>
            )}
          </div>
        </div>
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
            <p className="text-sm">Edit referees and table crew</p>
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

      <div style={{ display:'flex', justifyContent:'flex-end', marginTop:12 }}>
        <button onClick={createMatch}>Start Match</button>
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
