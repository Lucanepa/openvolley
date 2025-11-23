import { useState, useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { parseRosterPdf } from '../utils/parseRosterPdf'

export default function RosterSetup({ matchId, team, onBack }) {
  const [players, setPlayers] = useState([])
  const [benchOfficials, setBenchOfficials] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [pdfFile, setPdfFile] = useState(null)

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

  const handlePdfUpload = async (e) => {
    const file = e.target.files[0]
    if (!file) return

    setLoading(true)
    setError('')

    try {
      const parsedData = await parseRosterPdf(file)
      
      // Merge parsed players with existing players
      const mergedPlayers = [...players]
      
      parsedData.players.forEach(parsedPlayer => {
        const existingIndex = mergedPlayers.findIndex(p => 
          p.number === parsedPlayer.number || 
          (p.lastName.toLowerCase() === parsedPlayer.lastName.toLowerCase() && 
           p.firstName.toLowerCase() === parsedPlayer.firstName.toLowerCase())
        )
        
        if (existingIndex >= 0) {
          // Update existing player
          mergedPlayers[existingIndex] = {
            ...mergedPlayers[existingIndex],
            firstName: parsedPlayer.firstName || mergedPlayers[existingIndex].firstName,
            lastName: parsedPlayer.lastName || mergedPlayers[existingIndex].lastName,
            dob: parsedPlayer.dob || mergedPlayers[existingIndex].dob
          }
        } else {
          // Add new player
          mergedPlayers.push({
            id: null,
            number: parsedPlayer.number || (mergedPlayers.length > 0 ? Math.max(...mergedPlayers.map(p => p.number || 0)) + 1 : 1),
            firstName: parsedPlayer.firstName || '',
            lastName: parsedPlayer.lastName || '',
            dob: parsedPlayer.dob || '',
            libero: '',
            isCaptain: false
          })
        }
      })

      // Update bench officials if found in PDF
      if (parsedData.coach) {
        const coachIndex = benchOfficials.findIndex(o => o.role === 'Coach')
        if (coachIndex >= 0) {
          const updated = [...benchOfficials]
          updated[coachIndex] = { ...updated[coachIndex], ...parsedData.coach }
          setBenchOfficials(updated)
        } else {
          setBenchOfficials([...benchOfficials, { role: 'Coach', ...parsedData.coach }])
        }
      }

      if (parsedData.ac1) {
        const ac1Index = benchOfficials.findIndex(o => o.role === 'Assistant Coach 1')
        if (ac1Index >= 0) {
          const updated = [...benchOfficials]
          updated[ac1Index] = { ...updated[ac1Index], ...parsedData.ac1 }
          setBenchOfficials(updated)
        } else {
          setBenchOfficials([...benchOfficials, { role: 'Assistant Coach 1', ...parsedData.ac1 }])
        }
      }

      if (parsedData.ac2) {
        const ac2Index = benchOfficials.findIndex(o => o.role === 'Assistant Coach 2')
        if (ac2Index >= 0) {
          const updated = [...benchOfficials]
          updated[ac2Index] = { ...updated[ac2Index], ...parsedData.ac2 }
          setBenchOfficials(updated)
        } else {
          setBenchOfficials([...benchOfficials, { role: 'Assistant Coach 2', ...parsedData.ac2 }])
        }
      }

      setPlayers(mergedPlayers)
      setPdfFile(null)
    } catch (err) {
      console.error('Error parsing PDF:', err)
      setError(`Failed to parse PDF: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    if (!teamId) {
      setError('Team ID not found')
      return
    }

    setLoading(true)
    setError('')

    try {
      // Save players
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

      // Save bench officials
      const benchKey = team === 'home' ? 'bench_home' : 'bench_away'
      await db.matches.update(matchId, {
        [benchKey]: benchOfficials.map(o => ({
          role: o.role,
          firstName: o.firstName,
          lastName: o.lastName,
          dob: o.dob
        }))
      })

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
            Upload a roster PDF to automatically populate players and officials
          </p>
          <input
            type="file"
            accept=".pdf"
            onChange={handlePdfUpload}
            disabled={loading}
            style={{
              padding: '10px',
              fontSize: '14px',
              background: 'var(--bg-secondary)',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '6px',
              color: 'var(--text)',
              cursor: loading ? 'not-allowed' : 'pointer'
            }}
          />
          {loading && (
            <p style={{ fontSize: '14px', color: 'var(--muted)', marginTop: '10px' }}>
              Parsing PDF...
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
                      <input
                        type="text"
                        value={player.libero}
                        onChange={(e) => handleUpdatePlayer(index, 'libero', e.target.value)}
                        placeholder="L1, L2, etc."
                        style={{
                          width: '80px',
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
                        type="checkbox"
                        checked={player.isCaptain || false}
                        onChange={(e) => handleUpdatePlayer(index, 'isCaptain', e.target.checked)}
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

