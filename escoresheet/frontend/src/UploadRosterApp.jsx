import { useState, useEffect, useRef } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db/db'
import { parseRosterPdf } from './utils/parseRosterPdf'

export default function UploadRosterApp() {
  const [matchId, setMatchId] = useState(null)
  const [team, setTeam] = useState(null) // 'home' or 'away'
  const [pin, setPin] = useState('')
  const [enteredPin, setEnteredPin] = useState('')
  const [pdfFile, setPdfFile] = useState(null)
  const [pdfLoading, setPdfLoading] = useState(false)
  const [pdfError, setPdfError] = useState('')
  const [uploadSuccess, setUploadSuccess] = useState(false)
  const fileInputRef = useRef(null)

  // Parse URL parameters
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const urlMatchId = params.get('matchId')
    const urlTeam = params.get('team')
    const urlPin = params.get('pin')

    if (urlMatchId) {
      setMatchId(Number(urlMatchId))
    }
    if (urlTeam === 'home' || urlTeam === 'away') {
      setTeam(urlTeam)
    }
    if (urlPin) {
      setPin(urlPin)
    }
  }, [])

  // Load match data
  const match = useLiveQuery(async () => {
    if (!matchId) return null
    return await db.matches.get(matchId)
  }, [matchId])

  // Verify PIN
  const correctPin = team === 'home' ? match?.homeTeamUploadPin : match?.awayTeamUploadPin
  const isPinValid = pin && correctPin && pin === correctPin

  // Handle file selection
  const handleFileSelect = (e) => {
    const file = e.target.files?.[0]
    if (file && file.type === 'application/pdf') {
      setPdfFile(file)
      setPdfError('')
      setUploadSuccess(false)
    } else {
      setPdfError('Please select a valid PDF file')
      setPdfFile(null)
    }
  }

  // Handle PIN entry
  const handlePinSubmit = (e) => {
    e.preventDefault()
    if (enteredPin === correctPin) {
      setPin(enteredPin)
      setPdfError('')
    } else {
      setPdfError('Invalid PIN')
    }
  }

  // Handle PDF upload and parse
  const handleUpload = async () => {
    if (!pdfFile || !matchId || !team || !isPinValid) return

    setPdfLoading(true)
    setPdfError('')
    setUploadSuccess(false)

    try {
      const parsedData = await parseRosterPdf(pdfFile)

      // Prepare roster data
      const players = parsedData.players.map(p => ({
        number: p.number || null,
        firstName: p.firstName || '',
        lastName: p.lastName || '',
        dob: p.dob || '',
        libero: '',
        isCaptain: false
      }))

      // Prepare bench officials
      const bench = []
      if (parsedData.coach) {
        bench.push({
          role: 'Coach',
          firstName: parsedData.coach.firstName || '',
          lastName: parsedData.coach.lastName || '',
          dob: parsedData.coach.dob || ''
        })
      }
      if (parsedData.ac1) {
        bench.push({
          role: 'Assistant Coach 1',
          firstName: parsedData.ac1.firstName || '',
          lastName: parsedData.ac1.lastName || '',
          dob: parsedData.ac1.dob || ''
        })
      }
      if (parsedData.ac2) {
        bench.push({
          role: 'Assistant Coach 2',
          firstName: parsedData.ac2.firstName || '',
          lastName: parsedData.ac2.lastName || '',
          dob: parsedData.ac2.dob || ''
        })
      }

      // Store as pending roster
      const pendingField = team === 'home' ? 'pendingHomeRoster' : 'pendingAwayRoster'
      await db.matches.update(matchId, {
        [pendingField]: {
          players,
          bench,
          uploadedAt: new Date().toISOString()
        }
      })

      setUploadSuccess(true)
      setPdfFile(null)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    } catch (err) {
      console.error('Error parsing PDF:', err)
      setPdfError(`Failed to parse PDF: ${err.message}`)
    } finally {
      setPdfLoading(false)
    }
  }

  // If no matchId or team in URL, show input form
  if (!matchId || !team) {
    return (
      <div style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
      }}>
        <div style={{
          background: 'var(--bg-secondary)',
          borderRadius: '12px',
          padding: '40px',
          maxWidth: '400px',
          width: '100%',
          textAlign: 'center'
        }}>
          <h2 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '24px' }}>
            Upload Roster
          </h2>
          <p style={{ fontSize: '14px', color: 'var(--muted)', marginBottom: '24px' }}>
            Please access this page via the link provided in Match Setup.
          </p>
        </div>
      </div>
    )
  }

  // If match not found
  if (matchId && !match) {
    return (
      <div style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
      }}>
        <div style={{
          background: 'var(--bg-secondary)',
          borderRadius: '12px',
          padding: '40px',
          maxWidth: '400px',
          width: '100%',
          textAlign: 'center'
        }}>
          <h2 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '24px' }}>
            Match Not Found
          </h2>
          <p style={{ fontSize: '14px', color: 'var(--muted)' }}>
            The match with ID {matchId} does not exist.
          </p>
        </div>
      </div>
    )
  }

  // If PIN not provided in URL, show PIN input
  if (!pin || !isPinValid) {
    return (
      <div style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
      }}>
        <div style={{
          background: 'var(--bg-secondary)',
          borderRadius: '12px',
          padding: '40px',
          maxWidth: '400px',
          width: '100%',
          textAlign: 'center'
        }}>
          <h2 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '24px' }}>
            Enter Upload PIN
          </h2>
          <form onSubmit={handlePinSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <input
              type="text"
              value={enteredPin}
              onChange={(e) => {
                const val = e.target.value.replace(/\D/g, '').slice(0, 6)
                setEnteredPin(val)
                setPdfError('')
              }}
              placeholder="Enter 6-digit PIN"
              style={{
                padding: '12px',
                fontSize: '18px',
                fontFamily: 'monospace',
                textAlign: 'center',
                background: 'rgba(255, 255, 255, 0.1)',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                borderRadius: '6px',
                color: 'var(--text)'
              }}
              maxLength={6}
            />
            {pdfError && (
              <p style={{ color: '#ef4444', fontSize: '14px', margin: 0 }}>
                {pdfError}
              </p>
            )}
            <button
              type="submit"
              style={{
                padding: '12px 24px',
                fontSize: '16px',
                fontWeight: 600,
                background: 'var(--accent)',
                color: '#000',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer'
              }}
            >
              Submit
            </button>
          </form>
        </div>
      </div>
    )
  }

  // Main upload interface
  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
      color: '#fff',
      padding: '20px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    }}>
      <div style={{
        maxWidth: '800px',
        margin: '0 auto',
        background: 'var(--bg-secondary)',
        borderRadius: '12px',
        padding: '40px'
      }}>
        <h1 style={{ fontSize: '28px', fontWeight: 700, marginBottom: '8px' }}>
          Upload Roster
        </h1>
        <p style={{ fontSize: '14px', color: 'var(--muted)', marginBottom: '32px' }}>
          Team: {team === 'home' ? (match?.homeTeamId ? 'Home' : 'N/A') : (match?.awayTeamId ? 'Away' : 'N/A')}
        </p>

        {uploadSuccess && (
          <div style={{
            padding: '16px',
            background: 'rgba(34, 197, 94, 0.2)',
            border: '1px solid #22c55e',
            borderRadius: '8px',
            marginBottom: '24px',
            color: '#22c55e'
          }}>
            ✓ Roster uploaded successfully! Please confirm the import in Match Setup.
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf"
            onChange={handleFileSelect}
            style={{ display: 'none' }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={pdfLoading}
            style={{
              padding: '12px 24px',
              fontSize: '16px',
              fontWeight: 600,
              background: 'rgba(255, 255, 255, 0.1)',
              color: 'var(--text)',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              borderRadius: '6px',
              cursor: pdfLoading ? 'not-allowed' : 'pointer'
            }}
          >
            Choose PDF File
          </button>

          {pdfFile && (
            <>
              <div style={{
                padding: '12px',
                background: 'rgba(255, 255, 255, 0.05)',
                borderRadius: '6px',
                fontSize: '14px'
              }}>
                Selected: {pdfFile.name}
              </div>
              <button
                type="button"
                onClick={handleUpload}
                disabled={pdfLoading || !isPinValid}
                style={{
                  padding: '12px 24px',
                  fontSize: '16px',
                  fontWeight: 600,
                  background: 'var(--accent)',
                  color: '#000',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: pdfLoading || !isPinValid ? 'not-allowed' : 'pointer'
                }}
              >
                {pdfLoading ? 'Uploading...' : 'Upload & Parse PDF'}
              </button>
            </>
          )}

          {pdfLoading && (
            <p style={{ fontSize: '14px', color: 'var(--accent)', margin: 0 }}>
              Parsing PDF and uploading data...
            </p>
          )}

          {pdfError && (
            <p style={{ fontSize: '14px', color: '#ef4444', margin: 0 }}>
              {pdfError}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

