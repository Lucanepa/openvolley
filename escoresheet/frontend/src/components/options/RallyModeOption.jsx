import { useTranslation } from 'react-i18next'
import { SegmentedControl } from '../../ui'
import { storeRallyMode } from '../../utils/rallyMode'
import { POINT_HOLD_MS } from '../../hooks/useHoldToConfirm'

/**
 * Options › Match options › Point entry (owner 22.11.2026): "Rallies"
 * (Start rally, then the point; the app as always) or "Continuous play" (no
 * Start rally, a point is held about 2 s). This device only
 * (utils/rallyMode), in the Home options and the scoring screen's, at the
 * top of the match options. `kit`: the dialog's own Row and InfoDot.
 */
export default function RallyModeOption({ kit, value, onChange }) {
  const { Row, InfoDot } = kit
  const { t } = useTranslation()
  const seconds = POINT_HOLD_MS / 1000
  return (
    <Row style={{ marginBottom: '12px', flexDirection: 'column', alignItems: 'stretch', gap: '8px' }}>
      <div className="flex items-center gap-1.5">
        <div className="text-sm font-semibold text-stone-900">{t('options.rallyMode')}</div>
        <InfoDot title={t('options.rallyModeInfo', { seconds })} />
      </div>
      <SegmentedControl
        ariaLabel={t('options.rallyMode')}
        value={value === 'continuous' ? 'continuous' : 'rallies'}
        className="max-w-md"
        options={[
          { value: 'rallies', label: t('options.rallyModeRallies') },
          { value: 'continuous', label: t('options.rallyModeContinuous') }
        ]}
        onChange={(mode) => onChange?.(storeRallyMode(mode))}
      />
      <p data-testid="rally-mode-hint" className="m-0 text-xs leading-snug text-stone-500">
        {value === 'continuous' ? t('options.rallyModeContinuousHint', { seconds }) : t('options.rallyModeRalliesHint')}
      </p>
    </Row>
  )
}
