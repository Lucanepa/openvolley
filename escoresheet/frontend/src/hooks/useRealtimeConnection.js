/**
 * useRealtimeConnection Hook
 * Manages connection to match data using WebSocket as primary
 * with Supabase Realtime fallback
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabaseClient'
import { apiFrom } from '../lib/apiClient'
import { subscribeToMatchData, getMatchData } from '../utils/serverDataSync'

// Connection types
export const CONNECTION_TYPES = {
  AUTO: 'auto',           // Try WebSocket first, fall back to Supabase
  SUPABASE: 'supabase',   // Force Supabase Realtime only
  WEBSOCKET: 'websocket'  // Force WebSocket only
}

// Connection status
export const CONNECTION_STATUS = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  ERROR: 'error',
  FALLBACK: 'fallback',    // Using fallback connection
  OFFLINE: 'offline'       // Both WebSocket and Supabase failed, using offline mode
}

/**
 * Hook for managing realtime connection with WebSocket primary + Supabase Realtime fallback
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

  // UUID retry timer ref
  const uuidRetryRef = useRef(null)

  // Helper: fetch data and deliver to callback
  const fetchAndDeliver = useCallback((reason) => {
    getMatchData(matchId).then(result => {
      if (result.success && onDataRef.current) {
        onDataRef.current(result)
      }
    }).catch(err => {
      console.error(`[RealtimeConnection] Error fetching data after ${reason}:`, err)
    })
  }, [matchId])

  // Helper: build a Supabase channel with all subscriptions
  const buildChannel = useCallback((supabaseMatchUuid) => {
    const channelId = `match-${matchId}-${Date.now()}`
    const channel = supabase.channel(channelId)

    // Subscribe to events, sets, and match_live_state using UUID
    if (supabaseMatchUuid) {
      channel
        .on('postgres_changes', { event: '*', schema: 'public', table: 'events', filter: `match_id=eq.${supabaseMatchUuid}` },
          () => { if (!isMountedRef.current) return; setLastUpdate(Date.now()); fetchAndDeliver('event') })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'sets', filter: `match_id=eq.${supabaseMatchUuid}` },
          () => { if (!isMountedRef.current) return; setLastUpdate(Date.now()); fetchAndDeliver('set update') })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'match_live_state', filter: `match_id=eq.${supabaseMatchUuid}` },
          () => { if (!isMountedRef.current) return; setLastUpdate(Date.now()); fetchAndDeliver('live state update') })
    }

    // Always subscribe to matches table (uses external_id, no UUID needed)
    channel
      .on('postgres_changes', { event: '*', schema: 'public', table: 'matches', filter: `external_id=eq.${matchId}` },
        (payload) => {
          if (!isMountedRef.current) return
          setLastUpdate(Date.now())
          if (payload.eventType === 'DELETE') {
            if (onDeletedRef.current) onDeletedRef.current()
            return
          }
          fetchAndDeliver('match update')
        })

    return channel
  }, [matchId, fetchAndDeliver])

  // Cleanup function
  const cleanup = useCallback(() => {
    // Clear UUID retry timer
    if (uuidRetryRef.current) {
      clearTimeout(uuidRetryRef.current)
      uuidRetryRef.current = null
    }

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
      return false
    }

    // Clear any pending UUID retry
    if (uuidRetryRef.current) {
      clearTimeout(uuidRetryRef.current)
      uuidRetryRef.current = null
    }

    try {
      setStatus(CONNECTION_STATUS.CONNECTING)

      // Look up the Supabase UUID from external_id (seed_key)
      let supabaseMatchUuid = null
      const { data: matchData } = await apiFrom('matches')
        .select('id')
        .eq('external_id', matchId)
        .maybeSingle()

      if (matchData?.id) {
        supabaseMatchUuid = matchData.id
      }

      // Build and subscribe to channel
      const channel = buildChannel(supabaseMatchUuid)

      channel.subscribe((status) => {
        if (!isMountedRef.current) return

        if (status === 'SUBSCRIBED') {
          setStatus(CONNECTION_STATUS.CONNECTED)
          setActiveConnection('supabase')
          setError(null)

          // If we connected WITHOUT the UUID, retry the lookup periodically
          // so we can upgrade to full subscriptions once the match is synced
          if (!supabaseMatchUuid) {
            console.warn('[RealtimeConnection] Connected without UUID — will retry lookup')
            const retryLookup = async () => {
              if (!isMountedRef.current) return
              const { data } = await apiFrom('matches')
                .select('id')
                .eq('external_id', matchId)
                .maybeSingle()

              if (data?.id) {
                // UUID now available — rebuild channel with full subscriptions
                console.log('[RealtimeConnection] UUID found on retry, upgrading subscriptions')
                try { supabase?.removeChannel(channel) } catch {}
                const fullChannel = buildChannel(data.id)
                fullChannel.subscribe((s) => {
                  if (!isMountedRef.current) return
                  if (s === 'SUBSCRIBED') {
                    setStatus(CONNECTION_STATUS.CONNECTED)
                    setActiveConnection('supabase')
                    fetchAndDeliver('uuid retry')
                  }
                })
                supabaseChannelRef.current = fullChannel
              } else if (isMountedRef.current) {
                // Still no UUID, retry again in 3 seconds
                uuidRetryRef.current = setTimeout(retryLookup, 3000)
              }
            }
            uuidRetryRef.current = setTimeout(retryLookup, 3000)
          }
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('[RealtimeConnection] Supabase channel error/timeout, status:', status)
        }
      })

      supabaseChannelRef.current = channel
      return true
    } catch (err) {
      console.error('[RealtimeConnection] Supabase connection error:', err)
      setError(err.message)
      return false
    }
  }, [matchId, buildChannel, fetchAndDeliver]) // Removed onData from deps - using ref instead

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
          // AUTO mode: WebSocket first, Supabase fallback
          const wsSuccess = connectWebSocket()
          if (!wsSuccess) {
            const supabaseSuccess = await connectSupabase()
            if (supabaseSuccess) {
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
          // Auto mode: WebSocket first, Supabase fallback
          // 1. Try WebSocket first (primary — fastest, sub-100ms)
          // 2. If WebSocket fails, fall back to Supabase Realtime
          // 3. If both fail, go offline
          const wsSuccess = connectWebSocket()
          if (!wsSuccess) {
            console.log('[RealtimeConnection] WebSocket failed, trying Supabase fallback')
            const supabaseSuccess = await connectSupabase()
            if (supabaseSuccess) {
              setStatus(CONNECTION_STATUS.FALLBACK)
            } else {
              console.warn('[RealtimeConnection] Both WebSocket and Supabase failed, going offline')
              setStatus(CONNECTION_STATUS.OFFLINE)
              setActiveConnection(null)
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
    isOffline: status === CONNECTION_STATUS.OFFLINE,

    // Actions
    switchConnection,
    reconnect,
    setConnectionType: switchConnection
  }
}

export default useRealtimeConnection
