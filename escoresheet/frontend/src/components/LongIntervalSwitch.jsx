import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Switch } from '../ui/Switch.jsx'

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
      <div className="min-w-0">
        <div id={labelId} className="text-sm font-semibold" style={{ color: 'var(--ov-text, inherit)' }}>
          {t('matchSetup.longIntervalAfterSet2')}
        </div>
        <div id={hintId} className="mt-0.5 text-xs" style={{ color: 'var(--ov-text-muted, #78716c)' }}>
          {t('matchSetup.longIntervalAfterSet2Hint')}
        </div>
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
