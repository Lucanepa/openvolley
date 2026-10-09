import { useState } from 'react'
import { db } from '../db/db'
import { switchSides } from './corrections/liveActions'
import { Button } from '../ui/Button.jsx'

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
    console.log('[TestModeControls] getMatchState called, matchId:', matchId)
    const match = await db.matches.get(matchId)
    console.log('[TestModeControls] Match from db:', match)
    const sets = await db.sets.where('matchId').equals(matchId).sortBy('index')
    console.log('[TestModeControls] Sets from db:', sets)
    const currentSet = sets.find(s => !s.finished) || sets[sets.length - 1]
    console.log('[TestModeControls] Current set:', currentSet)
    const events = await db.events.where('matchId').equals(matchId).sortBy('seq')
    console.log('[TestModeControls] Events count:', events.length)
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
    console.log('[TestModeControls] handleAddPoint called')
    try {
      const { currentSet } = await getMatchState()
      console.log('[TestModeControls] Current set:', currentSet)
      if (!currentSet) {
        console.log('[TestModeControls] No active set found')
        setLastAction('No active set')
        return
      }

      const team = randomTeam()
      console.log('[TestModeControls] Adding point to:', team)
      await addEvent('point', { team }, currentSet.index)

      // Update set score
      const field = team === 'home' ? 'homePoints' : 'awayPoints'
      const currentPoints = currentSet[field] || 0
      await db.sets.update(currentSet.id, { [field]: currentPoints + 1 })
      console.log('[TestModeControls] Set updated, new points:', currentPoints + 1)

      setLastAction(`Point: ${team}`)
      console.log('[TestModeControls] Calling onRefresh...')
      onRefresh?.()
    } catch (err) {
      console.error('[TestModeControls] Error in handleAddPoint:', err)
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
      const { match, currentSet } = await getMatchState()
      if (!match || !currentSet) {
        setLastAction('No active set')
        return
      }

      // The change of sides the corrections card makes (sets 1-4 pin the
      // other sides, set 5 flips its coin toss side; A and B stay): it wrote
      // match.leftTeam, which no screen reads
      const { after } = await switchSides({ db, matchId, match, setIndex: currentSet.index })

      setLastAction(`Side: ${after}`)
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

  // volleyui (RESTYLE-SPEC P3b): the panel's tools are kit outline buttons
  // (secondary md, h-9) in a dense developer panel scoped by `.ov-kit`.
  const TOOL_CLASS = 'whitespace-nowrap px-2.5 text-xs'

  if (!expanded) {
    return (
      // The kit TEST badge (amber-800 on amber-100, amber-300 hairline;
      // was amber text on a pale amber wash at about 2:1).
      <div
        onClick={() => setExpanded(true)}
        className="no-print inline-flex items-center rounded-full border border-amber-300 bg-amber-100 text-[11px] font-semibold uppercase tracking-wide text-amber-800 shadow-sm"
        style={{
          position: 'fixed',
          bottom: '10px',
          right: '10px',
          padding: '6px 12px',
          cursor: 'pointer',
          zIndex: 9999
        }}
      >
        Test mode
      </div>
    )
  }

  return (
    <div className="ov-kit no-print rounded-2xl border border-stone-200/70 bg-white shadow-card-lg" style={{
      position: 'fixed',
      bottom: '10px',
      right: '10px',
      padding: '12px',
      zIndex: 9999,
      maxWidth: '320px'
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '10px'
      }}>
        <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-800">
          Test mode controls
        </span>
        <button
          onClick={() => setExpanded(false)}
          aria-label="Close"
          title="Close"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-transparent text-stone-500 hover:bg-stone-100 transition-colors"
          style={{
            border: 'none',
            cursor: 'pointer',
            fontSize: '18px',
            padding: 0
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
        <Button variant="secondary" className={TOOL_CLASS} onClick={handleAddPoint}>
          + Point
        </Button>
        <Button variant="secondary" className={TOOL_CLASS} onClick={handleInsertLibero}>
          Libero
        </Button>
        <Button variant="secondary" className={TOOL_CLASS} onClick={handleSwitchSide}>
          Side
        </Button>
        <Button variant="secondary" className={TOOL_CLASS} onClick={handleSwitchServe}>
          Serve
        </Button>
        <Button variant="secondary" className={TOOL_CLASS} onClick={handleTriggerTimeout}>
          Timeout
        </Button>
        <Button variant="secondary" className={TOOL_CLASS} onClick={handleSubstitute}>
          Sub
        </Button>
        <Button variant="secondary" className={TOOL_CLASS} onClick={handleTriggerSetEnd}>
          Set end
        </Button>
        <Button variant="secondary" className={TOOL_CLASS} onClick={handleTriggerMatchEnd}>
          Match end
        </Button>
        <Button variant="secondary" className={TOOL_CLASS} onClick={handleCallReferee}>
          Call ref
        </Button>
      </div>

      {lastAction && (
        <div style={{
          fontSize: '11px',
          color: 'var(--ov-text-muted)',
          textAlign: 'center',
          marginTop: '4px'
        }}>
          {lastAction}
        </div>
      )}
    </div>
  )
}
