import { useState } from 'react'
import { db } from '../db/db'

export default function MatchSetup({ onStart }) {
  const [home, setHome] = useState('Home')
  const [away, setAway] = useState('Away')

  async function createMatch() {
    const homeId = await db.teams.add({ name: home, createdAt: new Date().toISOString() })
    const awayId = await db.teams.add({ name: away, createdAt: new Date().toISOString() })
    const matchId = await db.matches.add({
      homeTeamId: homeId,
      awayTeamId: awayId,
      status: 'live',
      scheduledAt: new Date().toISOString(),
      createdAt: new Date().toISOString()
    })
    await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 0, finished: false })
    onStart(matchId)
  }

  return (
    <div className="setup">
      <h2>Create Match</h2>
      <label>Home Team <input value={home} onChange={e=>setHome(e.target.value)} /></label>
      <label>Away Team <input value={away} onChange={e=>setAway(e.target.value)} /></label>
      <button onClick={createMatch}>Start Match</button>
    </div>
  )
}


