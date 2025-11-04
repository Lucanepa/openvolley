import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'

export default function Scoreboard({ matchId, onFinishSet }) {
  const set = useLiveQuery(async () => {
    return await db.sets.where({ matchId, finished: false }).first()
  }, [matchId])

  if (!set) return <p>Loading…</p>

  async function point(team) {
    const field = team === 'home' ? 'homePoints' : 'awayPoints'
    await db.sets.update(set.id, { [field]: set[field] + 1 })
    await db.events.add({ matchId, setIndex: set.index, type: 'point', payload: { team }, ts: new Date().toISOString() })
    await db.sync_queue.add({ resource: 'event', action: 'insert', payload: { match_id: null, set_index: set.index, type: 'point', payload: { team } }, ts: Date.now(), status: 'queued' })
  }

  return (
    <div className="scoreboard">
      <h3>Set {set.index}</h3>
      <div className="scores">
        <button onClick={() => point('home')}>+ Home</button>
        <span className="score">{set.homePoints} : {set.awayPoints}</span>
        <button onClick={() => point('away')}>+ Away</button>
      </div>
      <button onClick={() => onFinishSet(set)}>End Set</button>
    </div>
  )
}


