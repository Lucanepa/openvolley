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
 * @param {boolean} options.enabled - Whether to enable the connection
 */
export function useRealtimeConnection({
  matchId,
  preferredConnection = CONNECTION_TYPES.AUTO,
  onData,
  onAction,
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

      // Subscribe to events table for this match
      const channel = supabase
        .channel(`match-${matchId}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'events',
            filter: `match_id=eq.${matchId}`
          },
          (payload) => {
            if (!isMountedRef.current) return
            console.log('[RealtimeConnection] Supabase event received:', payload)
            setLastUpdate(Date.now())

            // Fetch fresh data when events change
            getMatchData(matchId).then(result => {
              if (result.success && onData) {
                onData(result)
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
            filter: `match_id=eq.${matchId}`
          },
          (payload) => {
            if (!isMountedRef.current) return
            console.log('[RealtimeConnection] Supabase set update:', payload)
            setLastUpdate(Date.now())

            // Fetch fresh data when sets change
            getMatchData(matchId).then(result => {
              if (result.success && onData) {
                onData(result)
              }
            }).catch(err => {
              console.error('[RealtimeConnection] Error fetching data after set update:', err)
            })
          }
        )
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'matches',
            filter: `external_id=eq.${matchId}`
          },
          (payload) => {
            if (!isMountedRef.current) return
            console.log('[RealtimeConnection] Supabase match update:', payload)
            setLastUpdate(Date.now())

            // Fetch fresh data when match changes
            getMatchData(matchId).then(result => {
              if (result.success && onData) {
                onData(result)
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
            setError('Supabase connection failed')
            return false
          }
        })

      supabaseChannelRef.current = channel
      return true
    } catch (err) {
      console.error('[RealtimeConnection] Supabase connection error:', err)
      setError(err.message)
      return false
    }
  }, [matchId, onData])

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
          if (onAction) {
            onAction(data._action, data._actionData)
          }
        } else if (data && data.match) {
          if (onData) {
            onData({ success: true, ...data })
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
  }, [matchId, onData, onAction])

  // Main connection logic
  const connect = useCallback(async () => {
    if (!enabled || !matchId) return

    cleanup()

    const type = connectionType

    if (type === CONNECTION_TYPES.SUPABASE) {
      // Force Supabase only
      const success = await connectSupabase()
      if (!success) {
        setStatus(CONNECTION_STATUS.ERROR)
      }
    } else if (type === CONNECTION_TYPES.WEBSOCKET) {
      // Force WebSocket only
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
  }, [enabled, matchId, connectionType, cleanup, connectSupabase, connectWebSocket])

  // Switch connection type
  const switchConnection = useCallback((newType) => {
    console.log('[RealtimeConnection] Switching connection to:', newType)
    setConnectionType(newType)
    // Save preference to localStorage
    try {
      localStorage.setItem('preferredConnection', newType)
    } catch (e) {}
  }, [])

  // Force reconnect
  const reconnect = useCallback(() => {
    console.log('[RealtimeConnection] Force reconnecting...')
    connect()
  }, [connect])

  // Load saved preference on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem('preferredConnection')
      if (saved && Object.values(CONNECTION_TYPES).includes(saved)) {
        setConnectionType(saved)
      }
    } catch (e) {}
  }, [])

  // Connect when dependencies change
  useEffect(() => {
    isMountedRef.current = true
    connect()

    return () => {
      isMountedRef.current = false
      cleanup()
    }
  }, [connect, cleanup])

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
