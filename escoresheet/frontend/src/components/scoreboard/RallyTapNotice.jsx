import { useTranslation } from 'react-i18next'

// How long the notice stays (Scoreboard clears it after this long)
export const RALLY_TAP_NOTICE_MS = 1800

/**
 * "Not counted": a tap on the rally buttons was taken as the end of the tap
 * before it (useRallyTapGuard) and did nothing. Said, not silent: a scorer
 * whose tap was dropped without a sign tapped again, unsure whether the
 * first one had counted (owner, 2026-10-29). Drawn over the edge above the
 * rally buttons, out of the layout (the court does not move) and out of reach
 * of the taps (pointer-events: none). `id` > 0 shows it; a new id restarts it.
 */
export default function RallyTapNotice({ id, style }) {
  const { t } = useTranslation()
  if (!id) return null
  return (
    <div
      key={id}
      role="status"
      aria-live="polite"
      data-testid="rally-tap-notice"
      className="rally-tap-notice"
      style={style}
    >
      {t('scoreboard.rallyTapIgnored')}
    </div>
  )
}
