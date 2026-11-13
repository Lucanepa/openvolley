import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { scorerRelay } from '../../utils/relayPublisher'
import { scorerQueueReducer, latestLineup, setHasStarted } from '../../domain/benchRequests'

// The team has a line-up of the set already, or the set has started
const lineupClosed = (events, team, idx) => !!latestLineup(events, idx, team) || setHasStarted(events, idx)
const maxSeq = (events) => (events || []).reduce((m, e) => Math.max(m, e?.seq || 0), 0)
const same = (a, b) => String(a) === String(b)
const tsMs = (ts) => (typeof ts === 'number' ? ts : Date.parse(ts))

/**
 * What the recorded events say about an open bench request since it arrived
 * (`sinceSeq`): the scorer recorded it (through the request card or by hand,
 * as always), or not yet. A time-out also counts when it was recorded after
 * the relay took the request (`entry.at`): a request the relay replays after
 * the scorer recorded the time-out by hand is closed, not offered again. Pure.
 * @returns {{ status: 'accepted'|'declined', reason?: string } | { donePairs: number[] } | null}
 */
export function outcomeFromEvents(entry, events, sinceSeq) {
  const { team, request } = entry
  const newer = (events || []).filter((e) => (e?.seq || 0) > sinceSeq && e.payload?.team === team && (e.setIndex ?? 1) === request.setIndex)
  if (request.kind === 'timeout') {
    if (newer.some((e) => e.type === 'timeout')) return { status: 'accepted' }
    const at = Number(entry.at)
    if (!(at > 0)) return null
    const since = (events || []).some((e) => e?.type === 'timeout' && e.payload?.team === team && (e.setIndex ?? 1) === request.setIndex && tsMs(e.ts) >= at)
    return since ? { status: 'accepted' } : null
  }
  if (request.kind === 'lineup') {
    // the team's line-up recorded (as sent, changed or typed by hand): the
    // request is closed, nothing more goes to the bench (owner 2026-11-09)
    return newer.some((e) => e.type === 'lineup' && e.payload?.lineup) ? { status: 'accepted' } : null
  }
  if (request.kind === 'substitution') {
    const subs = newer.filter((e) => e.type === 'substitution')
    const donePairs = (request.pairs || []).map((p, i) => (subs.some((s) => same(s.payload?.playerOut, p.out) && same(s.payload?.playerIn, p.in)) ? i : -1)).filter((i) => i >= 0)
    if (donePairs.length === (request.pairs || []).length && donePairs.length > 0) return { status: 'accepted' }
    return { donePairs }
  }
  return null
}

/**
 * Whether the scorer may take a bench line-up as the starting line-up of the
 * set being scored (`setIndex`): only a line-up for that set, for a team with
 * no line-up in it yet. A request for a later set (kept while a set end was
 * undone) waits. Pure.
 * @returns {null | 'other-set' | 'has-lineup'}
 */
export function lineupAcceptBlock(entry, events, setIndex) {
  if (!setIndex || entry?.request?.setIndex !== setIndex) return 'other-set'
  return latestLineup(events, setIndex, entry.team) ? 'has-lineup' : null
}

/**
 * The scorer's end of the bench requests: the relay's bench-request messages
 * for this match (scorerRelay.listen), the answers (bench-response), and the
 * events that answer a request by themselves: a time-out, the line-up or the
 * substitutions the scorer records (through the request card, which opens
 * the scorer's normal dialog with every check, or by hand). A line-up
 * request is closed (accepted: "recorded" on the bench) once the team has a
 * line-up of the set, as sent, changed by the scorer or typed by hand; the
 * bench is never told it was entered otherwise (owner 2026-11-09).
 */
export function useBenchRequestBridge({ relayKey, events, setIndex }) {
  const [queue, dispatch] = useReducer(scorerQueueReducer, [])
  const [donePairs, setDonePairs] = useState({}) // request id -> pair indexes recorded (own keys only, read with Object.hasOwn)
  const [unsent, setUnsent] = useState({}) // request id -> true: the answer found no connection
  const sinceRef = useRef(new Map()) // request id -> max event seq when it arrived
  const eventsRef = useRef(events)
  eventsRef.current = events

  const respond = useCallback((team, id, status, reason = null) => {
    if (!relayKey) return false
    const ok = scorerRelay.send({ type: 'bench-response', matchId: relayKey, team, id, status, ...(reason ? { reason } : {}) })
    if (status !== 'seen') {
      if (ok) {
        dispatch({ type: 'answered', team, id })
        sinceRef.current.delete(id)
      }
      setUnsent((u) => ({ ...u, [id]: !ok }))
    }
    return ok
  }, [relayKey])

  useEffect(() => {
    if (!relayKey) return undefined
    return scorerRelay.listen((m) => {
      if (String(m?.matchId) !== String(relayKey)) return
      if (m.type === 'bench-request') {
        const r = m.request
        if (!r?.id) return
        if (r.kind !== 'cancel' && !sinceRef.current.has(r.id)) sinceRef.current.set(r.id, maxSeq(eventsRef.current))
        if (r.kind === 'lineup' && lineupClosed(eventsRef.current, m.team, r.setIndex)) {
          // the scorer has the team's line-up (or the set started): closed as recorded
          scorerRelay.send({ type: 'bench-response', matchId: relayKey, team: m.team, id: r.id, status: 'accepted' })
          return
        }
        dispatch({ type: 'bench-request', message: m })
        if (r.kind !== 'cancel' && m.status === 'pending') scorerRelay.send({ type: 'bench-response', matchId: relayKey, team: m.team, id: r.id, status: 'seen' })
      } else if (m.type === 'bench-response' && m.status !== 'seen') {
        // answered on another of this match's scoreboards
        dispatch({ type: 'answered', team: m.team, id: m.id })
      }
    })
  }, [relayKey])

  // A set that is over takes its requests with it
  useEffect(() => {
    if (setIndex) dispatch({ type: 'prune', setIndex })
  }, [setIndex])

  // Recorded since the request came: answered by the events
  useEffect(() => {
    for (const entry of queue) {
      const since = sinceRef.current.get(entry.request.id) ?? 0
      const out = outcomeFromEvents(entry, events, since)
      if (!out) continue
      if (out.status) respond(entry.team, entry.request.id, out.status, out.reason || null)
      else if (out.donePairs) {
        setDonePairs((d) => (Object.hasOwn(d, entry.request.id) && String(d[entry.request.id]) === String(out.donePairs) ? d : { ...d, [entry.request.id]: out.donePairs }))
      }
    }
  }, [queue, events, respond])

  const lineupOf = useCallback((team) => latestLineup(events, setIndex, team), [events, setIndex])

  return { queue, respond, donePairs, unsent, lineupOf }
}
