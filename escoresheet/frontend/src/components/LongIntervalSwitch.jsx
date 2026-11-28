import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Switch } from '../ui/Switch.jsx'
import { InfoDot } from '../ui/InfoDot.jsx'

/**
 * The "10-minute interval after set 2" switch (owner 2026-11-17,
 * domain/setInterval.js): Match setup's Game details and Edit match info,
 * also after the coin toss. Off by default.
 */
export default function LongIntervalSwitch({ checked, onChange, disabled = false, className = '' }) {
  const { t } = useTranslation()
  const labelId = useId()
  const hintId = useId()
  return (
    <div className={`flex items-start justify-between gap-3 ${className}`} data-testid="long-interval-after-set2">
      {/* the rule behind it in the (i) (28.11.2026); the switch keeps it as
          its description for screen readers */}
      <div className="flex min-w-0 items-center gap-1.5">
        <div id={labelId} className="text-sm font-semibold" style={{ color: 'var(--ov-text, inherit)' }}>
          {t('matchSetup.longIntervalAfterSet2')}
        </div>
        <InfoDot title={t('matchSetup.longIntervalAfterSet2Hint')} />
        <span id={hintId} className="sr-only">{t('matchSetup.longIntervalAfterSet2Hint')}</span>
      </div>
      <Switch
        checked={checked === true}
        onCheckedChange={(next) => onChange?.(next === true)}
        disabled={disabled}
        aria-labelledby={labelId}
        aria-describedby={hintId}
        data-testid="long-interval-after-set2-switch"
        // p-0: the global button padding (styles.css) squeezed the thumb
        // off the track (as MatchSetup's ToggleSwitch)
        className="mt-0.5 shrink-0 p-0"
      />
    </div>
  )
}
