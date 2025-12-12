export default function HomePage({
  favicon,
  newMatchMenuOpen,
  setNewMatchMenuOpen,
  createNewOfficialMatch,
  createNewTestMatch,
  testMatchLoading,
  currentOfficialMatch,
  currentTestMatch,
  continueMatch,
  continueTestMatch,
  showDeleteMatchModal,
  restartTestMatch,
  onOpenSettings
}) {
  return (
    <div className="home-view">
      <div className="home-content">
        <h1 className="home-title" style={{ width: 'auto' }}>Openvolley eScoresheet Indoor</h1>
        <div className="home-logo">
          <img src={favicon} alt="Openvolley" />
        </div>

        <div className="home-match-section" style={{ display: 'flex', flexDirection: 'column', gap: '16px', alignItems: 'center', maxWidth: '400px', margin: '0 auto', width: '100%', padding: '0 20px' }}>
          {/* New Match Button with Collapsible Menu */}
          <div style={{ width: '180px' }}>
            <button
              onClick={() => setNewMatchMenuOpen(!newMatchMenuOpen)}
              style={{
                width: '180px',
                padding: '16px 24px',
                fontSize: '16px',
                fontWeight: 600,
                background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
                color: '#fff',
                border: 'none',
                borderRadius: '12px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                transition: 'transform 0.2s, box-shadow 0.2s'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'translateY(-2px)'
                e.currentTarget.style.boxShadow = '0 8px 16px rgba(59, 130, 246, 0.3)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'translateY(0)'
                e.currentTarget.style.boxShadow = 'none'
              }}
            >
              <span>New Match</span>
              <span style={{ transform: newMatchMenuOpen ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }}>▼</span>
            </button>

            {/* Collapsible Menu */}
            {newMatchMenuOpen && (
              <div style={{
                marginTop: '8px',
                background: 'rgba(255, 255, 255, 0.05)',
                borderRadius: '12px',
                padding: '12px',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px'
              }}>
                <button
                  onClick={() => {
                    setNewMatchMenuOpen(false)
                    createNewOfficialMatch()
                  }}
                  style={{
                    width: '100%',
                    padding: '12px 20px',
                    fontSize: '14px',
                    fontWeight: 600,
                    background: 'rgba(59, 130, 246, 0.1)',
                    color: '#3b82f6',
                    border: '1px solid rgba(59, 130, 246, 0.3)',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    transition: 'background 0.2s'
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(59, 130, 246, 0.2)' }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(59, 130, 246, 0.1)' }}
                >
                  Official Match
                </button>
                <button
                  onClick={() => {
                    setNewMatchMenuOpen(false)
                    createNewTestMatch()
                  }}
                  disabled={testMatchLoading}
                  style={{
                    width: '100%',
                    padding: '12px 20px',
                    fontSize: '14px',
                    fontWeight: 600,
                    background: testMatchLoading ? 'rgba(168, 85, 247, 0.05)' : 'rgba(168, 85, 247, 0.1)',
                    color: testMatchLoading ? 'rgba(168, 85, 247, 0.5)' : '#a855f7',
                    border: testMatchLoading ? '1px solid rgba(168, 85, 247, 0.15)' : '1px solid rgba(168, 85, 247, 0.3)',
                    borderRadius: '8px',
                    cursor: testMatchLoading ? 'not-allowed' : 'pointer',
                    transition: 'background 0.2s'
                  }}
                  onMouseEnter={(e) => { if (!testMatchLoading) e.currentTarget.style.background = 'rgba(168, 85, 247, 0.2)' }}
                  onMouseLeave={(e) => { if (!testMatchLoading) e.currentTarget.style.background = 'rgba(168, 85, 247, 0.1)' }}
                >
                  {testMatchLoading ? 'Preparing…' : 'Test Match'}
                </button>
              </div>
            )}
          </div>

          {/* Continue Match Button */}
          <button
            onClick={() => {
              if (currentOfficialMatch) {
                continueMatch(currentOfficialMatch.id)
              } else if (currentTestMatch) {
                continueTestMatch()
              }
            }}
            disabled={!currentOfficialMatch && !currentTestMatch}
            style={{
              width: '180px',
              padding: '16px 24px',
              fontSize: '16px',
              fontWeight: 600,
              background: (!currentOfficialMatch && !currentTestMatch) ? 'rgba(255, 255, 255, 0.05)' : 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
              color: (!currentOfficialMatch && !currentTestMatch) ? 'rgba(255, 255, 255, 0.3)' : '#fff',
              border: 'none',
              borderRadius: '12px',
              cursor: (!currentOfficialMatch && !currentTestMatch) ? 'not-allowed' : 'pointer',
              transition: 'transform 0.2s, box-shadow 0.2s'
            }}
            onMouseEnter={(e) => {
              if (currentOfficialMatch || currentTestMatch) {
                e.currentTarget.style.transform = 'translateY(-2px)'
                e.currentTarget.style.boxShadow = '0 8px 16px rgba(16, 185, 129, 0.3)'
              }
            }}
            onMouseLeave={(e) => {
              if (currentOfficialMatch || currentTestMatch) {
                e.currentTarget.style.transform = 'translateY(0)'
                e.currentTarget.style.boxShadow = 'none'
              }
            }}
          >
            Continue Match
          </button>

          {/* Delete Match Button */}
          <button
            onClick={() => {
              if (currentOfficialMatch) {
                showDeleteMatchModal()
              } else if (currentTestMatch) {
                restartTestMatch()
              }
            }}
            disabled={!currentOfficialMatch && !currentTestMatch}
            style={{
              width: '180px',
              padding: '16px 24px',
              fontSize: '16px',
              fontWeight: 600,
              background: (!currentOfficialMatch && !currentTestMatch) ? 'rgba(255, 255, 255, 0.05)' : 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)',
              color: (!currentOfficialMatch && !currentTestMatch) ? 'rgba(255, 255, 255, 0.3)' : '#fff',
              border: 'none',
              borderRadius: '12px',
              cursor: (!currentOfficialMatch && !currentTestMatch) ? 'not-allowed' : 'pointer',
              transition: 'transform 0.2s, box-shadow 0.2s'
            }}
            onMouseEnter={(e) => {
              if (currentOfficialMatch || currentTestMatch) {
                e.currentTarget.style.transform = 'translateY(-2px)'
                e.currentTarget.style.boxShadow = '0 8px 16px rgba(239, 68, 68, 0.3)'
              }
            }}
            onMouseLeave={(e) => {
              if (currentOfficialMatch || currentTestMatch) {
                e.currentTarget.style.transform = 'translateY(0)'
                e.currentTarget.style.boxShadow = 'none'
              }
            }}
          >
            Delete Match
          </button>

          {/* Game PIN Display (if exists) */}
          {currentOfficialMatch?.gamePin && (
            <div style={{
              width: '180px',
              marginTop: '8px',
              padding: '12px 16px',
              background: 'rgba(255, 255, 255, 0.05)',
              borderRadius: '12px',
              textAlign: 'center'
            }}>
              <div style={{ fontSize: '11px', color: 'var(--muted)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Game PIN</div>
              <div style={{ fontSize: '20px', fontWeight: 700, fontFamily: 'monospace', letterSpacing: '2px' }}>
                {currentOfficialMatch.gamePin}
              </div>
            </div>
          )}
        </div>

        <div style={{ marginTop: '24px' }}>
          <button
            onClick={onOpenSettings}
            style={{
              padding: '10px 20px',
              fontSize: '14px',
              fontWeight: 600,
              background: 'rgba(255, 255, 255, 0.1)',
              color: 'var(--text)',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              borderRadius: '8px',
              cursor: 'pointer',
              width: '180px'
            }}
          >
            Settings
          </button>
        </div>
      </div>
    </div>
  )
}
