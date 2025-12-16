import { useState } from 'react'
import { db } from '../db/db'

/**
 * TestModeControls - Debug buttons for testing match functionality
 * Only shown when in test mode (match.test === true)
 *
 * Provides random actions for:
 * - Add a point
 * - Insert libero
 * - Switch side
 * - Switch serve
 * - Trigger timeout
 * - Substitute player
 * - Trigger match end
 * - Trigger set end
 * - Call referee
 */
export default function TestModeControls({ matchId, onRefresh }) {
  const [expanded, setExpanded] = useState(false)
  const [lastAction, setLastAction] = useState(null)

  // Get current match state
  const getMatchState = async () => {
    const match = await db.matches.get(matchId)
    const sets = await db.sets.where('matchId').equals(matchId).sortBy('index')
    const currentSet = sets.find(s => !s.finished) || sets[sets.length - 1]
    const events = await db.events.where('matchId').equals(matchId).sortBy('seq')
    const currentSetEvents = events.filter(e => e.setIndex === currentSet?.index)

    // Get max seq for current set
    const maxSeq = currentSetEvents.reduce((max, e) => Math.max(max, e.seq || 0), 0)

    return { match, sets, currentSet, events, currentSetEvents, maxSeq }
  }

  // Add event helper
  const addEvent = async (type, payload, setIndex) => {
    const { maxSeq } = await getMatchState()
    const nextSeq = Math.floor(maxSeq) + 1

    await db.events.add({
      matchId,
      setIndex,
      type,
      payload,
      ts: new Date().toISOString(),
      seq: nextSeq
    })
  }

  // Random team selector
  const randomTeam = () => Math.random() > 0.5 ? 'home' : 'away'

  // Action handlers
  const handleAddPoint = async () => {
    try {
      const { currentSet } = await getMatchState()
      if (!currentSet) {
        setLastAction('No active set')
        return
      }

      const team = randomTeam()
      await addEvent('point', { team }, currentSet.index)

      // Update set score
      const field = team === 'home' ? 'homePoints' : 'awayPoints'
      const currentPoints = currentSet[field] || 0
      await db.sets.update(currentSet.id, { [field]: currentPoints + 1 })

      setLastAction(`Point: ${team}`)
      onRefresh?.()
    } catch (err) {
      setLastAction(`Error: ${err.message}`)
    }
  }

  const handleInsertLibero = async () => {
    try {
      const { currentSet, currentSetEvents } = await getMatchState()
      if (!currentSet) {
        setLastAction('No active set')
        return
      }

      const team = randomTeam()

      // Get current lineup for this team
      const lineupEvents = currentSetEvents.filter(e =>
        e.type === 'lineup' && e.payload?.team === team
      )
      const lastLineup = lineupEvents[lineupEvents.length - 1]

      if (!lastLineup?.payload?.lineup) {
        setLastAction('No lineup found')
        return
      }

      // Find a back row position (4, 5, or 6) to insert libero
      const positions = [4, 5, 6]
      const position = positions[Math.floor(Math.random() * positions.length)]

      // Create new lineup with libero substitution marker
      const newLineup = { ...lastLineup.payload.lineup }

      await addEvent('lineup', {
        team,
        lineup: newLineup,
        liberoSubstitution: {
          position,
          liberoIn: true,
          liberoNumber: 99, // Mock libero number
          replacedPlayer: newLineup[position]
        }
      }, currentSet.index)

      setLastAction(`Libero: ${team} pos ${position}`)
      onRefresh?.()
    } catch (err) {
      setLastAction(`Error: ${err.message}`)
    }
  }

  const handleSwitchSide = async () => {
    try {
      const { match } = await getMatchState()

      // Toggle left/right team positions
      const newLeftTeam = match.leftTeam === 'home' ? 'away' : 'home'
      await db.matches.update(matchId, { leftTeam: newLeftTeam })

      setLastAction(`Side: ${newLeftTeam} now left`)
      onRefresh?.()
    } catch (err) {
      setLastAction(`Error: ${err.message}`)
    }
  }

  const handleSwitchServe = async () => {
    try {
      const { currentSet, currentSetEvents } = await getMatchState()
      if (!currentSet) {
        setLastAction('No active set')
        return
      }

      // Find current serve from lineup events
      const lineupEvents = currentSetEvents.filter(e => e.type === 'lineup')
      const lastHomeLineup = lineupEvents.filter(e => e.payload?.team === 'home').pop()
      const lastAwayLineup = lineupEvents.filter(e => e.payload?.team === 'away').pop()

      // Rotate serve between teams
      const currentServe = currentSet.firstServe || 'home'
      const newServe = currentServe === 'home' ? 'away' : 'home'

      await db.sets.update(currentSet.id, { firstServe: newServe })

      setLastAction(`Serve: ${newServe}`)
      onRefresh?.()
    } catch (err) {
      setLastAction(`Error: ${err.message}`)
    }
  }

  const handleTriggerTimeout = async () => {
    try {
      const { currentSet } = await getMatchState()
      if (!currentSet) {
        setLastAction('No active set')
        return
      }

      const team = randomTeam()
      await addEvent('timeout', { team }, currentSet.index)

      setLastAction(`Timeout: ${team}`)
      onRefresh?.()
    } catch (err) {
      setLastAction(`Error: ${err.message}`)
    }
  }

  const handleSubstitute = async () => {
    try {
      const { currentSet, currentSetEvents } = await getMatchState()
      if (!currentSet) {
        setLastAction('No active set')
        return
      }

      const team = randomTeam()

      // Get current lineup
      const lineupEvents = currentSetEvents.filter(e =>
        e.type === 'lineup' && e.payload?.team === team
      )
      const lastLineup = lineupEvents[lineupEvents.length - 1]

      if (!lastLineup?.payload?.lineup) {
        setLastAction('No lineup found')
        return
      }

      // Pick random position to substitute
      const position = Math.floor(Math.random() * 6) + 1
      const currentPlayer = lastLineup.payload.lineup[position]
      const newPlayer = Math.floor(Math.random() * 20) + 1 // Random player number

      const newLineup = { ...lastLineup.payload.lineup, [position]: newPlayer }

      await addEvent('lineup', {
        team,
        lineup: newLineup,
        fromSubstitution: true
      }, currentSet.index)

      setLastAction(`Sub: ${team} #${currentPlayer} -> #${newPlayer}`)
      onRefresh?.()
    } catch (err) {
      setLastAction(`Error: ${err.message}`)
    }
  }

  const handleTriggerSetEnd = async () => {
    try {
      const { currentSet } = await getMatchState()
      if (!currentSet) {
        setLastAction('No active set')
        return
      }

      const winner = randomTeam()
      const winnerPoints = 25
      const loserPoints = Math.floor(Math.random() * 23) + 1 // 1-23

      await db.sets.update(currentSet.id, {
        homePoints: winner === 'home' ? winnerPoints : loserPoints,
        awayPoints: winner === 'away' ? winnerPoints : loserPoints,
        finished: true,
        endTime: new Date().toISOString()
      })

      await addEvent('set_end', {
        team: winner,
        setIndex: currentSet.index,
        homePoints: winner === 'home' ? winnerPoints : loserPoints,
        awayPoints: winner === 'away' ? winnerPoints : loserPoints
      }, currentSet.index)

      // Create next set if not match end
      const { sets } = await getMatchState()
      const homeSetsWon = sets.filter(s => s.finished && s.homePoints > s.awayPoints).length
      const awaySetsWon = sets.filter(s => s.finished && s.awayPoints > s.homePoints).length

      if (homeSetsWon < 3 && awaySetsWon < 3) {
        const nextSetIndex = (currentSet.index || 0) + 1
        await db.sets.add({
          matchId,
          index: nextSetIndex,
          homePoints: 0,
          awayPoints: 0,
          finished: false,
          startTime: new Date().toISOString()
        })
      }

      setLastAction(`Set ${currentSet.index} end: ${winner} wins`)
      onRefresh?.()
    } catch (err) {
      setLastAction(`Error: ${err.message}`)
    }
  }

  const handleTriggerMatchEnd = async () => {
    try {
      const { match, sets, currentSet } = await getMatchState()

      // Finish current set if not finished
      if (currentSet && !currentSet.finished) {
        const winner = randomTeam()
        await db.sets.update(currentSet.id, {
          homePoints: winner === 'home' ? 25 : 20,
          awayPoints: winner === 'away' ? 25 : 20,
          finished: true,
          endTime: new Date().toISOString()
        })
      }

      // Count current wins
      const updatedSets = await db.sets.where('matchId').equals(matchId).toArray()
      let homeSetsWon = updatedSets.filter(s => s.finished && s.homePoints > s.awayPoints).length
      let awaySetsWon = updatedSets.filter(s => s.finished && s.awayPoints > s.homePoints).length

      // Add sets until one team wins 3
      const matchWinner = Math.random() > 0.5 ? 'home' : 'away'
      let setIndex = updatedSets.length

      while (homeSetsWon < 3 && awaySetsWon < 3) {
        setIndex++
        const setWinner = matchWinner === 'home'
          ? (homeSetsWon < 3 ? 'home' : 'away')
          : (awaySetsWon < 3 ? 'away' : 'home')

        await db.sets.add({
          matchId,
          index: setIndex,
          homePoints: setWinner === 'home' ? 25 : Math.floor(Math.random() * 23),
          awayPoints: setWinner === 'away' ? 25 : Math.floor(Math.random() * 23),
          finished: true,
          startTime: new Date().toISOString(),
          endTime: new Date().toISOString()
        })

        if (setWinner === 'home') homeSetsWon++
        else awaySetsWon++
      }

      // Update match status
      await db.matches.update(matchId, { status: 'final' })

      setLastAction(`Match end: ${matchWinner} wins ${homeSetsWon}-${awaySetsWon}`)
      onRefresh?.()
    } catch (err) {
      setLastAction(`Error: ${err.message}`)
    }
  }

  const handleCallReferee = async () => {
    try {
      const { currentSet } = await getMatchState()
      if (!currentSet) {
        setLastAction('No active set')
        return
      }

      // Add a referee call event (remark type)
      await addEvent('remark', {
        type: 'referee_call',
        message: 'Debug: Referee called for consultation',
        team: randomTeam()
      }, currentSet.index)

      setLastAction('Referee called')
      onRefresh?.()
    } catch (err) {
      setLastAction(`Error: ${err.message}`)
    }
  }

  const buttonStyle = {
    padding: '8px 12px',
    fontSize: '11px',
    fontWeight: 600,
    background: 'rgba(251, 191, 36, 0.2)',
    color: '#fbbf24',
    border: '1px solid rgba(251, 191, 36, 0.4)',
    borderRadius: '6px',
    cursor: 'pointer',
    whiteSpace: 'nowrap'
  }

  if (!expanded) {
    return (
      <div
        onClick={() => setExpanded(true)}
        style={{
          position: 'fixed',
          bottom: '10px',
          right: '10px',
          background: 'rgba(251, 191, 36, 0.3)',
          color: '#fbbf24',
          padding: '8px 12px',
          borderRadius: '8px',
          fontSize: '12px',
          fontWeight: 600,
          cursor: 'pointer',
          zIndex: 9999,
          border: '1px solid rgba(251, 191, 36, 0.5)'
        }}
      >
        TEST MODE
      </div>
    )
  }

  return (
    <div style={{
      position: 'fixed',
      bottom: '10px',
      right: '10px',
      background: 'rgba(0, 0, 0, 0.9)',
      borderRadius: '12px',
      padding: '12px',
      zIndex: 9999,
      border: '1px solid rgba(251, 191, 36, 0.5)',
      maxWidth: '320px'
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '10px'
      }}>
        <span style={{ color: '#fbbf24', fontWeight: 600, fontSize: '12px' }}>
          TEST MODE CONTROLS
        </span>
        <button
          onClick={() => setExpanded(false)}
          style={{
            background: 'none',
            border: 'none',
            color: '#fbbf24',
            cursor: 'pointer',
            fontSize: '16px',
            padding: '0 4px'
          }}
        >
          ×
        </button>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: '6px',
        marginBottom: '8px'
      }}>
        <button style={buttonStyle} onClick={handleAddPoint}>
          + Point
        </button>
        <button style={buttonStyle} onClick={handleInsertLibero}>
          Libero
        </button>
        <button style={buttonStyle} onClick={handleSwitchSide}>
          Side
        </button>
        <button style={buttonStyle} onClick={handleSwitchServe}>
          Serve
        </button>
        <button style={buttonStyle} onClick={handleTriggerTimeout}>
          Timeout
        </button>
        <button style={buttonStyle} onClick={handleSubstitute}>
          Sub
        </button>
        <button style={buttonStyle} onClick={handleTriggerSetEnd}>
          Set End
        </button>
        <button style={buttonStyle} onClick={handleTriggerMatchEnd}>
          Match End
        </button>
        <button style={buttonStyle} onClick={handleCallReferee}>
          Call Ref
        </button>
      </div>

      {lastAction && (
        <div style={{
          fontSize: '10px',
          color: 'rgba(255,255,255,0.6)',
          textAlign: 'center',
          marginTop: '4px'
        }}>
          {lastAction}
        </div>
      )}
    </div>
  )
}
