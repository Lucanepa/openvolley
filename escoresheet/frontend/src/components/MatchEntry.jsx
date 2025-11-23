import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'

export default function MatchEntry({ matchId, team, onBack }) {
  const match = useLiveQuery(async () => {
    if (!matchId) return null
    return await db.matches.get(matchId)
  }, [matchId])

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
        padding: '30px',
        textAlign: 'center'
      }}>
        <h1 style={{ fontSize: '28px', fontWeight: 700, marginBottom: '20px' }}>
          Enter Match
        </h1>
        <p style={{ fontSize: '16px', color: 'var(--muted)', marginBottom: '30px' }}>
          Match entry view - Coming soon
        </p>
        <p style={{ fontSize: '14px', color: 'var(--muted)', marginBottom: '30px' }}>
          This feature will allow teams to view match information and interact with the scoresheet.
        </p>
        <button
          onClick={onBack}
          style={{
            padding: '12px 24px',
            fontSize: '16px',
            fontWeight: 600,
            background: 'var(--accent)',
            color: '#000',
            border: 'none',
            borderRadius: '8px',
            cursor: 'pointer'
          }}
        >
          Back
        </button>
      </div>
    </div>
  )
}

