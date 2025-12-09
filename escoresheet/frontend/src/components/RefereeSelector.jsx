import { useState, useEffect, useMemo, useRef } from 'react'
import { db } from '../db/db'

/**
 * Reusable RefereeSelector component for selecting referees from SVRZ database
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

  // Load referees from database
  useEffect(() => {
    if (open) {
      loadReferees()
    }
  }, [open])

  // Update position when dropdown opens
  useEffect(() => {
    if (open && dropdownRef.current && position.element) {
      const updatePosition = () => {
        const rect = position.element.getBoundingClientRect()
        if (rect && dropdownRef.current) {
          dropdownRef.current.style.left = `${rect.right + 10}px`
          dropdownRef.current.style.top = `${rect.top + rect.height / 2}px`
          dropdownRef.current.style.transform = 'translateY(-50%)'
        }
      }
      // Use requestAnimationFrame to ensure element is rendered
      requestAnimationFrame(updatePosition)
      const interval = setInterval(updatePosition, 100)
      return () => clearInterval(interval)
    }
  }, [open, position])

  const loadReferees = async () => {
    setLoading(true)
    try {
      const allReferees = await db.referees.orderBy('lastName').toArray()
      
      // Deduplicate referees by lastName + firstName (case-insensitive)
      // Keep the first occurrence (or the one with the most complete data)
      const uniqueRefereesMap = new Map()
      allReferees.forEach(ref => {
        const key = `${(ref.lastName || '').toLowerCase().trim()}_${(ref.firstName || '').toLowerCase().trim()}`
        if (!uniqueRefereesMap.has(key)) {
          uniqueRefereesMap.set(key, ref)
        } else {
          // If duplicate found, keep the one with more complete data (has email, phone, level, etc.)
          const existing = uniqueRefereesMap.get(key)
          const existingCompleteness = (existing.email ? 1 : 0) + (existing.phone ? 1 : 0) + (existing.level ? 1 : 0)
          const newCompleteness = (ref.email ? 1 : 0) + (ref.phone ? 1 : 0) + (ref.level ? 1 : 0)
          if (newCompleteness > existingCompleteness) {
            uniqueRefereesMap.set(key, ref)
          }
        }
      })
      
      const uniqueReferees = Array.from(uniqueRefereesMap.values())
      console.log(`[RefereeSelector] Loaded ${uniqueReferees.length} unique referees (from ${allReferees.length} total)`)
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
      return referees.sort((a, b) => {
        const aName = `${a.lastName || ''}, ${a.firstName || ''}`
        const bName = `${b.lastName || ''}, ${b.firstName || ''}`
        return aName.localeCompare(bName)
      })
    }

    const query = searchQuery.toLowerCase()
    return referees
      .filter(ref => {
        const fullName = `${ref.lastName || ''} ${ref.firstName || ''}`.toLowerCase()
        return fullName.includes(query)
      })
      .sort((a, b) => {
        const aName = `${a.lastName || ''}, ${a.firstName || ''}`
        const bName = `${b.lastName || ''}, ${b.firstName || ''}`
        return aName.localeCompare(bName)
      })
  }, [referees, searchQuery])

  // Update dropdown position when open
  useEffect(() => {
    if (!open || !dropdownRef.current) return

    const updatePosition = () => {
      if (!dropdownRef.current) return

      const { element, x, y } = position
      if (x !== undefined && y !== undefined) {
        dropdownRef.current.style.position = 'fixed'
        dropdownRef.current.style.left = `${x}px`
        dropdownRef.current.style.top = `${y}px`
        dropdownRef.current.style.transform = 'translateY(-50%)'
        dropdownRef.current.style.zIndex = '1000'
      } else if (element) {
        const rect = typeof element.getBoundingClientRect === 'function' 
          ? element.getBoundingClientRect() 
          : null
        if (rect) {
          dropdownRef.current.style.position = 'fixed'
          dropdownRef.current.style.left = `${rect.right + 10}px`
          dropdownRef.current.style.top = `${rect.top + rect.height / 2}px`
          dropdownRef.current.style.transform = 'translateY(-50%)'
          dropdownRef.current.style.zIndex = '1000'
        } else {
          dropdownRef.current.style.position = 'absolute'
          dropdownRef.current.style.left = '50%'
          dropdownRef.current.style.top = '50%'
          dropdownRef.current.style.transform = 'translate(-50%, -50%)'
          dropdownRef.current.style.zIndex = '1000'
        }
      } else {
        dropdownRef.current.style.position = 'absolute'
        dropdownRef.current.style.left = '50%'
        dropdownRef.current.style.top = '50%'
        dropdownRef.current.style.transform = 'translate(-50%, -50%)'
        dropdownRef.current.style.zIndex = '1000'
      }
    }

    // Update immediately and on window resize/scroll
    updatePosition()
    const interval = setInterval(updatePosition, 100)
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)

    return () => {
      clearInterval(interval)
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open, position])

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
              fontSize: '14px'
            }}
            autoFocus
          />

          {/* Referees List */}
          <div style={{
            overflowY: 'auto',
            maxHeight: '320px',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px'
          }}>
            {loading ? (
              <div style={{ padding: '12px', textAlign: 'center', color: 'rgba(255, 255, 255, 0.6)' }}>
                Loading...
              </div>
            ) : filteredReferees.length === 0 ? (
              <div style={{ padding: '12px', textAlign: 'center', color: 'rgba(255, 255, 255, 0.6)' }}>
                {searchQuery ? 'No referees found' : 'No referees available'}
              </div>
            ) : (
              filteredReferees.map((referee) => (
                <button
                  key={referee.id}
                  onClick={() => {
                    onSelect(referee)
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
                    transition: 'all 0.2s'
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
                  {referee.lastName}, {referee.firstName}
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </>
  )
}
