import { useState, useEffect } from 'react'
import { db } from './db/db'
import MatchSetup from './components/MatchSetup'
import Scoreboard from './components/Scoreboard'
import { useSyncQueue } from './hooks/useSyncQueue'
import mikasaVolleyball from './mikasa_v200w.png'

export default function App() {
  const [matchId, setMatchId] = useState(null)
  useSyncQueue()

  // Preload volleyball image when app loads
  useEffect(() => {
    // Preload the image
    const img = new Image()
    img.src = mikasaVolleyball
    
    // Also add a preload link to the document head for early loading
    const link = document.createElement('link')
    link.rel = 'preload'
    link.as = 'image'
    link.href = mikasaVolleyball
    document.head.appendChild(link)
    
    return () => {
      // Cleanup: remove preload link if component unmounts
      const existingLink = document.querySelector(`link[href="${mikasaVolleyball}"]`)
      if (existingLink) {
        document.head.removeChild(existingLink)
      }
    }
  }, [])

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


