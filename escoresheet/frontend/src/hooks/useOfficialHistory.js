import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabaseClient'

/**
 * Hook to manage referee and scorer history for autocomplete
 *
 * When online (Supabase connected):
 * - Fetches unique referee/scorer names from history
 * - Returns suggestions based on input
 * - Saves officials when a match is confirmed
 */
export function useOfficialHistory() {
  const [referees, setReferees] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const isOnline = !!supabase

  // Fetch unique referees from history
  const fetchReferees = useCallback(async () => {
    if (!supabase) return []

    try {
      setLoading(true)
      setError(null)

      const { data, error: fetchError } = await supabase
        .from('referee_database')
        .select('first_name, last_name, country, dob, created_at')
        .order('last_name', { ascending: true })

      if (fetchError) {
        console.error('Error fetching referees:', fetchError)
        setError(fetchError.message)
        return []
      }

      // Data is already unique due to unique index, just map to expected format
      const uniqueRefs = (data || []).map(row => ({
        firstName: row.first_name,
        lastName: row.last_name,
        country: row.country || 'CHE',
        dob: row.dob || ''
      }))

      setReferees(uniqueRefs)
      return uniqueRefs
    } catch (err) {
      console.error('Error in fetchReferees:', err)
      setError(err.message)
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  // Fetch scorers - no longer stored in separate table, return empty
  const fetchScorers = useCallback(async () => {
    // scorer_history table was dropped - scorers now stored in match officials JSONB
    return []
  }, [])

  // Save referee to history (upsert - update if exists, insert if new)
  const saveReferee = useCallback(async (official) => {
    if (!supabase || !official?.firstName || !official?.lastName) {
      return false
    }

    try {
      const { error: upsertError } = await supabase
        .from('referee_database')
        .upsert({
          first_name: official.firstName,
          last_name: official.lastName,
          country: official.country || 'CHE',
          dob: official.dob || null,
          created_at: new Date().toISOString()
        }, {
          onConflict: 'lower(last_name),lower(first_name)',
          ignoreDuplicates: true
        })

      if (upsertError) {
        // Ignore duplicate key errors - expected with unique index
        if (!upsertError.message?.includes('duplicate')) {
          console.error('Error saving referee:', upsertError)
        }
        return false
      }

      return true
    } catch (err) {
      console.error('Error in saveReferee:', err)
      return false
    }
  }, [])

  // Save scorer - no longer stored in separate table
  const saveScorer = useCallback(async () => {
    // scorer_history table was dropped - scorers now stored in match officials JSONB
    return true
  }, [])

  // Save all officials from a match
  const saveMatchOfficials = useCallback(async (officials) => {
    if (!supabase || !officials) return false

    const promises = []

    // Save referees
    if (officials.referee1?.firstName && officials.referee1?.lastName) {
      promises.push(saveReferee(officials.referee1))
    }
    if (officials.referee2?.firstName && officials.referee2?.lastName) {
      promises.push(saveReferee(officials.referee2))
    }

    // Save scorers
    if (officials.scorer?.firstName && officials.scorer?.lastName) {
      promises.push(saveScorer(officials.scorer))
    }
    if (officials.assistantScorer?.firstName && officials.assistantScorer?.lastName) {
      promises.push(saveScorer(officials.assistantScorer))
    }

    await Promise.all(promises)

    // Refresh referee list
    await fetchReferees()
    return true
  }, [saveReferee, saveScorer, fetchReferees])

  // Load data on mount if online
  useEffect(() => {
    if (isOnline) {
      fetchReferees()
    }
  }, [isOnline, fetchReferees])

  return {
    isOnline,
    referees,
    scorers: [], // scorer_history table was dropped
    loading,
    error,
    fetchReferees,
    fetchScorers,
    saveReferee,
    saveScorer,
    saveMatchOfficials
  }
}

export default useOfficialHistory
