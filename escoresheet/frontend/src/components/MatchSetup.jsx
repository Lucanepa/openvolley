import { useState } from 'react'
import { db } from '../db/db'
import Modal from './Modal'

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
  const [homeColor, setHomeColor] = useState('#e11d48')
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

  // UI state for modals
  const [openInfo, setOpenInfo] = useState(false)
  const [openOfficials, setOpenOfficials] = useState(false)
  const [openHome, setOpenHome] = useState(false)
  const [openAway, setOpenAway] = useState(false)

  const teamColors = ['#ef4444','#f59e0b','#22c55e','#3b82f6','#a855f7','#ec4899','#14b8a6','#eab308','#6366f1','#84cc16','#10b981','#f97316','#06b6d4','#dc2626','#64748b']

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

  return (
    <div className="setup">
      <h2>Create Match</h2>
      <div className="grid-4">
        <div className="card">
          <div>
            <h3>Match info</h3>
            <p className="text-sm">{date || time || hall || city || league ? 'Configured' : 'Not set'}</p>
          </div>
          <div className="actions"><button className="secondary" onClick={()=>setOpenInfo(true)}>Edit</button></div>
        </div>
        <div className="card">
          <div>
            <h3>Match officials</h3>
            <p className="text-sm">Edit referees and table crew</p>
          </div>
          <div className="actions"><button className="secondary" onClick={()=>setOpenOfficials(true)}>Edit</button></div>
        </div>
        <div className="card">
          <div>
            <h3>Home team</h3>
            <p className="text-sm">{home}</p>
          </div>
          <div className="actions"><button className="secondary" onClick={()=>setOpenHome(true)}>Edit</button></div>
        </div>
        <div className="card">
          <div>
            <h3>Away team</h3>
            <p className="text-sm">{away}</p>
          </div>
          <div className="actions"><button className="secondary" onClick={()=>setOpenAway(true)}>Edit</button></div>
        </div>
      </div>

      <div style={{ display:'flex', justifyContent:'flex-end', marginTop:12 }}>
        <button onClick={createMatch}>Start Match</button>
      </div>

      <Modal title="Match info" open={openInfo} onClose={()=>setOpenInfo(false)} width={900}>
        <div className="row">
          <label className="inline"><span>Date</span><input className="w-160" type="date" value={date} onChange={e=>setDate(e.target.value)} /></label>
          <label className="inline"><span>Time</span><input className="w-140" type="time" value={time} onChange={e=>setTime(e.target.value)} /></label>
          <label className="inline"><span>City</span><input className="w-200 capitalize" value={city} onChange={e=>setCity(e.target.value)} /></label>
          <label className="inline"><span>Hall</span><input className="w-200 capitalize" value={hall} onChange={e=>setHall(e.target.value)} /></label>
          <label className="inline"><span>Match Type</span>
            <select className="w-200" value={type1} onChange={e=>setType1(e.target.value)}>
              <option value="championship">Championship</option>
              <option value="cup">Cup</option>
            </select>
          </label>
          <label className="inline"><span>Match Category</span>
            <select className="w-200" value={type2} onChange={e=>setType2(e.target.value)}>
              <option value="men">Men</option>
              <option value="women">Women</option>
            </select>
          </label>
          <label className="inline"><span>Match Level</span>
            <select className="w-200" value={type3} onChange={e=>setType3(e.target.value)}>
              <option value="enior">Senior</option>
              <option value="U23">U23</option>
              <option value="U21">U21</option>
              <option value="U19">U19</option>
            </select>
          </label>
          <label className="inline"><span>Game #</span><input className="w-120" type="number" inputMode="numeric" value={gameN} onChange={e=>setGameN(e.target.value)} /></label>
          <label className="inline"><span>League</span><input className="w-300 capitalize" value={league} onChange={e=>setLeague(e.target.value)} /></label>
        </div>
      </Modal>

      <Modal title="Home team" open={openHome} onClose={()=>setOpenHome(false)} width={1000}>
        <div className="row" style={{ alignItems:'center' }}>
          <label className="inline"><span>Name</span><input className="w-300 capitalize" value={home} onChange={e=>setHome(e.target.value)} /></label>
          <div className="inline" style={{ gap:6 }}>
            {teamColors.map(c => (
              <button key={c} type="button" className="secondary" onClick={()=>setHomeColor(c)} style={{ width:18, height:18, borderRadius:6, background:c, border: homeColor===c?'2px solid #fff':'1px solid rgba(255,255,255,.2)' }} />
            ))}
          </div>
        </div>
        <h4>Roster</h4>
        <div className="row">
          <input className="w-num" placeholder="#" type="number" inputMode="numeric" value={homeNum} onChange={e=>setHomeNum(e.target.value)} />
          <input className="w-name capitalize" placeholder="Last Name" value={homeLast} onChange={e=>setHomeLast(e.target.value)} />
          <input className="w-name capitalize" placeholder="First Name" value={homeFirst} onChange={e=>setHomeFirst(e.target.value)} />
          <input className="w-dob" placeholder="Date of birth" type="number" inputMode="numeric" value={homeDob} onChange={e=>setHomeDob(e.target.value)} />
          <select className="w-120" value={homeLibero} onChange={e=>setHomeLibero(e.target.value)}>
            <option value="">none</option>
            <option value="libero1">Libero 1</option>
            <option value="libero2">Libero 2</option>
          </select>
          <label className="inline"><input type="radio" name="homeCaptain" checked={homeCaptain} onChange={()=>setHomeCaptain(true)} /> Captain</label>
          <button type="button" className="secondary" onClick={() => {
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
          <div key={`bh-${i}`} className="form-grid" style={{ alignItems:'end' }}>
            <div className="col-3"><input disabled value={m.role} /></div>
            <div className="col-3"><input placeholder="Last Name" value={m.lastName} onChange={e=>setBenchHome(arr => { const a=[...arr]; a[i]={...a[i], lastName:e.target.value}; return a })} /></div>
            <div className="col-3"><input placeholder="First Name" value={m.firstName} onChange={e=>setBenchHome(arr => { const a=[...arr]; a[i]={...a[i], firstName:e.target.value}; return a })} /></div>
            <div className="col-3"><input placeholder="Date of birth" type="number" inputMode="numeric" value={m.dob} onChange={e=>setBenchHome(arr => { const a=[...arr]; a[i]={...a[i], dob:e.target.value}; return a })} /></div>
          </div>
        ))}
      </Modal>

      <Modal title="Away team" open={openAway} onClose={()=>setOpenAway(false)} width={1000}>
        <div className="row" style={{ alignItems:'center' }}>
          <label className="inline"><span>Name</span><input className="w-300 capitalize" value={away} onChange={e=>setAway(e.target.value)} /></label>
          <div className="inline" style={{ gap:6 }}>
            {teamColors.map(c => (
              <button key={c} type="button" className="secondary" onClick={()=>setAwayColor(c)} style={{ width:18, height:18, borderRadius:6, background:c, border: awayColor===c?'2px solid #fff':'1px solid rgba(255,255,255,.2)' }} />
            ))}
          </div>
        </div>
        <h4>Roster</h4>
        <div className="row">
          <input className="w-num" placeholder="#" type="number" inputMode="numeric" value={awayNum} onChange={e=>setAwayNum(e.target.value)} />
          <input className="w-name capitalize" placeholder="Last Name" value={awayLast} onChange={e=>setAwayLast(e.target.value)} />
          <input className="w-name capitalize" placeholder="First Name" value={awayFirst} onChange={e=>setAwayFirst(e.target.value)} />
          <input className="w-dob" placeholder="Date of birth" type="number" inputMode="numeric" value={awayDob} onChange={e=>setAwayDob(e.target.value)} />
          <select className="w-120" value={awayLibero} onChange={e=>setAwayLibero(e.target.value)}>
            <option value="">none</option>
            <option value="libero1">libero 1</option>
            <option value="libero2">libero 2</option>
          </select>
          <label className="inline"><input type="radio" name="awayCaptain" checked={awayCaptain} onChange={()=>setAwayCaptain(true)} /> Captain</label>
          <button type="button" className="secondary" onClick={() => {
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
          <div key={`ba-${i}`} className="form-grid" style={{ alignItems:'end' }}>
            <div className="col-3"><input disabled value={m.role} /></div>
            <div className="col-3"><input placeholder="Last Name" value={m.lastName} onChange={e=>setBenchAway(arr => { const a=[...arr]; a[i]={...a[i], lastName:e.target.value}; return a })} /></div>
            <div className="col-3"><input placeholder="First Name" value={m.firstName} onChange={e=>setBenchAway(arr => { const a=[...arr]; a[i]={...a[i], firstName:e.target.value}; return a })} /></div>
            <div className="col-3"><input placeholder="Date of birth" type="number" inputMode="numeric" value={m.dob} onChange={e=>setBenchAway(arr => { const a=[...arr]; a[i]={...a[i], dob:e.target.value}; return a })} /></div>
          </div>
        ))}
      </Modal>

      <Modal title="Match officials" open={openOfficials} onClose={()=>setOpenOfficials(false)} width={1000}>
        <div className="row">
          <h4>1st Referee</h4>
          <input className="w-200 capitalize" placeholder="Last Name" value={ref1Last} onChange={e=>setRef1Last(e.target.value)} />
          <input className="w-200 capitalize" placeholder="First Name" value={ref1First} onChange={e=>setRef1First(e.target.value)} />
          <input className="w-120" placeholder="Country" value={ref1Country} onChange={e=>setRef1Country(e.target.value)} />
          <input className="w-dob" placeholder="Date of birth" type="number" inputMode="numeric" value={ref1Dob} onChange={e=>setRef1Dob(e.target.value)} />
        </div>
        <div className="row">
          <h4>2nd Referee</h4>
          <input className="w-200 capitalize" placeholder="Last Name" value={ref2Last} onChange={e=>setRef2Last(e.target.value)} />
          <input className="w-200 capitalize" placeholder="First Name" value={ref2First} onChange={e=>setRef2First(e.target.value)} />
          <input className="w-120" placeholder="Country" value={ref2Country} onChange={e=>setRef2Country(e.target.value)} />
          <input className="w-dob" placeholder="Date of birth" type="number" inputMode="numeric" value={ref2Dob} onChange={e=>setRef2Dob(e.target.value)} />
        </div>
        <div className="row">
          <h4>Scorer</h4>
          <input className="w-200 capitalize" placeholder="Last Name" value={scorerLast} onChange={e=>setScorerLast(e.target.value)} />
          <input className="w-200 capitalize" placeholder="First Name" value={scorerFirst} onChange={e=>setScorerFirst(e.target.value)} />
          <input className="w-120" placeholder="Country" value={scorerCountry} onChange={e=>setScorerCountry(e.target.value)} />
          <input className="w-dob" placeholder="Date of birth" type="number" inputMode="numeric" value={scorerDob} onChange={e=>setScorerDob(e.target.value)} />
        </div>
        <div className="row">
          <h4>Assistant Scorer</h4>
          <input className="w-200 capitalize" placeholder="Last Name" value={asstLast} onChange={e=>setAsstLast(e.target.value)} />
          <input className="w-200 capitalize" placeholder="First Name" value={asstFirst} onChange={e=>setAsstFirst(e.target.value)} />
          <input className="w-120" placeholder="Country" value={asstCountry} onChange={e=>setAsstCountry(e.target.value)} />
          <input className="w-dob" placeholder="Date of birth" type="number" inputMode="numeric" value={asstDob} onChange={e=>setAsstDob(e.target.value)} />
        </div>
      </Modal>
    </div>
  )
}


