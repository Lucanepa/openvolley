/**
 * useRealtimeConnection Hook
 * Manages connection to match data using Supabase Realtime as primary
 * with WebSocket fallback
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabaseClient'
import { subscribeToMatchData, getMatchData } from '../utils/serverDataSync'

// Connection types
export const CONNECTION_TYPES = {
  AUTO: 'auto',           // Try Supabase first, fall back to WebSocket
  SUPABASE: 'supabase',   // Force Supabase Realtime only
  WEBSOCKET: 'websocket'  // Force WebSocket only
}

// Connection status
export const CONNECTION_STATUS = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  ERROR: 'error',
  FALLBACK: 'fallback'    // Using fallback connection
}

/**
 * Hook for managing realtime connection with Supabase primary + WebSocket fallback
 * @param {Object} options
 * @param {string|number} options.matchId - Match ID to subscribe to
 * @param {string} options.preferredConnection - Preferred connection type (auto|supabase|websocket)
 * @param {function} options.onData - Callback when data is received
 * @param {function} options.onAction - Callback when action is received (timeout, substitution, etc.)
 * @param {function} options.onDeleted - Callback when match is deleted from server
 * @param {boolean} options.enabled - Whether to enable the connection
 */
export function useRealtimeConnection({
  matchId,
  preferredConnection = CONNECTION_TYPES.AUTO,
  onData,
  onAction,
  onDeleted,
  enabled = true
}) {
  const [connectionType, setConnectionType] = useState(preferredConnection)
  const [activeConnection, setActiveConnection] = useState(null) // 'supabase' | 'websocket' | null
  const [status, setStatus] = useState(CONNECTION_STATUS.DISCONNECTED)
  const [error, setError] = useState(null)
  const [lastUpdate, setLastUpdate] = useState(null)

  const supabaseChannelRef = useRef(null)
  const wsUnsubscribeRef = useRef(null)
  const isMountedRef = useRef(true)
  const isConnectingRef = useRef(false)

  // Store callbacks in refs to avoid dependency changes
  const onDataRef = useRef(onData)
  const onActionRef = useRef(onAction)
  const onDeletedRef = useRef(onDeleted)

  // Update refs when callbacks change (without triggering re-renders)
  useEffect(() => {
    onDataRef.current = onData
  }, [onData])

  useEffect(() => {
    onActionRef.current = onAction
  }, [onAction])

  useEffect(() => {
    onDeletedRef.current = onDeleted
  }, [onDeleted])

  // Cleanup function
  const cleanup = useCallback(() => {
    // Cleanup Supabase subscription
    if (supabaseChannelRef.current) {
      try {
        supabase?.removeChannel(supabaseChannelRef.current)
      } catch (e) {
        console.warn('[RealtimeConnection] Error removing Supabase channel:', e)
      }
      supabaseChannelRef.current = null
    }

    // Cleanup WebSocket subscription
    if (wsUnsubscribeRef.current) {
      try {
        wsUnsubscribeRef.current()
      } catch (e) {
        console.warn('[RealtimeConnection] Error unsubscribing WebSocket:', e)
      }
      wsUnsubscribeRef.current = null
    }

    setActiveConnection(null)
  }, [])

  // Connect to Supabase Realtime
  const connectSupabase = useCallback(async () => {
    if (!supabase || !matchId) {
      console.log('[RealtimeConnection] Supabase not available or no matchId')
      return false
    }

    try {
      setStatus(CONNECTION_STATUS.CONNECTING)
      console.log('[RealtimeConnection] Connecting to Supabase Realtime for match:', matchId)

      // First, look up the Supabase UUID from external_id (seed_key)
      // This is needed because events/sets tables use match_id (UUID), not external_id
      let supabaseMatchUuid = null
      const { data: matchData, error: lookupError } = await supabase
        .from('matches')
        .select('id')
        .eq('external_id', matchId)
        .maybeSingle()

      if (matchData?.id) {
        supabaseMatchUuid = matchData.id
        console.log('[RealtimeConnection] Found Supabase UUID:', supabaseMatchUuid)
      }

      // Build channel subscriptions
      // Note: events/sets use UUID (match_id), matches uses external_id
      const channel = supabase.channel(`match-${matchId}`)

      // Only subscribe to events/sets/match_live_state if we have the UUID
      if (supabaseMatchUuid) {
        channel
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'events',
              filter: `match_id=eq.${supabaseMatchUuid}`
            },
            (payload) => {
              if (!isMountedRef.current) return
              console.log('[RealtimeConnection] Supabase event received:', payload)
              setLastUpdate(Date.now())

              // Fetch fresh data when events change
              getMatchData(matchId).then(result => {
                if (result.success && onDataRef.current) {
                  onDataRef.current(result)
                }
              }).catch(err => {
                console.error('[RealtimeConnection] Error fetching data after event:', err)
              })
            }
          )
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'sets',
              filter: `match_id=eq.${supabaseMatchUuid}`
            },
            (payload) => {
              if (!isMountedRef.current) return
              console.log('[RealtimeConnection] Supabase set update:', payload)
              setLastUpdate(Date.now())

              // Fetch fresh data when sets change
              getMatchData(matchId).then(result => {
                if (result.success && onDataRef.current) {
                  onDataRef.current(result)
                }
              }).catch(err => {
                console.error('[RealtimeConnection] Error fetching data after set update:', err)
              })
            }
          )
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'match_live_state',
              filter: `match_id=eq.${supabaseMatchUuid}`
            },
            (payload) => {
              if (!isMountedRef.current) return
              console.log('[RealtimeConnection] Supabase match_live_state update:', payload)
              setLastUpdate(Date.now())

              // Fetch fresh data when live state changes (scores, lineups, etc.)
              getMatchData(matchId).then(result => {
                if (result.success && onDataRef.current) {
                  onDataRef.current(result)
                }
              }).catch(err => {
                console.error('[RealtimeConnection] Error fetching data after live state update:', err)
              })
            }
          )
      } else {
        console.warn('[RealtimeConnection] No Supabase UUID found, subscribing to matches only')
      }

      // Always subscribe to matches table changes including deletions (uses external_id)
      channel
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'matches',
            filter: `external_id=eq.${matchId}`
          },
          (payload) => {
            if (!isMountedRef.current) return
            console.log('[RealtimeConnection] Supabase match update:', payload.eventType, payload)
            setLastUpdate(Date.now())

            // Handle match deletion
            if (payload.eventType === 'DELETE') {
              console.log('[RealtimeConnection] Match deleted, calling onDeleted callback')
              if (onDeletedRef.current) {
                onDeletedRef.current()
              }
              return
            }

            // Fetch fresh data when match changes
            getMatchData(matchId).then(result => {
              if (result.success && onDataRef.current) {
                onDataRef.current(result)
              }
            }).catch(err => {
              console.error('[RealtimeConnection] Error fetching data after match update:', err)
            })
          }
        )
        .subscribe((status) => {
          if (!isMountedRef.current) return
          console.log('[RealtimeConnection] Supabase channel status:', status)

          if (status === 'SUBSCRIBED') {
            setStatus(CONNECTION_STATUS.CONNECTED)
            setActiveConnection('supabase')
            setError(null)
            console.log('[RealtimeConnection] Connected to Supabase Realtime')
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            console.warn('[RealtimeConnection] Supabase channel error/timeout, status:', status)
            // Don't set error state, just log - the connection may still work
            // Supabase channels can sometimes report CLOSED/ERROR initially but still function
          }
        })

      supabaseChannelRef.current = channel
      return true
    } catch (err) {
      console.error('[RealtimeConnection] Supabase connection error:', err)
      setError(err.message)
      return false
    }
  }, [matchId]) // Removed onData from deps - using ref instead

  // Connect to WebSocket
  const connectWebSocket = useCallback(() => {
    if (!matchId) return false

    try {
      setStatus(CONNECTION_STATUS.CONNECTING)
      console.log('[RealtimeConnection] Connecting to WebSocket for match:', matchId)

      const unsubscribe = subscribeToMatchData(matchId, (data) => {
        if (!isMountedRef.current) return
        setLastUpdate(Date.now())

        // Check if this is an action
        if (data && data._action) {
          if (onActionRef.current) {
            onActionRef.current(data._action, data._actionData)
          }
        } else if (data && data.match) {
          if (onDataRef.current) {
            onDataRef.current({ success: true, ...data })
          }
        }
      })

      wsUnsubscribeRef.current = unsubscribe
      setStatus(CONNECTION_STATUS.CONNECTED)
      setActiveConnection('websocket')
      setError(null)
      console.log('[RealtimeConnection] Connected to WebSocket')
      return true
    } catch (err) {
      console.error('[RealtimeConnection] WebSocket connection error:', err)
      setError(err.message)
      return false
    }
  }, [matchId]) // Removed onData, onAction from deps - using refs instead

  // Switch connection type
  const switchConnection = useCallback((newType) => {
    console.log('[RealtimeConnection] Switching connection to:', newType)
    setConnectionType(newType)
    // Save preference to localStorage
    try {
      localStorage.setItem('preferredConnection', newType)
    } catch (e) {}
  }, [])

  // Force reconnect - will trigger effect by changing a state
  const reconnect = useCallback(() => {
    console.log('[RealtimeConnection] Force reconnecting...')
    // Reset connecting flag and trigger reconnection
    isConnectingRef.current = false
    cleanup()
    // Small delay then trigger by toggling enabled state would be complex
    // Instead, just call the connect functions directly
    if (!matchId) return

    const doReconnect = async () => {
      isConnectingRef.current = true
      try {
        if (connectionType === CONNECTION_TYPES.SUPABASE) {
          const success = await connectSupabase()
          if (!success) setStatus(CONNECTION_STATUS.ERROR)
        } else if (connectionType === CONNECTION_TYPES.WEBSOCKET) {
          const success = connectWebSocket()
          if (!success) setStatus(CONNECTION_STATUS.ERROR)
        } else {
          const supabaseSuccess = await connectSupabase()
          if (!supabaseSuccess) {
            const wsSuccess = connectWebSocket()
            if (wsSuccess) {
              setStatus(CONNECTION_STATUS.FALLBACK)
            } else {
              setStatus(CONNECTION_STATUS.ERROR)
            }
          }
        }
      } finally {
        isConnectingRef.current = false
      }
    }
    doReconnect()
  }, [matchId, connectionType, cleanup, connectSupabase, connectWebSocket])

  // Load saved preference on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem('preferredConnection')
      if (saved && Object.values(CONNECTION_TYPES).includes(saved)) {
        setConnectionType(saved)
      }
    } catch (e) {}
  }, [])

  // Connect when key dependencies change (not callback refs)
  useEffect(() => {
    // Prevent multiple simultaneous connections
    if (isConnectingRef.current) return

    isMountedRef.current = true

    const doConnect = async () => {
      if (!enabled || !matchId) return

      isConnectingRef.current = true
      cleanup()

      const type = connectionType

      try {
        if (type === CONNECTION_TYPES.SUPABASE) {
          const success = await connectSupabase()
          if (!success) {
            setStatus(CONNECTION_STATUS.ERROR)
          }
        } else if (type === CONNECTION_TYPES.WEBSOCKET) {
          const success = connectWebSocket()
          if (!success) {
            setStatus(CONNECTION_STATUS.ERROR)
          }
        } else {
          // Auto mode: Try Supabase first, fall back to WebSocket
          const supabaseSuccess = await connectSupabase()
          if (!supabaseSuccess) {
            console.log('[RealtimeConnection] Supabase failed, falling back to WebSocket')
            const wsSuccess = connectWebSocket()
            if (wsSuccess) {
              setStatus(CONNECTION_STATUS.FALLBACK)
            } else {
              setStatus(CONNECTION_STATUS.ERROR)
            }
          }
        }
      } finally {
        isConnectingRef.current = false
      }
    }

    doConnect()

    return () => {
      isMountedRef.current = false
      isConnectingRef.current = false
      cleanup()
    }
  }, [matchId, enabled, connectionType]) // Only core dependencies, not callbacks

  return {
    // State
    connectionType,
    activeConnection,
    status,
    error,
    lastUpdate,

    // Computed
    isConnected: status === CONNECTION_STATUS.CONNECTED || status === CONNECTION_STATUS.FALLBACK,
    isSupabase: activeConnection === 'supabase',
    isWebSocket: activeConnection === 'websocket',
    isFallback: status === CONNECTION_STATUS.FALLBACK,

    // Actions
    switchConnection,
    reconnect,
    setConnectionType: switchConnection
  }
}

export default useRealtimeConnection
