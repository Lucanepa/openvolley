import { useState } from 'react'
import { db } from '../db/db'

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
    initBench('coach'), initBench('assistant coach 1'), initBench('assistant coach 2'), initBench('medic'), initBench('physiotherapist')
  ])
  const [benchAway, setBenchAway] = useState([
    initBench('coach'), initBench('assistant coach 1'), initBench('assistant coach 2'), initBench('medic'), initBench('physiotherapist')
  ])

  async function createMatch() {
    const homeId = await db.teams.add({ name: home, createdAt: new Date().toISOString() })
    const awayId = await db.teams.add({ name: away, createdAt: new Date().toISOString() })

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
      <div className="panel" style={{ padding: 12 }}>
        <h3>Match info</h3>
        <label>Date <input type="date" value={date} onChange={e=>setDate(e.target.value)} /></label>
        <label>Time <input type="time" value={time} onChange={e=>setTime(e.target.value)} /></label>
        <label>Hall <input value={hall} onChange={e=>setHall(e.target.value)} /></label>
        <label>City <input value={city} onChange={e=>setCity(e.target.value)} /></label>
        <label>Match type 1
          <select value={type1} onChange={e=>setType1(e.target.value)}>
            <option value="championship">championship</option>
            <option value="cup">cup</option>
          </select>
        </label>
        <label>Match type 2
          <select value={type2} onChange={e=>setType2(e.target.value)}>
            <option value="men">men</option>
            <option value="women">women</option>
          </select>
        </label>
        <label>Match type 3
          <select value={type3} onChange={e=>setType3(e.target.value)}>
            <option value="senior">senior</option>
            <option value="U23">U23</option>
            <option value="U19">U19</option>
          </select>
        </label>
        <label>Game # <input type="number" inputMode="numeric" value={gameN} onChange={e=>setGameN(e.target.value)} /></label>
        <label>League <input value={league} onChange={e=>setLeague(e.target.value)} /></label>
      </div>

      <label>Home Team <input value={home} onChange={e=>setHome(e.target.value)} /></label>
      <div className="panel" style={{ padding: 12 }}>
        <h3>Roster — Home</h3>
        <div className="form-grid">
          <div className="col-3"><input placeholder="#" type="number" inputMode="numeric" value={homeNum} onChange={e=>setHomeNum(e.target.value)} /></div>
          <div className="col-3"><input placeholder="Last name" value={homeLast} onChange={e=>setHomeLast(e.target.value)} /></div>
          <div className="col-3"><input placeholder="First name" value={homeFirst} onChange={e=>setHomeFirst(e.target.value)} /></div>
          <div className="col-3"><input placeholder="DOB (YYYYMMDD)" type="number" inputMode="numeric" value={homeDob} onChange={e=>setHomeDob(e.target.value)} /></div>
          <div className="col-4"><select value={homeLibero} onChange={e=>setHomeLibero(e.target.value)}><option value="">none</option><option value="libero1">libero 1</option><option value="libero2">libero 2</option></select></div>
          <div className="col-4" style={{ display:'flex', alignItems:'center', gap:8 }}>
            <input type="checkbox" checked={homeCaptain} onChange={e=>setHomeCaptain(e.target.checked)} />
            <span>Captain</span>
          </div>
          <div className="col-4" style={{ display:'flex', justifyContent:'flex-end' }}>
            <button type="button" className="secondary" onClick={() => {
              if (!homeLast || !homeFirst) return
              setHomeRoster(list => [...list, { number: homeNum ? Number(homeNum) : null, lastName: homeLast, firstName: homeFirst, dob: homeDob, libero: homeLibero, isCaptain: homeCaptain }])
              setHomeNum(''); setHomeFirst(''); setHomeLast(''); setHomeDob(''); setHomeLibero(''); setHomeCaptain(false)
            }}>Add</button>
          </div>
        </div>
        <ul style={{ margin: 8, paddingLeft: 18 }}>
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
            <div className="col-3"><input placeholder="Last name" value={m.lastName} onChange={e=>setBenchHome(arr => { const a=[...arr]; a[i]={...a[i], lastName:e.target.value}; return a })} /></div>
            <div className="col-3"><input placeholder="First name" value={m.firstName} onChange={e=>setBenchHome(arr => { const a=[...arr]; a[i]={...a[i], firstName:e.target.value}; return a })} /></div>
            <div className="col-3"><input placeholder="DOB (YYYYMMDD)" type="number" inputMode="numeric" value={m.dob} onChange={e=>setBenchHome(arr => { const a=[...arr]; a[i]={...a[i], dob:e.target.value}; return a })} /></div>
          </div>
        ))}
      </div>

      <label>Away Team <input value={away} onChange={e=>setAway(e.target.value)} /></label>
      <div className="panel" style={{ padding: 12 }}>
        <h3>Roster — Away</h3>
        <div className="form-grid">
          <div className="col-3"><input placeholder="#" type="number" inputMode="numeric" value={awayNum} onChange={e=>setAwayNum(e.target.value)} /></div>
          <div className="col-3"><input placeholder="Last name" value={awayLast} onChange={e=>setAwayLast(e.target.value)} /></div>
          <div className="col-3"><input placeholder="First name" value={awayFirst} onChange={e=>setAwayFirst(e.target.value)} /></div>
          <div className="col-3"><input placeholder="DOB (YYYYMMDD)" type="number" inputMode="numeric" value={awayDob} onChange={e=>setAwayDob(e.target.value)} /></div>
          <div className="col-4"><select value={awayLibero} onChange={e=>setAwayLibero(e.target.value)}><option value="">none</option><option value="libero1">libero 1</option><option value="libero2">libero 2</option></select></div>
          <div className="col-4" style={{ display:'flex', alignItems:'center', gap:8 }}>
            <input type="checkbox" checked={awayCaptain} onChange={e=>setAwayCaptain(e.target.checked)} />
            <span>Captain</span>
          </div>
          <div className="col-4" style={{ display:'flex', justifyContent:'flex-end' }}>
            <button type="button" className="secondary" onClick={() => {
              if (!awayLast || !awayFirst) return
              setAwayRoster(list => [...list, { number: awayNum ? Number(awayNum) : null, lastName: awayLast, firstName: awayFirst, dob: awayDob, libero: awayLibero, isCaptain: awayCaptain }])
              setAwayNum(''); setAwayFirst(''); setAwayLast(''); setAwayDob(''); setAwayLibero(''); setAwayCaptain(false)
            }}>Add</button>
          </div>
        </div>
        <ul style={{ margin: 8, paddingLeft: 18 }}>
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
            <div className="col-3"><input placeholder="Last name" value={m.lastName} onChange={e=>setBenchAway(arr => { const a=[...arr]; a[i]={...a[i], lastName:e.target.value}; return a })} /></div>
            <div className="col-3"><input placeholder="First name" value={m.firstName} onChange={e=>setBenchAway(arr => { const a=[...arr]; a[i]={...a[i], firstName:e.target.value}; return a })} /></div>
            <div className="col-3"><input placeholder="DOB (YYYYMMDD)" type="number" inputMode="numeric" value={m.dob} onChange={e=>setBenchAway(arr => { const a=[...arr]; a[i]={...a[i], dob:e.target.value}; return a })} /></div>
          </div>
        ))}
      </div>

      <div className="panel" style={{ padding: 12 }}>
        <h3>Match officials</h3>
        <div className="form-grid">
          <div className="col-3"><input placeholder="1st Referee last" value={ref1Last} onChange={e=>setRef1Last(e.target.value)} /></div>
          <div className="col-3"><input placeholder="first" value={ref1First} onChange={e=>setRef1First(e.target.value)} /></div>
          <div className="col-2"><input placeholder="country" value={ref1Country} onChange={e=>setRef1Country(e.target.value)} /></div>
          <div className="col-4"><input placeholder="DOB (YYYYMMDD)" type="number" inputMode="numeric" value={ref1Dob} onChange={e=>setRef1Dob(e.target.value)} /></div>

          <div className="col-3"><input placeholder="2nd Referee last" value={ref2Last} onChange={e=>setRef2Last(e.target.value)} /></div>
          <div className="col-3"><input placeholder="first" value={ref2First} onChange={e=>setRef2First(e.target.value)} /></div>
          <div className="col-2"><input placeholder="country" value={ref2Country} onChange={e=>setRef2Country(e.target.value)} /></div>
          <div className="col-4"><input placeholder="DOB (YYYYMMDD)" type="number" inputMode="numeric" value={ref2Dob} onChange={e=>setRef2Dob(e.target.value)} /></div>

          <div className="col-3"><input placeholder="Scorer last" value={scorerLast} onChange={e=>setScorerLast(e.target.value)} /></div>
          <div className="col-3"><input placeholder="first" value={scorerFirst} onChange={e=>setScorerFirst(e.target.value)} /></div>
          <div className="col-2"><input placeholder="country" value={scorerCountry} onChange={e=>setScorerCountry(e.target.value)} /></div>
          <div className="col-4"><input placeholder="DOB (YYYYMMDD)" type="number" inputMode="numeric" value={scorerDob} onChange={e=>setScorerDob(e.target.value)} /></div>

          <div className="col-3"><input placeholder="Asst scorer last" value={asstLast} onChange={e=>setAsstLast(e.target.value)} /></div>
          <div className="col-3"><input placeholder="first" value={asstFirst} onChange={e=>setAsstFirst(e.target.value)} /></div>
          <div className="col-2"><input placeholder="country" value={asstCountry} onChange={e=>setAsstCountry(e.target.value)} /></div>
          <div className="col-4"><input placeholder="DOB (YYYYMMDD)" type="number" inputMode="numeric" value={asstDob} onChange={e=>setAsstDob(e.target.value)} /></div>
        </div>
      </div>
      <button onClick={createMatch}>Start Match</button>
    </div>
  )
}


