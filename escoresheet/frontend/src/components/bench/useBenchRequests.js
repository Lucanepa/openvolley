import { useCallback, useEffect, useReducer, useRef } from 'react'
import { addRelayMessageListener, sendRelayMessage } from '../../utils/serverDataSync'
import { benchRequestsReducer, newBenchRequestId } from '../../domain/benchRequests'

/**
 * The bench's requests to the scorer over its relay subscription
 * (domain/benchRequests.js, backend/lib/benchRequests.js). `send` answers
 * { ok, reason }: nothing is queued while the tablet has no connection to the
 * relay, the request is marked "not sent" and the coach asks as usual.
 */
export const BENCH_ACK_TIMEOUT_MS = 6000

export function useBenchRequests(matchId, team) {
  const [requests, dispatch] = useReducer(benchRequestsReducer, {})
  // A socket that still says open on a dead Wi-Fi link: no answer from the
  // relay in time and the request counts as not sent (nothing waits)
  const timers = useRef(new Set())
  useEffect(() => () => { for (const t of timers.current) clearTimeout(t) }, [])

  useEffect(() => {
    if (!matchId || matchId === -1 || !team) return undefined
    return addRelayMessageListener(matchId, (m) => {
      if (m.team && m.team !== team && m.type !== 'error') return
      if (m.type === 'bench-request-ack') dispatch({ type: 'ack', message: m })
      else if (m.type === 'bench-response') dispatch({ type: 'response', message: m })
      else if (m.type === 'bench-request-state') dispatch({ type: 'state', message: m })
      else if (m.type === 'error') dispatch({ type: 'refused', message: m })
    })
  }, [matchId, team])

  const send = useCallback((kind, setIndex, extra = {}) => {
    const request = { id: newBenchRequestId(), kind, setIndex, ...extra }
    const ok = matchId && matchId !== -1 && sendRelayMessage(matchId, { type: 'bench-request', matchId: String(matchId), team, request })
    if (!ok) {
      dispatch({ type: 'notSent', request, reason: 'no_connection' })
      return { ok: false, reason: 'no_connection', id: request.id }
    }
    dispatch({ type: 'sent', request })
    const timer = setTimeout(() => {
      timers.current.delete(timer)
      dispatch({ type: 'noAck', id: request.id })
    }, BENCH_ACK_TIMEOUT_MS)
    timers.current.add(timer)
    return { ok: true, id: request.id }
  }, [matchId, team])

  const cancel = useCallback((target) => {
    if (!target) return { ok: false }
    return send('cancel', target.setIndex, { cancelId: target.id })
  }, [send])

  return { requests, send, cancel }
}
