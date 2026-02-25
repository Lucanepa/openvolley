import { useState, useEffect, useCallback } from 'react'
import { apiFrom } from '../lib/apiClient'

// Sport type for indoor volleyball
const SPORT_TYPE = 'indoor'

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

  const isOnline = true

  // Fetch unique referees from history
  const fetchReferees = useCallback(async () => {

    try {
      setLoading(true)
      setError(null)

      const { data, error: fetchError } = await apiFrom('referee_database')
        .select('first_name, last_name, country, dob, created_at')
        .contains('sport_type', JSON.stringify([SPORT_TYPE]))
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

  // Save referee to history (check existing, then insert or update sport_type array)
  const saveReferee = useCallback(async (official) => {
    if (!official?.firstName || !official?.lastName) {
      return false
    }

    try {
      // Check if referee already exists
      const { data: existing } = await apiFrom('referee_database')
        .select('id, sport_type')
        .ilike('last_name', official.lastName)
        .ilike('first_name', official.firstName)
        .maybeSingle()

      if (existing) {
        // Add sport type to array if not already present
        const sports = existing.sport_type || []
        if (!sports.includes(SPORT_TYPE)) {
          const { error: updateError } = await apiFrom('referee_database')
            .update({ sport_type: [...sports, SPORT_TYPE] })
            .eq('id', existing.id)

          if (updateError) {
            console.error('Error updating referee sport_type:', updateError)
            return false
          }
        }
      } else {
        // Insert new referee
        const { error: insertError } = await apiFrom('referee_database')
          .insert({
            first_name: official.firstName,
            last_name: official.lastName,
            country: official.country || 'CHE',
            dob: official.dob || null,
            sport_type: [SPORT_TYPE],
            created_at: new Date().toISOString()
          })

        if (insertError) {
          if (!insertError.message?.includes('duplicate')) {
            console.error('Error saving referee:', insertError)
          }
          return false
        }
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
    if (!officials) return false

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
