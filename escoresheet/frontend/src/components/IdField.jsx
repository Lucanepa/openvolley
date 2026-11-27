import { useTranslation } from 'react-i18next'
import { DateField } from '../ui/DateField.jsx'
import { INPUT_SIZES } from '../ui/Input.jsx'
import { cn } from '../ui/cn.js'
import { cleanIdValue, isPlaceholderValue, typedIdValue } from '../domain/idMode'

/**
 * The value beside a person's name (domain/idMode): the same stored `dob`
 * string in every mode.
 *   'dob'      the DateField, with the props it always had (value and
 *              onChange in ISO; the caller converts)
 *   'licence'  (every Swiss match) a text field: a licence number, or a date
 *              of birth typed with its separator (14.03.2008). inputMode text:
 *              the iPad's numeric keypad has no "."; the value is tidied when
 *              the field is left (cleanIdValue: a date dd.mm.yyyy, else the
 *              digits)
 *   'number' / 'text'  (Global) a text field of the stored text
 * rawValue / onRawChange(text): the stored text, for every mode but 'dob'.
 * The 01.01.1900 placeholder of older matches shows empty. The field looks
 * like the DateField of the same `size` ('bare': the caller's className).
 */
export default function IdField({ idMode = 'dob', rawValue = '', onRawChange, ...dateProps }) {
  const { t } = useTranslation()
  if (idMode === 'dob') return <DateField {...dateProps} />
  const {
    size = 'md', wrapperClassName, className, style, onKeyDown, onBlur, onFocus, disabled, readOnly, id,
    placeholder, title,
    'aria-label': ariaLabel, 'aria-describedby': ariaDescribedBy, 'aria-invalid': ariaInvalid,
    'data-testid': testId,
    // a photo import's mark on the field (MatchSetup; UI only)
    'data-photo-mark': photoMark
  } = dateProps
  const licence = idMode === 'licence'
  const text = rawValue == null || isPlaceholderValue(rawValue) ? '' : String(rawValue)
  return (
    <span className={cn('relative flex w-full min-w-0 items-center', wrapperClassName)}>
      <input
        id={id}
        type="text"
        inputMode={idMode === 'number' ? 'numeric' : 'text'}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        maxLength={licence ? 10 : undefined}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        data-testid={testId}
        data-photo-mark={photoMark}
        disabled={disabled}
        readOnly={readOnly}
        placeholder={placeholder}
        title={title ?? (licence ? t('idMode.hint.licence', 'or date of birth (dd.mm.yyyy)') : undefined)}
        style={size === 'bare' ? { flex: '1 1 auto', minWidth: 0, ...style } : style}
        className={size === 'bare' ? cn('min-w-0 flex-1 tabular-nums', className) : cn(INPUT_SIZES[size] ?? INPUT_SIZES.md, 'tabular-nums', className)}
        value={text}
        onFocus={onFocus}
        onChange={e => onRawChange?.(typedIdValue(idMode, e.target.value))}
        onBlur={e => {
          // Tidy what was typed: 1.3.2008 -> 01.03.2008, "12 345" -> 12345
          if (licence) {
            const clean = cleanIdValue('licence', e.target.value)
            if (clean !== text) onRawChange?.(clean)
          }
          onBlur?.(e)
        }}
        onKeyDown={onKeyDown}
      />
    </span>
  )
}
