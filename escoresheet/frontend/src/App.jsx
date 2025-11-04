import { useState } from 'react'
import { db } from './db/db'
import MatchSetup from './components/MatchSetup'
import Scoreboard from './components/Scoreboard'
import { useSyncQueue } from './hooks/useSyncQueue'

export default function App() {
  const [matchId, setMatchId] = useState(null)
  useSyncQueue()

  async function finishSet(cur) {
    await db.sets.update(cur.id, { finished: true })
    const sets = await db.sets.where({ matchId: cur.matchId }).toArray()
    const finished = sets.filter(s => s.finished).length
    if (finished >= 5) {
      await db.matches.update(cur.matchId, { status: 'final' })
      setMatchId(null)
      return
    }
    await db.sets.add({ matchId: cur.matchId, index: cur.index + 1, homePoints: 0, awayPoints: 0, finished: false })
  }

  return (
    <div className="container">
      <h1>Open eScoresheet</h1>
      <div className="panel">
        {!matchId ? (
          <MatchSetup onStart={setMatchId} />
        ) : (
          <Scoreboard matchId={matchId} onFinishSet={finishSet} />
        )}
      </div>
      <p>Offline-first PWA. Data is saved locally and syncs when online.</p>
    </div>
  )
}


