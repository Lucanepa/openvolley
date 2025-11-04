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
  const [homePlayer, setHomePlayer] = useState('')
  const [awayNum, setAwayNum] = useState('')
  const [awayPlayer, setAwayPlayer] = useState('')

  // Officials
  const [ref1, setRef1] = useState('')
  const [ref2, setRef2] = useState('')
  const [scorer, setScorer] = useState('')
  const [asstScorer, setAsstScorer] = useState('')

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
      referee_1: ref1 || null,
      referee_2: ref2 || null,
      scorer: scorer || null,
      assistant_scorer: asstScorer || null,
      createdAt: new Date().toISOString()
    })
    if (homeRoster.length) {
      await db.players.bulkAdd(
        homeRoster.map(p => ({ teamId: homeId, number: p.number, name: p.name, role: null, createdAt: new Date().toISOString() }))
      )
    }
    if (awayRoster.length) {
      await db.players.bulkAdd(
        awayRoster.map(p => ({ teamId: awayId, number: p.number, name: p.name, role: null, createdAt: new Date().toISOString() }))
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
        <div style={{ display:'grid', gridTemplateColumns: '100px 1fr auto', gap: 8, alignItems:'center' }}>
          <input placeholder="#" type="number" inputMode="numeric" value={homeNum} onChange={e=>setHomeNum(e.target.value)} />
          <input placeholder="Player name" value={homePlayer} onChange={e=>setHomePlayer(e.target.value)} />
          <button type="button" className="secondary" onClick={() => {
            if (!homePlayer) return
            setHomeRoster(list => [...list, { number: homeNum ? Number(homeNum) : null, name: homePlayer }])
            setHomeNum(''); setHomePlayer('')
          }}>Add</button>
        </div>
        <ul style={{ margin: 8, paddingLeft: 18 }}>
          {homeRoster.map((p, i) => (
            <li key={`h-${i}`} style={{ display:'flex', justifyContent:'space-between', gap:8 }}>
              <span>{p.number ?? ''} {p.name}</span>
              <button type="button" className="secondary" onClick={() => setHomeRoster(list => list.filter((_, idx) => idx !== i))}>Remove</button>
            </li>
          ))}
        </ul>
      </div>

      <label>Away Team <input value={away} onChange={e=>setAway(e.target.value)} /></label>
      <div className="panel" style={{ padding: 12 }}>
        <h3>Roster — Away</h3>
        <div style={{ display:'grid', gridTemplateColumns: '100px 1fr auto', gap: 8, alignItems:'center' }}>
          <input placeholder="#" type="number" inputMode="numeric" value={awayNum} onChange={e=>setAwayNum(e.target.value)} />
          <input placeholder="Player name" value={awayPlayer} onChange={e=>setAwayPlayer(e.target.value)} />
          <button type="button" className="secondary" onClick={() => {
            if (!awayPlayer) return
            setAwayRoster(list => [...list, { number: awayNum ? Number(awayNum) : null, name: awayPlayer }])
            setAwayNum(''); setAwayPlayer('')
          }}>Add</button>
        </div>
        <ul style={{ margin: 8, paddingLeft: 18 }}>
          {awayRoster.map((p, i) => (
            <li key={`a-${i}`} style={{ display:'flex', justifyContent:'space-between', gap:8 }}>
              <span>{p.number ?? ''} {p.name}</span>
              <button type="button" className="secondary" onClick={() => setAwayRoster(list => list.filter((_, idx) => idx !== i))}>Remove</button>
            </li>
          ))}
        </ul>
      </div>

      <div className="panel" style={{ padding: 12 }}>
        <h3>Match officials</h3>
        <label>1st Referee <input value={ref1} onChange={e=>setRef1(e.target.value)} /></label>
        <label>2nd Referee <input value={ref2} onChange={e=>setRef2(e.target.value)} /></label>
        <label>Scorer <input value={scorer} onChange={e=>setScorer(e.target.value)} /></label>
        <label>Assistant Scorer <input value={asstScorer} onChange={e=>setAsstScorer(e.target.value)} /></label>
      </div>
      <button onClick={createMatch}>Start Match</button>
    </div>
  )
}


