import { useState, useEffect, useMemo, useRef } from 'react'
import { supabase } from '../lib/supabaseClient'

/**
 * Reusable RefereeSelector component for selecting referees from history
 * Uses Supabase referee_database table for suggestions
 * @param {boolean} open - Whether dropdown is open
 * @param {function} onClose - Function to call when closing
 * @param {function} onSelect - Function to call when a referee is selected: (referee) => void
 * @param {Object} position - Position config for dropdown placement
 */
export default function RefereeSelector({ open, onClose, onSelect, position = {} }) {
  const [searchQuery, setSearchQuery] = useState('')
  const [referees, setReferees] = useState([])
  const [loading, setLoading] = useState(false)
  const dropdownRef = useRef(null)

  // Load referees from Supabase history
  useEffect(() => {
    if (open) {
      loadReferees()
    }
  }, [open])

  const loadReferees = async () => {
    setLoading(true)
    try {
      if (!supabase) {
        console.log('[RefereeSelector] Supabase not available')
        setReferees([])
        return
      }

      const { data, error } = await supabase
        .from('referee_database')
        .select('first_name, last_name, country, dob, created_at')
        .order('last_name', { ascending: true })

      if (error) {
        console.error('Error loading referees from history:', error)
        setReferees([])
        return
      }

      // Data is already unique due to unique index, just map to expected format
      const uniqueReferees = (data || []).map(ref => ({
        id: `${ref.last_name}_${ref.first_name}`.toLowerCase(),
        firstName: ref.first_name || '',
        lastName: ref.last_name || '',
        country: ref.country || 'CHE',
        dob: ref.dob || ''
      }))

      console.log(`[RefereeSelector] Loaded ${uniqueReferees.length} unique referees from history`)
      setReferees(uniqueReferees)
    } catch (error) {
      console.error('Error loading referees:', error)
      setReferees([])
    } finally {
      setLoading(false)
    }
  }

  // Filter and sort referees
  const filteredReferees = useMemo(() => {
    if (!searchQuery.trim()) {
      return referees
    }

    const query = searchQuery.toLowerCase()
    return referees.filter(ref => {
      const fullName = `${ref.lastName || ''} ${ref.firstName || ''}`.toLowerCase()
      return fullName.includes(query)
    })
  }, [referees, searchQuery])

  // Always center the modal on screen
  useEffect(() => {
    if (!open || !dropdownRef.current) return

    // Always center the modal
    dropdownRef.current.style.position = 'fixed'
    dropdownRef.current.style.left = '50%'
    dropdownRef.current.style.top = '50%'
    dropdownRef.current.style.transform = 'translate(-50%, -50%)'
    dropdownRef.current.style.zIndex = '1000'
  }, [open])

  // Handle click outside
  useEffect(() => {
    if (!open) return

    const handleClickOutside = (e) => {
      if (!e.target.closest('[data-referee-selector]')) {
        onClose()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [open, onClose])

  if (!open) return null

  const isOnline = !!supabase

  return (
    <>
      {/* Backdrop */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 999,
          background: 'transparent'
        }}
        onClick={onClose}
      />
      {/* Dropdown */}
      <div
        ref={dropdownRef}
        style={{
          position: 'fixed',
          zIndex: 1000
        }}
        className="modal-wrapper-roll-down"
      >
        <div
          data-referee-selector
          style={{
            background: 'rgba(15, 23, 42, 0.95)',
            border: '2px solid rgba(255, 255, 255, 0.2)',
            borderRadius: '8px',
            padding: '8px',
            minWidth: '300px',
            maxWidth: '400px',
            maxHeight: '400px',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
            display: 'flex',
            flexDirection: 'column'
          }}
        >
          {/* Header */}
          <div style={{
            padding: '4px 8px 8px',
            fontSize: '11px',
            color: 'rgba(255,255,255,0.5)',
            borderBottom: '1px solid rgba(255,255,255,0.1)',
            marginBottom: '8px'
          }}>
            {isOnline ? 'Select from history (Supabase)' : 'Offline - no history available'}
          </div>

          {/* Search Input */}
          <input
            type="text"
            placeholder="Search referees..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              width: '100%',
              padding: '8px 12px',
              marginBottom: '8px',
              background: 'rgba(255, 255, 255, 0.1)',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              borderRadius: '4px',
              color: '#fff',
              fontSize: '14px',
              boxSizing: 'border-box'
            }}
            autoFocus
          />

          {/* Referees List */}
          <div style={{
            overflowY: 'auto',
            maxHeight: '280px',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px'
          }}>
            {!isOnline ? (
              <div style={{ padding: '12px', textAlign: 'center', color: 'rgba(255, 255, 255, 0.6)' }}>
                Connect to internet to see referee history
              </div>
            ) : loading ? (
              <div style={{ padding: '12px', textAlign: 'center', color: 'rgba(255, 255, 255, 0.6)' }}>
                Loading...
              </div>
            ) : filteredReferees.length === 0 ? (
              <div style={{ padding: '12px', textAlign: 'center', color: 'rgba(255, 255, 255, 0.6)' }}>
                {searchQuery ? 'No referees found' : 'No referee history yet. Enter referees manually and they will be saved for future matches.'}
              </div>
            ) : (
              filteredReferees.map((referee) => (
                <button
                  key={referee.id}
                  onClick={() => {
                    onSelect(referee)
                    setSearchQuery('') // Reset search for next use
                    onClose()
                  }}
                  style={{
                    padding: '8px 12px',
                    background: 'rgba(255, 255, 255, 0.05)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '4px',
                    color: '#fff',
                    fontSize: '14px',
                    textAlign: 'left',
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                    e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
                    e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)'
                  }}
                >
                  <span>{referee.lastName}, {referee.firstName}</span>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </>
  )
}
