import DonutCountdown from '../DonutCountdown'

/** Size of the time-out ring, the same in the popup and on the court, so it can move between them. */
export const TIMEOUT_RING_SIZE = 130

/** The time-out's ring with its seconds (the referee screen, the "Recorded" popup, the move between them). */
export default function TimeoutCountdown({ countdown, fontFamily = 'inherit' }) {
  return (
    <DonutCountdown current={countdown} total={30} size={TIMEOUT_RING_SIZE} strokeWidth={6}>
      <div style={{ fontSize: 'clamp(24px, 8vw, 40px)', fontFamily, fontWeight: 600, color: countdown <= 10 ? '#ef4444' : 'var(--accent)', lineHeight: 1 }}>
        {countdown}"
      </div>
    </DonutCountdown>
  )
}
