import { useState, useRef, useEffect } from 'react'

/**
 * Official (referee/scorer) autocomplete with dropdown
 * Shows suggestions from previously used officials when online
 */
export default function OfficialAutocomplete({
  value = '',
  onChange,
  onSelect,
  officials = [],
  placeholder = 'Last name',
  isOnline = false,
  style = {},
  inputStyle = {}
}) {
  const [showDropdown, setShowDropdown] = useState(false)
  const [filteredOfficials, setFilteredOfficials] = useState([])
  const containerRef = useRef(null)
  const inputRef = useRef(null)

  // Filter officials based on input
  useEffect(() => {
    if (!officials.length) {
      setFilteredOfficials([])
      return
    }

    if (!value) {
      setFilteredOfficials(officials.slice(0, 10))
      return
    }

    const searchLower = value.toLowerCase()
    const filtered = officials.filter(official => {
      const fullName = `${official.lastName} ${official.firstName}`.toLowerCase()
      const reverseName = `${official.firstName} ${official.lastName}`.toLowerCase()
      return fullName.includes(searchLower) ||
             reverseName.includes(searchLower) ||
             official.lastName.toLowerCase().includes(searchLower) ||
             official.firstName.toLowerCase().includes(searchLower)
    }).slice(0, 10)

    setFilteredOfficials(filtered)
  }, [value, officials])

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
    if (isOnline && officials.length > 0) {
      setShowDropdown(true)
    }
  }

  const handleFocus = () => {
    if (isOnline && officials.length > 0) {
      setShowDropdown(true)
    }
  }

  const handleSelectOfficial = (official) => {
    setShowDropdown(false)
    if (onSelect) {
      onSelect(official)
    }
  }

  const hasHistory = isOnline && officials.length > 0

  return (
    <div ref={containerRef} style={{ position: 'relative', ...style }}>
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
            width: '100%',
            padding: '8px 12px',
            paddingRight: hasHistory ? '32px' : '12px',
            borderRadius: 6,
            border: '1px solid rgba(255, 255, 255, 0.15)',
            background: 'rgba(15, 23, 42, 0.5)',
            color: 'var(--text)',
            fontSize: '13px',
            minHeight: 36,
            boxSizing: 'border-box',
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
              right: '6px',
              top: '50%',
              transform: 'translateY(-50%)',
              background: 'none',
              border: 'none',
              color: 'rgba(255,255,255,0.4)',
              cursor: 'pointer',
              padding: '4px',
              fontSize: '10px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
            tabIndex={-1}
          >
            <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor">
              <path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        )}
      </div>

      {/* Dropdown */}
      {showDropdown && filteredOfficials.length > 0 && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            minWidth: '220px',
            maxHeight: '250px',
            overflowY: 'auto',
            background: '#1e293b',
            border: '1px solid rgba(255,255,255,0.2)',
            borderRadius: '6px',
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
            zIndex: 1000,
            marginTop: '2px'
          }}
        >
          <div style={{
            padding: '6px 10px',
            fontSize: '10px',
            color: 'rgba(255,255,255,0.5)',
            borderBottom: '1px solid rgba(255,255,255,0.1)',
            background: 'rgba(0,0,0,0.2)'
          }}>
            Select from history
          </div>

          {filteredOfficials.map((official, index) => (
            <button
              key={index}
              type="button"
              onClick={() => handleSelectOfficial(official)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '8px',
                width: '100%',
                padding: '10px 12px',
                background: 'transparent',
                border: 'none',
                borderBottom: index < filteredOfficials.length - 1 ? '1px solid rgba(255,255,255,0.08)' : 'none',
                color: 'var(--text)',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'background 0.15s'
              }}
              onMouseEnter={(e) => e.target.style.background = 'rgba(59, 130, 246, 0.2)'}
              onMouseLeave={(e) => e.target.style.background = 'transparent'}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: '13px',
                  fontWeight: 500,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}>
                  {official.lastName}, {official.firstName}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
