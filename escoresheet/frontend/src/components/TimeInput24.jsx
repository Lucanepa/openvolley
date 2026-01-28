import { useState, useEffect } from 'react'

const defaultInputStyle = {
  width: '2.5em',
  padding: '6px 4px',
  fontSize: 'inherit',
  textAlign: 'center',
  background: 'var(--bg-secondary, #1f2937)',
  border: '1px solid rgba(255,255,255,0.2)',
  borderRadius: '6px',
  color: 'var(--text, #e5e7eb)'
}

function parseHHmm(value) {
  if (!value || typeof value !== 'string') return { hour: 0, minute: 0 }
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return { hour: 0, minute: 0 }
  const hour = Math.min(23, Math.max(0, parseInt(match[1], 10)))
  const minute = Math.min(59, Math.max(0, parseInt(match[2], 10)))
  return { hour, minute }
}

function formatHHmm(hour, minute) {
  const h = Math.min(23, Math.max(0, Number(hour) || 0))
  const m = Math.min(59, Math.max(0, Number(minute) || 0))
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/**
 * Time input that always displays and edits in 24-hour format (HH:mm).
 * Use this instead of <input type="time"> when you need locale-independent 24h display.
 */
export function TimeInput24({ value = '', onChange, style, className, ...rest }) {
  const parsed = parseHHmm(value)
  const [hour, setHour] = useState(parsed.hour)
  const [minute, setMinute] = useState(parsed.minute)

  useEffect(() => {
    const next = parseHHmm(value)
    setHour(next.hour)
    setMinute(next.minute)
  }, [value])

  const notify = (h, m) => {
    const next = formatHHmm(h, m)
    if (onChange) onChange(next)
  }

  const handleHourChange = (e) => {
    const v = e.target.value === '' ? 0 : parseInt(e.target.value, 10)
    const h = isNaN(v) ? hour : Math.min(23, Math.max(0, v))
    setHour(h)
    notify(h, minute)
  }

  const handleMinuteChange = (e) => {
    const v = e.target.value === '' ? 0 : parseInt(e.target.value, 10)
    const m = isNaN(v) ? minute : Math.min(59, Math.max(0, v))
    setMinute(m)
    notify(hour, m)
  }

  const containerStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px'
  }
  const inputStyle = { ...defaultInputStyle, ...(style || {}) }

  return (
    <span className={className} style={containerStyle} {...rest}>
      <input
        type="number"
        min={0}
        max={23}
        value={hour}
        onChange={handleHourChange}
        onFocus={(e) => e.target.select()}
        style={inputStyle}
        aria-label="Hour (24h)"
      />
      <span style={{ fontWeight: 600, userSelect: 'none' }}>:</span>
      <input
        type="number"
        min={0}
        max={59}
        value={minute}
        onChange={handleMinuteChange}
        onFocus={(e) => e.target.select()}
        style={inputStyle}
        aria-label="Minute"
      />
    </span>
  )
}
