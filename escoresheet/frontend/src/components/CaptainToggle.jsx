import { useTranslation } from 'react-i18next'
import { FOCUS_RING } from '../ui/Button.jsx'

/**
 * The roster's team-captain switch: a real toggle button (was a 24 px div with
 * no role, label or keyboard access). 40 px square, aria-pressed, and a label
 * that names the player. On = emerald (done / chosen), off = a stone outline.
 * @param {object} props
 * @param {boolean} props.pressed  this player is the team captain
 * @param {() => void} props.onToggle
 * @param {number|string|null} [props.number]  jersey number for the label
 */
export default function CaptainToggle({ pressed, onToggle, number = null, ...rest }) {
  const { t } = useTranslation()
  const hasNumber = number !== null && number !== undefined && number !== ''
  const label = hasNumber
    ? t('matchSetup.captainToggle', { number, defaultValue: 'Team captain #{{number}}' })
    : t('matchSetup.captainToggleNew', 'Team captain (new player)')
  return (
    <button
      type="button"
      aria-pressed={!!pressed}
      aria-label={label}
      title={label}
      onClick={onToggle}
      className={FOCUS_RING}
      style={{
        width: '40px',
        height: '40px',
        minWidth: '40px',
        padding: 0,
        margin: 0,
        borderRadius: '8px',
        border: pressed ? '2px solid #059669' : '2px solid #d6d3d1', // emerald-600 / stone-300
        background: pressed ? '#ecfdf5' : '#ffffff', // emerald-50 / white
        color: pressed ? '#047857' : '#78716c', // emerald-700 / stone-500
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        fontSize: '14px',
        fontWeight: 700,
        lineHeight: 1,
        userSelect: 'none'
      }}
      {...rest}
    >
      C
    </button>
  )
}
