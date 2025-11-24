import { useState, useEffect, useRef } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { parseRosterPdf } from '../utils/parseRosterPdf'

export default function RosterSetup({ matchId, team, onBack }) {
  const [players, setPlayers] = useState([])
  const [benchOfficials, setBenchOfficials] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [pdfFile, setPdfFile] = useState(null)
  const fileInputRef = useRef(null)

  const match = useLiveQuery(async () => {
    if (!matchId) return null
    return await db.matches.get(matchId)
  }, [matchId])

  const teamId = team === 'home' ? match?.homeTeamId : match?.awayTeamId

  // Load existing roster
  useEffect(() => {
    if (!teamId) return

    async function loadRoster() {
      try {
        const teamPlayers = await db.players.where('teamId').equals(teamId).sortBy('number')
        setPlayers(teamPlayers.map(p => ({
          id: p.id,
          number: p.number,
          firstName: p.firstName || '',
          lastName: p.lastName || p.name || '',
          dob: p.dob || '',
          libero: p.libero || '',
          isCaptain: p.isCaptain || false
        })))

        const benchKey = team === 'home' ? 'bench_home' : 'bench_away'
        if (match?.[benchKey]) {
          setBenchOfficials(match[benchKey].map(b => ({
            role: b.role || '',
            firstName: b.firstName || b.first_name || '',
            lastName: b.lastName || b.last_name || '',
            dob: b.dob || b.date_of_birth || b.dateOfBirth || ''
          })))
        }
      } catch (err) {
        console.error('Error loading roster:', err)
        setError('Failed to load roster')
      }
    }

    loadRoster()
  }, [teamId, match, team])

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
    console.log('[RosterSetup] handlePdfUpload called with file:', file)
    if (!file) {
      console.log('[RosterSetup] No file provided')
      return
    }

    setLoading(true)
    setError('')
    setPdfFile(file)

    try {
      console.log('[RosterSetup] Parsing PDF:', file.name)
      const parsedData = await parseRosterPdf(file)
      console.log('[RosterSetup] Parsed data:', parsedData)
      
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
      
      console.log('[RosterSetup] Replaced', players.length, 'existing players with', mergedPlayers.length, 'imported players')

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
      
      // Auto-save to database with overwrite mode
      if (teamId && matchId) {
        console.log('[RosterSetup] Auto-saving imported data to database (overwrite mode)')
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
        
        console.log('[RosterSetup] Overwritten bench officials:', importedBenchOfficials.length, 'officials')
        console.log('[RosterSetup] Imported data saved to database')
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
    console.log('[RosterSetup] Import button clicked, pdfFile:', pdfFile)
    if (pdfFile) {
      console.log('[RosterSetup] Starting import for file:', pdfFile.name)
      await handlePdfUpload(pdfFile)
    } else {
      console.log('[RosterSetup] No file selected')
      setError('Please select a PDF file first')
    }
  }

  const handleSave = async (overwrite = false) => {
    if (!teamId) {
      setError('Team ID not found')
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
        console.log('[RosterSetup] Deleted all existing players for overwrite')
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
        console.log('[RosterSetup] Added', players.length, 'players to database')
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
      console.log('[RosterSetup] Updated bench officials in database')

      alert('Roster saved successfully!')
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
            Set up roster
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
            Back
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
            Load roster from PDF
          </h2>
          <p style={{ fontSize: '14px', color: 'var(--muted)', marginBottom: '16px' }}>
            Select a roster PDF file to automatically import players and officials
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
                Choose PDF File
              </button>
              {pdfFile && !loading && (
                <span style={{ fontSize: '14px', color: 'var(--text)', flex: 1 }}>
                  Selected: {pdfFile.name}
                </span>
              )}
            </div>
            {pdfFile && !loading && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  console.log('[RosterSetup] Import button onClick triggered')
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
                Import
              </button>
            )}
          </div>
          {loading && (
            <p style={{ fontSize: '14px', color: 'var(--accent)', marginTop: '10px' }}>
              Parsing PDF and importing data...
            </p>
          )}
          {error && (
            <p style={{ fontSize: '14px', color: '#ef4444', marginTop: '10px' }}>
              {error}
            </p>
          )}
        </div>

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
              Players
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
              + Add Player
            </button>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.2)' }}>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '14px', fontWeight: 600 }}>Number</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '14px', fontWeight: 600 }}>First Name</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '14px', fontWeight: 600 }}>Last Name</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '14px', fontWeight: 600 }}>DOB</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '14px', fontWeight: 600 }}>Libero</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '14px', fontWeight: 600 }}>Captain</th>
                  <th style={{ padding: '12px', textAlign: 'center', fontSize: '14px', fontWeight: 600 }}>Actions</th>
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
                          width: '60px',
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
                        Delete
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
              Bench Officials
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
              + Add Official
            </button>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.2)' }}>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '14px', fontWeight: 600 }}>Role</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '14px', fontWeight: 600 }}>First Name</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '14px', fontWeight: 600 }}>Last Name</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '14px', fontWeight: 600 }}>DOB</th>
                  <th style={{ padding: '12px', textAlign: 'center', fontSize: '14px', fontWeight: 600 }}>Actions</th>
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
                        <option value="Coach">Coach</option>
                        <option value="Assistant Coach 1">Assistant Coach 1</option>
                        <option value="Assistant Coach 2">Assistant Coach 2</option>
                        <option value="Physiotherapist">Physiotherapist</option>
                        <option value="Medic">Medic</option>
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
                        Delete
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
            Cancel
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
            {loading ? 'Saving...' : 'Save Roster'}
          </button>
        </div>
      </div>
    </div>
  )
}

