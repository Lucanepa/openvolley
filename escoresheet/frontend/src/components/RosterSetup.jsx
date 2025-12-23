import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { getMatchData, subscribeToMatchData, listAvailableMatchesSupabase } from '../utils/serverDataSync'
import { parseRosterPdf } from '../utils/parseRosterPdf'
import { db } from '../db/db'
import { supabase } from '../lib/supabaseClient'

export default function RosterSetup({ matchId, team, onBack, embedded = false, useSupabaseConnection = false, matchData = null }) {
  const { t } = useTranslation()
  const [players, setPlayers] = useState([])
  const [benchOfficials, setBenchOfficials] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [pdfFile, setPdfFile] = useState(null)
  const [pendingRoster, setPendingRoster] = useState(null) // The actual pending roster data
  const [showPreview, setShowPreview] = useState(false)
  const fileInputRef = useRef(null)

  const [match, setMatch] = useState(matchData)

  // Get pending roster from match data
  const pendingRosterField = team === 'home' ? 'pendingHomeRoster' : 'pendingAwayRoster'
  const pendingRosterFieldSnake = team === 'home' ? 'pending_home_roster' : 'pending_away_roster'
  const [teamId, setTeamId] = useState(null)

  // Load match data from server
  useEffect(() => {
    if (!matchId) {
      setMatch(null)
      return
    }

    // Test mode: use mock data
    if (matchId === -1) {
      setMatch({
        id: -1,
        gameNumber: 999,
        status: 'live'
      })
      setTeamId(-1) // Mock team ID for test mode
      setPlayers([
        { id: 1, number: 1, firstName: 'Test', lastName: 'Player 1', dob: '', libero: '', isCaptain: true },
        { id: 2, number: 5, firstName: 'Test', lastName: 'Player 2', dob: '', libero: '', isCaptain: false },
        { id: 3, number: 7, firstName: 'Test', lastName: 'Player 3', dob: '', libero: '', isCaptain: false },
        { id: 4, number: 10, firstName: 'Test', lastName: 'Player 4', dob: '', libero: '', isCaptain: false },
        { id: 5, number: 12, firstName: 'Test', lastName: 'Player 5', dob: '', libero: 'libero1', isCaptain: false },
        { id: 6, number: 15, firstName: 'Test', lastName: 'Player 6', dob: '', libero: '', isCaptain: false }
      ])
      setBenchOfficials([
        { role: 'Coach', firstName: 'Test', lastName: 'Coach', dob: '' },
        { role: 'Assistant Coach 1', firstName: 'Test', lastName: 'Assistant', dob: '' }
      ])
      return
    }

    const fetchData = async () => {
      try {
        const result = await getMatchData(matchId)
        if (result.success) {
          setMatch(result.match)

          // Load players and bench officials
          const loadedTeamId = team === 'home' ? result.match.homeTeamId : result.match.awayTeamId
          setTeamId(loadedTeamId)
          const teamPlayers = team === 'home' 
            ? (result.homePlayers || [])
            : (result.awayPlayers || [])
          
          setPlayers(teamPlayers
            .sort((a, b) => (a.number || 0) - (b.number || 0))
            .map(p => ({
              id: p.id,
              number: p.number,
              firstName: p.firstName || '',
              lastName: p.lastName || p.name || '',
              dob: p.dob || '',
              libero: p.libero || '',
              isCaptain: p.isCaptain || false
            })))

          const benchKey = team === 'home' ? 'bench_home' : 'bench_away'
          if (result.match[benchKey]) {
            setBenchOfficials(result.match[benchKey].map(b => ({
              role: b.role || '',
              firstName: b.firstName || b.first_name || '',
              lastName: b.lastName || b.last_name || '',
              dob: b.dob || b.date_of_birth || b.dateOfBirth || ''
            })))
          }
        }
      } catch (err) {
        console.error('Error loading roster:', err)
        setError('Failed to load roster. Make sure the main scoresheet is running.')
      }
    }

    fetchData()

    // Subscribe to updates
    const unsubscribe = subscribeToMatchData(matchId, (updatedData) => {
      setMatch(updatedData.match)
      
      const teamPlayers = team === 'home' 
        ? (updatedData.homePlayers || [])
        : (updatedData.awayPlayers || [])
      
      setPlayers(teamPlayers
        .sort((a, b) => (a.number || 0) - (b.number || 0))
        .map(p => ({
          id: p.id,
          number: p.number,
          firstName: p.firstName || '',
          lastName: p.lastName || p.name || '',
          dob: p.dob || '',
          libero: p.libero || '',
          isCaptain: p.isCaptain || false
        })))

      const benchKey = team === 'home' ? 'bench_home' : 'bench_away'
      if (updatedData.match[benchKey]) {
        setBenchOfficials(updatedData.match[benchKey].map(b => ({
          role: b.role || '',
          firstName: b.firstName || b.first_name || '',
          lastName: b.lastName || b.last_name || '',
          dob: b.dob || b.date_of_birth || b.dateOfBirth || ''
        })))
      }
    })

    return () => {
      unsubscribe()
    }
  }, [matchId, team])

  // Check for pending roster from match data or Supabase
  useEffect(() => {
    // Check local match data first
    if (match) {
      const pendingData = match[pendingRosterField] || match[pendingRosterFieldSnake]
      if (pendingData) {
        console.log('[RosterSetup] Found pending roster in match data:', pendingData)
        setPendingRoster(pendingData)
      } else {
        setPendingRoster(null)
      }
    }

    // If using Supabase connection, also check Supabase directly
    if (useSupabaseConnection && supabase && matchData?.external_id) {
      const checkSupabasePendingRoster = async () => {
        try {
          const { data, error } = await supabase
            .from('matches')
            .select(pendingRosterFieldSnake)
            .eq('external_id', matchData.external_id)
            .single()

          if (!error && data && data[pendingRosterFieldSnake]) {
            console.log('[RosterSetup] Found pending roster in Supabase:', data[pendingRosterFieldSnake])
            setPendingRoster(data[pendingRosterFieldSnake])
          }
        } catch (err) {
          console.error('[RosterSetup] Error checking Supabase for pending roster:', err)
        }
      }
      checkSupabasePendingRoster()

      // Subscribe to changes
      const channel = supabase
        .channel(`roster-${matchData.external_id}-${team}`)
        .on('postgres_changes', {
          event: 'UPDATE',
          schema: 'public',
          table: 'matches',
          filter: `external_id=eq.${matchData.external_id}`
        }, (payload) => {
          const pendingData = payload.new?.[pendingRosterFieldSnake]
          console.log('[RosterSetup] Supabase update received, pending roster:', pendingData)
          setPendingRoster(pendingData || null)
        })
        .subscribe()

      return () => {
        supabase.removeChannel(channel)
      }
    }
  }, [match, matchData, useSupabaseConnection, pendingRosterField, pendingRosterFieldSnake, team])

  // Accept pending roster - import players and bench officials
  const handleAcceptPendingRoster = async () => {
    if (!pendingRoster) return

    setLoading(true)
    setError('')

    try {
      const importedPlayers = pendingRoster.players || []
      const importedBench = pendingRoster.bench || []

      // Update local state
      setPlayers(importedPlayers.map(p => ({
        id: null,
        number: p.number,
        firstName: p.firstName || '',
        lastName: p.lastName || '',
        dob: p.dob || '',
        libero: p.libero || '',
        isCaptain: p.isCaptain || false
      })))
      setBenchOfficials(importedBench.map(b => ({
        role: b.role || '',
        firstName: b.firstName || b.first_name || '',
        lastName: b.lastName || b.last_name || '',
        dob: b.dob || b.date_of_birth || ''
      })))

      // Save to database
      if (teamId && matchId && matchId !== -1 && teamId !== -1) {
        // Delete existing players
        const existingPlayers = await db.players.where('teamId').equals(teamId).toArray()
        for (const ep of existingPlayers) {
          await db.players.delete(ep.id)
        }

        // Add imported players
        if (importedPlayers.length) {
          await db.players.bulkAdd(
            importedPlayers.map(p => ({
              teamId,
              number: p.number,
              name: `${p.lastName || ''} ${p.firstName || ''}`.trim(),
              lastName: p.lastName || '',
              firstName: p.firstName || '',
              dob: p.dob || null,
              libero: p.libero || '',
              isCaptain: !!p.isCaptain,
              role: null,
              createdAt: new Date().toISOString()
            }))
          )
        }

        // Update match with bench officials and clear pending roster
        const benchKey = team === 'home' ? 'bench_home' : 'bench_away'
        await db.matches.update(matchId, {
          [benchKey]: importedBench,
          [pendingRosterField]: null
        })
      }

      // Clear pending roster in Supabase if connected
      if (useSupabaseConnection && supabase && matchData?.external_id) {
        await supabase
          .from('matches')
          .update({ [pendingRosterFieldSnake]: null })
          .eq('external_id', matchData.external_id)
      }

      setPendingRoster(null)
      console.log('[RosterSetup] Pending roster accepted and imported')
    } catch (err) {
      console.error('[RosterSetup] Error accepting pending roster:', err)
      setError(t('rosterSetup.errorAcceptingRoster'))
    } finally {
      setLoading(false)
    }
  }

  // Reject pending roster - just clear it
  const handleRejectPendingRoster = async () => {
    setLoading(true)

    try {
      // Clear pending roster locally
      if (matchId && matchId !== -1) {
        await db.matches.update(matchId, { [pendingRosterField]: null })
      }

      // Clear pending roster in Supabase if connected
      if (useSupabaseConnection && supabase && matchData?.external_id) {
        await supabase
          .from('matches')
          .update({ [pendingRosterFieldSnake]: null })
          .eq('external_id', matchData.external_id)
      }

      setPendingRoster(null)
      console.log('[RosterSetup] Pending roster rejected')
    } catch (err) {
      console.error('[RosterSetup] Error rejecting pending roster:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleAddPlayer = () => {
    const newNumber = players.length > 0 
      ? Math.max(...players.map(p => p.number || 0)) + 1 
      : 1
    setPlayers([...players, {
      id: null,
      number: newNumber,
      firstName: '',
      lastName: '',
      dob: '',
      libero: '',
      isCaptain: false
    }])
  }

  const handleDeletePlayer = (index) => {
    const player = players[index]
    if (player.id) {
      // Delete from database
      db.players.delete(player.id).catch(err => {
        console.error('Error deleting player:', err)
        setError('Failed to delete player')
      })
    }
    setPlayers(players.filter((_, i) => i !== index))
  }

  const handleUpdatePlayer = (index, field, value) => {
    const updated = [...players]
    updated[index] = { ...updated[index], [field]: value }
    setPlayers(updated)
  }

  const handleAddOfficial = () => {
    setBenchOfficials([...benchOfficials, {
      role: 'Coach',
      firstName: '',
      lastName: '',
      dob: ''
    }])
  }

  const handleDeleteOfficial = (index) => {
    setBenchOfficials(benchOfficials.filter((_, i) => i !== index))
  }

  const handleUpdateOfficial = (index, field, value) => {
    const updated = [...benchOfficials]
    updated[index] = { ...updated[index], [field]: value }
    setBenchOfficials(updated)
  }

  const handlePdfUpload = async (file) => {
    // Removed console.log('[RosterSetup] handlePdfUpload called with file:', file)
    if (!file) {
      return
    }

    setLoading(true)
    setError('')
    setPdfFile(file)

    try {
      const parsedData = await parseRosterPdf(file)
      
      // Replace all players with imported ones (overwrite mode)
      const mergedPlayers = parsedData.players.map(parsedPlayer => ({
        id: null, // New players, will be assigned when saved
        number: parsedPlayer.number || null,
        firstName: parsedPlayer.firstName || '',
        lastName: parsedPlayer.lastName || '',
        dob: parsedPlayer.dob || '',
        libero: '',
        isCaptain: false
      }))
      

      // Replace all players with imported data
      setPlayers(mergedPlayers)
      
      // Prepare bench officials from imported data (will be saved to DB below)
      const importedBenchOfficials = []
      if (parsedData.coach) {
        importedBenchOfficials.push({ 
          role: 'Coach', 
          firstName: parsedData.coach.firstName || '',
          lastName: parsedData.coach.lastName || '',
          dob: parsedData.coach.dob || ''
        })
      }
      if (parsedData.ac1) {
        importedBenchOfficials.push({ 
          role: 'Assistant Coach 1', 
          firstName: parsedData.ac1.firstName || '',
          lastName: parsedData.ac1.lastName || '',
          dob: parsedData.ac1.dob || ''
        })
      }
      if (parsedData.ac2) {
        importedBenchOfficials.push({ 
          role: 'Assistant Coach 2', 
          firstName: parsedData.ac2.firstName || '',
          lastName: parsedData.ac2.lastName || '',
          dob: parsedData.ac2.dob || ''
        })
      }
      
      // Update UI state immediately
      setBenchOfficials(importedBenchOfficials)
      
      // Auto-save to database with overwrite mode (skip in test mode)
      if (teamId && matchId && matchId !== -1 && teamId !== -1) {
        // Save immediately with overwrite flag
        const existingPlayers = await db.players.where('teamId').equals(teamId).toArray()
        for (const ep of existingPlayers) {
          await db.players.delete(ep.id)
        }
        
        await db.players.bulkAdd(
          mergedPlayers.map(p => ({
            teamId,
            number: p.number,
            firstName: p.firstName,
            lastName: p.lastName,
            name: `${p.lastName} ${p.firstName}`,
            dob: p.dob || null,
            libero: p.libero || '',
            isCaptain: !!p.isCaptain,
            role: null,
            createdAt: new Date().toISOString()
          }))
        )
        
        // Overwrite bench officials in database with imported data
        const benchKey = team === 'home' ? 'bench_home' : 'bench_away'
        await db.matches.update(matchId, {
          [benchKey]: importedBenchOfficials
        })
        
      }
      
      // Reset file input to allow re-uploading the same file
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    } catch (err) {
      console.error('Error parsing PDF:', err)
      setError(`Failed to parse PDF: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  const handleFileSelect = (e) => {
    const file = e.target.files[0]
    if (file) {
      setPdfFile(file)
      setError('') // Clear any previous errors
    }
  }

  const handleChooseFileClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click()
    }
  }

  const handleImportClick = async () => {
    if (pdfFile) {
      await handlePdfUpload(pdfFile)
    } else {
      setError('Please select a PDF file first')
    }
  }

  const handleSave = async (overwrite = false) => {
    if (!teamId) {
      setError('Team ID not found')
      return
    }

    // Skip database operations in test mode
    if (matchId === -1 || teamId === -1) {
      console.log('[Test Mode] Skipping database save')
      return
    }

    setLoading(true)
    setError('')

    try {
      // If overwrite is true (e.g., from PDF import), delete all existing players first
      if (overwrite) {
        const existingPlayers = await db.players.where('teamId').equals(teamId).toArray()
        for (const ep of existingPlayers) {
          await db.players.delete(ep.id)
        }
      } else {
        // Normal save: update existing, add new, delete removed
        const existingPlayers = await db.players.where('teamId').equals(teamId).toArray()
        
        for (const player of players) {
          if (player.id) {
            // Update existing player
            await db.players.update(player.id, {
              number: player.number,
              firstName: player.firstName,
              lastName: player.lastName,
              name: `${player.lastName} ${player.firstName}`,
              dob: player.dob || null,
              libero: player.libero || '',
              isCaptain: !!player.isCaptain
            })
          } else {
            // Add new player
            await db.players.add({
              teamId,
              number: player.number,
              firstName: player.firstName,
              lastName: player.lastName,
              name: `${player.lastName} ${player.firstName}`,
              dob: player.dob || null,
              libero: player.libero || '',
              isCaptain: !!player.isCaptain,
              role: null,
              createdAt: new Date().toISOString()
            })
          }
        }

        // Delete players that are no longer in the roster
        const rosterNumbers = new Set(players.map(p => p.number))
        for (const ep of existingPlayers) {
          if (!rosterNumbers.has(ep.number)) {
            await db.players.delete(ep.id)
          }
        }
      }
      
      // Add all players (after deletion if overwrite)
      if (overwrite || players.some(p => !p.id)) {
        await db.players.bulkAdd(
          players.map(p => ({
            teamId,
            number: p.number,
            firstName: p.firstName,
            lastName: p.lastName,
            name: `${p.lastName} ${p.firstName}`,
            dob: p.dob || null,
            libero: p.libero || '',
            isCaptain: !!p.isCaptain,
            role: null,
            createdAt: new Date().toISOString()
          }))
        )
      }

      // Save bench officials - always overwrite completely
      const benchKey = team === 'home' ? 'bench_home' : 'bench_away'
      await db.matches.update(matchId, {
        [benchKey]: benchOfficials.map(o => ({
          role: o.role,
          firstName: o.firstName,
          lastName: o.lastName,
          dob: o.dob
        }))
      })

      // If connected to Supabase, also send roster as pending for scorer approval
      if (useSupabaseConnection && supabase && matchData?.external_id) {
        const pendingRosterData = {
          players: players.map(p => ({
            number: p.number,
            firstName: p.firstName,
            lastName: p.lastName,
            dob: p.dob || '',
            libero: p.libero || '',
            isCaptain: !!p.isCaptain
          })),
          bench: benchOfficials.map(o => ({
            role: o.role,
            firstName: o.firstName,
            lastName: o.lastName,
            dob: o.dob || ''
          })),
          timestamp: new Date().toISOString()
        }

        const { error: supabaseError } = await supabase
          .from('matches')
          .update({ [pendingRosterFieldSnake]: pendingRosterData })
          .eq('external_id', matchData.external_id)

        if (supabaseError) {
          console.error('[RosterSetup] Failed to sync roster to Supabase:', supabaseError)
        } else {
          console.log('[RosterSetup] Roster synced to Supabase as pending for scorer approval')
        }
      }

      alert(t('rosterSetup.rosterSaved'))
    } catch (err) {
      console.error('Error saving roster:', err)
      setError('Failed to save roster')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
      color: '#fff',
      padding: '20px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    }}>
      <div style={{
        maxWidth: '1200px',
        margin: '0 auto',
        background: 'var(--bg-secondary)',
        borderRadius: '12px',
        padding: '30px'
      }}>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '30px'
        }}>
          <h1 style={{ fontSize: '28px', fontWeight: 700, margin: 0 }}>
            {t('rosterSetup.title')} — {team === 'home' ? (match?.homeTeamName || t('common.home')) : (match?.awayTeamName || t('common.away'))}
          </h1>
          <button
            onClick={onBack}
            style={{
              padding: '10px 20px',
              fontSize: '14px',
              fontWeight: 500,
              background: 'transparent',
              color: 'var(--muted)',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '8px',
              cursor: 'pointer'
            }}
          >
            {t('common.back')}
          </button>
        </div>

        {error && (
          <div style={{
            padding: '12px',
            background: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid #ef4444',
            borderRadius: '6px',
            color: '#ef4444',
            fontSize: '14px',
            marginBottom: '20px'
          }}>
            {error}
          </div>
        )}

        {/* PDF Upload Section */}
        <div style={{
          marginBottom: '30px',
          padding: '20px',
          background: 'var(--bg)',
          borderRadius: '8px',
          border: '1px solid rgba(255,255,255,0.1)'
        }}>
          <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '12px' }}>
            {t('rosterSetup.loadRosterFromPdf')}
          </h2>
          <p style={{ fontSize: '14px', color: 'var(--muted)', marginBottom: '16px' }}>
            {t('rosterSetup.loadRosterFromPdfDescription')}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf"
                onChange={handleFileSelect}
                disabled={loading}
                style={{ display: 'none' }}
              />
              <button
                type="button"
                onClick={handleChooseFileClick}
                disabled={loading}
                style={{
                  padding: '12px 24px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: loading ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.1)',
                  color: loading ? 'var(--muted)' : 'var(--text)',
                  border: '1px solid rgba(255,255,255,0.2)',
                  borderRadius: '6px',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  transition: 'opacity 0.2s'
                }}
                onMouseOver={(e) => !loading && (e.target.style.opacity = '0.9')}
                onMouseOut={(e) => !loading && (e.target.style.opacity = '1')}
              >
                {t('rosterSetup.choosePdfFile')}
              </button>
              {pdfFile && !loading && (
                <span style={{ fontSize: '14px', color: 'var(--text)', flex: 1 }}>
                  {t('rosterSetup.selectedFile')}: {pdfFile.name}
                </span>
              )}
            </div>
            {pdfFile && !loading && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  handleImportClick()
                }}
                disabled={loading}
                style={{
                  padding: '12px 24px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: 'var(--accent)',
                  color: '#000',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  transition: 'opacity 0.2s',
                  width: 'fit-content'
                }}
                onMouseOver={(e) => !loading && (e.target.style.opacity = '0.9')}
                onMouseOut={(e) => !loading && (e.target.style.opacity = '1')}
              >
                {t('rosterSetup.import')}
              </button>
            )}
          </div>
          {loading && (
            <p style={{ fontSize: '14px', color: 'var(--accent)', marginTop: '10px' }}>
              {t('rosterSetup.parsingPdf')}
            </p>
          )}
          {error && (
            <p style={{ fontSize: '14px', color: '#ef4444', marginTop: '10px' }}>
              {error}
            </p>
          )}
        </div>

        {/* Pending Roster Section */}
        {pendingRoster && (
          <div style={{
            marginBottom: '30px',
            padding: '20px',
            background: 'rgba(34, 197, 94, 0.1)',
            borderRadius: '8px',
            border: '1px solid rgba(34, 197, 94, 0.3)'
          }}>
            <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '12px', color: '#22c55e' }}>
              {t('rosterSetup.rosterUploaded')}
            </h2>
            <p style={{ fontSize: '14px', color: 'var(--muted)', marginBottom: '16px' }}>
              {t('rosterSetup.rosterUploadedDescription')}
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
              <div style={{ fontSize: '14px' }}>
                {t('rosterSetup.playersCount')}: {pendingRoster.players?.length || 0}
              </div>
              <div style={{ fontSize: '14px' }}>
                {t('rosterSetup.benchOfficialsCount')}: {pendingRoster.bench?.length || 0}
              </div>
              {pendingRoster.timestamp && (
                <div style={{ fontSize: '12px', color: 'var(--muted)' }}>
                  {t('rosterSetup.uploadedAt')}: {new Date(pendingRoster.timestamp).toLocaleString()}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: '12px', marginBottom: '12px' }}>
              <button
                type="button"
                onClick={() => setShowPreview(true)}
                style={{
                  padding: '12px 24px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: 'rgba(59, 130, 246, 0.2)',
                  color: '#3b82f6',
                  border: '1px solid #3b82f6',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  flex: 1
                }}
              >
                {t('rosterSetup.previewRoster')}
              </button>
            </div>
            <div style={{ display: 'flex', gap: '12px' }}>
              <button
                type="button"
                onClick={handleAcceptPendingRoster}
                disabled={loading}
                style={{
                  padding: '12px 24px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: loading ? 'rgba(34, 197, 94, 0.5)' : '#22c55e',
                  color: '#000',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  flex: 1
                }}
              >
                {loading ? t('common.loading') : t('rosterSetup.acceptRoster')}
              </button>
              <button
                type="button"
                onClick={handleRejectPendingRoster}
                disabled={loading}
                style={{
                  padding: '12px 24px',
                  fontSize: '14px',
                  fontWeight: 600,
                  background: loading ? 'rgba(239, 68, 68, 0.3)' : 'rgba(239, 68, 68, 0.2)',
                  color: '#ef4444',
                  border: '1px solid #ef4444',
                  borderRadius: '6px',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  flex: 1
                }}
              >
                {t('rosterSetup.rejectRoster')}
              </button>
            </div>
          </div>
        )}

        {/* Players Section */}
        <div style={{
          marginBottom: '30px',
          padding: '20px',
          background: 'var(--bg)',
          borderRadius: '8px',
          border: '1px solid rgba(255,255,255,0.1)'
        }}>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '20px'
          }}>
            <h2 style={{ fontSize: '18px', fontWeight: 600, margin: 0 }}>
              {t('rosterSetup.players')}
            </h2>
            <button
              onClick={handleAddPlayer}
              style={{
                padding: '8px 16px',
                fontSize: '14px',
                fontWeight: 600,
                background: 'var(--accent)',
                color: '#000',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer'
              }}
            >
              {t('rosterSetup.addPlayer')}
            </button>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.2)' }}>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '14px', fontWeight: 600 }}>{t('rosterSetup.number')}</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '14px', fontWeight: 600 }}>{t('rosterSetup.firstName')}</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '14px', fontWeight: 600 }}>{t('rosterSetup.lastName')}</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '14px', fontWeight: 600 }}>{t('rosterSetup.dob')}</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '14px', fontWeight: 600 }}>{t('rosterSetup.libero')}</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '14px', fontWeight: 600 }}>{t('rosterSetup.captain')}</th>
                  <th style={{ padding: '12px', textAlign: 'center', fontSize: '14px', fontWeight: 600 }}>{t('rosterSetup.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {players.map((player, index) => (
                  <tr key={index} style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                    <td style={{ padding: '12px' }}>
                      <input
                        type="number"
                        value={player.number || ''}
                        onChange={(e) => handleUpdatePlayer(index, 'number', parseInt(e.target.value) || 0)}
                        style={{
                          width: '40px',
                          padding: '6px',
                          fontSize: '14px',
                          textAlign: 'center',
                          background: 'var(--bg-secondary)',
                          border: '1px solid rgba(255,255,255,0.2)',
                          borderRadius: '4px',
                          color: 'var(--text)'
                        }}
                      />
                    </td>
                    <td style={{ padding: '12px' }}>
                      <input
                        type="text"
                        value={player.firstName}
                        onChange={(e) => handleUpdatePlayer(index, 'firstName', e.target.value)}
                        style={{
                          width: '150px',
                          padding: '6px',
                          fontSize: '14px',
                          background: 'var(--bg-secondary)',
                          border: '1px solid rgba(255,255,255,0.2)',
                          borderRadius: '4px',
                          color: 'var(--text)'
                        }}
                      />
                    </td>
                    <td style={{ padding: '12px' }}>
                      <input
                        type="text"
                        value={player.lastName}
                        onChange={(e) => handleUpdatePlayer(index, 'lastName', e.target.value)}
                        style={{
                          width: '150px',
                          padding: '6px',
                          fontSize: '14px',
                          background: 'var(--bg-secondary)',
                          border: '1px solid rgba(255,255,255,0.2)',
                          borderRadius: '4px',
                          color: 'var(--text)'
                        }}
                      />
                    </td>
                    <td style={{ padding: '12px' }}>
                      <input
                        type="text"
                        value={player.dob}
                        onChange={(e) => handleUpdatePlayer(index, 'dob', e.target.value)}
                        placeholder="DD/MM/YYYY"
                        style={{
                          width: '120px',
                          padding: '6px',
                          fontSize: '14px',
                          background: 'var(--bg-secondary)',
                          border: '1px solid rgba(255,255,255,0.2)',
                          borderRadius: '4px',
                          color: 'var(--text)'
                        }}
                      />
                    </td>
                    <td style={{ padding: '12px' }}>
                      <select
                        value={player.libero || ''}
                        onChange={(e) => {
                          const newValue = e.target.value
                          // If L2 is selected but no L1 exists, automatically change L2 to L1
                          if (newValue === 'libero2') {
                            const hasL1 = players.some((p, idx) => idx !== index && p.libero === 'libero1')
                            if (!hasL1) {
                              handleUpdatePlayer(index, 'libero', 'libero1')
                              return
                            }
                          }
                          handleUpdatePlayer(index, 'libero', newValue)
                        }}
                        style={{
                          width: '100px',
                          padding: '6px',
                          fontSize: '14px',
                          background: '#000000',
                          border: '1px solid rgba(255,255,255,0.2)',
                          borderRadius: '4px',
                          color: 'var(--text)',
                          cursor: 'pointer'
                        }}
                      >
                        <option value="" style={{ background: '#000000', color: 'var(--text)' }}>None</option>
                        {!players.some((p, idx) => idx !== index && p.libero === 'libero1') && (
                          <option value="libero1" style={{ background: '#000000', color: 'var(--text)' }}>L1</option>
                        )}
                        {!players.some((p, idx) => idx !== index && p.libero === 'libero2') && (
                          <option value="libero2" style={{ background: '#000000', color: 'var(--text)' }}>L2</option>
                        )}
                      </select>
                    </td>
                    <td style={{ padding: '12px' }}>
                      <input
                        type="radio"
                        name={`captain-${team}`}
                        checked={player.isCaptain || false}
                        onChange={(e) => {
                          // Unset all other captains, set this one
                          const updatedPlayers = players.map((p, idx) => ({
                            ...p,
                            isCaptain: idx === index ? e.target.checked : false
                          }))
                          setPlayers(updatedPlayers)
                        }}
                        style={{
                          width: '20px',
                          height: '20px',
                          cursor: 'pointer'
                        }}
                      />
                    </td>
                    <td style={{ padding: '12px', textAlign: 'center' }}>
                      <button
                        onClick={() => handleDeletePlayer(index)}
                        style={{
                          padding: '6px 12px',
                          fontSize: '12px',
                          background: 'rgba(239, 68, 68, 0.2)',
                          color: '#ef4444',
                          border: '1px solid #ef4444',
                          borderRadius: '4px',
                          cursor: 'pointer'
                        }}
                      >
                        {t('common.delete')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Bench Officials Section */}
        <div style={{
          marginBottom: '30px',
          padding: '20px',
          background: 'var(--bg)',
          borderRadius: '8px',
          border: '1px solid rgba(255,255,255,0.1)'
        }}>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '20px'
          }}>
            <h2 style={{ fontSize: '18px', fontWeight: 600, margin: 0 }}>
              {t('rosterSetup.benchOfficials')}
            </h2>
            <button
              onClick={handleAddOfficial}
              style={{
                padding: '8px 16px',
                fontSize: '14px',
                fontWeight: 600,
                background: 'var(--accent)',
                color: '#000',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer'
              }}
            >
              {t('rosterSetup.addOfficial')}
            </button>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.2)' }}>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '14px', fontWeight: 600 }}>{t('rosterSetup.role')}</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '14px', fontWeight: 600 }}>{t('rosterSetup.firstName')}</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '14px', fontWeight: 600 }}>{t('rosterSetup.lastName')}</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '14px', fontWeight: 600 }}>{t('rosterSetup.dob')}</th>
                  <th style={{ padding: '12px', textAlign: 'center', fontSize: '14px', fontWeight: 600 }}>{t('rosterSetup.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {benchOfficials.map((official, index) => (
                  <tr key={index} style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                    <td style={{ padding: '12px' }}>
                      <select
                        value={official.role}
                        onChange={(e) => handleUpdateOfficial(index, 'role', e.target.value)}
                        style={{
                          width: '180px',
                          padding: '6px',
                          fontSize: '14px',
                          background: 'var(--bg-secondary)',
                          border: '1px solid rgba(255,255,255,0.2)',
                          borderRadius: '4px',
                          color: 'var(--text)'
                        }}
                      >
                        <option value="Coach">{t('benchRoles.coach')}</option>
                        <option value="Assistant Coach 1">{t('benchRoles.assistantCoach1')}</option>
                        <option value="Assistant Coach 2">{t('benchRoles.assistantCoach2')}</option>
                        <option value="Physiotherapist">{t('benchRoles.physiotherapist')}</option>
                        <option value="Medic">{t('benchRoles.medic')}</option>
                      </select>
                    </td>
                    <td style={{ padding: '12px' }}>
                      <input
                        type="text"
                        value={official.firstName}
                        onChange={(e) => handleUpdateOfficial(index, 'firstName', e.target.value)}
                        style={{
                          width: '150px',
                          padding: '6px',
                          fontSize: '14px',
                          background: 'var(--bg-secondary)',
                          border: '1px solid rgba(255,255,255,0.2)',
                          borderRadius: '4px',
                          color: 'var(--text)'
                        }}
                      />
                    </td>
                    <td style={{ padding: '12px' }}>
                      <input
                        type="text"
                        value={official.lastName}
                        onChange={(e) => handleUpdateOfficial(index, 'lastName', e.target.value)}
                        style={{
                          width: '150px',
                          padding: '6px',
                          fontSize: '14px',
                          background: 'var(--bg-secondary)',
                          border: '1px solid rgba(255,255,255,0.2)',
                          borderRadius: '4px',
                          color: 'var(--text)'
                        }}
                      />
                    </td>
                    <td style={{ padding: '12px' }}>
                      <input
                        type="text"
                        value={official.dob}
                        onChange={(e) => handleUpdateOfficial(index, 'dob', e.target.value)}
                        placeholder="DD/MM/YYYY"
                        style={{
                          width: '120px',
                          padding: '6px',
                          fontSize: '14px',
                          background: 'var(--bg-secondary)',
                          border: '1px solid rgba(255,255,255,0.2)',
                          borderRadius: '4px',
                          color: 'var(--text)'
                        }}
                      />
                    </td>
                    <td style={{ padding: '12px', textAlign: 'center' }}>
                      <button
                        onClick={() => handleDeleteOfficial(index)}
                        style={{
                          padding: '6px 12px',
                          fontSize: '12px',
                          background: 'rgba(239, 68, 68, 0.2)',
                          color: '#ef4444',
                          border: '1px solid #ef4444',
                          borderRadius: '4px',
                          cursor: 'pointer'
                        }}
                      >
                        {t('common.delete')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Save Button */}
        <div style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '12px',
          marginTop: '30px'
        }}>
          <button
            onClick={onBack}
            style={{
              padding: '12px 24px',
              fontSize: '16px',
              fontWeight: 500,
              background: 'transparent',
              color: 'var(--muted)',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '8px',
              cursor: 'pointer'
            }}
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={loading}
            style={{
              padding: '12px 24px',
              fontSize: '16px',
              fontWeight: 600,
              background: loading ? 'rgba(255,255,255,0.3)' : 'var(--accent)',
              color: loading ? 'rgba(255,255,255,0.5)' : '#000',
              border: 'none',
              borderRadius: '8px',
              cursor: loading ? 'not-allowed' : 'pointer'
            }}
          >
            {loading ? t('rosterSetup.saving') : t('rosterSetup.saveRoster')}
          </button>
        </div>

        {/* Roster Preview Modal */}
        {showPreview && pendingRoster && (
          <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.8)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000
          }}>
            <div style={{
              background: 'var(--bg-secondary)',
              borderRadius: '12px',
              padding: '24px',
              maxWidth: '700px',
              width: '90%',
              maxHeight: '80vh',
              overflow: 'auto'
            }}>
              <h2 style={{ marginTop: 0, marginBottom: '20px', fontSize: '20px', fontWeight: 600 }}>
                {t('rosterSetup.rosterPreviewTitle')}
              </h2>

              <h3 style={{ marginTop: 0, marginBottom: '12px', fontSize: '16px' }}>
                {t('rosterSetup.playersCount')}: {pendingRoster.players?.length || 0}
              </h3>
              <div style={{ marginBottom: '20px', overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.2)' }}>
                      <th style={{ padding: '8px', textAlign: 'left' }}>#</th>
                      <th style={{ padding: '8px', textAlign: 'left' }}>{t('rosterSetup.lastName')}</th>
                      <th style={{ padding: '8px', textAlign: 'left' }}>{t('rosterSetup.firstName')}</th>
                      <th style={{ padding: '8px', textAlign: 'center' }}>{t('rosterSetup.libero')}</th>
                      <th style={{ padding: '8px', textAlign: 'center' }}>{t('rosterSetup.captain')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(pendingRoster.players || []).map((p, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                        <td style={{ padding: '6px 8px' }}>{p.number}</td>
                        <td style={{ padding: '6px 8px' }}>{p.lastName || ''}</td>
                        <td style={{ padding: '6px 8px' }}>{p.firstName || ''}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'center' }}>{p.libero ? 'L' : ''}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'center' }}>{p.isCaptain ? 'C' : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {pendingRoster.bench && pendingRoster.bench.length > 0 && (
                <>
                  <h3 style={{ marginTop: '20px', marginBottom: '12px', fontSize: '16px' }}>
                    {t('rosterSetup.benchOfficialsCount')}: {pendingRoster.bench.length}
                  </h3>
                  <div style={{ marginBottom: '20px', overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.2)' }}>
                          <th style={{ padding: '8px', textAlign: 'left' }}>{t('rosterSetup.role')}</th>
                          <th style={{ padding: '8px', textAlign: 'left' }}>{t('rosterSetup.lastName')}</th>
                          <th style={{ padding: '8px', textAlign: 'left' }}>{t('rosterSetup.firstName')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pendingRoster.bench.map((b, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                            <td style={{ padding: '6px 8px' }}>{b.role || ''}</td>
                            <td style={{ padding: '6px 8px' }}>{b.lastName || ''}</td>
                            <td style={{ padding: '6px 8px' }}>{b.firstName || ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              <div style={{ display: 'flex', justifyContent: 'center', marginTop: '20px' }}>
                <button
                  onClick={() => setShowPreview(false)}
                  style={{
                    padding: '12px 32px',
                    fontSize: '14px',
                    fontWeight: 600,
                    background: 'var(--accent)',
                    color: '#000',
                    border: 'none',
                    borderRadius: '8px',
                    cursor: 'pointer'
                  }}
                >
                  {t('common.close')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

