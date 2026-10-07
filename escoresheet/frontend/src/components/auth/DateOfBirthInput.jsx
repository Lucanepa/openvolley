import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '../../ui'
import { isoToDobText, parseDobText, shapeDobText } from './dobInput'

/**
 * Date of birth typed as DD.MM.YYYY (see dobInput.js for why it is not a
 * native date field). Starts empty unless `value` holds a date.
 *
 * @param {object} props
 * @param {string} props.value  ISO date (YYYY-MM-DD) or ''
 * @param {(iso: string|null) => void} props.onChange  '' when cleared, the
 *   ISO date once complete and valid, null while unfinished or impossible
 */
export default function DateOfBirthInput({ value, onChange, size = 'lg', ...rest }) {
  const { t } = useTranslation()
  const [text, setText] = useState(() => isoToDobText(value))
  // The value this field last reported: a different `value` came from outside
  // (a profile that loaded), and the text follows it.
  const reported = useRef(value)

  useEffect(() => {
    if (value === reported.current) return
    reported.current = value
    setText(isoToDobText(value))
  }, [value])

  const handle = (e) => {
    const raw = e.target.value
    // Autofill may hand over an ISO date (bday): keep it whole
    const next = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? isoToDobText(raw) : shapeDobText(raw)
    setText(next)
    const { iso } = parseDobText(next)
    reported.current = iso
    onChange?.(iso)
  }

  return (
    <Input
      size={size}
      type="text"
      inputMode="numeric"
      autoComplete="bday"
      placeholder={t('auth.dobPlaceholder', 'DD.MM.YYYY')}
      maxLength={10}
      value={text}
      onChange={handle}
      {...rest}
    />
  )
}
