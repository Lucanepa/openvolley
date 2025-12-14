import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabaseClient'

/**
 * Hook to manage team history for autocomplete/recall feature
 *
 * When online (Supabase connected):
 * - Fetches unique team names that have been used before
 * - For a selected team, fetches all historical players (UNION)
 * - For a selected team, fetches latest bench officials
 * - Saves team data when a match is confirmed
 */
export function useTeamHistory() {
  const [teamNames, setTeamNames] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // Check if Supabase is available
  const isOnline = !!supabase

  // Fetch unique team names from history
  const fetchTeamNames = useCallback(async () => {
    if (!supabase) return []

    try {
      setLoading(true)
      setError(null)

      // Get distinct team names from roster history, ordered by most recent
      const { data, error: fetchError } = await supabase
        .from('team_roster_history')
        .select('team_name, short_name, color, created_at')
        .order('created_at', { ascending: false })

      if (fetchError) {
        console.error('Error fetching team names:', fetchError)
        setError(fetchError.message)
        return []
      }

      // Deduplicate and get the most recent info for each team
      const teamMap = new Map()
      for (const row of data || []) {
        if (!teamMap.has(row.team_name)) {
          teamMap.set(row.team_name, {
            name: row.team_name,
            shortName: row.short_name,
            color: row.color
          })
        }
      }

      const uniqueTeams = Array.from(teamMap.values())
      setTeamNames(uniqueTeams)
      return uniqueTeams
    } catch (err) {
      console.error('Error in fetchTeamNames:', err)
      setError(err.message)
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  // Fetch team history (players + officials) for a specific team name
  const fetchTeamHistory = useCallback(async (teamName) => {
    if (!supabase || !teamName) {
      return { players: [], officials: [], shortName: '', color: '' }
    }

    try {
      setLoading(true)
      setError(null)

      // Fetch all players for this team (UNION - deduplicated by number+name)
      const { data: playersData, error: playersError } = await supabase
        .from('team_roster_history')
        .select('*')
        .eq('team_name', teamName)
        .order('created_at', { ascending: false })

      if (playersError) {
        console.error('Error fetching players:', playersError)
        setError(playersError.message)
        return { players: [], officials: [], shortName: '', color: '' }
      }

      // Deduplicate players by number + lastName + firstName
      // Keep the most recent version of each player
      const playerMap = new Map()
      let latestShortName = ''
      let latestColor = ''

      for (const row of playersData || []) {
        // Get latest team info
        if (!latestShortName && row.short_name) latestShortName = row.short_name
        if (!latestColor && row.color) latestColor = row.color

        // Only add if player has a number (skip empty rows)
        if (row.player_number != null) {
          const key = `${row.player_number}-${row.player_last_name || ''}-${row.player_first_name || ''}`
          if (!playerMap.has(key)) {
            playerMap.set(key, {
              number: row.player_number,
              firstName: row.player_first_name || '',
              lastName: row.player_last_name || '',
              dob: row.player_dob || '',
              libero: '',
              isCaptain: false
            })
          }
        }
      }

      const players = Array.from(playerMap.values())
        .sort((a, b) => (a.number || 0) - (b.number || 0))

      // Fetch officials - get the latest for each role
      const { data: officialsData, error: officialsError } = await supabase
        .from('team_officials_history')
        .select('*')
        .eq('team_name', teamName)
        .order('created_at', { ascending: false })

      if (officialsError) {
        console.error('Error fetching officials:', officialsError)
        // Continue with players even if officials fail
      }

      // Get latest official for each role
      const officialMap = new Map()
      for (const row of officialsData || []) {
        if (row.role && !officialMap.has(row.role)) {
          officialMap.set(row.role, {
            role: row.role,
            firstName: row.first_name || '',
            lastName: row.last_name || '',
            dob: row.dob || ''
          })
        }
      }

      const officials = Array.from(officialMap.values())

      return {
        players,
        officials,
        shortName: latestShortName,
        color: latestColor
      }
    } catch (err) {
      console.error('Error in fetchTeamHistory:', err)
      setError(err.message)
      return { players: [], officials: [], shortName: '', color: '' }
    } finally {
      setLoading(false)
    }
  }, [])

  // Save team history to Supabase
  const saveTeamHistory = useCallback(async (teamName, shortName, color, players, officials, matchId = null) => {
    if (!supabase || !teamName) {
      return false
    }

    try {
      setLoading(true)
      setError(null)

      const timestamp = new Date().toISOString()

      // Save each player to roster history
      // Using upsert-like behavior by just inserting (duplicates handled by unique constraint)
      const playerRows = players
        .filter(p => p.number != null && (p.firstName || p.lastName))
        .map(p => ({
          team_name: teamName,
          short_name: shortName || null,
          color: color || null,
          player_number: p.number,
          player_first_name: p.firstName || null,
          player_last_name: p.lastName || null,
          player_dob: p.dob || null,
          match_id: matchId,
          created_at: timestamp
        }))

      if (playerRows.length > 0) {
        const { error: playersError } = await supabase
          .from('team_roster_history')
          .insert(playerRows)

        if (playersError) {
          // Ignore unique constraint violations (player already exists)
          if (!playersError.message?.includes('duplicate') && !playersError.code?.includes('23505')) {
            console.error('Error saving players:', playersError)
          }
        }
      }

      // Save officials to history
      const officialRows = officials
        .filter(o => o.role && (o.firstName || o.lastName))
        .map(o => ({
          team_name: teamName,
          role: o.role,
          first_name: o.firstName || null,
          last_name: o.lastName || null,
          dob: o.dob || null,
          match_id: matchId,
          created_at: timestamp
        }))

      if (officialRows.length > 0) {
        const { error: officialsError } = await supabase
          .from('team_officials_history')
          .insert(officialRows)

        if (officialsError) {
          console.error('Error saving officials:', officialsError)
        }
      }

      // Refresh team names list
      await fetchTeamNames()

      return true
    } catch (err) {
      console.error('Error in saveTeamHistory:', err)
      setError(err.message)
      return false
    } finally {
      setLoading(false)
    }
  }, [fetchTeamNames])

  // Load team names on mount if online
  useEffect(() => {
    if (isOnline) {
      fetchTeamNames()
    }
  }, [isOnline, fetchTeamNames])

  return {
    isOnline,
    teamNames,
    loading,
    error,
    fetchTeamNames,
    fetchTeamHistory,
    saveTeamHistory
  }
}

export default useTeamHistory
