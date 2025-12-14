import { useState, useRef, useEffect } from 'react'

/**
 * Team name autocomplete with dropdown for historical teams
 * Shows suggestions from previously used team names when online
 */
export default function TeamAutocomplete({
  value,
  onChange,
  onSelectTeam,
  teamNames = [],
  placeholder = 'Team name',
  isOnline = false,
  style = {},
  inputStyle = {},
  measureRef,
  inputRef: externalInputRef
}) {
  const [showDropdown, setShowDropdown] = useState(false)
  const [filteredTeams, setFilteredTeams] = useState([])
  const containerRef = useRef(null)
  const internalInputRef = useRef(null)
  const inputRef = externalInputRef || internalInputRef

  // Filter teams based on input
  useEffect(() => {
    if (!value || !teamNames.length) {
      setFilteredTeams(teamNames.slice(0, 10)) // Show first 10 when empty
      return
    }

    const searchLower = value.toLowerCase()
    const filtered = teamNames.filter(team =>
      team.name.toLowerCase().includes(searchLower)
    ).slice(0, 10)

    setFilteredTeams(filtered)
  }, [value, teamNames])

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setShowDropdown(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleInputChange = (e) => {
    onChange(e.target.value)
    if (isOnline && teamNames.length > 0) {
      setShowDropdown(true)
    }
  }

  const handleFocus = () => {
    if (isOnline && teamNames.length > 0) {
      setShowDropdown(true)
    }
    // Update width measurement
    if (measureRef?.current && inputRef?.current) {
      measureRef.current.textContent = value || placeholder
      const measuredWidth = measureRef.current.offsetWidth
      inputRef.current.style.width = `${Math.max(80, measuredWidth + 24)}px`
    }
  }

  const handleSelectTeam = (team) => {
    onChange(team.name)
    setShowDropdown(false)
    if (onSelectTeam) {
      onSelectTeam(team)
    }
  }

  const hasHistory = isOnline && teamNames.length > 0

  return (
    <div ref={containerRef} style={{ position: 'relative', ...style }}>
      {/* Hidden measure span for width calculation */}
      {measureRef && (
        <span
          ref={measureRef}
          style={{
            position: 'absolute',
            visibility: 'hidden',
            whiteSpace: 'pre',
            fontSize: inputStyle.fontSize || '16px',
            fontWeight: inputStyle.fontWeight || 700,
            letterSpacing: inputStyle.letterSpacing || '0.01em',
            padding: '0 12px'
          }}
        >
          {value || placeholder}
        </span>
      )}

      {/* Input field */}
      <div style={{ position: 'relative' }}>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={handleInputChange}
          onFocus={handleFocus}
          placeholder={placeholder}
          style={{
            minWidth: '80px',
            width: 'auto',
            padding: '8px 12px',
            paddingRight: hasHistory ? '32px' : '12px',
            borderRadius: 8,
            border: '1px solid rgba(255, 255, 255, 0.2)',
            background: 'rgba(15, 23, 42, 0.35)',
            color: 'var(--text)',
            fontSize: '16px',
            fontWeight: 700,
            letterSpacing: '0.01em',
            minHeight: 48,
            boxSizing: 'border-box',
            transition: 'width 0.1s ease',
            ...inputStyle
          }}
        />

        {/* Dropdown indicator */}
        {hasHistory && (
          <button
            type="button"
            onClick={() => setShowDropdown(!showDropdown)}
            style={{
              position: 'absolute',
              right: '8px',
              top: '50%',
              transform: 'translateY(-50%)',
              background: 'none',
              border: 'none',
              color: 'rgba(255,255,255,0.5)',
              cursor: 'pointer',
              padding: '4px',
              fontSize: '12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
            tabIndex={-1}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        )}
      </div>

      {/* Dropdown */}
      {showDropdown && filteredTeams.length > 0 && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            minWidth: '250px',
            maxHeight: '300px',
            overflowY: 'auto',
            background: '#1e293b',
            border: '1px solid rgba(255,255,255,0.2)',
            borderRadius: '8px',
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
            zIndex: 1000,
            marginTop: '4px'
          }}
        >
          <div style={{
            padding: '8px 12px',
            fontSize: '11px',
            color: 'rgba(255,255,255,0.5)',
            borderBottom: '1px solid rgba(255,255,255,0.1)',
            background: 'rgba(0,0,0,0.2)'
          }}>
            Select from history or type new name
          </div>

          {filteredTeams.map((team, index) => (
            <button
              key={index}
              type="button"
              onClick={() => handleSelectTeam(team)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                width: '100%',
                padding: '12px',
                background: 'transparent',
                border: 'none',
                borderBottom: index < filteredTeams.length - 1 ? '1px solid rgba(255,255,255,0.1)' : 'none',
                color: 'var(--text)',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'background 0.15s'
              }}
              onMouseEnter={(e) => e.target.style.background = 'rgba(59, 130, 246, 0.2)'}
              onMouseLeave={(e) => e.target.style.background = 'transparent'}
            >
              {/* Color indicator */}
              {team.color && (
                <div
                  style={{
                    width: '16px',
                    height: '16px',
                    borderRadius: '4px',
                    background: team.color,
                    flexShrink: 0
                  }}
                />
              )}

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: '14px',
                  fontWeight: 600,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}>
                  {team.name}
                </div>
                {team.shortName && (
                  <div style={{
                    fontSize: '11px',
                    color: 'rgba(255,255,255,0.5)',
                    marginTop: '2px'
                  }}>
                    Short: {team.shortName}
                  </div>
                )}
              </div>

              {/* History indicator */}
              <div style={{
                fontSize: '10px',
                color: 'rgba(255,255,255,0.4)',
                background: 'rgba(255,255,255,0.1)',
                padding: '2px 6px',
                borderRadius: '4px',
                flexShrink: 0
              }}>
                History
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
