import { useState, useRef, useEffect } from 'react'
import { ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { FOCUS_RING_INSET } from '../ui/Button.jsx'

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
  const { t } = useTranslation()
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
            aria-label={t('officialAutocomplete.selectFromHistory', 'Select from history')}
            title={t('officialAutocomplete.selectFromHistory', 'Select from history')}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center rounded-md bg-transparent p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-600 transition-colors"
            style={{ border: 'none' }}
            tabIndex={-1}
          >
            <ChevronDown size={12} strokeWidth={2.5} aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Dropdown */}
      {showDropdown && filteredOfficials.length > 0 && (
        // Anchored dropdown: white card, stone hairline, card-lg shadow
        // (RESTYLE-SPEC 3.4; was a dark #1e293b popover).
        <div
          className="absolute left-0 right-0 top-full mt-1 overflow-y-auto rounded-xl border border-stone-200 bg-white p-1.5 shadow-card-lg"
          style={{ minWidth: '220px', maxHeight: '250px', zIndex: 1000 }}
        >
          <div className="px-2.5 pt-1 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400">
            {t('officialAutocomplete.selectFromHistory', 'Select from history')}
          </div>

          {filteredOfficials.map((official, index) => (
            <button
              key={index}
              type="button"
              onClick={() => handleSelectOfficial(official)}
              className={`flex w-full min-h-11 items-center justify-between gap-2 rounded-lg bg-transparent px-2.5 text-left text-stone-800 hover:bg-stone-100 transition-colors ${FOCUS_RING_INSET}`}
              style={{ border: 'none' }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="text-sm font-medium" style={{
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
