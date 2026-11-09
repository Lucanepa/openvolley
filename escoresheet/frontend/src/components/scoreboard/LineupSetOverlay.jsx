import { useTranslation } from 'react-i18next'

/**
 * Over a team's half court on the phone scoring screen while its line-up is
 * the only one recorded (domain/lineupPrivacy.js), as the tablet court does:
 * "Line-up set", Show line-up (press and hold) and Change line-up.
 */
export default function LineupSetOverlay({ side, onPeek, onChange }) {
  const { t } = useTranslation()
  const peek = (on) => () => onPeek(on)
  return (
    <div
      data-testid={`phone-lineup-hidden-${side}`}
      style={{
        position: 'absolute', inset: 0, zIndex: 5, borderRadius: 8,
        background: 'rgba(15, 23, 42, 0.55)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 6
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 700, color: '#22c55e', textAlign: 'center' }}>{t('scoreboard.lineupSet', 'Line-up set')}</div>
      <button
        type="button"
        onPointerDown={peek(true)}
        onPointerUp={peek(false)}
        onPointerLeave={peek(false)}
        onPointerCancel={peek(false)}
        style={{ minHeight: 36, padding: '6px 10px', fontSize: 12, fontWeight: 600, background: 'rgba(59, 130, 246, 0.3)', color: '#fff', border: '1px solid rgba(59, 130, 246, 0.5)', borderRadius: 6, touchAction: 'none' }}
      >
        {t('scoreboard.showLineup', 'Show line-up')}
      </button>
      {onChange && (
        <button
          type="button"
          onClick={onChange}
          style={{ minHeight: 36, padding: '6px 10px', fontSize: 12, fontWeight: 600, background: 'rgba(251, 191, 36, 0.3)', color: '#fbbf24', border: '1px solid rgba(251, 191, 36, 0.5)', borderRadius: 6 }}
        >
          {t('scoreboard.changeLineup', 'Change line-up')}
        </button>
      )}
    </div>
  )
}
