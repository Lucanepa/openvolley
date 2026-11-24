import { useEffect } from 'react'
import { POINT_HOLD_MS, useHoldToConfirm } from '../../hooks/useHoldToConfirm'

/**
 * A button that gives its action only once it has been held for `holdMs`
 * (hooks/useHoldToConfirm): continuous play's Point A | Point B on the
 * tablet and on the phone. It draws the fill that grows while it is held
 * (styles.css .hold-button, .hold-fill) under its label, and a "Hold"
 * caption, so the scorer sees it is held, not tapped; the corner icon is the
 * hold hint (.hold-hint, hidden with Options › Show tap hints off, as the
 * tap hints). It has no onClick: the action comes at the end of the hold.
 *
 * `apiRef` gets the hold's api ({ start, release, cancel }) for the scoring
 * keys, which hold the button the key stands for.
 */
export default function HoldToConfirmButton({
  label,
  caption,
  ariaLabel,
  onConfirm,
  onShortPress,
  disabled = false,
  holdMs = POINT_HOLD_MS,
  apiRef = null,
  className = '',
  style,
  contentStyle,
  captionStyle,
  ...rest
}) {
  const { ref, handlers, api } = useHoldToConfirm({ onConfirm, onShortPress, disabled, holdMs })
  useEffect(() => {
    if (!apiRef) return undefined
    apiRef.current = api
    return () => {
      if (apiRef.current === api) apiRef.current = null
    }
  }, [apiRef, api])
  return (
    <button
      type="button"
      ref={ref}
      className={`hold-button ${className}`.trim()}
      aria-label={ariaLabel}
      disabled={disabled}
      data-hold-button=""
      style={{ '--hold-ms': `${holdMs}ms`, ...style }}
      {...handlers}
      {...rest}
    >
      <span className="hold-fill" data-hold-fill="" aria-hidden="true" />
      <span className="hold-content" aria-hidden={ariaLabel ? 'true' : undefined} style={contentStyle}>
        <span className="hold-label">{label}</span>
        {caption && <span className="hold-caption" style={captionStyle}>{caption}</span>}
      </span>
    </button>
  )
}
