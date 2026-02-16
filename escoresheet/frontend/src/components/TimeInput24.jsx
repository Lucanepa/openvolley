import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

const defaultInputStyle = {
  width: '5em',
  padding: '6px 8px',
  fontSize: 'inherit',
  textAlign: 'center',
  background: 'var(--bg-secondary, #1f2937)',
  border: '1px solid rgba(255,255,255,0.2)',
  borderRadius: '6px',
  color: 'var(--text, #e5e7eb)'
}

const HHMM_REGEX = /^(\d{1,2}):(\d{2})$/

function parseHHmm(value) {
  if (!value || typeof value !== 'string') return { hour: 0, minute: 0 }
  const match = value.trim().match(HHMM_REGEX)
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
 * Single field like a normal time input, e.g. "08:30" or "20:45".
 */
export function TimeInput24({ value = '', onChange, style, className, ...rest }) {
  const { t } = useTranslation()
  const normalized = formatHHmm(parseHHmm(value).hour, parseHHmm(value).minute)
  const [local, setLocal] = useState(normalized || '00:00')
  const lastSentRef = useRef(normalized || '00:00')

  useEffect(() => {
    const next = formatHHmm(parseHHmm(value).hour, parseHHmm(value).minute) || '00:00'
    if (value !== undefined && value !== lastSentRef.current) {
      lastSentRef.current = next
      setLocal(next)
    }
  }, [value])

  const handleChange = (e) => {
    const raw = e.target.value
    setLocal(raw)
    if (HHMM_REGEX.test(raw.trim())) {
      const { hour, minute } = parseHHmm(raw)
      const formatted = formatHHmm(hour, minute)
      lastSentRef.current = formatted
      if (onChange) onChange(formatted)
    }
  }

  const handleBlur = () => {
    const { hour, minute } = parseHHmm(local)
    const formatted = formatHHmm(hour, minute)
    setLocal(formatted)
    lastSentRef.current = formatted
    if (onChange) onChange(formatted)
  }

  const inputStyle = { ...defaultInputStyle, ...(style || {}) }

  return (
    <input
      type="text"
      inputMode="numeric"
      placeholder={t('matchSetup.placeholders.hhMm')}
      value={local}
      onChange={handleChange}
      onBlur={handleBlur}
      onFocus={(e) => e.target.select()}
      maxLength={5}
      className={className}
      style={inputStyle}
      aria-label={t('common.timeLabel')}
      {...rest}
    />
  )
}
